#!/usr/bin/env bun
/**
 * Send a single test order to TrueX UAT to diagnose "Open order limit exceeded"
 */

import { FIXConnection } from '../src/fix-protocol/fix-connection.js';

const logger = {
  info: (msg, meta) => console.log(`[INFO]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[WARN]  ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
  debug: () => {},
};

async function main() {
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

  const clientId = process.env.TRUEX_CLIENT_ID || '78972918929686546';

  // Log ALL inbound messages
  fix.on('message', (msg) => {
    const fields = msg?.fields;
    if (!fields) return;
    console.log(`\n>>> INBOUND msgType=${fields['35']} ordStatus=${fields['39'] || 'N/A'} clOrdID=${fields['11'] || 'N/A'} text=${fields['58'] || 'none'}`);
    console.log('    Full fields:', JSON.stringify(fields));
  });

  await fix.connect();
  logger.info('FIX connected — sending 1 test buy order...');

  // Send a single buy order at a price far from market (won't fill)
  const clOrdID = `TEST-${Date.now()}`;
  fix.sendMessage({
    '35': 'D',              // NewOrderSingle
    '11': clOrdID,
    '18': '6',              // ExecInst: ALO
    '55': 'BTC-PYUSD',
    '54': '1',              // Buy
    '38': '0.001',          // Very small: 0.001 BTC
    '44': '50000.00',       // Way below market (~$67k) — won't fill
    '40': '2',              // Limit
    '59': '1',              // GTC
    '453': '1',
    '448': clientId,
    '452': '3',
  });

  logger.info(`Sent buy 0.001 BTC @ $50,000 (clOrdID=${clOrdID})`);
  logger.info('Waiting 10s for response...');

  await new Promise(r => setTimeout(r, 10000));

  // Try to cancel it
  logger.info('Sending cancel...');
  const cancelClOrdID = `CANCEL-${Date.now()}`;
  fix.sendMessage({
    '35': 'G',
    '11': cancelClOrdID,
    '41': clOrdID,
    '38': '0',
    '453': '1',
    '448': clientId,
    '452': '3',
  });

  logger.info('Waiting 5s for cancel response...');
  await new Promise(r => setTimeout(r, 5000));

  await fix.disconnect();
  logger.info('Done');
  process.exit(0);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
