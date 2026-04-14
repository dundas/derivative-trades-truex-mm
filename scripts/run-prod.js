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
 *
 * Usage:
 *   bun scripts/run-prod.js
 */

import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';
import { DataPipelineManager } from '../src/data-pipeline/data-pipeline-manager.js';
import { PriceAggregator } from '../src/connectors/aggregator/PriceAggregator.ts';
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
  baseSpreadBps: 80,           // 0.8% spread — wider for safety in production
  levelSpacingTicks: 2,
  randomLevelSpacingBpsMin: 0.8,
  randomLevelSpacingBpsMax: 1.2,
  repriceThresholdTicks: 3,    // Reprice after > $1.50 move
  baseSizeBTC: 0.01,           // ~$1,000 at $100k BTC
  sizeDecayFactor: 0.8,        // Each level 80% of previous
  sizeDecimalPlaces: 4,        // TrueX BTC increment: 0.0001
  maxOrdersPerSecond: 4,
  minRepriceIntervalMs: 5000,  // 5s minimum between reprices
  tickSize: 0.50,              // TrueX minimum increment
  minNotional: 1.0,            // TrueX minimum
  priceBandPct: 2.5,           // TrueX ±2.5% band

  // Inventory Manager — tight for ~0.044 BTC capital
  maxPositionBTC: 0.05,        // Slightly above starting balance
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

  // REST URL for reconciliation + balance fetching
  restUrl: process.env.TRUEX_REST_URL || 'http://178.156.230.110:3006',
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
  logger.info(`Emergency:     ${config.emergencyLimitBTC} BTC`);
  logger.info(`Redis:         ${config.redisUrl ? 'configured' : 'none'}`);
  logger.info(`PostgreSQL:    ${config.pgUrl ? 'configured' : 'none'}`);
  logger.info('');

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
          timestamp: Date.now(),
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

    // TrueX client ID
    clientId: config.clientId,

    // Inventory manager
    maxPositionBTC: config.maxPositionBTC,
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

    // REST reconciliation + balance refresh
    restUrl: config.restUrl,

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
    logger.info(
      `[STATUS] pos=${inv.netPosition?.toFixed(4) || '0'} BTC | ` +
      `side=${inv.side || 'flat'} | ` +
      `pnl=$${pnl.totalPnL?.toFixed(2) || '0'} | ` +
      `quotes=${quotes.activeOrderCount || 0} active | ` +
      `fills=${inv.fillCount || 0} | ` +
      `base=${inv.baseBalance?.available?.toFixed(4) || '?'} BTC avail | ` +
      `quote=${inv.quoteBalance?.available?.toFixed(2) || '?'} PYUSD avail | ` +
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
