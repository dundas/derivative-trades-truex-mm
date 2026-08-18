#!/usr/bin/env bun
/**
 * TrueX UAT Paper Trading Script
 *
 * Uses the new MarketMakerOrchestrator with:
 *   - Coinbase WS feed for BTC-USD pricing
 *   - PriceAggregator (single-source, Coinbase)
 *   - FIX connection to TrueX UAT (Order Entry)
 *   - DataPipelineManager (Memory → Redis → PostgreSQL)
 *
 * Trading Parameters (from TrueX call):
 *   - $1,000-$5,000 bid/offer per side (~0.01-0.05 BTC at $100k)
 *   - Cash replaces (continuous requoting)
 *   - Zero maker fees
 *   - ~$10k capital
 *   - BTC-PYUSD on TrueX, priced off BTC-USD on Coinbase
 *
 * UAT Client IDs:
 *   - DAVID1 → 78972918929686546
 *   - DAVID2 → 78972918929686547
 *
 * Environment Variables:
 *   TRUEX_API_KEY        - TrueX API key (tag 553 Username)
 *   TRUEX_SECRET_KEY     - TrueX secret for HMAC-SHA256 auth
 *   TRUEX_SENDER_COMP_ID - FIX SenderCompID (default: DAVID1)
 *   TRUEX_TARGET_COMP_ID - FIX TargetCompID (default: TRUEX_UAT_OE)
 *   TRUEX_FIX_HOST       - TrueX host (default: 38.32.101.229)
 *   TRUEX_FIX_PORT       - TrueX port (default: 19484)
 *   REDIS_URL            - Redis connection (optional)
 *   DATABASE_URL         - PostgreSQL connection (optional)
 *   LOG_LEVEL            - info/debug (default: info)
 *   TARGET_INVENTORY_BTC - Desired BTC allocation used for inventory skew (default: 0)
 *
 * Usage:
 *   bun scripts/run-uat-paper-trading.js
 */

import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';
import { DataPipelineManager } from '../src/data-pipeline/data-pipeline-manager.js';
import { PriceAggregator } from '../src/connectors/aggregator/PriceAggregator.ts';
import { CoinbaseWsIngest } from '../src/data-pipeline/coinbase-ws-ingest.js';

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
  // Session
  sessionId: `uat-${Date.now()}`,
  symbol: 'BTC-PYUSD',

  // FIX Connection — TrueX UAT
  truexHost: process.env.TRUEX_FIX_HOST || '38.32.101.229',
  truexPort: parseInt(process.env.TRUEX_FIX_PORT || '19484', 10),
  senderCompID: process.env.TRUEX_SENDER_COMP_ID || 'DAVID1',
  targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
  apiKey: process.env.TRUEX_API_KEY,
  apiSecret: process.env.TRUEX_SECRET_KEY,
  clientId: process.env.TRUEX_CLIENT_ID || '78972918929686546', // DAVID1 default
  heartbeatInterval: 30,

  // Quote Engine — UAT sizing
  //   5 levels per side (cap 5 open per side)
  //   Total per side: ~$6,723 (0.02 + 0.016 + 0.0128 + 0.01024 + 0.008192 BTC at $100k)
  levels: 5,
  baseSpreadBps: 50,         // 0.5% spread — wide for safety in UAT
  levelSpacingTicks: 2,      // Fallback spacing when randomized bps ladder is disabled
  randomLevelSpacingBpsMin: 0.8, // ~0.8 bps min step between ladder levels
  randomLevelSpacingBpsMax: 1.2, // ~1.2 bps max step between ladder levels
  repriceThresholdTicks: 3,  // Reprice only after > $1.00 move (3 × $0.50 = $1.50)
  baseSizeBTC: 0.02,         // ~$2,000 at $100k BTC
  sizeDecayFactor: 0.8,      // Each level 80% of previous
  sizeDecimalPlaces: 4,      // TrueX BTC increment: 0.0001
  maxOrdersPerSecond: 4,     // Conservative: prevents burst edge effects hitting TrueX 10/sec
  minRepriceIntervalMs: 5000, // 5s minimum between reprices — let cancels complete before repricing
  tickSize: 0.50,            // TrueX minimum increment
  minNotional: 1.0,          // TrueX minimum
  priceBandPct: 2.5,         // TrueX ±2.5% band

  // Inventory Manager — tight limits for $10k capital
  maxPositionBTC: 0.10,      // ~$10k max exposure
  targetInventoryBTC: parseNumber('TARGET_INVENTORY_BTC', 0),
  hedgeThresholdBTC: 0.05,   // Hedge at ~$5k
  maxSkewTicks: 3,           // Max 3 ticks ($1.50) skew
  skewExponent: 1.5,
  emergencyLimitBTC: 0.12,   // Emergency at $12k

  // PnL Tracker — fees configurable via env (currently 0/0 per agreement)
  truexMakerFeeBps: parseFee('TRUEX_MAKER_FEE_BPS', 0),
  truexTakerFeeBps: parseFee('TRUEX_TAKER_FEE_BPS', 0),
  hedgeMakerFeeBps: parseFee('HEDGE_MAKER_FEE_BPS', 0),
  hedgeTakerFeeBps: parseFee('HEDGE_TAKER_FEE_BPS', 0),
  pnlLogIntervalMs: 30000,   // Log PnL every 30s

  // Data Pipeline
  redisUrl: process.env.REDIS_URL || null,
  pgUrl: process.env.DATABASE_URL || null,
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logLevel = process.env.LOG_LEVEL || 'info';
const isDebug = logLevel === 'debug';

