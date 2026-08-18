#!/usr/bin/env bun
/**
 * TrueX PRODUCTION Market Maker
 *
 * Uses the MarketMakerOrchestrator with:
 *   - Coinbase WS feed for BTC-USD pricing
 *   - FIX connection to TrueX PROD (via Hetzner proxy → WireGuard → TrueX)
 *   - Balance-aware quoting (won't post unfunded orders)
 *   - DataPipelineManager (Memory → Redis → PostgreSQL)
 *
 * Production Parameters:
 *   - 0.044 BTC + 0 PYUSD initial balance
 *   - Sell-only initially (no PYUSD to back bids)
 *   - Zero maker fees per TrueX agreement
 *   - BTC-PYUSD on TrueX, priced off BTC-USD on Coinbase
 *
 * Environment Variables (must be set in .env):
 *   TRUEX_PROD_API_KEY     - TrueX production API key
 *   TRUEX_PROD_SECRET_KEY  - TrueX production secret
 *   TRUEX_CLIENT_ID        - Production client ID (78932725357888855)
 *   TRUEX_FIX_HOST         - Proxy host (178.156.230.110)
 *   TRUEX_FIX_PORT         - Proxy OE port (3004)
 *   TRUEX_TARGET_COMP_ID   - Target comp ID (TRUEX_PROD_OE)
 *   TRUEX_REST_URL         - REST URL via proxy (http://178.156.230.110:3006)
 *   TRUEX_SENDER_COMP_ID   - SenderCompID (default: DAVID1)
 *   DATABASE_URL            - PostgreSQL (optional)
 *   REDIS_URL               - Redis (optional)
 *   TARGET_INVENTORY_BTC     - Desired BTC allocation used for inventory skew (default: 0)
 *
 * Usage:
 *   bun scripts/run-prod.js
 */

import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';
import { DataPipelineManager } from '../src/data-pipeline/data-pipeline-manager.js';
import { PriceAggregator } from '../src/connectors/aggregator/PriceAggregator.ts';
import { KrakenRestClient } from '../src/connectors/kraken/KrakenRestClient.ts';
import { CoinbaseWsIngest } from '../src/data-pipeline/coinbase-ws-ingest.js';
import { CoinbaseMarketDataAdapter } from '../src/data-pipeline/coinbase-market-data-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse fee env var with NaN guard and sanity bound (max 500bps = 5%) */
function parseFee(envVar, defaultVal = 0) {
  const val = parseInt(process.env[envVar] || String(defaultVal));
  if (Number.isNaN(val)) return defaultVal;
  if (val < 0 || val > 500) {
    console.warn(`[WARN] ${envVar}=${val} out of range [0,500] — using default ${defaultVal}`);
    return defaultVal;
  }
  return val;
}

function parseNumber(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const val = Number(raw);
  return Number.isFinite(val) ? val : defaultVal;
}

function parseBoolean(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  if (['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase())) return false;
  return defaultVal;
}

function parseIntegerList(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === null || raw.trim() === '') return [...defaultVal];
  const values = raw.split(',').map(value => Number(value.trim()));
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new Error(`${envVar} must be a comma-separated list of safe integers`);
  }
  return values;
}

const shadowPhase2Criteria = {
  minObservationDays: parseNumber('SHADOW_GO_MIN_OBSERVATION_DAYS', 3),
  minWouldTakeCount: parseNumber('SHADOW_GO_MIN_WOULD_TAKE_COUNT', 50),
  minAttributedCount: parseNumber('SHADOW_GO_MIN_ATTRIBUTED_COUNT', 40),
  minMedianBasisAdjEdgeBps: parseNumber('SHADOW_GO_MIN_MEDIAN_BASIS_ADJ_EDGE_BPS', 20),
  minP25BasisAdjEdgeBps: parseNumber('SHADOW_GO_MIN_P25_BASIS_ADJ_EDGE_BPS', 15),
  maxDisappearedRatePct: parseNumber('SHADOW_ABORT_MAX_DISAPPEARED_RATE_PCT', 35),
  maxAbsPyusdBasisBps: parseNumber('SHADOW_ABORT_MAX_ABS_PYUSD_BASIS_BPS', 100),
  maxP95AbsPyusdBasisBps: parseNumber('SHADOW_ABORT_MAX_P95_ABS_PYUSD_BASIS_BPS', 80),
};

// ---------------------------------------------------------------------------
// Configuration — PRODUCTION
// ---------------------------------------------------------------------------

