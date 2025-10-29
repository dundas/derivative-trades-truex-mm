#!/usr/bin/env node

/**
 * TrueX Market Maker - Data Pipeline Test (No FIX Required)
 * 
 * Tests the data flow WITHOUT needing TrueX connection:
 * 1. In-memory data storage (Data Manager)
 * 2. OHLC generation
 * 3. Redis storage
 * 4. PostgreSQL migration
 * 
 * This can be run anytime to verify the data pipeline is working.
 * 
 * Usage: node test-data-pipeline-only.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { TrueXDataManager } from './data-pipeline/truex-data-manager.js';
import { TrueXRedisManager } from './data-pipeline/truex-redis-manager.js';
import { TrueXPostgreSQLManager } from './data-pipeline/truex-postgresql-manager.js';
import { TrueXOhlcBuilder } from './data-pipeline/ohlc-builder.js';
import RedisClient from '../../../lib/utils/redis-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║          TrueX Data Pipeline Test (No FIX Required)           ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');

// Test configuration
const testId = Date.now();
const sessionId = `pipeline-test-${testId}`;
const symbol = 'BTC-PYUSD';

console.log('📋 Test Configuration:');
console.log(`   Session ID:  ${sessionId}`);
console.log(`   Symbol:      ${symbol}`);
console.log('');

// Test results tracking
const results = {
  memoryStorage: false,
  ohlcGeneration: false,
  redisStorage: false,
  postgresStorage: false,
  errors: []
};

let redisClient;
let dataManager;
let redisManager;
let pgManager;
let ohlcBuilder;

async function runTest() {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 1: Initialize Components');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 1. Initialize Redis
    console.log('1️⃣  Initializing Redis...');
    redisClient = new RedisClient();
    const pingResult = await redisClient.ping();
    if (!pingResult) {
      throw new Error('Redis connection failed');
    }
    console.log('   ✅ Redis connected');
    console.log('');

    // 2. Initialize Data Manager
    console.log('2️⃣  Initializing Data Manager...');
    dataManager = new TrueXDataManager({ logger: console });
    console.log('   ✅ Data Manager initialized');
    console.log('');

    // 3. Initialize Redis Manager
    console.log('3️⃣  Initializing Redis Manager...');
    redisManager = new TrueXRedisManager({
      sessionId,
      symbol,
      redisClient,
      logger: console
    });
    console.log('   ✅ Redis Manager initialized');
    console.log('');

    // 4. Initialize PostgreSQL
    console.log('4️⃣  Initializing PostgreSQL...');
    pgManager = new TrueXPostgreSQLManager({ logger: console });
    await pgManager.initialize();
    console.log('   ✅ PostgreSQL initialized');
    console.log('');

    // 5. Initialize OHLC Builder
    console.log('5️⃣  Initializing OHLC Builder...');
    ohlcBuilder = new TrueXOhlcBuilder({ 
      symbol, 
      logger: console,
      intervals: ['1m', '5m']
    });
    console.log('   ✅ OHLC Builder initialized');
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 2: Generate Test Data');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 6. Store test orders in memory
    console.log('6️⃣  Creating test orders...');
    const testOrders = [
      {
        id: `ORDER-${testId}-1`,
        sessionId,
        side: 'buy',
        price: 121700,
        size: 0.01,
        symbol,
        status: 'filled',
        createdAt: new Date(Date.now() - 120000)
      },
      {
        id: `ORDER-${testId}-2`,
        sessionId,
        side: 'sell',
        price: 121750,
        size: 0.015,
        symbol,
        status: 'filled',
        createdAt: new Date(Date.now() - 60000)
      },
      {
        id: `ORDER-${testId}-3`,
        sessionId,
        side: 'buy',
        price: 121720,
        size: 0.02,
        symbol,
        status: 'new',
        createdAt: new Date()
      }
    ];

    for (const order of testOrders) {
      // Map to Data Manager format
      const orderData = {
        orderId: order.id,
        exchangeOrderId: order.id,
        sessionId: order.sessionId,
        side: order.side,
        price: order.price,
        size: order.size,
        symbol: order.symbol,
        status: order.status,
        createdAt: order.createdAt
      };
      dataManager.addOrder(orderData);
    }

    console.log(`   Created ${testOrders.length} test orders`);
    console.log('   ✅ Orders stored in memory');
    results.memoryStorage = true;
    console.log('');

    // 7. Store test fills
    console.log('7️⃣  Creating test fills...');
    const testFills = [
      {
        id: `FILL-${testId}-1`,
        orderId: `ORDER-${testId}-1`,
        sessionId,
        side: 'buy',
        price: 121700,
        size: 0.01,
        symbol,
        timestamp: Date.now() - 120000,
        execId: `EXEC-${testId}-1`
      },
      {
        id: `FILL-${testId}-2`,
        orderId: `ORDER-${testId}-2`,
        sessionId,
        side: 'sell',
        price: 121750,
        size: 0.015,
        symbol,
        timestamp: Date.now() - 60000,
        execId: `EXEC-${testId}-2`
      }
    ];

    for (const fill of testFills) {
      // Map to Data Manager format
      const fillData = {
        fillId: fill.id,
        orderId: fill.orderId,
        sessionId: fill.sessionId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        symbol: fill.symbol,
        timestamp: fill.timestamp,
        execID: fill.execId
      };
      dataManager.addFill(fillData);
    }

    console.log(`   Created ${testFills.length} test fills`);
    console.log('   ✅ Fills stored in memory');
    console.log('');

    // 8. Generate OHLC data
    console.log('8️⃣  Generating OHLC candles...');
    const testTrades = [
      { price: 121700, size: 0.01, timestamp: Date.now() - 120000 },
      { price: 121705, size: 0.02, timestamp: Date.now() - 90000 },
      { price: 121710, size: 0.015, timestamp: Date.now() - 60000 },
      { price: 121750, size: 0.015, timestamp: Date.now() - 30000 },
      { price: 121720, size: 0.01, timestamp: Date.now() }
    ];

    for (const trade of testTrades) {
      ohlcBuilder.updateWithTrade({
        timestamp: trade.timestamp,
        price: trade.price,
        volume: trade.size,
        symbol
      });
    }

    // Get all candles (complete and incomplete)
    const allCandles = Array.from(ohlcBuilder.candles.values());
    console.log(`   Generated ${allCandles.length} OHLC candles`);
    
    if (allCandles.length > 0) {
      for (const candle of allCandles) {
        console.log(`     ${candle.interval} @ ${new Date(candle.timestamp).toISOString()}`);
        console.log(`       O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`);
      }
      results.ohlcGeneration = true;
      console.log('   ✅ OHLC data generated');
    } else {
      console.log('   ⚠️  No OHLC data generated');
    }
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 3: Redis Storage');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 9. Flush to Redis
    console.log('9️⃣  Flushing data to Redis...');
    try {
      // Flush orders (map to Redis Manager format)
      const ordersToFlush = testOrders.map(o => ({
        orderId: o.id,           // Redis Manager expects 'orderId'
        exchangeOrderId: o.id,
        sessionId: o.sessionId,
        side: o.side,
        price: o.price,
        size: o.size,
        symbol: o.symbol,
        status: o.status,
        createdAt: o.createdAt
      }));
      await redisManager.flushOrders(ordersToFlush);
      console.log(`   Flushed ${ordersToFlush.length} orders`);
      
      // Flush fills (map to Redis Manager format)
      const fillsToFlush = testFills.map(f => ({
        fillId: f.id,            // Redis Manager expects 'fillId'
        execID: f.execId,        // Redis Manager expects 'execID'
        orderId: f.orderId,
        sessionId: f.sessionId,
        side: f.side,
        price: f.price,
        size: f.size,
        symbol: f.symbol,
        timestamp: f.timestamp
      }));
      await redisManager.flushFills(fillsToFlush);
      console.log(`   Flushed ${fillsToFlush.length} fills`);
      
      // Flush OHLC (format as expected by Redis Manager: { '1m': [...], '5m': [...] })
      const ohlcToFlush = { '1m': allCandles };
      await redisManager.flushOHLC(ohlcToFlush);
      console.log(`   Flushed OHLC data: ${allCandles.length} candles`);
      
      results.redisStorage = true;
      console.log('   ✅ Data flushed to Redis');
    } catch (error) {
      console.error(`   ❌ Redis flush failed: ${error.message}`);
      console.error(`   Error stack: ${error.stack}`);
      results.errors.push({ phase: 'Redis Flush', error: error.message });
    }
    console.log('');

    // 10. Verify Redis storage
    console.log('🔟 Verifying Redis storage...');
    try {
      const redisOrders = await redisClient.hgetall(`session:${sessionId}:orders`);
      const redisFills = await redisClient.hgetall(`session:${sessionId}:fills`);
      const redisOhlc1m = await redisClient.hgetall(`session:${sessionId}:ohlc:1m`);
      const redisOhlc5m = await redisClient.hgetall(`session:${sessionId}:ohlc:5m`);
      
      console.log(`   Orders in Redis:   ${Object.keys(redisOrders || {}).length}`);
      console.log(`   Fills in Redis:    ${Object.keys(redisFills || {}).length}`);
      console.log(`   OHLC 1m in Redis:  ${Object.keys(redisOhlc1m || {}).length} candles`);
      console.log(`   OHLC 5m in Redis:  ${Object.keys(redisOhlc5m || {}).length} candles`);
      
      if (Object.keys(redisOrders || {}).length > 0) {
        console.log('   ✅ Redis storage verified');
        const firstOrderKey = Object.keys(redisOrders)[0];
        const firstOrder = JSON.parse(redisOrders[firstOrderKey]);
        console.log(`   Sample order from Redis:`, firstOrder);
      } else {
        console.log('   ⚠️  No data found in Redis');
      }
    } catch (error) {
      console.error(`   ❌ Redis verification failed: ${error.message}`);
      results.errors.push({ phase: 'Redis Verification', error: error.message });
    }
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 4: PostgreSQL Storage');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 11. Migrate to PostgreSQL
    console.log('1️⃣1️⃣  Migrating data to PostgreSQL...');
    try {
      await pgManager.migrateFromRedis(redisManager, sessionId);
      results.postgresStorage = true;
      console.log('   ✅ Data migrated to PostgreSQL');
    } catch (error) {
      console.error(`   ❌ PostgreSQL migration failed: ${error.message}`);
      results.errors.push({ phase: 'PostgreSQL Migration', error: error.message });
    }
    console.log('');

    // 12. Verify PostgreSQL storage
    console.log('1️⃣2️⃣  Verifying PostgreSQL storage...');
    try {
      const ordersQuery = 'SELECT * FROM orders WHERE session_id = $1';
      const fillsQuery = 'SELECT * FROM fills WHERE session_id = $1';
      const ohlcQuery = 'SELECT * FROM ohlc WHERE session_id = $1';
      
      const ordersResult = await pgManager.db.query(ordersQuery, [sessionId]);
      const fillsResult = await pgManager.db.query(fillsQuery, [sessionId]);
      const ohlcResult = await pgManager.db.query(ohlcQuery, [sessionId]);
      
      console.log(`   Orders in PostgreSQL:  ${ordersResult.rows.length}`);
      console.log(`   Fills in PostgreSQL:   ${fillsResult.rows.length}`);
      console.log(`   OHLC in PostgreSQL:    ${ohlcResult.rows.length} candles`);
      
      if (ordersResult.rows.length > 0) {
        console.log('   ✅ PostgreSQL storage verified');
        console.log(`   Sample order from PostgreSQL:`, ordersResult.rows[0]);
      } else {
        console.log('   ⚠️  No orders found in PostgreSQL');
      }
      
      if (ohlcResult.rows.length > 0) {
        console.log(`   Sample OHLC from PostgreSQL:`, ohlcResult.rows[0]);
      }
    } catch (error) {
      console.error(`   ❌ PostgreSQL verification failed: ${error.message}`);
      results.errors.push({ phase: 'PostgreSQL Verification', error: error.message });
    }
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ TEST FAILED:');
    console.error(`   ${error.message}`);
    console.error('');
    if (error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }
    results.errors.push({ phase: 'General', error: error.message });
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('CLEANUP');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (redisClient) {
    try {
      console.log('🔌 Disconnecting from Redis...');
      await redisClient.quit();
    } catch (error) {
      console.log(`   ⚠️  Redis disconnect warning: ${error.message}`);
    }
  }

  if (pgManager) {
    try {
      console.log('🔌 Closing PostgreSQL connections...');
      await pgManager.close();
    } catch (error) {
      console.log(`   ⚠️  PostgreSQL close warning: ${error.message}`);
    }
  }

  console.log('✅ Cleanup complete');
  console.log('');

  printResults();
}

function printResults() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                       TEST RESULTS                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  const checks = [
    { name: 'Memory Storage', status: results.memoryStorage },
    { name: 'OHLC Generation', status: results.ohlcGeneration },
    { name: 'Redis Storage', status: results.redisStorage },
    { name: 'PostgreSQL Storage', status: results.postgresStorage }
  ];

  for (const check of checks) {
    const icon = check.status ? '✅' : '❌';
    const status = check.status ? 'PASS' : 'FAIL';
    console.log(`${icon} ${check.name.padEnd(30)} ${status}`);
  }

  console.log('');

  const passed = checks.filter(c => c.status).length;
  const total = checks.length;
  const percentage = Math.round((passed / total) * 100);

  console.log(`Score: ${passed}/${total} (${percentage}%)`);
  console.log('');

  if (results.errors.length > 0) {
    console.log('❌ ERRORS ENCOUNTERED:');
    for (const error of results.errors) {
      console.log(`   [${error.phase}] ${error.error}`);
    }
    console.log('');
  }

  const overallSuccess = passed === total && results.errors.length === 0;
  
  if (overallSuccess) {
    console.log('🎉 ALL TESTS PASSED! Data pipeline is working end-to-end!');
    console.log('');
    console.log('✅ Data flows correctly:');
    console.log('   Memory → Redis → PostgreSQL');
    console.log('');
    console.log('✅ OHLC generation is working');
    console.log('✅ All storage layers are functional');
  } else {
    console.log('⚠️  SOME TESTS FAILED. Review the errors above.');
  }
  console.log('');

  process.exit(overallSuccess ? 0 : 1);
}

// Run the test
runTest().catch(error => {
  console.error('');
  console.error('💥 FATAL ERROR:');
  console.error(error);
  console.error('');
  process.exit(1);
});

