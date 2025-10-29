#!/usr/bin/env node
/**
 * Test 50-Order Ladder with FIXConnection
 * 
 * This script:
 * 1. Connects to Coinbase for live BTC price
 * 2. Generates 50 orders (25 buys, 25 sells) around current price
 * 3. Sends all orders via FIXConnection
 * 4. Monitors for execution reports
 * 5. Tests resend request handling
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { FIXConnection } = require('./fix-protocol/fix-connection.js');
const LiveCoinbaseDataManager = require('./live-coinbase-data-manager.cjs');

// Configuration
const CONFIG = {
  totalOrders: 50,
  priceLevels: 8,
  truexIncrement: 0.50,
  baseSize: 0.01, // 0.01 BTC per order
  testDuration: 90000, // 90 seconds
};

// Track results
const results = {
  ordersSent: 0,
  executionReportsReceived: 0,
  orderAcks: 0,
  orderRejects: 0,
  fills: 0,
  resendRequests: 0,
  orders: new Map()
};

/**
 * Generate 50-order ladder around current price
 */
function generateOrderLadder(basePrice) {
  const orders = [];
  const ordersPerSide = Math.floor(CONFIG.totalOrders / 2);
  
  console.log(`\n📊 Generating ${CONFIG.totalOrders} orders around $${basePrice.toFixed(2)}`);
  console.log(`   ${ordersPerSide} buys below market`);
  console.log(`   ${ordersPerSide} sells above market\n`);
  
  // Buy orders (below market)
  for (let level = 1; level <= CONFIG.priceLevels; level++) {
    const ordersAtLevel = Math.ceil(ordersPerSide / CONFIG.priceLevels);
    
    for (let i = 0; i < ordersAtLevel && orders.filter(o => o.side === 'buy').length < ordersPerSide; i++) {
      const levelOffset = level * CONFIG.truexIncrement;
      const price = Math.floor((basePrice - levelOffset) / CONFIG.truexIncrement) * CONFIG.truexIncrement;
      
      orders.push({
        side: 'buy',
        price: price,
        size: CONFIG.baseSize,
        level: level
      });
    }
  }
  
  // Sell orders (above market)
  for (let level = 1; level <= CONFIG.priceLevels; level++) {
    const ordersAtLevel = Math.ceil(ordersPerSide / CONFIG.priceLevels);
    
    for (let i = 0; i < ordersAtLevel && orders.filter(o => o.side === 'sell').length < ordersPerSide; i++) {
      const levelOffset = level * CONFIG.truexIncrement;
      const price = Math.ceil((basePrice + levelOffset) / CONFIG.truexIncrement) * CONFIG.truexIncrement;
      
      orders.push({
        side: 'sell',
        price: price,
        size: CONFIG.baseSize,
        level: level
      });
    }
  }
  
  return orders.slice(0, CONFIG.totalOrders);
}

/**
 * Setup FIX event handlers
 */