const config = {
  // Session
  sessionId: `prod-${Date.now()}`,
  symbol: 'BTC-PYUSD',

  // FIX Connection — TrueX PROD via Hetzner proxy
  truexHost: process.env.TRUEX_FIX_HOST || '178.156.230.110',
  truexPort: parseInt(process.env.TRUEX_FIX_PORT || '3004', 10),
  senderCompID: process.env.TRUEX_SENDER_COMP_ID || 'DAVID1',
  targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_PROD_OE',
  apiKey: process.env.TRUEX_PROD_API_KEY,
  apiSecret: process.env.TRUEX_PROD_SECRET_KEY,
  clientId: process.env.TRUEX_CLIENT_ID || '78932725357888855',
  heartbeatInterval: 30,

  // Quote Engine — CONSERVATIVE production sizing
  //   2 levels per side (TrueX requested; matches available BTC inventory)
  //   Base size 0.01 BTC (~$1,000 at $100k)
  //   Total per side: ~0.018 BTC (0.01 + 0.008)
  levels: 2,
  // Mirror Coinbase's book: we are effectively the entire TrueX book (sole liquidity), so
  // anchoring our quotes to Coinbase best bid/ask (offset by a 1-tick buffer) makes TrueX show
  // a Coinbase-tight market. baseSpreadBps is the fallback if the Coinbase book is absent.
  //
  // ACCEPTED RISK: prod has no TrueX top-of-book feed, so the marketable/slide guard is inert.
  // Because we are the only resting liquidity there is effectively nothing to cross; the rare
  // case (a third party rests inside our quote) is caught reactively by the reject-backoff
  // (3 rejects → 5s pause). Revisit when a real TrueX book feed and/or hedge venue is wired.
  quoteAnchorMode: 'coinbase-mirror',
  coinbaseAnchorBufferTicks: 1,      // 1 tick ($0.50) outside Coinbase touch
  // marketablePostOnlyAction stays at the default 'skip': the prod marketDataFeed (Coinbase
  // adapter) does not expose getBestBidAsk(), so no TrueX top-of-book is available and the
  // marketable/slide guard is inert. We are effectively the book, so this is acceptable;
  // revisit if a real TrueX book feed is wired.
  baseSpreadBps: 30,                 // fallback spread (15bps/side) when Coinbase book is absent
  levelSpacingTicks: 2,
  randomLevelSpacingBpsMin: 0.8,
  randomLevelSpacingBpsMax: 1.2,
  // Faster reprice regime for a tight mirrored spread: stale quotes are the main risk when
  // mirroring Coinbase, and repricing only updates our own book. Tightened from 3 ticks/5s.
  repriceThresholdTicks: 1,    // Reprice on any $0.50 move off the anchor
  baseSizeBTC: 0.01,           // ~$1,000 at $100k BTC
  sizeDecayFactor: 0.8,        // Each level 80% of previous
  sizeDecimalPlaces: 4,        // TrueX BTC increment: 0.0001
  // passive-safe replace = cancel+place, so a full 2-level/2-side reprice is ~8 FIX actions.
  // At 6 msg/s that's ~1.3s — within the 1.5s min reprice interval and under TrueX's ~10 msg/s.
  maxOrdersPerSecond: 6,
  minRepriceIntervalMs: 1500,  // 1.5s minimum between reprices (was 5s)
  momentumRepriceBps: parseNumber('MOMENTUM_REPRICE_BPS', 10),  // task 0010: bypass debounce on moves >= N bps (0 disables)
  tickSize: 0.50,              // TrueX minimum increment
  minNotional: 1.0,            // TrueX minimum
  priceBandPct: 2.5,           // TrueX ±2.5% band

  // Inventory Manager — tight for ~0.044 BTC capital
  maxPositionBTC: 0.05,        // Slightly above starting balance
  // This is an operating target, not a limit. Leave unset to retain a zero-BTC target.
  // Do not change the deployed value without shadow evidence and explicit approval.
  targetInventoryBTC: parseNumber('TARGET_INVENTORY_BTC', 0),
  hedgeThresholdBTC: 0.03,     // Hedge signal at 0.03
  maxSkewTicks: 3,
  skewExponent: 1.5,
  emergencyLimitBTC: 0.06,     // Emergency stop

  // PnL Tracker — fees configurable via env (currently 0/0 per agreement)
  truexMakerFeeBps: parseFee('TRUEX_MAKER_FEE_BPS', 0),
  truexTakerFeeBps: parseFee('TRUEX_TAKER_FEE_BPS', 0),
  hedgeMakerFeeBps: parseFee('HEDGE_MAKER_FEE_BPS', 0),
  hedgeTakerFeeBps: parseFee('HEDGE_TAKER_FEE_BPS', 0),
  pnlLogIntervalMs: 30000,

  // Data Pipeline
  redisUrl: process.env.REDIS_URL || null,
  pgUrl: process.env.DATABASE_URL || null,
  referenceMarkoutConfig: {
    product: process.env.REFERENCE_MARKOUT_PRODUCT || 'BTC-USD',
    quoteCurrency: process.env.REFERENCE_MARKOUT_QUOTE_CURRENCY || 'USD',
    sourceExchange: process.env.REFERENCE_MARKOUT_SOURCE_EXCHANGE || 'coinbase',
    sourceType: process.env.REFERENCE_MARKOUT_SOURCE_TYPE || 'top-of-book',
    horizonsMs: parseIntegerList('REFERENCE_MARKOUT_HORIZONS_MS', [60_000, 300_000, 3_600_000]),
    maxSourceAgeMs: parseNumber('REFERENCE_MARKOUT_MAX_SOURCE_AGE_MS', 5_000),
    maxLatenessMs: parseNumber('REFERENCE_MARKOUT_MAX_LATENESS_MS', 30_000),
    pollIntervalMs: parseNumber('REFERENCE_MARKOUT_POLL_INTERVAL_MS', 1_000),
    batchSize: parseNumber('REFERENCE_MARKOUT_BATCH_SIZE', 100),
    claimLeaseMs: parseNumber('REFERENCE_MARKOUT_CLAIM_LEASE_MS', 5_000),
    retentionMs: parseNumber('REFERENCE_MARKOUT_RETENTION_MS', 90 * 86_400_000),
    retentionSweepIntervalMs: parseNumber('REFERENCE_MARKOUT_RETENTION_SWEEP_INTERVAL_MS', 3_600_000),
    auditMaxGroups: parseNumber('REFERENCE_MARKOUT_AUDIT_MAX_GROUPS', 500),
    maxAbsBasisAdjustmentBps: parseNumber('REFERENCE_MARKOUT_MAX_ABS_BASIS_BPS', 25),
  },

  // REST URL for reconciliation + balance fetching
  restUrl: process.env.TRUEX_REST_URL || 'http://178.156.230.110:3006',
  pyusdUsdPollIntervalMs: parseInt(process.env.PYUSD_USD_POLL_INTERVAL_MS || '5000', 10),
  pyusdUsdPollTimeoutMs: parseInt(process.env.PYUSD_USD_POLL_TIMEOUT_MS || '1000', 10),
  pyusdUsdStaleThresholdMs: parseInt(process.env.PYUSD_USD_STALE_THRESHOLD_MS || '15000', 10),
  pyusdUsdReferenceSources: [
    { type: 'kraken-rest', pair: process.env.PYUSD_USD_PRIMARY_PAIR || 'PYUSD/USD' },
    { type: 'kraken-rest', pair: process.env.PYUSD_USD_FALLBACK_PAIR || 'PYUSDUSD' },
  ],

  // Shadow take mode — observe-only, no FIX sends. Phase 1 runs enabled by default in
  // production so we collect data while keeping the taker path unreachable.
  shadowTakeMode: parseBoolean('SHADOW_TAKE_MODE', true),
  minTakeEdgeBps: parseNumber('SHADOW_MIN_TAKE_EDGE_BPS', 15),
  maxEdgeCeilingBps: parseNumber('SHADOW_MAX_EDGE_CEILING_BPS', 250),
  pyusdDepegThresholdBps: parseNumber('SHADOW_PYUSD_DEPEG_THRESHOLD_BPS', 100),
  maxTakeNotionalPerOrder: parseNumber('SHADOW_MAX_TAKE_NOTIONAL_PER_ORDER', 250),
  minTakeSizeBTC: parseNumber('SHADOW_MIN_TAKE_SIZE_BTC', 0.0001),
  shadowPersistenceRequiredPolls: parseInt(process.env.SHADOW_PERSISTENCE_POLLS || '3', 10),
  truexEbboPollIntervalMs: parseInt(process.env.TRUEX_EBBO_POLL_INTERVAL_MS || '1000', 10),
  shadowZeroDetectionAlertThresholdMs: parseInt(process.env.SHADOW_ZERO_DETECTION_ALERT_THRESHOLD_MS || '300000', 10),
  shadowSuppressionAlertThreshold: parseInt(process.env.SHADOW_SUPPRESSION_ALERT_THRESHOLD || '5', 10),
  shadowEdgeCeilingAlertThreshold: parseInt(process.env.SHADOW_EDGE_CEILING_ALERT_THRESHOLD || '3', 10),
  // Tape-freshness gates — split detection vs send. Detection uses a looser window so shadow
  // logs edge-quality data on illiquid books (BTC-PYUSD trades print < every 5s); the strict
  // send-side gate is reserved for the taker send-path re-check when allowTakerOrders is enabled.
  shadowDetectionTapeMaxAgeMs: parseInt(process.env.SHADOW_DETECTION_TAPE_MAX_AGE_MS || '30000', 10),
  truexTapeMaxAgeMs: parseInt(process.env.SHADOW_SEND_TAPE_MAX_AGE_MS || '5000', 10),
  shadowPhase2Criteria,
};

