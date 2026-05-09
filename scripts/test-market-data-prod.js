/**
 * Quick test: listen to BTC-PYUSD orderbook on prod via SSH tunnel
 *
 * Prerequisites:
 *   SSH tunnel must be active (substitute current TRUEX_PROD_HOST):
 *   ssh -f -N -L 20484:${TRUEX_PROD_HOST}:20484 root@178.156.230.110
 *
 * Run: bun scripts/test-market-data-prod.js
 */

import { TrueXMarketDataFeed } from '../src/core/truex-market-data.js';

const md = new TrueXMarketDataFeed({
  host: '127.0.0.1',
  port: 20484,
  senderCompID: process.env.TRUEX_SENDER_COMP_ID || 'DAVID1',
  targetCompID: 'TRUEX_PROD_MD',
  apiKey: process.env.TRUEX_PROD_API_KEY || process.env.TRUEX_API_KEY,
  apiSecret: process.env.TRUEX_PROD_SECRET_KEY || process.env.TRUEX_SECRET_KEY,
});

// Log all raw incoming FIX messages before anything else processes them
md.fix.on('message', (msg) => {
  const raw = JSON.stringify(msg.fields);
  console.log(`RAW FIX [35=${msg.fields['35']}]: ${raw}`);
});

md.on('connected', () => console.log('Connected to prod MD feed'));
md.on('disconnected', () => console.log('Disconnected'));
md.on('error', (e) => console.error('Error:', e.message));

md.on('snapshot', (data) => {
  console.log('\n=== SNAPSHOT ===');
  console.log(JSON.stringify(data, null, 2));
});

md.on('book-change', (book) => {
  const bids = book.bids || [];
  const asks = book.asks || [];
  const topBid = bids[0];
  const topAsk = asks[0];
  const bidStr = topBid ? `${topBid.price ?? topBid[0]} x ${topBid.size ?? topBid[1]}` : 'none';
  const askStr = topAsk ? `${topAsk.price ?? topAsk[0]} x ${topAsk.size ?? topAsk[1]}` : 'none';
  console.log(`Book  Bid: ${bidStr}  |  Ask: ${askStr}`);
});

md.on('update', (data) => {
  console.log('Update:', JSON.stringify(data));
});

console.log('Connecting to 127.0.0.1:20484 (tunneled to TrueX prod via WireGuard)');
console.log(`SenderCompID: ${process.env.TRUEX_SENDER_COMP_ID || 'DAVID1'}, TargetCompID: TRUEX_PROD_MD`);
console.log('Ctrl+C to stop\n');

await md.connect();
await md.subscribe('BTC-PYUSD');