const logger = {
  info: (msg, meta) => console.log('[INFO]  %s', msg, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn('[WARN]  %s', msg, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error('[ERROR] %s', msg, meta ? JSON.stringify(meta) : ''),
  debug: (msg, meta) => { if (isDebug) console.log('[DEBUG] %s', msg, meta ? JSON.stringify(meta) : ''); },
};

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

function validateEnv() {
  const required = ['TRUEX_API_KEY', 'TRUEX_SECRET_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    logger.info('Set TRUEX_API_KEY and TRUEX_SECRET_KEY before running.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let orchestrator = null;
let coinbaseIngest = null;
let priceAggregator = null;
let dataPipeline = null;
let isShuttingDown = false;

async function main() {
  validateEnv();

  logger.info('=== TrueX UAT Paper Trading ===');
  logger.info(`Session:       ${config.sessionId}`);
  logger.info(`Symbol:        ${config.symbol}`);
  logger.info(`FIX Host:      ${config.truexHost}:${config.truexPort}`);
  logger.info(`SenderCompID:  ${config.senderCompID}`);
  logger.info(`TargetCompID:  ${config.targetCompID}`);
  logger.info(`Client ID:     ${config.clientId}`);
  logger.info(`Levels:        ${config.levels} per side`);
  logger.info(`Base size:     ${config.baseSizeBTC} BTC (~$${(config.baseSizeBTC * 100000).toFixed(0)} at $100k)`);
  logger.info(`Max position:  ${config.maxPositionBTC} BTC`);
  logger.info(`Target inventory: ${config.targetInventoryBTC} BTC`);
  logger.info(`Maker fee:     ${config.truexMakerFeeBps} bps (zero per agreement)`);
  logger.info(`Redis:         ${config.redisUrl ? 'configured' : 'none (memory only)'}`);
  logger.info(`PostgreSQL:    ${config.pgUrl ? 'configured' : 'none'}`);
  logger.info('');

  // 0. Cancel orphaned orders from previous sessions via REST API
  logger.info('[0/5] Cancelling orphaned orders via REST API...');
  const restUrl = process.env.TRUEX_REST_URL || 'http://38.32.101.229:9742';
  try {
    const { TrueXRESTClient } = await import('../src/exchanges/truex/TrueXRESTClient.ts');
    const restClient = new TrueXRESTClient({
      baseURL: `${restUrl}/api/v1`,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      userId: config.clientId,
    });

    const active = await restClient.getActiveOrders();
    if (active.length > 0) {
      logger.info(`Found ${active.length} orphaned orders — cancelling...`);
      const result = await restClient.cancelAllOrders();
      logger.info(`Cancelled: ${result.canceled.length}, Failed: ${result.failed.length}`);
      if (result.failed.length > 0) {
        logger.warn(`Cancel failures: ${result.failed.map(f => f.error).join(', ')}`);
      }
    } else {
      logger.info('No orphaned orders found');
    }
  } catch (err) {
    logger.warn(`REST cancel failed (non-fatal): ${err.message}`);
  }
  logger.info('');

  // 1. Data Pipeline (Memory → Redis → PostgreSQL)
  logger.info('[1/4] Setting up data pipeline...');
  dataPipeline = new DataPipelineManager({
    sessionId: config.sessionId,
    symbol: config.symbol,
    redisUrl: config.redisUrl,
    pgUrl: config.pgUrl,
    logger,
  });

  // 2. Price Aggregator (Coinbase only for UAT)
  logger.info('[2/4] Setting up Coinbase price feed...');
  priceAggregator = new PriceAggregator({
    symbol: config.symbol,
    stalenessThresholdMs: 10000,  // 10s stale threshold
    updateIntervalMs: 200,
    weights: { coinbase: 1.0 },   // Single source
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
          // Coinbase level2 snapshots do not carry an exchange timestamp.
          timestamp: null,
        });
      }
    },
    onL2Update: (symbol, deltas) => {
      // L2 updates don't directly map to ticker — rely on ticker channel
    },
    logger,
  });

  // 3. Start Coinbase feed first (need prices before FIX connect)
  logger.info('[3/4] Connecting to Coinbase WebSocket...');
  await coinbaseIngest.start();
  priceAggregator.start();

  // Wait for first price
  logger.info('Waiting for Coinbase price data...');
  const firstPrice = await waitForFirstPrice(priceAggregator, 30000);
  if (!firstPrice) {
    logger.error('Timed out waiting for Coinbase price data');
    await shutdown('NO_PRICE');
    return;
  }
  logger.info(`First price received: mid=$${firstPrice.weightedMidpoint.toFixed(2)} confidence=${firstPrice.confidence.toFixed(2)}`);

  // 4. Create and start orchestrator
  logger.info('[4/4] Starting MarketMakerOrchestrator...');
  orchestrator = new MarketMakerOrchestrator({
    // Session
    sessionId: config.sessionId,
    symbol: config.symbol,
    logger,

    // FIX connection (orchestrator creates FIXConnection internally)
    truexHost: config.truexHost,
    truexPort: config.truexPort,
    senderCompID: config.senderCompID,
    targetCompID: config.targetCompID,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    heartbeatInterval: config.heartbeatInterval,

    // Price feed
    priceAggregator,

    // Quote engine config
    levels: config.levels,
    baseSpreadBps: config.baseSpreadBps,
    levelSpacingTicks: config.levelSpacingTicks,
    randomLevelSpacingBpsMin: config.randomLevelSpacingBpsMin,
    randomLevelSpacingBpsMax: config.randomLevelSpacingBpsMax,
    repriceThresholdTicks: config.repriceThresholdTicks,
    baseSizeBTC: config.baseSizeBTC,
    sizeDecayFactor: config.sizeDecayFactor,
    sizeDecimalPlaces: config.sizeDecimalPlaces,
    maxOrdersPerSecond: config.maxOrdersPerSecond,
    minRepriceIntervalMs: config.minRepriceIntervalMs,
    tickSize: config.tickSize,
    minNotional: config.minNotional,
    priceBandPct: config.priceBandPct,

    // TrueX client ID (Party ID tag 448)
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

    // REST reconciliation (every 5 min)
    restUrl,

    // No hedging in UAT (no Kraken client)
    krakenClient: null,
  });

  // Wire orchestrator events for console monitoring
  wireOrchestratorEvents(orchestrator);

  // Start the orchestrator (connects FIX, starts quoting)
  await orchestrator.start();

  logger.info('');
  logger.info('=== UAT Paper Trading LIVE ===');
  logger.info('Quoting will begin on next price update from Coinbase.');
  logger.info('Press Ctrl+C to stop gracefully.');
  logger.info('');

  // Periodic status report
  const statusInterval = setInterval(() => {
    if (!orchestrator || !orchestrator.isRunning) return;
    const status = orchestrator.getStatus();
    const inv = status.inventory;
    const pnl = status.pnl;
    const quotes = status.quotes;
    logger.info(
      `[STATUS] pos=${inv.netPosition?.toFixed(4) || '0'} BTC | ` +
      `pnl=$${pnl.totalPnL?.toFixed(2) || '0'} | ` +
      `quotes=${quotes.activeOrderCount || 0} | ` +
      `uptime=${((status.uptimeMs || 0) / 1000 / 60).toFixed(1)}min`
    );
  }, 60000); // Every minute

  // Clean up status interval on shutdown
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

    // Check if we already have a price
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
  });

  orch.on('error', (err) => {
    logger.error(`[ERROR] ${err.message || err}`);
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`\n[SHUTDOWN] Received ${signal} — stopping gracefully...`);

  // 1. Stop orchestrator (cancels quotes, flushes pipeline, disconnects FIX)
  if (orchestrator) {
    try {
      await orchestrator.stop();
    } catch (err) {
      logger.error(`[SHUTDOWN] Orchestrator stop error: ${err.message}`);
    }
  }

  // 2. Stop price feed
  if (priceAggregator) {
    priceAggregator.stop();
  }
  if (coinbaseIngest) {
    coinbaseIngest.stop();
  }

  logger.info('[SHUTDOWN] Complete. Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack);
  shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  shutdown('UNHANDLED_REJECTION');
});

// Run
main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