// ---------------------------------------------------------------------------
// Webhook Alerting
// ---------------------------------------------------------------------------

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

async function sendAlert(eventType, severity, message, context = {}) {
  if (!ALERT_WEBHOOK_URL) return;
  const payload = {
    event_type: eventType,
    severity,          // 'info' | 'warning' | 'error' | 'critical'
    message,
    timestamp: new Date().toISOString(),
    session_id: `prod-${process.pid}`,
    context,
  };
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Never let alerting crash the process
  }
}

// ---------------------------------------------------------------------------
// Logger (tees to stdout + file)
// ---------------------------------------------------------------------------

import { mkdirSync, appendFileSync } from 'fs';

const logLevel  = process.env.LOG_LEVEL || 'info';
const isDebug   = logLevel === 'debug';
const LOG_FILE  = process.env.LOG_FILE || '/app/logs/market-maker.log';

// Ensure log dir exists
try { mkdirSync(LOG_FILE.replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}

function writeLog(line) {
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const logger = {
  info:  (msg, meta) => { const l = `[INFO]  ${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`; console.log(l);  writeLog(l); },
  warn:  (msg, meta) => { const l = `[WARN]  ${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`; console.warn(l); writeLog(l); },
  error: (msg, meta) => { const l = `[ERROR] ${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`; console.error(l); writeLog(l); },
  debug: (msg, meta) => { if (isDebug) { const l = `[DEBUG] ${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`; console.log(l); writeLog(l); } },
};

// ---------------------------------------------------------------------------
// Validate environment — STRICT for production
// ---------------------------------------------------------------------------

function validateEnv() {
  const required = [
    'TRUEX_PROD_API_KEY',
    'TRUEX_PROD_SECRET_KEY',
    'TRUEX_CLIENT_ID',
    'TRUEX_FIX_HOST',
    'TRUEX_FIX_PORT',
    'TRUEX_REST_URL',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Safety: make sure we're not accidentally using UAT credentials
  if (config.targetCompID.includes('UAT')) {
    logger.error('SAFETY: targetCompID contains "UAT" — refusing to start in production mode');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let orchestrator = null;
let coinbaseIngest = null;
let coinbaseMdAdapter = null;
let priceAggregator = null;
let krakenRestClient = null;
let dataPipeline = null;
let isShuttingDown = false;

async function main() {
  validateEnv();

  logger.info('╔════════════════════════════════════════╗');
  logger.info('║   TrueX PRODUCTION Market Maker        ║');
  logger.info('╚════════════════════════════════════════╝');
  logger.info('');
  logger.info(`Session:       ${config.sessionId}`);
  logger.info(`Symbol:        ${config.symbol}`);
  logger.info(`FIX Host:      ${config.truexHost}:${config.truexPort}`);
  logger.info(`SenderCompID:  ${config.senderCompID}`);
  logger.info(`TargetCompID:  ${config.targetCompID}`);
  logger.info(`Client ID:     ${config.clientId}`);
  logger.info(`REST URL:      ${config.restUrl}`);
  logger.info(`Levels:        ${config.levels} per side`);
  logger.info(`Base size:     ${config.baseSizeBTC} BTC`);
  logger.info(`Base spread:   ${config.baseSpreadBps} bps`);
  logger.info(`Max position:  ${config.maxPositionBTC} BTC`);
  logger.info(`Target inventory: ${config.targetInventoryBTC} BTC`);
  logger.info(`Emergency:     ${config.emergencyLimitBTC} BTC`);
  logger.info(`Redis:         ${config.redisUrl ? 'configured' : 'none'}`);
  logger.info(`PostgreSQL:    ${config.pgUrl ? 'configured' : 'none'}`);
  logger.info(`Shadow mode:   ${config.shadowTakeMode ? 'observe-only enabled' : 'off'}`);
  logger.info(
    `Shadow gate:   >=${config.shadowPhase2Criteria.minWouldTakeCount} would-takes over >=${config.shadowPhase2Criteria.minObservationDays}d, ` +
    `median edge >=${config.shadowPhase2Criteria.minMedianBasisAdjEdgeBps}bps, p25 edge >=${config.shadowPhase2Criteria.minP25BasisAdjEdgeBps}bps`
  );
  logger.info(
    `Shadow abort:  disappeared rate >${config.shadowPhase2Criteria.maxDisappearedRatePct}% ` +
    `or |PYUSD basis| >${config.shadowPhase2Criteria.maxAbsPyusdBasisBps}bps ` +
    `or p95(|basis|) >${config.shadowPhase2Criteria.maxP95AbsPyusdBasisBps}bps`
  );
  logger.info('');

  krakenRestClient = new KrakenRestClient({});

  // 0. Cancel orphaned orders from previous sessions via REST API
  logger.info('[0/5] Cancelling orphaned orders via REST API...');
  try {
    const { TrueXRESTClient } = await import('../src/exchanges/truex/TrueXRESTClient.ts');
    const restClient = new TrueXRESTClient({
      baseURL: `${config.restUrl}/api/v1`,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      userId: config.clientId,
    });

    const result = await restClient.cancelAllOrders();
    if (result.failed.length > 0) {
      logger.error(`Orphan cancel failures: ${result.failed.map(f => `${f.id}:${f.error}`).join(', ')}`);
      logger.error('Cannot start with live orphaned orders — exiting');
      process.exit(1);
    }
    if (result.canceled.length > 0) {
      logger.info(`Cancelled ${result.canceled.length} orphaned orders`);
    } else {
      logger.info('No orphaned orders found');
    }
  } catch (err) {
    logger.error(`REST orphan cancel failed: ${err.message}`);
    logger.error('Cannot proceed without REST connectivity — exiting');
    process.exit(1);
  }
  logger.info('');

  // 1. Data Pipeline (Memory → Redis → PostgreSQL)
  logger.info('[1/5] Setting up data pipeline...');
  dataPipeline = new DataPipelineManager({
    sessionId: config.sessionId,
    symbol: config.symbol,
    redisUrl: config.redisUrl,
    pgUrl: config.pgUrl,
    logger,
  });

  // 1b. Analytics API (queries PostgreSQL, serves on port 3100)
  let apiSetOrchestrator = null;
  if (config.pgUrl) {
    const apiPort = process.env.API_PORT || '3100';
    logger.info(`[1b/5] Starting Analytics API on port ${apiPort}...`);
    try {
      const apiModule = await import('../src/api/server.js');
      apiSetOrchestrator = apiModule.setOrchestrator;
    } catch (err) {
      logger.warn(`Analytics API failed to start: ${err.message} — continuing without it`);
    }
  }

  // 2. Price Aggregator (Coinbase only)
  logger.info('[2/5] Setting up Coinbase price feed...');
  priceAggregator = new PriceAggregator({
    symbol: config.symbol,
    stalenessThresholdMs: 10000,
    updateIntervalMs: 200,
    weights: { coinbase: 1.0 },
  });
  priceAggregator.registerExchange('coinbase', 1.0);

  // Wire Coinbase WS → PriceAggregator
  coinbaseIngest = new CoinbaseWsIngest({
    symbols: [config.symbol],
    onTicker: (symbol, ticker) => {
      priceAggregator.updateTicker({
        exchange: 'coinbase',
        symbol,
        bid: ticker.bid,
        ask: ticker.ask,
        last: ticker.last,
        timestamp: ticker.timestamp,
      });
    },
    onSnapshot: (symbol, { bids, asks }) => {
      if (bids.length > 0 && asks.length > 0) {
        priceAggregator.updateTicker({
          exchange: 'coinbase',
          symbol,
          bid: bids[0][0],
          ask: asks[0][0],
          last: (bids[0][0] + asks[0][0]) / 2,
          // Coinbase level2 snapshots do not carry an exchange timestamp. Keep this
          // explicitly unavailable so analytics cannot mistake receipt time for source time.
          timestamp: null,
        });
      }
    },
    onL2Update: () => {},
    logger,
  });

  coinbaseMdAdapter = new CoinbaseMarketDataAdapter({
    ingest: coinbaseIngest,
    priceAggregator,
    exchange: 'coinbase',
  });

  // 3. Start Coinbase feed (need prices before FIX connect)
  logger.info('[3/5] Connecting to Coinbase WebSocket...');
  await coinbaseIngest.start();
  priceAggregator.start();

  logger.info('Waiting for Coinbase price data...');
  const firstPrice = await waitForFirstPrice(priceAggregator, 30000);
  if (!firstPrice) {
    logger.error('Timed out waiting for Coinbase price — exiting');
    await shutdown('NO_PRICE', 1);
    return;
  }
  logger.info(`First price received: mid=$${firstPrice.weightedMidpoint.toFixed(2)} confidence=${firstPrice.confidence.toFixed(2)}`);

  // 4. Create and start orchestrator
  logger.info('[4/5] Starting MarketMakerOrchestrator...');
  orchestrator = new MarketMakerOrchestrator({
    sessionId: config.sessionId,
    symbol: config.symbol,
    logger,

    // FIX connection
    truexHost: config.truexHost,
    truexPort: config.truexPort,
    senderCompID: config.senderCompID,
    targetCompID: config.targetCompID,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    heartbeatInterval: config.heartbeatInterval,

    // Price feed
    priceAggregator,
    marketDataFeed: coinbaseMdAdapter,

    // Quote engine
    levels: config.levels,
    baseSpreadBps: config.baseSpreadBps,
    quoteAnchorMode: config.quoteAnchorMode,
    coinbaseAnchorBufferTicks: config.coinbaseAnchorBufferTicks,
    levelSpacingTicks: config.levelSpacingTicks,
    randomLevelSpacingBpsMin: config.randomLevelSpacingBpsMin,
    randomLevelSpacingBpsMax: config.randomLevelSpacingBpsMax,
    repriceThresholdTicks: config.repriceThresholdTicks,
    baseSizeBTC: config.baseSizeBTC,
    sizeDecayFactor: config.sizeDecayFactor,
    sizeDecimalPlaces: config.sizeDecimalPlaces,
    maxOrdersPerSecond: config.maxOrdersPerSecond,
    minRepriceIntervalMs: config.minRepriceIntervalMs,
    momentumRepriceBps: config.momentumRepriceBps,
    tickSize: config.tickSize,
    minNotional: config.minNotional,
    priceBandPct: config.priceBandPct,

    // TrueX client ID
    clientId: config.clientId,

    // Inventory manager
    maxPositionBTC: config.maxPositionBTC,
    targetInventoryBTC: config.targetInventoryBTC,
    hedgeThresholdBTC: config.hedgeThresholdBTC,
    maxSkewTicks: config.maxSkewTicks,
    skewExponent: config.skewExponent,
    emergencyLimitBTC: config.emergencyLimitBTC,

    // PnL tracker
    truexMakerFeeBps: config.truexMakerFeeBps,
    truexTakerFeeBps: config.truexTakerFeeBps,
    hedgeMakerFeeBps: config.hedgeMakerFeeBps,
    hedgeTakerFeeBps: config.hedgeTakerFeeBps,
    pnlLogIntervalMs: config.pnlLogIntervalMs,

    // Data pipeline
    dataPipeline,
    referenceMarkoutConfig: config.referenceMarkoutConfig,

    // REST reconciliation + balance refresh
    restUrl: config.restUrl,
    pyusdUsdPollIntervalMs: config.pyusdUsdPollIntervalMs,
    pyusdUsdPollTimeoutMs: config.pyusdUsdPollTimeoutMs,
    pyusdUsdStaleThresholdMs: config.pyusdUsdStaleThresholdMs,
    pyusdUsdReferenceSources: config.pyusdUsdReferenceSources,
    krakenRestClient,
    shadowTakeMode: config.shadowTakeMode,
    minTakeEdgeBps: config.minTakeEdgeBps,
    maxEdgeCeilingBps: config.maxEdgeCeilingBps,
    pyusdDepegThresholdBps: config.pyusdDepegThresholdBps,
    maxTakeNotionalPerOrder: config.maxTakeNotionalPerOrder,
    minTakeSizeBTC: config.minTakeSizeBTC,
    shadowPersistenceRequiredPolls: config.shadowPersistenceRequiredPolls,
    truexEbboPollIntervalMs: config.truexEbboPollIntervalMs,
    shadowZeroDetectionAlertThresholdMs: config.shadowZeroDetectionAlertThresholdMs,
    shadowSuppressionAlertThreshold: config.shadowSuppressionAlertThreshold,
    shadowEdgeCeilingAlertThreshold: config.shadowEdgeCeilingAlertThreshold,
    shadowDetectionTapeMaxAgeMs: config.shadowDetectionTapeMaxAgeMs,
    truexTapeMaxAgeMs: config.truexTapeMaxAgeMs,

    // No hedging initially
    krakenClient: null,
  });

  wireOrchestratorEvents(orchestrator);

  coinbaseIngest.onReconnect = () => {
    orchestrator.alertManager.sendRecovery({ reason: 'Coinbase WS disconnected' })
      .catch((err) => logger.error(`[Coinbase] Recovery notification failed: ${err.message}`));
  };

  let lastCoinbaseRestartAt = 0;
  const COINBASE_RESTART_COOLDOWN_MS = 5 * 60 * 1000;
  orchestrator.on('watchdog-alert', async ({ issues }) => {
    const quotingIdle = issues.some((i) => i.includes('Quoting idle'));
    if (!quotingIdle) return;
    // Recycle Coinbase when the MD path is unhealthy: hard disconnect or half-open/stale feed
    // (adapter isLoggedOn requires socket connected + fresh non-stale ticker data)
    const mdHealthy = orchestrator.marketDataFeed?.isLoggedOn === true;
    if (mdHealthy) return;
    const t = Date.now();
    if (t - lastCoinbaseRestartAt < COINBASE_RESTART_COOLDOWN_MS) return;
    lastCoinbaseRestartAt = t;
    logger.warn('[Recovery] Coinbase MD unhealthy during quoting-idle watchdog — restarting feed');
    try {
      await orchestrator.marketDataFeed?.restart?.();
    } catch (err) {
      logger.error(`[Recovery] Coinbase restart failed: ${err.message}`);
    }
  });

  // Wire orchestrator into API server so /health and /api/status reflect live state
  apiSetOrchestrator?.(orchestrator);

  // 5. Start (connects FIX, fetches balances, begins quoting)
  await orchestrator.start();

  logger.info('');
  logger.info('╔════════════════════════════════════════╗');
  logger.info('║   PRODUCTION LIVE — Real Money Active   ║');
  logger.info('╚════════════════════════════════════════╝');
  logger.info('');
  logger.info('Balance-aware quoting active.');
  logger.info('With 0 PYUSD, only asks (sells) will be posted.');
  logger.info('Press Ctrl+C to stop gracefully.');
  logger.info('');

  // Periodic status report — every 60s
  const statusInterval = setInterval(() => {
    if (!orchestrator || !orchestrator.isRunning) return;
    const status = orchestrator.getStatus();
    const inv = status.inventory;
    const pnl = status.pnl;
    const quotes = status.quotes;
    const pyusdUsd = status.pyusdUsd;
    logger.info(
      `[STATUS] pos=${inv.netPosition?.toFixed(4) || '0'} BTC | ` +
      `side=${inv.side || 'flat'} | ` +
      `pnl=$${pnl.totalPnL?.toFixed(2) || '0'} | ` +
      `quotes=${quotes.activeCount || 0} active | ` +
      `fills=${inv.fillCount || 0} | ` +
      `base=${inv.baseBalance?.available?.toFixed(4) || '?'} BTC avail | ` +
      `quote=${inv.quoteBalance?.available?.toFixed(2) || '?'} PYUSD avail | ` +
      `pyusdUsd=${pyusdUsd?.price?.toFixed?.(6) || '?'}${status.pyusdUsdFresh ? '' : ' stale'} | ` +
      `shadow=${quotes.shadowTakeMode ? 'on' : 'off'} | ` +
      `uptime=${((status.uptimeMs || 0) / 1000 / 60).toFixed(1)}min`
    );
  }, 60000);

  process.on('beforeExit', () => clearInterval(statusInterval));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForFirstPrice(aggregator, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      aggregator.removeListener('price', onPrice);
      resolve(null);
    }, timeoutMs);

    function onPrice(price) {
      clearTimeout(timeout);
      aggregator.removeListener('price', onPrice);
      resolve(price);
    }

    aggregator.on('price', onPrice);

    const existing = aggregator.getAggregatedPrice();
    if (existing && existing.confidence > 0) {
      clearTimeout(timeout);
      aggregator.removeListener('price', onPrice);
      resolve(existing);
    }
  });
}

function wireOrchestratorEvents(orch) {
  orch.on('started', ({ sessionId }) => {
    logger.info(`[EVENT] Orchestrator started: session=${sessionId}`);
  });

  orch.on('stopped', ({ sessionId, durationMs, pnl }) => {
    logger.info(`[EVENT] Orchestrator stopped: session=${sessionId} duration=${(durationMs / 1000 / 60).toFixed(1)}min`);
    if (pnl) {
      logger.info(`[EVENT] Final PnL: total=$${pnl.totalPnL?.toFixed(2)} realized=$${pnl.realizedPnL?.toFixed(2)}`);
    }
  });

  orch.on('fill', ({ side, price, size, venue }) => {
    logger.info(`[FILL] ${side.toUpperCase()} ${size} BTC @ $${price.toFixed(2)} on ${venue}`);
  });

  orch.on('hedge', ({ side, size, price, venue }) => {
    logger.info(`[HEDGE] ${side.toUpperCase()} ${size} BTC @ $${price.toFixed(2)} on ${venue}`);
  });

  orch.on('emergency', ({ reason }) => {
    logger.error(`[EMERGENCY] ${reason}`);
    sendAlert('emergency', 'critical', `Emergency stop: ${reason}`, { reason });
  });

  orch.on('error', (err) => {
    const msg = err.message || String(err);
    logger.error(`[ERROR] ${msg}`);
    // Distinguish FIX connectivity errors from general errors
    const isConnectError = /connect|socket|logon timeout|unreachable/i.test(msg);
    if (isConnectError) {
      sendAlert('fix_connection_failed', 'critical', `FIX connection error: ${msg}`, {
        host: config.truexHost,
        port: config.truexPort,
        targetCompID: config.targetCompID,
      });
    } else {
      sendAlert('orchestrator_error', 'error', msg);
    }
  });

  orch.on('fix_disconnected', ({ reason } = {}) => {
    const msg = reason || 'FIX session dropped unexpectedly';
    logger.error(`[FIX] ${msg}`);
    sendAlert('fix_disconnected', 'critical', msg, {
      host: config.truexHost,
      port: config.truexPort,
      targetCompID: config.targetCompID,
    });
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`\n[SHUTDOWN] Received ${signal} — stopping gracefully...`);

  if (orchestrator) {
    try {
      await orchestrator.stop();
    } catch (err) {
      logger.error(`[SHUTDOWN] Orchestrator stop error: ${err.message}`);
      exitCode = Math.max(exitCode, 1);
    }
  }

  if (priceAggregator) priceAggregator.stop();
  if (coinbaseIngest) coinbaseIngest.stop();

  if (dataPipeline) {
    try {
      await dataPipeline.stop();
    } catch (err) {
      logger.error(`[SHUTDOWN] Data pipeline stop error: ${err.message}`);
      exitCode = Math.max(exitCode, 1);
    }
  }

  logger.info('[SHUTDOWN] Complete. Goodbye.');
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack);
  if (isShuttingDown) return;
  sendAlert('crash', 'critical', `Uncaught exception: ${err.message}`, { stack: err.stack })
    .catch(() => {})
    .finally(() => shutdown('UNCAUGHT_EXCEPTION', 1));
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled rejection: ${msg}`);
  if (isShuttingDown) return;
  sendAlert('crash', 'critical', `Unhandled rejection: ${msg}`)
    .catch(() => {})
    .finally(() => shutdown('UNHANDLED_REJECTION', 1));
});

// Run
main().catch(async (err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  const isFixError = /connect|socket|logon timeout|unreachable/i.test(err.message);
  try {
    await sendAlert(
      isFixError ? 'fix_connection_failed' : 'crash',
      'critical',
      isFixError
        ? `Cannot connect to TrueX exchange (${config.truexHost}:${config.truexPort}): ${err.message}`
        : `Fatal error: ${err.message}`,
      { stack: err.stack, host: config.truexHost, port: config.truexPort }
    );
  } catch (alertErr) {
    logger.error(`[SHUTDOWN] Alert send failed: ${alertErr.message}`);
  }
  await shutdown('FATAL_MAIN', 1);
});