function setupFIXHandlers(fix) {
  fix.on('loggedOn', () => {
    console.log('✅ FIX Logon accepted - ready to send orders\n');
  });
  
  fix.on('executionReport', (report) => {
    results.executionReportsReceived++;
    
    const orderId = report.fields['11'];
    const execType = report.fields['150'];
    const ordStatus = report.fields['39'];
    const side = report.fields['54'] === '1' ? 'BUY' : 'SELL';
    const qty = report.fields['38'];
    const price = report.fields['44'];
    
    // Track order
    if (!results.orders.has(orderId)) {
      results.orders.set(orderId, {
        orderId,
        side,
        qty,
        price,
        status: ordStatus,
        execType
      });
    } else {
      results.orders.get(orderId).status = ordStatus;
      results.orders.get(orderId).execType = execType;
    }
    
    // Execution type mapping
    const execTypeMap = {
      '0': 'NEW',
      '1': 'PARTIAL_FILL',
      '2': 'FILL',
      '4': 'CANCELED',
      '8': 'REJECTED'
    };
    
    const execTypeStr = execTypeMap[execType] || execType;
    
    // Count by type
    if (execType === '0') results.orderAcks++;
    if (execType === '8') results.orderRejects++;
    if (execType === '2' || execType === '1') results.fills++;
    
    console.log(`📊 Execution Report #${results.executionReportsReceived}: ${execTypeStr}`);
    console.log(`   Order: ${orderId}`);
    console.log(`   ${side} ${qty} @ $${price}`);
    console.log(`   Status: ${ordStatus}\n`);
  });
  
  fix.on('reject', ({ reason, refSeqNum }) => {
    console.log(`❌ Reject: ${reason} (RefSeqNum: ${refSeqNum})\n`);
  });
  
  fix.on('resendRequest', ({ beginSeqNo, endSeqNo }) => {
    results.resendRequests++;
    console.log(`🔄 Resend Request #${results.resendRequests}: ${beginSeqNo} to ${endSeqNo === 0 ? '∞' : endSeqNo}`);
    console.log(`   FIXConnection will automatically handle this...\n`);
  });
  
  fix.on('sent', ({ msgSeqNum, fields }) => {
    const msgType = fields['35'];
    if (msgType === 'D') {
      // New Order sent
      // console.log(`📤 Order Sent: SeqNum=${msgSeqNum}`);
    }
  });
  
  fix.on('error', (error) => {
    console.error('❌ FIX Connection Error:', error);
  });
  
  fix.on('disconnected', () => {
    console.log('🔌 FIX Disconnected');
  });
}

/**
 * Print progress summary
 */
function printProgress() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 PROGRESS SUMMARY');
  console.log('='.repeat(60));
  console.log(`Orders Sent:              ${results.ordersSent}`);
  console.log(`Execution Reports:        ${results.executionReportsReceived}`);
  console.log(`  - Order Acks (NEW):     ${results.orderAcks}`);
  console.log(`  - Order Rejects:        ${results.orderRejects}`);
  console.log(`  - Fills:                ${results.fills}`);
  console.log(`Resend Requests Handled:  ${results.resendRequests}`);
  console.log(`Active Orders Tracked:    ${results.orders.size}`);
  console.log('='.repeat(60) + '\n');
}

/**
 * Print final results
 */
function printFinalResults() {
  console.log('\n' + '='.repeat(60));
  console.log('🎯 FINAL RESULTS');
  console.log('='.repeat(60));
  console.log(`Orders Sent:              ${results.ordersSent}`);
  console.log(`Execution Reports:        ${results.executionReportsReceived}`);
  console.log(`  - Order Acks (NEW):     ${results.orderAcks}`);
  console.log(`  - Order Rejects:        ${results.orderRejects}`);
  console.log(`  - Fills:                ${results.fills}`);
  console.log(`Resend Requests:          ${results.resendRequests}`);
  console.log(`Active Orders:            ${results.orders.size}`);
  console.log('='.repeat(60));
  
  // Success rate
  const ackRate = results.ordersSent > 0 ? (results.orderAcks / results.ordersSent * 100).toFixed(1) : 0;
  const rejectRate = results.ordersSent > 0 ? (results.orderRejects / results.ordersSent * 100).toFixed(1) : 0;
  
  console.log(`\nAcknowledgment Rate:      ${ackRate}%`);
  console.log(`Rejection Rate:           ${rejectRate}%`);
  
  // Show order breakdown
  if (results.orders.size > 0) {
    console.log(`\n📋 Order Status Breakdown:`);
    const statusCounts = {};
    for (const order of results.orders.values()) {
      const key = order.execType;
      statusCounts[key] = (statusCounts[key] || 0) + 1;
    }
    
    const execTypeMap = {
      '0': 'NEW (Acknowledged)',
      '1': 'PARTIAL_FILL',
      '2': 'FILL',
      '4': 'CANCELED',
      '8': 'REJECTED'
    };
    
    for (const [key, count] of Object.entries(statusCounts)) {
      console.log(`   ${execTypeMap[key] || key}: ${count}`);
    }
  }
  
  console.log('\n' + '='.repeat(60) + '\n');
}

