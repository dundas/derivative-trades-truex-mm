#!/usr/bin/env bun
/**
 * TrueX UAT Taker Bot
 *
 * Independently trades against any resting orders on TrueX UAT.
 * Uses DAVID2 credentials (separate from the market maker's DAVID1).
 *
 * Strategy:
 *   - Gets BTC-USD mid price from Coinbase
 *   - Every ~30s, places an aggressive limit order that crosses the spread
 *   - Alternates buy/sell to stay inventory-neutral
 *   - Cancels unfilled orders after 5s
 *   - Logs all fills
 *
 * Environment Variables:
 *   TRUEX_API_KEY        - TrueX API key (shared with DAVID1)
 *   TRUEX_SECRET_KEY     - TrueX secret (shared with DAVID1)
 *   TRUEX_FIX_HOST       - FIX host/proxy (default from env)
 *   TRUEX_FIX_PORT       - FIX port (default from env)
 *
 * Usage:
 *   bun scripts/run-uat-taker.js
 */

import { FIXConnection } from '../src/fix-protocol/fix-connection.js';
import { CoinbaseWsIngest } from '../src/data-pipeline/coinbase-ws-ingest.js';
import { DataPipelineManager } from '../src/data-pipeline/data-pipeline-manager.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
  sessionId: `taker-${Date.now()}`,
  symbol: 'BTC-PYUSD',

  // FIX — DAVID2
  truexHost: process.env.TRUEX_FIX_HOST || '38.32.101.229',
  truexPort: parseInt(process.env.TRUEX_FIX_PORT || '19484', 10),
  senderCompID: 'DAVID2',
  targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
  apiKey: process.env.TRUEX_API_KEY,
  apiSecret: process.env.TRUEX_SECRET_KEY,
  clientId: process.env.TRUEX_CLIENT_ID_2 || '78972918929686547', // DAVID2
  heartbeatInterval: 30,

  // Taker strategy
  orderSizeBTC: 0.001,          // ~$70 per order at $70k
  orderIntervalMs: 30000,       // Place an order every 30s
  cancelTimeoutMs: 5000,        // Cancel unfilled after 5s
  spreadCrossBps: 30,           // Price offset in bps to cross the spread (0.30%)
  tickSize: 0.50,               // TrueX min price increment

  // Data pipeline (optional)
  pgUrl: process.env.DATABASE_URL || null,
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = {
  info: (msg, meta) => console.log(`[INFO]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[WARN]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
  debug: () => {},
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let latestMid = 0;
let fix = null;
let coinbaseIngest = null;
let dataPipeline = null;
let orderTimer = null;
let isShuttingDown = false;
let orderSeq = 0;
let nextSide = 'buy'; // alternate buy/sell

// Track active orders for cancellation
const activeOrders = new Map(); // clOrdID → { side, price, size, placedAt }

// Fill statistics
const stats = {
  ordersPlaced: 0,
  ordersFilled: 0,
  ordersRejected: 0,
  ordersCancelled: 0,
  totalBought: 0,
  totalSold: 0,
  fills: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateClOrdID() {
  return `TK${Date.now().toString(36)}${(++orderSeq).toString(36)}`.slice(0, 18);
}

function snapToTick(price) {
  return Math.round(price / config.tickSize) * config.tickSize;
}

// ---------------------------------------------------------------------------
// Taker Strategy
// ---------------------------------------------------------------------------

function placeAggressiveOrder() {
  if (!fix || !fix.isLoggedOn || latestMid === 0 || isShuttingDown) return;

  const side = nextSide;
  nextSide = side === 'buy' ? 'sell' : 'buy'; // alternate

  // Price to cross the spread
  const offsetPct = config.spreadCrossBps / 10000;
  const rawPrice = side === 'buy'
    ? latestMid * (1 + offsetPct)   // Buy above mid → cross the ask
    : latestMid * (1 - offsetPct);  // Sell below mid → cross the bid
  const price = snapToTick(rawPrice);

  const clOrdID = generateClOrdID();
  const sizeStr = config.orderSizeBTC.toFixed(4);

  const fields = {
    '35': 'D',
    '11': clOrdID,
    '55': config.symbol,
    '54': side === 'buy' ? '1' : '2',
    '38': sizeStr,
    '44': price.toFixed(2),
    '40': '2',   // Limit
    '59': '1',   // GTC
    // NO tag 18 — allows crossing the spread (maker uses 18='6')
    '453': '1',
    '448': config.clientId,
    '452': '3',
  };

  fix.sendMessage(fields);
  activeOrders.set(clOrdID, { side, price, size: config.orderSizeBTC, placedAt: Date.now() });
  stats.ordersPlaced++;

  logger.info(`[TAKER] ${side.toUpperCase()} ${sizeStr} BTC @ $${price.toFixed(2)} (mid=$${latestMid.toFixed(2)}) clOrdID=${clOrdID}`);

  // Schedule cancel if not filled
  setTimeout(() => cancelIfActive(clOrdID), config.cancelTimeoutMs);
}

function cancelIfActive(clOrdID) {
  if (!activeOrders.has(clOrdID)) return; // already filled or cancelled
  if (!fix || !fix.isLoggedOn) return;

  const newClOrdID = generateClOrdID();
  const fields = {
    '35': 'F',   // OrderCancelRequest
    '11': newClOrdID,
    '41': clOrdID, // OrigClOrdID
    '453': '1',
    '448': config.clientId,
    '452': '3',
  };

  fix.sendMessage(fields);
  logger.info(`[TAKER] Cancel sent for ${clOrdID}`);
}

// ---------------------------------------------------------------------------
// FIX Message Handler
// ---------------------------------------------------------------------------

function onFIXMessage(message) {
  if (!message || !message.fields) return;
  const f = message.fields;
  const msgType = f['35'];

  // Log to data pipeline
  if (dataPipeline) {
    dataPipeline.logFIXMessage(message, {
      direction: 'INBOUND',
      msgType,
      sessionId: config.sessionId,
    });
  }

  if (msgType === '8') {
    onExecutionReport(f);
  } else if (msgType === '9') {
    onCancelReject(f);
  }
}

function onExecutionReport(f) {
  const clOrdID = f['11'];
  const ordStatus = f['39'];
  const execID = f['17'];
  const lastPx = f['31'] ? parseFloat(f['31']) : null;
  const lastQty = f['32'] ? parseFloat(f['32']) : null;
  const rejectReason = f['58'] || '';

  switch (ordStatus) {
    case 'A': // PendingNew
      break;

    case '0': // New (resting on book — means it didn't immediately cross)
      logger.info(`[TAKER] Order resting: ${clOrdID} (no immediate fill)`);
      break;

    case '1': // Partial fill
    case '2': { // Filled
      const order = activeOrders.get(clOrdID);
      const side = order?.side || (f['54'] === '1' ? 'buy' : 'sell');

      logger.info(`[FILL]  ${side.toUpperCase()} ${lastQty} BTC @ $${lastPx?.toFixed(2)} execID=${execID} clOrdID=${clOrdID}`);

      if (side === 'buy') stats.totalBought += lastQty;
      else stats.totalSold += lastQty;
      stats.ordersFilled++;

      stats.fills.push({ side, price: lastPx, qty: lastQty, execID, clOrdID, timestamp: Date.now() });

      // Route to data pipeline
      if (dataPipeline && execID && lastQty > 0) {
        dataPipeline.addFill({
          fillId: `${clOrdID}-${execID}`,
          execID,
          orderId: clOrdID,
          sessionId: config.sessionId,
          symbol: config.symbol,
          side,
          quantity: lastQty,
          price: lastPx,
          timestamp: Date.now(),
        });
      }

      if (ordStatus === '2') activeOrders.delete(clOrdID); // fully filled
      break;
    }

    case '4': // Cancelled
      activeOrders.delete(clOrdID);
      stats.ordersCancelled++;
      break;

    case '8': // Rejected
      activeOrders.delete(clOrdID);
      stats.ordersRejected++;
      logger.warn(`[TAKER] Rejected: ${clOrdID} — ${rejectReason}`);
      break;
  }
}

function onCancelReject(f) {
  const origClOrdID = f['41'];
  const reason = f['58'] || 'unknown';
  logger.warn(`[TAKER] Cancel reject for ${origClOrdID}: ${reason}`);

  // If "Unknown order", it's already gone
  if (f['102'] === '1') {
    activeOrders.delete(origClOrdID);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.TRUEX_API_KEY || !process.env.TRUEX_SECRET_KEY) {
    logger.error('Missing TRUEX_API_KEY or TRUEX_SECRET_KEY');
    process.exit(1);
  }

  logger.info('=== TrueX UAT Taker Bot ===');
  logger.info(`Session:    ${config.sessionId}`);
  logger.info(`Client ID:  ${config.clientId} (DAVID2)`);
  logger.info(`Order size: ${config.orderSizeBTC} BTC`);
  logger.info(`Interval:   ${config.orderIntervalMs / 1000}s`);
  logger.info(`Spread:     ${config.spreadCrossBps} bps cross offset`);
  logger.info('');

  // 1. Data pipeline (optional)
  dataPipeline = new DataPipelineManager({
    sessionId: config.sessionId,
    symbol: config.symbol,
    pgUrl: config.pgUrl,
    logger,
  });

  // 2. Coinbase price feed
  logger.info('[1/3] Connecting to Coinbase...');
  coinbaseIngest = new CoinbaseWsIngest({
    symbols: [config.symbol],
    onTicker: (_symbol, ticker) => {
      latestMid = (ticker.bid + ticker.ask) / 2;
    },
    onSnapshot: (_symbol, { bids, asks }) => {
      if (bids.length > 0 && asks.length > 0) {
        latestMid = (bids[0][0] + asks[0][0]) / 2;
      }
    },
    onL2Update: () => {},
    logger,
  });
  await coinbaseIngest.start();

  // Wait for first price
  logger.info('Waiting for price...');
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (latestMid > 0) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 15000);
  });

  if (latestMid === 0) {
    logger.error('No price data — aborting');
    process.exit(1);
  }
  logger.info(`Price received: mid=$${latestMid.toFixed(2)}`);

  // 3. FIX connection (DAVID2)
  logger.info('[2/3] Connecting FIX (DAVID2)...');
  fix = new FIXConnection({
    host: config.truexHost,
    port: config.truexPort,
    senderCompID: config.senderCompID,
    targetCompID: config.targetCompID,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    heartbeatInterval: config.heartbeatInterval,
    logger,
  });

  fix.on('message', onFIXMessage);
  await fix.connect();
  logger.info('FIX connected');

  // 4. Start data pipeline
  logger.info('[3/3] Starting data pipeline...');
  await dataPipeline.start();

  // 5. Start taker strategy
  logger.info('');
  logger.info('=== Taker Bot LIVE ===');
  logger.info('Placing aggressive orders to cross the spread...');
  logger.info('Press Ctrl+C to stop.');
  logger.info('');

  // First order after 10s (give market maker time to quote)
  setTimeout(() => {
    placeAggressiveOrder();
    orderTimer = setInterval(placeAggressiveOrder, config.orderIntervalMs);
  }, 10000);

  // Status report every 60s
  setInterval(() => {
    if (isShuttingDown) return;
    logger.info(
      `[STATUS] placed=${stats.ordersPlaced} filled=${stats.ordersFilled} rejected=${stats.ordersRejected} ` +
      `cancelled=${stats.ordersCancelled} | bought=${stats.totalBought.toFixed(4)} sold=${stats.totalSold.toFixed(4)} ` +
      `net=${(stats.totalBought - stats.totalSold).toFixed(4)} BTC`
    );
  }, 60000);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`\n[SHUTDOWN] ${signal} — stopping taker...`);

  if (orderTimer) clearInterval(orderTimer);

  // Cancel any active orders
  for (const [clOrdID] of activeOrders) {
    cancelIfActive(clOrdID);
  }

  // Wait for cancels to process
  await new Promise(r => setTimeout(r, 2000));

  // Stop data pipeline
  if (dataPipeline) {
    try { await dataPipeline.stop(); } catch {}
  }

  // Disconnect FIX
  if (fix) {
    try { await fix.disconnect(); } catch {}
  }

  if (coinbaseIngest) coinbaseIngest.stop();

  // Print final stats
  logger.info('');
  logger.info('=== Taker Final Stats ===');
  logger.info(`Orders placed:    ${stats.ordersPlaced}`);
  logger.info(`Orders filled:    ${stats.ordersFilled}`);
  logger.info(`Orders rejected:  ${stats.ordersRejected}`);
  logger.info(`Orders cancelled: ${stats.ordersCancelled}`);
  logger.info(`Total bought:     ${stats.totalBought.toFixed(4)} BTC`);
  logger.info(`Total sold:       ${stats.totalSold.toFixed(4)} BTC`);
  logger.info(`Net position:     ${(stats.totalBought - stats.totalSold).toFixed(4)} BTC`);
  if (stats.fills.length > 0) {
    logger.info('');
    logger.info('=== Fill Log ===');
    for (const f of stats.fills) {
      logger.info(`  ${f.side.toUpperCase()} ${f.qty} @ $${f.price?.toFixed(2)} execID=${f.execID}`);
    }
  }
  logger.info('');
  logger.info('[SHUTDOWN] Taker stopped.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught: ${err.message}`);
  shutdown('UNCAUGHT');
});

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
