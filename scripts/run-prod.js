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
  //   3 levels per side (tight ladder)
  //   Base size 0.01 BTC (~$1,000 at $100k)
  //   Total per side: ~0.0244 BTC (0.01 + 0.008 + 0.0064)
  levels: 3,
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

  // PnL Tracker
  truexMakerFeeBps: 0,         // Zero fees on maker
  truexTakerFeeBps: 10,        // 1bp taker
  hedgeMakerFeeBps: 0,
  hedgeTakerFeeBps: 0,
  pnlLogIntervalMs: 30000,

  // Data Pipeline
  redisUrl: process.env.REDIS_URL || null,
  pgUrl: process.env.DATABASE_URL || null,

  // REST URL for reconciliation + balance fetching
  restUrl: process.env.TRUEX_REST_URL || 'http://178.156.230.110:3006',
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logLevel = process.env.LOG_LEVEL || 'info';
const isDebug = logLevel === 'debug';

const logger = {
  info: (msg, meta) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, meta ? JSON.stringify(meta) : ''),
  debug: (msg, meta) => { if (isDebug) console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, meta ? JSON.stringify(meta) : ''); },
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

  // 3. Start Coinbase feed (need prices before FIX connect)
  logger.info('[3/5] Connecting to Coinbase WebSocket...');
  await coinbaseIngest.start();
  priceAggregator.start();

  logger.info('Waiting for Coinbase price data...');
  const firstPrice = await waitForFirstPrice(priceAggregator, 30000);
  if (!firstPrice) {
    logger.error('Timed out waiting for Coinbase price — exiting');
    await shutdown('NO_PRICE');
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

  if (orchestrator) {
    try {
      await orchestrator.stop();
    } catch (err) {
      logger.error(`[SHUTDOWN] Orchestrator stop error: ${err.message}`);
    }
  }

  if (priceAggregator) priceAggregator.stop();
  if (coinbaseIngest) coinbaseIngest.stop();

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
