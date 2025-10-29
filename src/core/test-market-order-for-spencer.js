#!/usr/bin/env node
/**
 * Market Order Test for TrueX Support
 * 
 * This script:
 * 1. Connects to Coinbase to get current BTC price
 * 2. Sends ONE order at/near market price
 * 3. Logs all FIX messages for debugging
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { FIXConnection } from './fix-protocol/fix-connection.js';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

console.log('='.repeat(80));
console.log('TrueX Market Order Test - For Support Review');
console.log('='.repeat(80));
console.log(`Test Time: ${new Date().toISOString()}`);
console.log('='.repeat(80));
console.log();

// Storage for all messages
const messages = {
  sent: [],
  received: []
};

let currentPrice = null;
let coinbaseWs = null;

async function connectToCoinbase() {
  return new Promise((resolve, reject) => {
    console.log('📊 STEP 1: Connecting to Coinbase for market price...');
    console.log();
    
    coinbaseWs = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    
    coinbaseWs.on('open', () => {
      console.log('✅ Connected to Coinbase WebSocket');
      
      // Subscribe to ticker for BTC-USD
      const subscribeMessage = {
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker']
      };
      
      coinbaseWs.send(JSON.stringify(subscribeMessage));
    });
    
    coinbaseWs.on('message', (data) => {
      const msg = JSON.parse(data);
      
      if (msg.type === 'ticker' && msg.product_id === 'BTC-USD') {
        currentPrice = parseFloat(msg.price);
        console.log(`💰 Current BTC Price: $${currentPrice.toFixed(2)}`);
        
        if (!resolve.called) {
          resolve.called = true;
          resolve();
        }
      }
    });
    
    coinbaseWs.on('error', (error) => {
      console.error('❌ Coinbase WebSocket error:', error);
      reject(error);
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      if (!currentPrice) {
        reject(new Error('Timeout waiting for Coinbase price'));
      }
    }, 10000);
  });
}

async function runTrueXTest() {
  // Use a unique SenderCompID for this test
  const testId = Date.now();
  const senderCompID = `CLI_TEST_${testId}`;
  
  console.log();
  console.log('📋 TEST CONFIGURATION');
  console.log('-'.repeat(80));
  console.log(`SenderCompID:     ${senderCompID}`);
  console.log(`TargetCompID:     TRUEX_UAT_OE`);
  console.log(`Proxy Host:       ${process.env.TRUEX_FIX_HOST}`);
  console.log(`Proxy Port:       ${process.env.TRUEX_FIX_PORT || '3004'}`);
  console.log(`API Key:          ${process.env.TRUEX_API_KEY ? process.env.TRUEX_API_KEY.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`Market Price:     $${currentPrice.toFixed(2)}`);
  console.log('-'.repeat(80));
  console.log();

  // Create FIX connection
  const fix = new FIXConnection({
    host: process.env.TRUEX_FIX_HOST,
    port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
    senderCompID: senderCompID,
    targetCompID: 'TRUEX_UAT_OE',
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_SECRET_KEY,
    heartbeatInterval: 30,
    logger: console
  });

  // Listen to ALL sent messages
  fix.on('sent', ({ msgSeqNum, fields }) => {
    const msgType = fields['35'];
    const msgTypeName = getMsgTypeName(msgType);
    
    // Build raw message for display
    const rawMsg = buildRawMessage(fields);
    
    messages.sent.push({
      seqNum: msgSeqNum,
      msgType,
      msgTypeName,
      fields,
      rawMsg,
      timestamp: new Date().toISOString()
    });
    
    console.log(`\n📤 OUTBOUND MESSAGE ${msgSeqNum}: ${msgTypeName} (35=${msgType})`);
    console.log('-'.repeat(80));
    console.log(`Raw FIX: ${rawMsg}`);
    console.log(`Parsed Fields:`);
    for (const [tag, value] of Object.entries(fields)) {
      const fieldName = getFieldName(tag);
      console.log(`  ${tag.padStart(3)} (${fieldName.padEnd(20)}): ${value}`);
    }
    console.log('-'.repeat(80));
  });

  // Listen to ALL received messages
  fix.on('message', (message) => {
    const msgType = message.fields['35'];
    const msgSeq = message.fields['34'];
    const msgTypeName = getMsgTypeName(msgType);
    
    messages.received.push({
      seqNum: msgSeq,
      msgType,
      msgTypeName,
      fields: message.fields,
      timestamp: new Date().toISOString()
    });
    
    console.log(`\n📥 INBOUND MESSAGE ${msgSeq}: ${msgTypeName} (35=${msgType})`);
    console.log('-'.repeat(80));
    console.log(`Parsed Fields:`);
    for (const [tag, value] of Object.entries(message.fields)) {
      const fieldName = getFieldName(tag);
      console.log(`  ${tag.padStart(3)} (${fieldName.padEnd(20)}): ${value}`);
    }
    
    // Highlight important fields
    if (msgType === '3') {
      console.log(`\n⚠️  REJECT REASON: ${message.fields['58'] || 'Not specified'}`);
    } else if (msgType === 'j') {
      console.log(`\n⚠️  BUSINESS REJECT: ${message.fields['58'] || 'Not specified'}`);
    } else if (msgType === '8') {
      console.log(`\n✅ EXECUTION REPORT: ExecType=${message.fields['150']}, OrdStatus=${message.fields['39']}`);
    }
    console.log('-'.repeat(80));
  });

  // Listen for errors
  fix.on('error', (error) => {
    console.error(`\n❌ ERROR: ${error.message}`);
  });

  try {
    // Step 2: Connect and authenticate to TrueX
    console.log('🔗 STEP 2: Connecting to TrueX...');
    console.log();
    await fix.connect();
    console.log('\n✅ STEP 2 COMPLETE: Authenticated to TrueX');
    console.log();

    // Wait a moment for any immediate responses
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 3: Send order at market price
    console.log('📤 STEP 3: Sending order at market price...');
    console.log();
    
    // Calculate order price (buy slightly below market, sell slightly above)
    const buyPrice = Math.floor(currentPrice - 5); // $5 below market
    const sellPrice = Math.ceil(currentPrice + 5);  // $5 above market
    
    // For this test, let's send a BUY order
    const orderPrice = buyPrice;
    
    console.log(`📊 Order Pricing:`);
    console.log(`   Current Market: $${currentPrice.toFixed(2)}`);
    console.log(`   Buy Price:      $${buyPrice.toFixed(1)} (market - $5)`);
    console.log(`   Sell Price:     $${sellPrice.toFixed(1)} (market + $5)`);
    console.log(`   Using:          $${orderPrice.toFixed(1)} (BUY)`);
    console.log();
    
    const orderFields = {
      '35': 'D',                    // MsgType = New Order Single
      '11': `ORD-${testId.toString().slice(-12)}`,  // ClOrdID (16 chars, ≤18 per TrueX spec)
      '55': 'BTC-PYUSD',            // Symbol
      '54': '1',                    // Side = Buy
      '38': '0.01',                 // OrderQty (minimum size)
      '40': '2',                    // OrdType = Limit
      '44': orderPrice.toFixed(1),  // Price (near market)
      '59': '1'                     // TimeInForce = GTC
    };

    await fix.sendMessage(orderFields);
    
    console.log('\n✅ STEP 3 COMPLETE: Order sent at market price');
    console.log();

    // Step 4: Wait for responses
    console.log('⏳ STEP 4: Waiting for execution report (60 seconds)...');
    console.log();
    
    await new Promise(resolve => setTimeout(resolve, 60000));

    // Step 5: Disconnect
    console.log('\n🛑 STEP 5: Disconnecting...');
    await fix.disconnect();
    console.log('✅ STEP 5 COMPLETE: Disconnected');
    console.log();

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    // Close Coinbase WebSocket
    if (coinbaseWs) {
      coinbaseWs.close();
    }
  }

  // Print summary
  printSummary();
}

function printSummary() {
  console.log('\n');
  console.log('='.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(80));
  console.log();
  
  console.log(`Market Price:      $${currentPrice.toFixed(2)}`);
  console.log(`Messages Sent:     ${messages.sent.length}`);
  console.log(`Messages Received: ${messages.received.length}`);
  console.log();
  
  console.log('📤 SENT MESSAGES:');
  console.log('-'.repeat(80));
  messages.sent.forEach((msg, idx) => {
    console.log(`${idx + 1}. Seq ${msg.seqNum}: ${msg.msgTypeName} (35=${msg.msgType})`);
    if (msg.msgType === 'D') {
      const price = msg.fields['44'];
      const side = msg.fields['54'] === '1' ? 'BUY' : 'SELL';
      const qty = msg.fields['38'];
      console.log(`   ${side} ${qty} BTC-PYUSD @ $${price}`);
    }
  });
  console.log();
  
  console.log('📥 RECEIVED MESSAGES:');
  console.log('-'.repeat(80));
  if (messages.received.length === 0) {
    console.log('  (No messages received)');
  } else {
    messages.received.forEach((msg, idx) => {
      console.log(`${idx + 1}. Seq ${msg.seqNum}: ${msg.msgTypeName} (35=${msg.msgType})`);
      if (msg.fields['58']) {
        console.log(`   Reason: ${msg.fields['58']}`);
      }
    });
  }
  console.log();
  
  // Check for execution report
  const execReports = messages.received.filter(m => m.msgType === '8');
  if (execReports.length === 0) {
    console.log('⚠️  NO EXECUTION REPORT RECEIVED');
    console.log('    Expected: 35=8 (Execution Report) with ExecType and OrdStatus');
    console.log('    Actual:   None received');
  } else {
    console.log('✅ EXECUTION REPORT RECEIVED');
    execReports.forEach(report => {
      console.log(`   ExecType: ${report.fields['150']}, OrdStatus: ${report.fields['39']}`);
    });
  }
  
  console.log();
  console.log('='.repeat(80));
  console.log('Test completed at:', new Date().toISOString());
  console.log('='.repeat(80));
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
    'F': 'Order Cancel Request',
    'G': 'Order Cancel/Replace',
    'V': 'Market Data Request',
    'W': 'Market Data Snapshot',
    'X': 'Market Data Incremental',
    'j': 'Business Message Reject'
  };
  return types[msgType] || `Unknown (${msgType})`;
}

function getFieldName(tag) {
  const fields = {
    '8': 'BeginString',
    '9': 'BodyLength',
    '10': 'CheckSum',
    '11': 'ClOrdID',
    '34': 'MsgSeqNum',
    '35': 'MsgType',
    '38': 'OrderQty',
    '39': 'OrdStatus',
    '40': 'OrdType',
    '44': 'Price',
    '45': 'RefSeqNum',
    '49': 'SenderCompID',
    '52': 'SendingTime',
    '54': 'Side',
    '55': 'Symbol',
    '56': 'TargetCompID',
    '58': 'Text',
    '59': 'TimeInForce',
    '98': 'EncryptMethod',
    '108': 'HeartBtInt',
    '141': 'ResetSeqNumFlag',
    '150': 'ExecType',
    '380': 'BusinessRejectReason',
    '553': 'Username',
    '554': 'Password',
    '1137': 'DefaultApplVerID'
  };
  return fields[tag] || `Field${tag}`;
}

function buildRawMessage(fields) {
  // Build message in proper order (standard header, body, trailer)
  let msg = '';
  const standardOrder = ['8', '9', '34', '35', '49', '52', '56'];
  
  // Add standard header fields first
  for (const tag of standardOrder) {
    if (fields[tag]) {
      msg += `${tag}=${fields[tag]}|`;
    }
  }
  
  // Add remaining body fields
  for (const [tag, value] of Object.entries(fields)) {
    if (!standardOrder.includes(tag) && tag !== '10') {
      msg += `${tag}=${value}|`;
    }
  }
  
  // Add checksum
  if (fields['10']) {
    msg += `10=${fields['10']}|`;
  }
  
  return msg;
}

// Run the test
async function run() {
  try {
    await connectToCoinbase();
    await runTrueXTest();
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

run();

