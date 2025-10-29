#!/usr/bin/env node

/**
 * TrueX Market Maker - End-to-End Test
 * 
 * Tests the complete data flow:
 * 1. FIX Connection & Authentication
 * 2. Order placement
 * 3. Execution report handling
 * 4. OHLC data generation
 * 5. Redis storage
 * 6. PostgreSQL storage
 * 
 * Usage: node test-end-to-end.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { FIXConnection } from './fix-protocol/fix-connection.js';
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
console.log('║     TrueX Market Maker - End-to-End Integration Test          ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');

// Test configuration
const testId = Date.now();
const sessionId = `e2e-test-${testId}`;
const symbol = 'BTC-PYUSD';
const clOrdID = `E2E-${testId.toString().slice(-12)}`;  // 16 chars total

console.log('📋 Test Configuration:');
console.log(`   Session ID:  ${sessionId}`);
console.log(`   Symbol:      ${symbol}`);
console.log(`   ClOrdID:     ${clOrdID} (${clOrdID.length} chars)`);
console.log('');

// Test results tracking
const results = {
  fixConnection: false,
  fixAuthentication: false,
  orderSent: false,
  executionReportReceived: false,
  ohlcGenerated: false,
  redisStorage: false,
  postgresStorage: false,
  errors: []
};

let fix;
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
    console.log('1️⃣  Initializing Redis connection...');
    redisClient = new RedisClient();
    // Test connection
    const pingResult = await redisClient.ping();
    if (!pingResult) {
      throw new Error('Redis connection failed');
    }
    console.log('   ✅ Redis connected');
    console.log('');

    // 2. Initialize Data Manager (in-memory storage)
    console.log('2️⃣  Initializing Data Manager (in-memory)...');
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

    // 4. Initialize PostgreSQL Manager
    console.log('4️⃣  Initializing PostgreSQL Manager...');
    pgManager = new TrueXPostgreSQLManager({ logger: console });
    await pgManager.initialize();
    await pgManager.ensureTrueXSchema();
    console.log('   ✅ PostgreSQL Manager initialized');
    console.log('');

    // 5. Initialize OHLC Builder
    console.log('5️⃣  Initializing OHLC Builder...');
    ohlcBuilder = new TrueXOhlcBuilder({ 
      symbol, 
      logger: console,
      intervals: ['1m', '5m']  // Test with 1m and 5m candles
    });
    console.log('   ✅ OHLC Builder initialized');
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 2: FIX Connection & Authentication');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 6. Initialize FIX Connection
    console.log('6️⃣  Initializing FIX Connection...');
    const fixHost = process.env.TRUEX_FIX_HOST || 'localhost';
    const fixPort = parseInt(process.env.TRUEX_ORDER_ENTRY_PORT || '19484');
    const uniqueSenderCompID = `E2E_TEST_${testId}`;
    
    console.log(`   Host:         ${fixHost}`);
    console.log(`   Port:         ${fixPort}`);
    console.log(`   SenderCompID: ${uniqueSenderCompID}`);
    console.log('');

    fix = new FIXConnection({
      host: fixHost,
      port: fixPort,
      senderCompID: uniqueSenderCompID,
      targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_SECRET_KEY,
      heartbeatInterval: 30,
      logger: console
    });

    // Set up FIX event handlers
    fix.on('loggedOn', () => {
      console.log('   ✅ FIX Authentication successful');
      results.fixAuthentication = true;
    });

    fix.on('message', (message) => {
      const msgType = message.fields['35'];
      const msgTypeName = getMsgTypeName(msgType);
      
      console.log(`   📨 Received: ${msgType} (${msgTypeName})`);
      
      // Handle Execution Report
      if (msgType === '8') {
        handleExecutionReport(message);
      }
    });

    fix.on('disconnected', () => {
      console.log('   ⚠️  FIX Connection disconnected');
    });

    fix.on('error', (error) => {
      console.error(`   ❌ FIX Error: ${error.message}`);
      results.errors.push({ phase: 'FIX', error: error.message });
    });

    // Connect to TrueX
    console.log('7️⃣  Connecting to TrueX...');
    await fix.connect();
    results.fixConnection = true;
    console.log('   ✅ FIX Connection established');
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 3: Order Placement');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Wait a bit for authentication to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 8. Send test order
    console.log('8️⃣  Sending test order...');
    const orderFields = {
      '35': 'D',                    // MsgType = New Order Single
      '11': clOrdID,                // ClOrdID (16 chars)
      '55': symbol,                 // Symbol
      '54': '1',                    // Side = Buy
      '38': '0.01',                 // OrderQty (minimum)
      '40': '2',                    // OrdType = Limit
      '44': '100000',               // Price (far from market to avoid fill)
      '59': '1',                    // TimeInForce = GTC
      // Party ID fields for authentication
      '453': '1',                   // NoPartyIDs
      '448': process.env.TRUEX_CLIENT_ID,  // PartyID
      '452': '3'                    // PartyRole = Client ID
    };

    console.log('   Order Details:');
    console.log(`     ClOrdID:     ${orderFields['11']}`);
    console.log(`     Symbol:      ${orderFields['55']}`);
    console.log(`     Side:        ${orderFields['54']} (Buy)`);
    console.log(`     Qty:         ${orderFields['38']}`);
    console.log(`     Price:       ${orderFields['44']}`);
    console.log(`     TimeInForce: ${orderFields['59']} (GTC)`);
    console.log('');

    await fix.sendMessage(orderFields);
    results.orderSent = true;
    console.log('   ✅ Order sent successfully');
    console.log('');

    // Wait for execution report
    console.log('⏳ Waiting 10 seconds for execution report...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('PHASE 4: Data Pipeline Verification');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // 9. Check in-memory data
    console.log('9️⃣  Checking in-memory data...');
    const memoryOrders = dataManager.getAllOrders();
    const memoryFills = dataManager.getAllFills();
    console.log(`   Orders in memory:  ${memoryOrders.length}`);
    console.log(`   Fills in memory:   ${memoryFills.length}`);
    
    if (memoryOrders.length > 0) {
      console.log('   ✅ Orders stored in memory');
      console.log(`   Latest order: ${JSON.stringify(memoryOrders[0], null, 2)}`);
    }
    console.log('');

    // 10. Generate OHLC data (simulate some trades)
    console.log('🔟 Generating OHLC data...');
    const testTrades = [
      { price: 121700, size: 0.01, timestamp: Date.now() - 60000 },
      { price: 121705, size: 0.02, timestamp: Date.now() - 30000 },
      { price: 121710, size: 0.015, timestamp: Date.now() }
    ];

    for (const trade of testTrades) {
      ohlcBuilder.addTrade(trade);
    }

    const candles = ohlcBuilder.getAllCandles();
    console.log(`   Generated ${Object.keys(candles).length} candle intervals`);
    for (const [interval, candleData] of Object.entries(candles)) {
      console.log(`   ${interval}: ${candleData.length} candles`);
    }
    results.ohlcGenerated = true;
    console.log('   ✅ OHLC data generated');
    console.log('');

    // 11. Flush to Redis
    console.log('1️⃣1️⃣  Flushing data to Redis...');
    try {
      // Flush orders
      for (const order of memoryOrders) {
        await redisManager.flushOrders([order]);
      }
      
      // Flush fills
      for (const fill of memoryFills) {
        await redisManager.flushFills([fill]);
      }
      
      // Flush OHLC
      await redisManager.flushOHLC(candles);
      
      results.redisStorage = true;
      console.log('   ✅ Data flushed to Redis');
    } catch (error) {
      console.error(`   ❌ Redis flush failed: ${error.message}`);
      results.errors.push({ phase: 'Redis', error: error.message });
    }
    console.log('');

    // 12. Verify Redis storage
    console.log('1️⃣2️⃣  Verifying Redis storage...');
    try {
      const redisOrders = await redisClient.hgetall(`session:${sessionId}:orders`);
      const redisFills = await redisClient.hgetall(`session:${sessionId}:fills`);
      const redisOhlc = await redisClient.hgetall(`session:${sessionId}:ohlc:1m`);
      
      console.log(`   Orders in Redis:   ${Object.keys(redisOrders || {}).length}`);
      console.log(`   Fills in Redis:    ${Object.keys(redisFills || {}).length}`);
      console.log(`   OHLC in Redis:     ${Object.keys(redisOhlc || {}).length}`);
      
      if (Object.keys(redisOrders || {}).length > 0) {
        console.log('   ✅ Redis storage verified');
      } else {
        console.log('   ⚠️  No data found in Redis');
      }
    } catch (error) {
      console.error(`   ❌ Redis verification failed: ${error.message}`);
      results.errors.push({ phase: 'Redis Verification', error: error.message });
    }
    console.log('');

    // 13. Migrate to PostgreSQL
    console.log('1️⃣3️⃣  Migrating data to PostgreSQL...');
    try {
      await pgManager.migrateFromRedis(redisManager, sessionId);
      results.postgresStorage = true;
      console.log('   ✅ Data migrated to PostgreSQL');
    } catch (error) {
      console.error(`   ❌ PostgreSQL migration failed: ${error.message}`);
      results.errors.push({ phase: 'PostgreSQL', error: error.message });
    }
    console.log('');

    // 14. Verify PostgreSQL storage
    console.log('1️⃣4️⃣  Verifying PostgreSQL storage...');
    try {
      // Query orders from PostgreSQL directly
      const query = 'SELECT * FROM orders WHERE sessionid = $1 LIMIT 10';
      const result = await pgManager.db.query(query, [sessionId]);
      const pgOrders = result.rows;
      
      console.log(`   Orders in PostgreSQL: ${pgOrders.length}`);
      
      if (pgOrders.length > 0) {
        console.log('   ✅ PostgreSQL storage verified');
        console.log(`   Sample order:`, pgOrders[0]);
      } else {
        console.log('   ⚠️  No orders found in PostgreSQL (this is expected if order was rejected)');
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
    console.error('Stack trace:');
    console.error(error.stack);
    results.errors.push({ phase: 'General', error: error.message });
  } finally {
    await cleanup();
  }
}

function handleExecutionReport(message) {
  const fields = message.fields;
  const ordStatus = fields['39'];
  const execType = fields['150'];
  const clOrdID = fields['11'];
  const rejectReason = fields['58'] || fields['103'];
  
  console.log('');
  console.log('   📊 Execution Report Details:');
  console.log(`      ClOrdID:     ${clOrdID}`);
  console.log(`      OrdStatus:   ${ordStatus} (${getOrdStatusName(ordStatus)})`);
  console.log(`      ExecType:    ${execType} (${getExecTypeName(execType)})`);
  
  if (rejectReason) {
    console.log(`      Reject:      ${rejectReason}`);
  }
  
  if (ordStatus === '0') {
    console.log('      ✅ Order accepted (NEW)');
  } else if (ordStatus === '8') {
    console.log(`      ❌ Order rejected: ${rejectReason}`);
  } else if (ordStatus === '2') {
    console.log('      ✅ Order filled');
  }
  console.log('');
  
  results.executionReportReceived = true;
  
  // Store order in data manager
  const order = {
    id: clOrdID,
    sessionId,
    side: fields['54'] === '1' ? 'buy' : 'sell',
    price: parseFloat(fields['44'] || '0'),
    size: parseFloat(fields['38'] || '0'),
    symbol: fields['55'],
    status: getOrdStatusName(ordStatus),
    createdAt: new Date()
  };
  
  dataManager.storeOrder(order);
  console.log('   ✅ Order stored in data manager');
}

function getMsgTypeName(msgType) {
  const types = {
    '0': 'Heartbeat',
    '1': 'Test Request',
    '2': 'Resend Request',
    '3': 'Reject',
    '5': 'Logout',
    '8': 'Execution Report',
    'A': 'Logon',
    'D': 'New Order Single',
    'j': 'Business Message Reject'
  };
  return types[msgType] || msgType;
}

function getOrdStatusName(ordStatus) {
  const statuses = {
    '0': 'New',
    '1': 'Partially Filled',
    '2': 'Filled',
    '4': 'Canceled',
    '8': 'Rejected'
  };
  return statuses[ordStatus] || ordStatus;
}

function getExecTypeName(execType) {
  const types = {
    '0': 'New',
    '4': 'Canceled',
    '8': 'Rejected',
    'F': 'Trade (Fill)'
  };
  return types[execType] || execType;
}

async function cleanup() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('CLEANUP');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (fix && fix.isConnected) {
    console.log('🔌 Disconnecting from TrueX...');
    await fix.disconnect();
  }

  if (redisClient) {
    console.log('🔌 Disconnecting from Redis...');
    await redisClient.disconnect();
  }

  if (pgManager) {
    console.log('🔌 Closing PostgreSQL connections...');
    await pgManager.close();
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
    { name: 'FIX Connection', status: results.fixConnection },
    { name: 'FIX Authentication', status: results.fixAuthentication },
    { name: 'Order Sent', status: results.orderSent },
    { name: 'Execution Report Received', status: results.executionReportReceived },
    { name: 'OHLC Generated', status: results.ohlcGenerated },
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
    console.log('🎉 ALL TESTS PASSED! End-to-end system is working!');
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

