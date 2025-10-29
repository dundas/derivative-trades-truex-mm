#!/usr/bin/env node
/**
 * Simple test - just send ONE order to debug sequence numbers
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { FIXConnection } from './fix-protocol/fix-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

console.log('='.repeat(60));
console.log('TEST: Single Order with Sequence Number Debugging');
console.log('='.repeat(60));

async function run() {
  // Create FIX connection with UNIQUE SenderCompID to avoid stale sessions
  const uniqueId = `CLI_${Date.now()}`;
  console.log(`\n🆔 Using SenderCompID: ${uniqueId}\n`);
  
  const fix = new FIXConnection({
    host: process.env.TRUEX_FIX_HOST,
    port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
    senderCompID: uniqueId,
    targetCompID: 'TRUEX_UAT_OE',
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_SECRET_KEY,
    heartbeatInterval: 30,
    logger: console
  });

  // Listen to sent messages
  fix.on('sent', ({ msgSeqNum, fields }) => {
    const msgType = fields['35'];
    console.log(`\n📤 SENT seq ${msgSeqNum}: MsgType=${msgType}`);
  });

  // Listen to all received messages
  fix.on('message', (message) => {
    const msgType = message.fields['35'];
    const msgSeq = message.fields['34'];
    console.log(`📥 RECEIVED seq ${msgSeq}: MsgType=${msgType}`);
    console.log(`   Full message:`, JSON.stringify(message.fields, null, 2));
    
    if (msgType === '3') {
      const reason = message.fields['58'];
      console.log(`   ❌ REJECT: ${reason}`);
    }
  });

  try {
    // Connect
    console.log('\n🔗 Connecting to TrueX...');
    await fix.connect();
    console.log('✅ Connected and authenticated\n');

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('📤 Sending single order...');
    
    // Send ONE order
    await fix.sendMessage({
      '35': 'D',  // MsgType = New Order Single
      '11': 'TEST-ORD-001',    // ClOrdID (13 chars, ≤18 per TrueX spec)
      '55': 'BTC-PYUSD',       // Symbol
      '54': '1',               // Side = Buy
      '38': '0.01',            // OrderQty
      '40': '2',               // OrdType = Limit
      '44': '50000',           // Price
      '59': '1'                // TimeInForce = GTC
    });

    console.log('✅ Order sent\n');
    console.log('⏳ Waiting 30 seconds for response...\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log('\n🛑 Disconnecting...');
    await fix.disconnect();

  } catch (error) {
    console.error('❌ Error:', error);
  }

  process.exit(0);
}

run();

