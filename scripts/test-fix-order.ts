#!/usr/bin/env bun
/**
 * Test FIX Order Submission to TrueX UAT
 *
 * Tests the fix for tag ordering issue where tag 11 (ClOrdID) was
 * appearing in the header instead of the body.
 *
 * UAT Parameters (from Spencer):
 * - Duplicate Order Interval: 500ms
 * - Max Order/Second: 10
 * - Max Order/Minute: 300
 * - Min Notional/Order: 1 PYUSD
 * - Price band: 2.5% around midpoint
 * - ClOrdID: <=18 chars if not a UUID
 */

import { FIXConnection } from '../src/fix-protocol/fix-connection.js';

// Configuration from environment
const config = {
  host: process.env.TRUEX_FIX_HOST || 'localhost',
  port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
  apiKey: process.env.TRUEX_API_KEY,
  apiSecret: process.env.TRUEX_SECRET_KEY,
  clientId: process.env.TRUEX_CLIENT_ID || '78969806725840914', // DAVID1
};

console.log('='.repeat(70));
console.log('TrueX FIX Order Test - Verifying Tag Ordering Fix');
console.log('='.repeat(70));
console.log();

if (!config.apiKey || !config.apiSecret) {
  console.error('Missing required environment variables:');
  console.error('  TRUEX_API_KEY, TRUEX_SECRET_KEY');
  process.exit(1);
}

console.log('Configuration:');
console.log(`  Host:      ${config.host}:${config.port}`);
console.log(`  API Key:   ${config.apiKey.substring(0, 8)}...`);
console.log(`  Client ID: ${config.clientId}`);
console.log();

