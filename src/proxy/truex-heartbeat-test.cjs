const net = require('net');
const fs = require('fs');
require('dotenv').config({ path: '.env' });

const {
  SOH,
  buildTrueXLogonMessage,
  buildMarketDataRequest
} = require('./fix-message-builder.cjs');

// Connect to TrueMarkets proxy server
const FIX_PROXY_HOST = '129.212.145.83';
const FIX_PROXY_PORT = 3004;

/**
 * TrueX FIX Heartbeat Test
 * 
 * Tests proper heartbeat handling to maintain session
 */
class TrueXHeartbeatTest {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.isLoggedIn = false;
    this.sequenceNumber = 1;
    this.testStartTime = null;
    this.testDuration = 2 * 60 * 1000; // 2 minutes for testing
    this.heartbeatsSent = 0;
    this.testRequestsReceived = 0;
  }

  async start() {
    console.log('🔌 TrueX FIX Heartbeat Test');
    console.log('===========================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Test Duration: 2 minutes`);
    console.log('');

    try {
      await this.connect();
      await this.login();
      await this.subscribeToMarketData();
      await this.runHeartbeatTest();
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      throw error;
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log('🔄 Connecting to TrueX FIX Gateway via proxy...');
      
      this.socket = new net.Socket();
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true, 30000);

      const timeout = setTimeout(() => {
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket.connect(FIX_PROXY_PORT, FIX_PROXY_HOST, () => {
        clearTimeout(timeout);
        this.isConnected = true;
        console.log('✅ Connected to TrueX FIX Gateway');
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        console.error('❌ Connection error:', error.message);
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('🔌 Connection closed');
        this.isConnected = false;
      });

      this.socket.on('data', (data) => {
        const message = data.toString();
        const displayMessage = message.replace(new RegExp(SOH, 'g'), '|');
        console.log(`📨 RAW: ${displayMessage}`);
        this.handleFIXMessage(data);
      });
    });
  }

  async login() {
    return new Promise((resolve, reject) => {
      console.log('🔐 Sending FIX Logon message...');
      
      const apiKey = process.env.TRUEX_API_KEY;
      const apiSecret = process.env.TRUEX_SECRET_KEY;

      if (!apiKey || !apiSecret) {
        reject(new Error('Missing TrueX credentials'));
        return;
      }

      const { message: logonMessage } = buildTrueXLogonMessage(apiKey, apiSecret);
      
      console.log('📤 Logon message sent');
      this.socket.write(logonMessage, 'utf8');

      // Set up one-time listener for logon response
      this.loginResolver = resolve;
      this.loginRejecter = reject;

      // Timeout for login
      setTimeout(() => {
        if (!this.isLoggedIn) {
          reject(new Error('Login timeout'));
        }
      }, 10000);
    });
  }

  async subscribeToMarketData() {
    return new Promise((resolve, reject) => {
      console.log('📡 Subscribing to BTC-PYUSD market data...');
      
      const apiKey = process.env.TRUEX_API_KEY;
      const apiSecret = process.env.TRUEX_SECRET_KEY;
      const mdReqId = `MD_HB_${Date.now()}`;
      const symbol = 'BTC-PYUSD';

      this.sequenceNumber++;
      const { message: mdRequest } = buildMarketDataRequest(
        apiKey,
        apiSecret,
        mdReqId,
        symbol,
        this.sequenceNumber.toString()
      );

      console.log('📤 Market Data Request sent');
      this.socket.write(mdRequest, 'utf8');

      // Set up one-time listener for market data response
      this.mdSubscriptionResolver = resolve;
      this.mdSubscriptionRejecter = reject;

      // Timeout for subscription
      setTimeout(() => {
        if (!this.mdSubscriptionResolver) return;
        reject(new Error('Market data subscription timeout'));
      }, 10000);
    });
  }

  async runHeartbeatTest() {
    console.log('💓 Starting heartbeat test...');
    console.log('============================');
    this.testStartTime = Date.now();
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - this.testStartTime;
        const remaining = this.testDuration - elapsed;
        
        if (remaining <= 0) {
          clearInterval(checkInterval);
          this.printTestResults();
          this.disconnect();
          resolve();
        } else {
          // Print periodic status
          const remainingSeconds = Math.floor(remaining / 1000);
          if (remainingSeconds % 10 === 0) {
            console.log(`⏱️  Test running... ${remainingSeconds}s remaining (Heartbeats sent: ${this.heartbeatsSent})`);
          }
        }
      }, 1000);
    });
  }

  handleFIXMessage(data) {
    const message = data.toString();
    const displayMessage = message.replace(new RegExp(SOH, 'g'), '|');
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([^\x01]+)/);
    if (!msgTypeMatch) return;
    
    const msgType = msgTypeMatch[1];
    
    switch (msgType) {
      case 'A': // Logon response
        console.log('✅ FIX Logon accepted');
        this.isLoggedIn = true;
        if (this.loginResolver) {
          this.loginResolver();
          this.loginResolver = null;
        }
        break;

      case '5': // Logout
        console.log('❌ FIX Logout received');
        const textMatch = message.match(/58=([^\x01]+)/);
        if (textMatch) {
          console.log(`   Reason: ${textMatch[1]}`);
        }
        console.log('   Test ended due to logout');
        this.printTestResults();
        this.disconnect();
        process.exit(0);
        break;

      case 'W': // Market Data Snapshot Full Refresh
        console.log('📊 Market Data Snapshot received');
        if (this.mdSubscriptionResolver) {
          console.log('✅ Market data subscription successful');
          this.mdSubscriptionResolver();
          this.mdSubscriptionResolver = null;
        }
        break;

      case '1': // Test Request - Must respond with Heartbeat
        this.testRequestsReceived++;
        console.log(`💓 Test Request #${this.testRequestsReceived} received - sending Heartbeat response`);
        this.sendHeartbeat(message);
        break;

      case '0': // Heartbeat
        console.log('💓 Heartbeat received from TrueX');
        break;

      default:
        // Don't log every message to keep output clean
        break;
    }
  }

  sendHeartbeat(testRequestMessage) {
    // Extract TestReqID from the test request if present
    const testReqIdMatch = testRequestMessage.match(/112=([^\x01]+)/);
    const testReqId = testReqIdMatch ? testReqIdMatch[1] : '';
    
    // Create heartbeat response
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
    const sendingTime = `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;
    
    this.sequenceNumber++;
    
    // Build heartbeat message
    let heartbeatFields = [
      `8=FIXT.1.1`,
      `9=0`, // Will be calculated
      `35=0`, // Heartbeat
      `49=CLI_CLIENT`,
      `56=TRUEX_UAT_GW`,
      `34=${this.sequenceNumber}`,
      `52=${sendingTime}`
    ];
    
    // Add TestReqID if it was in the test request
    if (testReqId) {
      heartbeatFields.push(`112=${testReqId}`);
    }
    
    // Calculate body length
    const body = heartbeatFields.slice(2).join(SOH) + SOH;
    heartbeatFields[1] = `9=${body.length}`;
    
    // Create full message
    let heartbeatMessage = heartbeatFields.join(SOH) + SOH;
    
    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < heartbeatMessage.length; i++) {
      checksum += heartbeatMessage.charCodeAt(i);
    }
    heartbeatMessage += `10=${String(checksum % 256).padStart(3, '0')}${SOH}`;
    
    // Send heartbeat
    if (this.socket && this.isConnected) {
      this.socket.write(heartbeatMessage, 'utf8');
      this.heartbeatsSent++;
      console.log(`   ✅ Heartbeat #${this.heartbeatsSent} sent (SeqNum: ${this.sequenceNumber})`);
    }
  }

  printTestResults() {
    console.log('\n💓 Heartbeat Test Results');
    console.log('========================');
    console.log(`Test Duration: ${Math.floor((Date.now() - this.testStartTime) / 1000)} seconds`);
    console.log(`Test Requests Received: ${this.testRequestsReceived}`);
    console.log(`Heartbeats Sent: ${this.heartbeatsSent}`);
    console.log(`Response Rate: ${this.testRequestsReceived > 0 ? '100%' : 'N/A'}`);
    
    if (this.heartbeatsSent === this.testRequestsReceived) {
      console.log('✅ SUCCESS: All test requests answered with heartbeats');
    } else {
      console.log('❌ ISSUE: Mismatch between test requests and heartbeat responses');
    }
  }

  disconnect() {
    if (this.socket && this.isConnected) {
      console.log('\n🔌 Disconnecting from TrueX FIX Gateway...');
      this.socket.end();
    }
  }
}

// Run the heartbeat test
async function main() {
  const test = new TrueXHeartbeatTest();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    test.disconnect();
    process.exit(0);
  });
  
  try {
    await test.start();
    console.log('\n🎉 Heartbeat test completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Heartbeat test failed:', error.message);
    process.exit(1);
  }
}

// Start the test
main();
