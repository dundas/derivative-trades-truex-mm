#!/usr/bin/env node

/**
 * TrueX Client ID Validation Test
 * 
 * This test validates the client ID and Party ID configuration
 * by testing multiple scenarios to identify the exact issue.
 * 
 * Tests:
 * 1. Client ID format validation
 * 2. Party ID field combinations
 * 3. Order submission with different Party configurations
 * 4. Response analysis to identify missing fields
 * 
 * Usage: node test-client-id-validation.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { FIXConnection } from './fix-protocol/fix-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║        TrueX Client ID Validation & Diagnostic Test           ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');

// Test configuration
const testId = Date.now();
const clientId = process.env.TRUEX_CLIENT_ID;
const apiKey = process.env.TRUEX_API_KEY;
const apiSecret = process.env.TRUEX_SECRET_KEY;

console.log('📋 Configuration Validation:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Client ID:        ${clientId || '❌ MISSING'}`);
console.log(`API Key:          ${apiKey ? '✅ Configured (' + apiKey.substring(0, 8) + '...)' : '❌ MISSING'}`);
console.log(`API Secret:       ${apiSecret ? '✅ Configured' : '❌ MISSING'}`);
console.log(`Client ID Length: ${clientId ? clientId.length : 'N/A'}`);
console.log(`Client ID Type:   ${clientId ? (isNaN(clientId) ? 'Alphanumeric' : 'Numeric') : 'N/A'}`);
console.log('');

if (!clientId || !apiKey || !apiSecret) {
  console.error('❌ ERROR: Missing required environment variables!');
  console.error('');
  console.error('Required in .env:');
  console.error('  TRUEX_CLIENT_ID=<your_client_id>');
  console.error('  TRUEX_API_KEY=<your_api_key>');
  console.error('  TRUEX_SECRET_KEY=<your_secret_key>');
  console.error('');
  process.exit(1);
}

// Test scenarios to try
const testScenarios = [
  {
    name: 'Scenario 1: Basic Party ID (Current Implementation)',
    description: 'Party ID with fields 453, 448, 452',
    fields: {
      '453': '1',                    // NoPartyIDs
      '448': clientId,               // PartyID
      '452': '3'                     // PartyRole = Client ID
    }
  },
  {
    name: 'Scenario 2: Party ID with PartyIDSource',
    description: 'Adding field 447 (PartyIDSource = D for proprietary)',
    fields: {
      '453': '1',                    // NoPartyIDs
      '447': 'D',                    // PartyIDSource = Proprietary
      '448': clientId,               // PartyID
      '452': '3'                     // PartyRole = Client ID
    }
  },
  {
    name: 'Scenario 3: Party ID with Source = General Identifier',
    description: 'PartyIDSource = C (General Identifier)',
    fields: {
      '453': '1',                    // NoPartyIDs
      '447': 'C',                    // PartyIDSource = General Identifier
      '448': clientId,               // PartyID
      '452': '3'                     // PartyRole = Client ID
    }
  },
  {
    name: 'Scenario 4: Party Role = Entering Firm',
    description: 'Using PartyRole = 1 (Entering Firm) instead of 3',
    fields: {
      '453': '1',                    // NoPartyIDs
      '448': clientId,               // PartyID
      '452': '1'                     // PartyRole = Entering Firm
    }
  }
];

// Results tracking
const results = [];
let fix;

async function runTests() {
  try {
    console.log('🔗 Connecting to TrueX...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Initialize FIX connection
    const fixHost = process.env.TRUEX_FIX_HOST || 'localhost';
    const fixPort = parseInt(process.env.TRUEX_FIX_PORT || '3004');
    const senderCompID = `VALIDATE_${testId}`;

    fix = new FIXConnection({
      host: fixHost,
      port: fixPort,
      senderCompID,
      targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE',
      apiKey,
      apiSecret,
      heartbeatInterval: 30,
      logger: console
    });

    // Track responses
    const responses = [];
    
    fix.on('message', (message) => {
      const msgType = message.fields['35'];
      const ordStatus = message.fields['39'];
      const rejectText = message.fields['58'];
      
      responses.push({
        msgType,
        ordStatus,
        rejectText,
        fields: message.fields
      });
      
      if (msgType === '8' && rejectText) {
        console.log(`   ⚠️  Rejection: "${rejectText}"`);
      }
    });

    // Connect
    console.log(`Connecting to ${fixHost}:${fixPort}...`);
    await fix.connect();
    console.log('✅ Connected and authenticated');
    console.log('');

    // Run test scenarios
    console.log('🧪 Running Test Scenarios:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    for (let i = 0; i < testScenarios.length; i++) {
      const scenario = testScenarios[i];
      
      console.log(`\n📌 ${scenario.name}`);
      console.log(`   ${scenario.description}`);
      console.log('');

      // Build order fields
      const clOrdID = `VAL${i}-${testId.toString().slice(-10)}`;  // Unique per scenario
      const orderFields = {
        '35': 'D',                    // MsgType = New Order Single
        '11': clOrdID,                // ClOrdID (≤18 chars)
        '55': 'BTC-PYUSD',            // Symbol
        '54': '1',                    // Side = Buy
        '38': '0.01',                 // OrderQty (minimum)
        '40': '2',                    // OrdType = Limit
        '44': '100000',               // Price (far from market)
        '59': '1',                    // TimeInForce = GTC
        ...scenario.fields            // Add scenario-specific Party fields
      };

      console.log('   Sending order with Party fields:');
      for (const [tag, value] of Object.entries(scenario.fields)) {
        const fieldName = getFieldName(tag);
        console.log(`     ${tag.padStart(3)} (${fieldName.padEnd(20)}): ${value}`);
      }
      console.log('');

      // Clear previous responses
      responses.length = 0;

      // Send order
      await fix.sendMessage(orderFields);
      console.log('   ✅ Order sent');

      // Wait for response
      console.log('   ⏳ Waiting for response (5 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Analyze response
      if (responses.length > 0) {
        const execReport = responses.find(r => r.msgType === '8');
        if (execReport) {
          const ordStatus = execReport.ordStatus;
          const rejectText = execReport.rejectText;
          
          const result = {
            scenario: scenario.name,
            clOrdID,
            partyFields: scenario.fields,
            ordStatus,
            ordStatusName: getOrdStatusName(ordStatus),
            rejectText,
            accepted: ordStatus === '0' || ordStatus === '1' || ordStatus === '2',
            rejected: ordStatus === '8'
          };
          
          results.push(result);
          
          if (result.accepted) {
            console.log(`   ✅ SUCCESS! Order accepted (OrdStatus: ${ordStatus})`);
          } else if (result.rejected) {
            console.log(`   ❌ REJECTED: ${rejectText} (OrdStatus: ${ordStatus})`);
          } else {
            console.log(`   ⚠️  Status: ${result.ordStatusName} (${ordStatus})`);
          }
        } else {
          console.log('   ⚠️  No execution report received');
          results.push({
            scenario: scenario.name,
            clOrdID,
            partyFields: scenario.fields,
            error: 'No execution report'
          });
        }
      } else {
        console.log('   ❌ No response received');
        results.push({
          scenario: scenario.name,
          clOrdID,
          partyFields: scenario.fields,
          error: 'No response'
        });
      }

      // Wait between scenarios
      if (i < testScenarios.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

  } catch (error) {
    console.error('');
    console.error('❌ TEST ERROR:');
    console.error(`   ${error.message}`);
    console.error('');
    console.error(error.stack);
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧹 Cleanup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (fix && fix.isConnected) {
    console.log('Disconnecting from TrueX...');
    await fix.disconnect();
    console.log('✅ Disconnected');
  }

  console.log('');
  printResults();
}

function printResults() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                       TEST RESULTS                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  if (results.length === 0) {
    console.log('⚠️  No results to display');
    console.log('');
    process.exit(1);
  }

  // Summary table
  console.log('📊 Summary:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  for (const result of results) {
    const status = result.accepted ? '✅ ACCEPTED' : 
                   result.rejected ? '❌ REJECTED' : 
                   result.error ? '⚠️  ERROR' : '❓ UNKNOWN';
    
    console.log(`${status} - ${result.scenario}`);
    
    if (result.rejected) {
      console.log(`        Reason: ${result.rejectText}`);
    } else if (result.error) {
      console.log(`        Error: ${result.error}`);
    }
    
    console.log('        Party Fields:');
    for (const [tag, value] of Object.entries(result.partyFields)) {
      console.log(`          ${tag} = ${value}`);
    }
    console.log('');
  }

  // Analysis
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 Analysis:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const acceptedScenarios = results.filter(r => r.accepted);
  const rejectedScenarios = results.filter(r => r.rejected);
  const errorScenarios = results.filter(r => r.error);

  console.log(`Total Tests:     ${results.length}`);
  console.log(`✅ Accepted:     ${acceptedScenarios.length}`);
  console.log(`❌ Rejected:     ${rejectedScenarios.length}`);
  console.log(`⚠️  Errors:       ${errorScenarios.length}`);
  console.log('');

  if (acceptedScenarios.length > 0) {
    console.log('🎉 SUCCESS! Found working configuration:');
    console.log('');
    for (const result of acceptedScenarios) {
      console.log(`   ${result.scenario}`);
      console.log('   Party Fields:');
      for (const [tag, value] of Object.entries(result.partyFields)) {
        const fieldName = getFieldName(tag);
        console.log(`     ${tag} (${fieldName}): ${value}`);
      }
      console.log('');
    }
  } else if (rejectedScenarios.length === results.length) {
    const uniqueReasons = [...new Set(rejectedScenarios.map(r => r.rejectText))];
    
    console.log('⚠️  All scenarios rejected with same error:');
    console.log('');
    for (const reason of uniqueReasons) {
      console.log(`   "${reason}"`);
    }
    console.log('');
    console.log('💡 This suggests:');
    console.log('   1. Client ID authorization issue (not field format issue)');
    console.log('   2. Account/permissions need to be configured in UAT');
    console.log('   3. Contact TrueX support to enable client ID');
    console.log('');
  }

  // Recommendations
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 Recommendations:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (acceptedScenarios.length > 0) {
    console.log('✅ Use the accepted configuration in production');
    console.log('✅ Update FIXConnection to include working Party fields');
  } else {
    console.log('📧 Contact TrueX Support (support@truex.co):');
    console.log('');
    console.log('   Subject: "Client ID Authorization - UAT Environment"');
    console.log('');
    console.log('   Body:');
    console.log('   ------');
    console.log(`   Client ID: ${clientId}`);
    console.log(`   Environment: UAT`);
    console.log('   Issue: All orders rejected with "Invalid client"');
    console.log('   Request: Please enable this client ID in UAT environment');
    console.log('');
    console.log('   Tested configurations:');
    for (const result of results) {
      console.log(`   - ${result.scenario}: ${result.rejectText || result.error}`);
    }
    console.log('   ------');
  }

  console.log('');
  process.exit(acceptedScenarios.length > 0 ? 0 : 1);
}

function getFieldName(tag) {
  const fieldNames = {
    '447': 'PartyIDSource',
    '448': 'PartyID',
    '452': 'PartyRole',
    '453': 'NoPartyIDs'
  };
  return fieldNames[tag] || `Field${tag}`;
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

// Run the tests
runTests().catch(error => {
  console.error('');
  console.error('💥 FATAL ERROR:');
  console.error(error);
  console.error('');
  process.exit(1);
});