async function run() {
  const testId = Date.now();
  const senderCompID = `CLI_TEST_${testId}`;

  const fix = new FIXConnection({
    host: config.host,
    port: config.port,
    senderCompID,
    targetCompID: 'TRUEX_UAT_OE',
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    heartbeatInterval: 30,
    logger: console,
  });

  // Track messages for verification
  const sentMessages: string[] = [];
  const receivedMessages: any[] = [];

  // Capture raw messages to verify tag ordering
  fix.on('sent', ({ raw, fields, msgSeqNum }) => {
    const display = raw.replace(/\x01/g, '|');
    sentMessages.push(display);
    console.log(`\n📤 SENT [seq ${msgSeqNum}] MsgType=${fields['35']}`);
    console.log(`   Raw: ${display.substring(0, 200)}${display.length > 200 ? '...' : ''}`);

    // Verify tag ordering for New Order Single (35=D)
    if (fields['35'] === 'D') {
      verifyTagOrdering(display);
    }
  });

  fix.on('message', (message) => {
    const msgType = message.fields['35'];
    const msgSeq = message.fields['34'];
    receivedMessages.push(message);

    console.log(`\n📥 RECEIVED [seq ${msgSeq}] MsgType=${msgType}`);

    if (msgType === '8') { // Execution Report
      console.log(`   ✅ EXECUTION REPORT`);
      console.log(`      ExecType: ${message.fields['150']}`);
      console.log(`      OrdStatus: ${message.fields['39']}`);
      console.log(`      ClOrdID: ${message.fields['11']}`);
    } else if (msgType === '3') { // Reject
      console.log(`   ❌ SESSION REJECT: ${message.fields['58']}`);
    } else if (msgType === 'j') { // Business Reject
      console.log(`   ❌ BUSINESS REJECT: ${message.fields['58']}`);
    } else if (msgType === '2') { // Resend Request
      console.log(`   ⚠️  RESEND REQUEST: BeginSeqNo=${message.fields['7']}, EndSeqNo=${message.fields['16']}`);
    }
  });

  fix.on('error', (error) => {
    console.error(`\n❌ ERROR: ${error.message}`);
  });

  try {
    // Step 1: Connect
    console.log('🔗 Step 1: Connecting to TrueX UAT...');
    await fix.connect();
    console.log('✅ Connected and authenticated');

    // Wait for session to stabilize
    await Bun.sleep(2000);

    // Step 2: Send a test order
    console.log('\n📤 Step 2: Sending test order...');

    // Generate ClOrdID <=18 chars (per TrueX spec)
    const clOrdID = `T${testId.toString().slice(-12)}`; // 13 chars

    const orderFields = {
      '35': 'D',                    // MsgType = New Order Single
      '11': clOrdID,                // ClOrdID (<=18 chars for non-UUID)
      '55': 'BTC-PYUSD',            // Symbol
      '54': '1',                    // Side = Buy
      '38': '0.001',                // OrderQty (small test)
      '40': '2',                    // OrdType = Limit
      '44': '80000',                // Price (within 2.5% band, below midpoint)
      '59': '1',                    // TimeInForce = GTC
      // Party ID Authentication
      '453': '1',                   // NoPartyIDs
      '448': config.clientId,       // PartyID (client ID)
      '452': '3',                   // PartyRole = Client ID
    };

    console.log(`   ClOrdID: ${clOrdID} (${clOrdID.length} chars)`);
    console.log(`   Symbol:  BTC-PYUSD`);
    console.log(`   Side:    Buy`);
    console.log(`   Qty:     0.001`);
    console.log(`   Price:   80000`);

    await fix.sendMessage(orderFields);
    console.log('✅ Order sent');

    // Step 3: Wait for execution report
    console.log('\n⏳ Step 3: Waiting for execution report (30 seconds)...');

    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      const execReport = receivedMessages.find(m => m.fields['35'] === '8');
      if (execReport) {
        console.log('\n✅ Execution report received!');
        break;
      }
      await Bun.sleep(1000);
    }

    // Step 4: Disconnect
    console.log('\n🛑 Step 4: Disconnecting...');
    await fix.disconnect();
    console.log('✅ Disconnected');

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`Messages Sent:     ${sentMessages.length}`);
    console.log(`Messages Received: ${receivedMessages.length}`);

    const execReports = receivedMessages.filter(m => m.fields['35'] === '8');
    const rejects = receivedMessages.filter(m => m.fields['35'] === '3' || m.fields['35'] === 'j');
    const resendRequests = receivedMessages.filter(m => m.fields['35'] === '2');

    console.log(`Execution Reports: ${execReports.length}`);
    console.log(`Rejects:           ${rejects.length}`);
    console.log(`Resend Requests:   ${resendRequests.length}`);

    if (execReports.length > 0) {
      console.log('\n✅ TEST PASSED - Received execution report(s)');
    } else if (rejects.length > 0) {
      console.log('\n❌ TEST FAILED - Received reject(s)');
      rejects.forEach(r => console.log(`   Reason: ${r.fields['58']}`));
    } else if (resendRequests.length > 0) {
      console.log('\n⚠️  TEST INCONCLUSIVE - TrueX requested resend (possible tag ordering issue)');
    } else {
      console.log('\n⚠️  TEST INCONCLUSIVE - No execution report received');
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }

  process.exit(0);
}

function verifyTagOrdering(rawMessage: string) {
  // Extract tags in order (ignoring values)
  const tags = rawMessage.split('|')
    .filter(Boolean)
    .map(part => part.split('=')[0]);

  const headerTags = ['8', '9', '35', '49', '56', '34', '52'];
  const bodyTag11Index = tags.indexOf('11');

  // Check that tag 11 appears AFTER all header tags
  const headerEndIndex = Math.max(
    ...headerTags.map(t => tags.indexOf(t)).filter(i => i !== -1)
  );

  if (bodyTag11Index !== -1 && bodyTag11Index <= headerEndIndex) {
    console.log(`   ❌ TAG ORDERING ERROR: Tag 11 at position ${bodyTag11Index}, header ends at ${headerEndIndex}`);
    console.log(`   Tag sequence: ${tags.slice(0, 10).join(', ')}...`);
  } else {
    console.log(`   ✅ Tag ordering correct: header tags before body tag 11`);
  }
}

run();