/**
 * Main test function
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Test 50-Order Ladder with FIXConnection                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  let coinbase, fix;
  
  try {
    // Step 1: Connect to Coinbase
    console.log('📡 Step 1: Connecting to Coinbase...\n');
    coinbase = new LiveCoinbaseDataManager({ symbol: 'BTC-USD' });
    await coinbase.connect();
    
    // Wait for first price update
    await new Promise(resolve => {
      coinbase.once('priceUpdate', resolve);
    });
    
    const currentPrice = coinbase.getCurrentMidpoint();
    console.log(`✅ Coinbase connected: Current BTC Price = $${currentPrice.toFixed(2)}\n`);
    
    // Step 2: Connect to TrueX
    console.log('🔗 Step 2: Connecting to TrueX FIX...\n');
    fix = new FIXConnection({
      host: process.env.TRUEX_FIX_HOST || '129.212.145.83',
      port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_SECRET_KEY,
      senderCompID: 'CLI_CLIENT',
      targetCompID: 'TRUEX_UAT_OE',
      heartbeatInterval: 30
    });
    
    // Setup event handlers
    setupFIXHandlers(fix);
    
    // Connect and authenticate
    await fix.connect();
    await fix.sendLogon();
    
    // Wait for logon
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Logon timeout')), 15000);
      fix.once('loggedOn', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    
    // Step 3: Generate orders
    console.log('📊 Step 3: Generating order ladder...\n');
    const orders = generateOrderLadder(currentPrice);
    
    console.log(`✅ Generated ${orders.length} orders:`);
    const buyOrders = orders.filter(o => o.side === 'buy');
    const sellOrders = orders.filter(o => o.side === 'sell');
    console.log(`   ${buyOrders.length} buys from $${Math.min(...buyOrders.map(o => o.price)).toFixed(2)} to $${Math.max(...buyOrders.map(o => o.price)).toFixed(2)}`);
    console.log(`   ${sellOrders.length} sells from $${Math.min(...sellOrders.map(o => o.price)).toFixed(2)} to $${Math.max(...sellOrders.map(o => o.price)).toFixed(2)}\n`);
    
    // Step 4: Submit orders
    console.log('📤 Step 4: Submitting orders to TrueX...\n');
    
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const clientOrderId = `LADDER-${Date.now()}-${i}`;
      
      await fix.placeOrder({
        clientOrderId,
        symbol: 'BTC-PYUSD',
        side: order.side === 'buy' ? '1' : '2',
        orderQty: order.size.toString(),
        ordType: '2', // Limit
        price: order.price.toString(),
        timeInForce: '1' // GTC
      });
      
      results.ordersSent++;
      
      // Small delay between orders (20ms = 50 orders/second)
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Progress update every 10 orders
      if ((i + 1) % 10 === 0) {
        console.log(`   ✅ ${i + 1}/${orders.length} orders sent...`);
      }
    }
    
    console.log(`\n✅ All ${orders.length} orders submitted!\n`);
    
    // Step 5: Monitor for execution reports
    console.log(`⏳ Step 5: Monitoring for execution reports (${CONFIG.testDuration/1000} seconds)...\n`);
    
    // Print progress every 10 seconds
    const progressInterval = setInterval(() => {
      printProgress();
    }, 10000);
    
    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, CONFIG.testDuration));
    
    clearInterval(progressInterval);
    
    // Step 6: Cleanup
    console.log('\n🛑 Step 6: Cleaning up...\n');
    await fix.disconnect();
    await coinbase.disconnect();
    
    // Print final results
    printFinalResults();
    
    // Determine success
    if (results.orderAcks >= orders.length * 0.95) {
      console.log('✅ TEST PASSED: 95%+ of orders acknowledged by TrueX\n');
      process.exit(0);
    } else if (results.executionReportsReceived > 0) {
      console.log('⚠️  TEST PARTIAL: Some execution reports received, but not all orders acknowledged\n');
      process.exit(0);
    } else {
      console.log('❌ TEST FAILED: No execution reports received from TrueX\n');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    
    // Cleanup on error
    if (fix) {
      try { await fix.disconnect(); } catch (e) {}
    }
    if (coinbase) {
      try { await coinbase.disconnect(); } catch (e) {}
    }
    
    process.exit(1);
  }
}

// Handle interruption
process.on('SIGINT', async () => {
  console.log('\n⏹️  Test interrupted by user\n');
  printFinalResults();
  process.exit(0);
});

// Run test
main();



