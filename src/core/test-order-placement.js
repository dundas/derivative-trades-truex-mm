#!/usr/bin/env node
/**
 * Test Order Placement with TrueX
 * 
 * Simple test to verify orders are being accepted by TrueX
 */

import { TrueXMarketMaker } from './truex-market-maker.js';
import { RedisClient } from '../../../lib/utils/redis-client.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../../../.env') });

async function main() {
  console.log('🧪 Testing TrueX Order Placement\n');

  // Create Redis client
  const redisClient = new RedisClient();
  await new Promise(resolve => {
    if (redisClient.ioredisClient.status === 'ready') resolve();
    else redisClient.ioredisClient.once('ready', resolve);
  });

  // Configuration
  const config = {
    sessionId: `test-order-${Date.now()}`,
    symbol: 'BTC-PYUSD',
    redisClient,
    fix: {
      host: process.env.TRUEX_FIX_HOST || '129.212.145.83',
      port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),  // Connect on main port
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_SECRET_KEY,
      senderCompID: 'CLI_CLIENT',
      targetCompID: 'TRUEX_UAT_OE',  // Route to Order Entry via TargetCompID
      heartbeatInterval: 30
    },
    logger: console
  };

  console.log('📋 Configuration:', {
    sessionId: config.sessionId,
    symbol: config.symbol,
    fixHost: config.fix.host
  });

  // Create market maker
  const mm = new TrueXMarketMaker(config);

  // Listen for execution reports
  mm.fix.on('executionReport', (report) => {
    const orderId = report.fields['11'];
    const execType = report.fields['150'];
    const ordStatus = report.fields['39'];
    console.log(`\n📊 Execution Report:`);
    console.log(`   Order ID: ${orderId}`);
    console.log(`   ExecType: ${execType}`);
    console.log(`   OrdStatus: ${ordStatus}`);
    console.log(`   Raw:`, report.raw.replace(/\x01/g, '|'));
  });

  mm.fix.on('reject', ({ reason }) => {
    console.log(`\n❌ Reject: ${reason}`);
  });

  // Start market maker
  console.log('\n▶️  Starting market maker...');
  await mm.start();
  console.log('✅ Market maker started and authenticated\n');

  // Wait a moment for everything to settle
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get current market price (approximate)
  const currentPrice = 121000; // BTC-PYUSD approximate price
  const bidPrice = currentPrice - 100; // $100 below market
  const askPrice = currentPrice + 100; // $100 above market

  // Place a test buy order
  console.log('📤 Placing TEST BUY order...');
  console.log(`   Side: BUY`);
  console.log(`   Size: 0.01 BTC`);
  console.log(`   Price: $${bidPrice}`);
  
  await mm.placeOrder({
    clientOrderId: `TEST-BUY-${Date.now()}`,
    side: '1', // Buy
    type: '2', // Limit
    size: '0.01',
    price: bidPrice.toString()
  });

  console.log('✅ Order sent to TrueX\n');
  console.log('⏳ Waiting for execution report (30 seconds)...\n');

  // Wait for execution report
  await new Promise(resolve => setTimeout(resolve, 30000));

  // Cleanup
  console.log('\n🛑 Stopping market maker...');
  await mm.stop();
  await redisClient.ioredisClient.quit();
  console.log('✅ Test complete');
  process.exit(0);
}

main().catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});

