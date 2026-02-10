#!/usr/bin/env bun
/**
 * Test FIX cancel round-trip against TrueX UAT:
 *   1. Place a limit buy far from market
 *   2. Cancel it → expect 35=8 ordStatus=4 (Cancelled)
 *   3. Cancel it again → expect 35=9 (OrderCancelReject, Unknown order)
 *
 * This validates that both cancel success and cancel rejection
 * are correctly received over FIX.
 */

import { FIXConnection } from '../src/fix-protocol/fix-connection.js';
import { QuoteEngine } from '../src/core/quote-engine.js';

const logger = {
  info: (msg, meta) => console.log(`[INFO]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[WARN]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
  debug: () => {},
};

const clientId = process.env.TRUEX_CLIENT_ID || '78972918929686546';

// Results tracking
const results = {
  orderAccepted: false,
  cancelSuccess: false,
  cancelReject: false,
  cancelRejectReason: null,
};

async function main() {
  // --- FIX connection ---
  const fix = new FIXConnection({
    host: process.env.TRUEX_FIX_HOST || '178.156.230.110',
    port: parseInt(process.env.TRUEX_FIX_PORT || '3004', 10),
    senderCompID: process.env.TRUEX_SENDER_COMP_ID || 'DAVID1',
    targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_SECRET_KEY,
    heartbeatInterval: 30,
    logger,
  });

  // --- QuoteEngine (to test its handlers) ---
  const mockInventory = {
    getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }),
    canQuote: () => true,
  };
  const engine = new QuoteEngine({
    inventoryManager: mockInventory,
    fixConnection: fix,
    logger,
    levels: 1,
    baseSpreadBps: 50,
    levelSpacingTicks: 1,
    repriceThresholdTicks: 1,
    baseSizeBTC: 0.001,
    sizeDecayFactor: 1,
    maxOrdersPerSecond: 4,
    tickSize: 0.5,
    minNotional: 1,
    clientId,
  });

  // --- Listen for ALL inbound FIX messages ---
  fix.on('message', (msg) => {
    const fields = msg?.fields;
    if (!fields) return;
    const msgType = fields['35'];
    const ordStatus = fields['39'];
    const clOrdID = fields['11'];
    const text = fields['58'] || '';

    // Skip heartbeats/logon
    if (msgType === '0' || msgType === 'A') return;

    console.log(`\n>>> INBOUND  msgType=${msgType}  ordStatus=${ordStatus || 'N/A'}  clOrdID=${clOrdID}  text=${text}`);

    if (msgType === '8') {
      // Route execution reports to QuoteEngine
      engine.onExecutionReport(fields);

      if (ordStatus === '0') {
        results.orderAccepted = true;
        logger.info('✓ Order ACCEPTED');
      } else if (ordStatus === '4') {
        results.cancelSuccess = true;
        logger.info('✓ Cancel SUCCESS — order cancelled');
      } else if (ordStatus === '8') {
        logger.warn(`✗ Order REJECTED: ${text}`);
      }
    } else if (msgType === '9') {
      // Route cancel rejects to QuoteEngine
      engine.onOrderCancelReject(fields);

      results.cancelReject = true;
      results.cancelRejectReason = text || `CxlRejReason=${fields['102']}`;
      logger.info(`✓ Cancel REJECTED (35=9) — reason: ${results.cancelRejectReason}`);
    }
  });

  // --- Connect ---
  await fix.connect();
  logger.info('FIX connected\n');

  // === STEP 1: Place a limit buy far below market ===
  const orderClOrdID = `T${Date.now().toString(36)}001`;
  logger.info(`STEP 1: Placing buy 0.001 BTC @ $50,000 (clOrdID=${orderClOrdID})`);

  // Pre-register in QuoteEngine's activeOrders (like it would during normal operation)
  engine.activeOrders.set(orderClOrdID, {
    side: 'buy', price: 50000, size: 0.001, level: 1, status: 'pending', placedAt: Date.now(),
  });

  fix.sendMessage({
    '35': 'D',
    '11': orderClOrdID,
    '55': 'BTC-PYUSD',
    '54': '1',          // Buy
    '38': '0.001',
    '44': '50000.00',   // Far below market
    '40': '2',          // Limit
    '59': '1',          // GTC
    '453': '1',
    '448': clientId,
    '452': '3',
  });

  // Wait for acceptance
  await waitFor(() => results.orderAccepted, 10000, 'Order acceptance');

  // Check QuoteEngine state
  const orderAfterAccept = engine.activeOrders.get(orderClOrdID);
  logger.info(`  QuoteEngine state: status=${orderAfterAccept?.status}, activeOrders=${engine.activeOrders.size}`);

  // === STEP 2: Cancel the order ===
  const cancelClOrdID = `T${Date.now().toString(36)}002`;
  logger.info(`\nSTEP 2: Cancelling order (cancelClOrdID=${cancelClOrdID}, origClOrdID=${orderClOrdID})`);

  // Use QuoteEngine's internal cancel (which tracks cancelToOrigMap)
  engine.cancelToOrigMap.set(cancelClOrdID, orderClOrdID);
  if (orderAfterAccept) orderAfterAccept.status = 'cancelling';

  // Try multiple cancel approaches to find what TrueX accepts
  const cancelApproaches = [
    { name: '35=F (OrderCancelRequest)', fields: { '35': 'F', '11': cancelClOrdID, '41': orderClOrdID, '453': '1', '448': clientId, '452': '3' } },
    { name: '35=F with Side', fields: { '35': 'F', '11': `${cancelClOrdID}b`, '41': orderClOrdID, '54': '1', '453': '1', '448': clientId, '452': '3' } },
    { name: '35=G qty=0', fields: { '35': 'G', '11': `${cancelClOrdID}c`, '41': orderClOrdID, '38': '0', '453': '1', '448': clientId, '452': '3' } },
    { name: '35=G qty=0.001 price=0', fields: { '35': 'G', '11': `${cancelClOrdID}d`, '41': orderClOrdID, '38': '0.001', '44': '0', '453': '1', '448': clientId, '452': '3' } },
  ];

  for (const approach of cancelApproaches) {
    logger.info(`  Trying: ${approach.name}`);
    // Track each cancel ClOrdID
    engine.cancelToOrigMap.set(approach.fields['11'], orderClOrdID);
    fix.sendMessage(approach.fields);
    await new Promise(r => setTimeout(r, 2000));

    if (results.cancelSuccess) {
      logger.info(`  → WORKS: ${approach.name}`);
      break;
    }
  }

  if (!results.cancelSuccess) {
    logger.error('  All cancel approaches failed');
  }

  logger.info(`  QuoteEngine state: activeOrders=${engine.activeOrders.size}, cancelToOrigMap=${engine.cancelToOrigMap.size}`);

  // === STEP 3: Cancel again (order already gone) — should get 35=9 ===
  const cancelClOrdID2 = `T${Date.now().toString(36)}003`;
  logger.info(`\nSTEP 3: Re-cancelling same order (should get 35=9 reject)`);
  logger.info(`  cancelClOrdID=${cancelClOrdID2}, origClOrdID=${orderClOrdID}`);

  // Reset cancelReject flag for step 3
  results.cancelReject = false;

  // Pre-track in cancelToOrigMap to test cleanup
  engine.cancelToOrigMap.set(cancelClOrdID2, orderClOrdID);

  fix.sendMessage({
    '35': 'F',
    '11': cancelClOrdID2,
    '41': orderClOrdID,
    '453': '1',
    '448': clientId,
    '452': '3',
  });

  await waitFor(() => results.cancelReject, 10000, 'Cancel reject (35=9)');

  logger.info(`  QuoteEngine state: activeOrders=${engine.activeOrders.size}, cancelToOrigMap=${engine.cancelToOrigMap.size}`);

  // === RESULTS ===
  console.log('\n' + '='.repeat(60));
  console.log('TEST RESULTS:');
  console.log('='.repeat(60));
  console.log(`  1. Order accepted:        ${results.orderAccepted ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  2. Cancel success (35=8):  ${results.cancelSuccess ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  3. Cancel reject (35=9):   ${results.cancelReject ? 'PASS ✓' : 'FAIL ✗'}`);
  if (results.cancelRejectReason) {
    console.log(`     Reason: ${results.cancelRejectReason}`);
  }

  const engineClean = engine.activeOrders.size === 0 && engine.cancelToOrigMap.size === 0;
  console.log(`  4. QuoteEngine cleanup:    ${engineClean ? 'PASS ✓' : 'FAIL ✗'} (activeOrders=${engine.activeOrders.size}, cancelMap=${engine.cancelToOrigMap.size})`);

  const allPass = results.orderAccepted && results.cancelSuccess && results.cancelReject && engineClean;
  console.log(`\n  OVERALL: ${allPass ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}`);
  console.log('='.repeat(60));

  await fix.disconnect();
  process.exit(allPass ? 0 : 1);
}

async function waitFor(condition, timeoutMs, label) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      logger.error(`Timed out waiting for: ${label}`);
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
