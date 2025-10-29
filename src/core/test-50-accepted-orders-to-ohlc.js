#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { FIXConnection } from './fix-protocol/fix-connection.js';
import { TrueXOhlcBuilder } from './data-pipeline/ohlc-builder.js';
import RedisClient from '../../../lib/utils/redis-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const symbol = 'BTC-PYUSD';
const numOrders = 50;
const testId = Date.now();
const senderCompID = `LADDER_${testId}`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║    TrueX: Place 50 Accepted Orders → Build OHLC from Accepts   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  const fix = new FIXConnection({
    host: process.env.TRUEX_FIX_HOST,
    port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
    senderCompID,
    targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_SECRET_KEY,
    heartbeatInterval: 30,
    logger: console
  });

  const ohlc = new TrueXOhlcBuilder({ symbol, logger: console });
  const redis = new RedisClient();

  const clientId = process.env.TRUEX_CLIENT_ID;
  if (!clientId) {
    console.error('❌ TRUEX_CLIENT_ID missing');
    process.exit(1);
  }

  let acceptedCount = 0;
  const acceptedPrices = [];

  // Normalize to BTC-PYUSD tick size (0.5 USD)
  function normalizeToHalfDollar(p) {
    return Math.round(p * 2) / 2;
  }

  fix.on('message', (m) => {
    if (m.fields['35'] === '8') {
      const ordStatus = m.fields['39'];
      const price = parseFloat(m.fields['44'] || '0');
      if (ordStatus === '0') { // New (accepted)
        acceptedCount += 1;
        acceptedPrices.push(price);
        ohlc.updateWithTrade({ timestamp: Date.now(), price, volume: 1, symbol });
        console.log(`✅ Accepted ${acceptedCount}/${numOrders} @ ${price}`);
      } else if (ordStatus === '8') {
        console.log(`❌ Rejected: ${m.fields['58'] || ''}`);
      }
    }
  });

  console.log('🔗 Connecting...');
  await fix.connect();
  console.log('✅ Logged on');

  // Build a near-market synthetic ladder around a reference price
  // Without counterparty fills expected, we only need accepts. Use tight band.
  const refPrice = 121750; // Static ref; keep prices within bands
  const half = Math.floor(numOrders / 2);
  const increments = 0.5; // Respect TrueX tick size for BTC-PYUSD

  for (let i = -half; i < numOrders - half; i++) {
    const price = normalizeToHalfDollar(refPrice + i * increments).toFixed(1);
    const clOrdID = `LAD-${testId}-${i + half}`.slice(0, 18);
    const order = {
      '35': 'D',
      '11': clOrdID,
      '55': symbol,
      '54': i % 2 === 0 ? '1' : '2', // alternate buy/sell
      '38': '0.01',
      '40': '2',
      '44': price,
      '59': '1',
      // Party ID
      '453': '1',
      '448': clientId,
      '452': '3'
    };
    await fix.sendMessage(order);
    await sleep(100); // small pacing
  }

  const waitMs = parseInt(process.env.WAIT_MS || '20000');
  console.log(`⏳ Waiting ${Math.round(waitMs/1000)}s for execution reports...`);
  await sleep(waitMs);

  // Summarize OHLC
  const candles = Array.from(ohlc.candles.values());
  console.log(`\n📊 Summary`);
  console.log(`Accepted: ${acceptedCount}/${numOrders}`);
  console.log(`Candles built: ${candles.length}`);
  for (const c of candles) {
    console.log(`  ${c.interval} @ ${new Date(c.timestamp).toISOString()} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }

  // Flush accepted candles to Redis hash for session
  const sessionId = `ladder-${testId}`;
  const key = `session:${sessionId}:ohlc:1m`;
  for (const c of candles) {
    const field = `${symbol}:${c.timestamp}`;
    await redis.hset(key, field, JSON.stringify(c));
  }
  console.log(`✅ OHLC flushed to Redis: ${key}`);

  await fix.disconnect();
  await redis.quit();
  console.log('✅ Done');
}

main().catch(err => { console.error(err); process.exit(1); });
