const net = require('net');
const fs = require('fs');
const path = require('path');
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
 * TrueX FIX Market Data Observer with File Logging
 * 
 * Simple market maker that:
 * 1. Connects via FIX
 * 2. Subscribes to BTC-PYUSD market data
 * 3. Observes market data for 5 minutes
 * 4. Logs all market data updates to both console and file
 */
class TrueXFIXMarketDataObserver {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.isLoggedIn = false;
    this.sequenceNumber = 1;
    this.observationStartTime = null;
    this.observationDuration = 5 * 60 * 1000; // 5 minutes
    
    // Create log files
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(__dirname, `truex-market-data-${timestamp}.log`);
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    
    // Create structured data files
    this.dataFile = path.join(__dirname, `truex-market-data-${timestamp}.json`);
    this.rawMessagesFile = path.join(__dirname, `truex-raw-messages-${timestamp}.log`);
    
    this.marketDataStats = {
      snapshotsReceived: 0,
      incrementalUpdatesReceived: 0,
      tradesReceived: 0,
      bidUpdates: 0,
      askUpdates: 0,
      lastBid: null,
      lastAsk: null,
      lastTrade: null,
      allBids: [],
      allAsks: [],
      allTrades: [],
      allMessages: [],
      sessionStart: new Date().toISOString(),
      sessionEnd: null
    };
  }

  log(message, writeToFile = true) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    
    console.log(message);
    
    if (writeToFile && this.logStream) {
      this.logStream.write(logMessage + '\n');
    }
  }

  async start() {
    this.log('🔌 TrueX FIX Market Data Observer with File Logging');
    this.log('===================================================');
    this.log(`Time: ${new Date().toISOString()}`);
    this.log(`Symbol: BTC-PYUSD`);
    this.log(`Observation Duration: 5 minutes`);
    this.log(`Log File: ${this.logFile}`);
    this.log('');

    try {
      await this.connect();
      await this.login();
      await this.subscribeToMarketData();
      await this.observeMarketData();
    } catch (error) {
      this.log(`❌ Observer failed: ${error.message}`);
      throw error;
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.log('🔄 Connecting to TrueX FIX Gateway via proxy...');
      
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
        this.log('✅ Connected to TrueX FIX Gateway');
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        this.log(`❌ Connection error: ${error.message}`);
        reject(error);
      });

      this.socket.on('close', () => {
        this.log('🔌 Connection closed');
        this.isConnected = false;
        // Don't exit immediately - let the 5-minute timer complete
        this.log('   Connection closed but continuing observation timer...');
      });

      this.socket.on('data', (data) => {
        this.handleFIXMessage(data);
      });
    });
  }

  async login() {
    return new Promise((resolve, reject) => {
      this.log('🔐 Sending FIX Logon message...');
      
      const apiKey = process.env.TRUEX_API_KEY;
      const apiSecret = process.env.TRUEX_SECRET_KEY;

      if (!apiKey || !apiSecret) {
        reject(new Error('Missing TrueX credentials'));
        return;
      }

      const { message: logonMessage } = buildTrueXLogonMessage(apiKey, apiSecret);
      
      this.log('📤 Logon message sent');
      this.socket.write(logonMessage, 'utf8');

      // Set up one-time listener for logon response
      this.loginResolver = resolve;
      this.loginRejecter = reject;

      // Timeout for login
      setTimeout(() => {
        if (!this.isLoggedIn) {
          reject(new Error('Login timeout'));
        }
      }, 15000);
    });
  }

  async subscribeToMarketData() {
    return new Promise((resolve, reject) => {
      this.log('📡 Subscribing to BTC-PYUSD market data...');
      
      const apiKey = process.env.TRUEX_API_KEY;
      const apiSecret = process.env.TRUEX_SECRET_KEY;
      const mdReqId = `MD_BTC_${Date.now()}`;
      const symbol = 'BTC-USD';

      this.sequenceNumber++;
      const { message: mdRequest } = buildMarketDataRequest(
        apiKey,
        apiSecret,
        mdReqId,
        symbol,
        this.sequenceNumber.toString()
      );

      this.log('📤 Market Data Request sent');
      this.log(`   MDReqID: ${mdReqId}`);
      this.log(`   Symbol: ${symbol}`);
      this.log(`   SubscriptionType: 1 (Snapshot + Updates)`);
      this.log('');

      this.socket.write(mdRequest, 'utf8');

      // Set up one-time listener for market data response
      this.mdSubscriptionResolver = resolve;
      this.mdSubscriptionRejecter = reject;

      // Timeout for subscription
      setTimeout(() => {
        if (!this.mdSubscriptionResolver) return;
        reject(new Error('Market data subscription timeout'));
      }, 15000);
    });
  }

  async observeMarketData() {
    this.log('👀 Starting market data observation...');
    this.log('=====================================');
    this.observationStartTime = Date.now();
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - this.observationStartTime;
        const remaining = this.observationDuration - elapsed;
        
        if (remaining <= 0) {
          clearInterval(checkInterval);
          this.printFinalStats();
          this.disconnect();
          resolve();
        } else {
          // Print periodic status (only to console, not file)
          const remainingMinutes = Math.floor(remaining / 60000);
          const remainingSeconds = Math.floor((remaining % 60000) / 1000);
          const statusMsg = `⏱️  Observing... ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')} remaining`;
          
          // Write status to file but not console (to avoid clutter)
          if (this.logStream) {
            this.logStream.write(`[${new Date().toISOString()}] ${statusMsg}\n`);
          }
          
          // Only print to console every 30 seconds to reduce noise
          if (remainingSeconds % 30 === 0) {
            console.log(statusMsg);
          }
        }
      }, 1000);
    });
  }

  handleFIXMessage(data) {
    const message = data.toString();
    const displayMessage = message.replace(new RegExp(SOH, 'g'), '|');
    const timestamp = new Date().toISOString();
    
    // Save raw message to structured data
    this.saveRawMessage(message, timestamp);
    
    // Log raw message to file only (too verbose for console)
    this.logStream.write(`[${timestamp}] 📨 RAW FIX: ${displayMessage}\n`);
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([^\x01]+)/);
    if (!msgTypeMatch) {
      this.log(`⚠️  No message type found in message`);
      return;
    }
    
    const msgType = msgTypeMatch[1];
    
    switch (msgType) {
      case 'A': // Logon response
        this.log('✅ FIX Logon accepted');
        this.isLoggedIn = true;
        if (this.loginResolver) {
          this.loginResolver();
          this.loginResolver = null;
        }
        break;

      case '5': // Logout
        this.log('❌ FIX Logout received');
        const textMatch = message.match(/58=([^\x01]+)/);
        if (textMatch) {
          this.log(`   Reason: ${textMatch[1]}`);
        }
        if (this.loginRejecter) {
          this.loginRejecter(new Error('Login rejected'));
        }
        // Exit on logout as this indicates session termination
        this.log('   Session terminated by TrueX - ending observation');
        this.printFinalStats();
        this.disconnect();
        process.exit(0);
        break;

      case 'W': // Market Data Snapshot Full Refresh
        this.handleMarketDataSnapshot(message);
        if (this.mdSubscriptionResolver) {
          this.log('✅ Market data subscription successful');
          this.mdSubscriptionResolver();
          this.mdSubscriptionResolver = null;
        }
        break;

      case 'X': // Market Data Incremental Refresh
        this.handleMarketDataIncremental(message);
        break;

      case 'Y': // Market Data Request Reject
        this.log('❌ Market Data Request Rejected');
        const rejectTextMatch = message.match(/58=([^\x01]+)/);
        if (rejectTextMatch) {
          this.log(`   Reason: ${rejectTextMatch[1]}`);
        }
        if (this.mdSubscriptionRejecter) {
          this.mdSubscriptionRejecter(new Error('Market data subscription rejected'));
        }
        break;

      case '1': // Test Request - Must respond with Heartbeat
        this.log('💓 Test Request received - sending Heartbeat response');
        this.sendHeartbeat(message);
        break;

      case '0': // Heartbeat
        this.log('💓 Heartbeat received');
        break;

      default:
        this.log(`📨 Other FIX message (${msgType}): ${displayMessage.substring(0, 100)}`);
        break;
    }
  }

  handleMarketDataSnapshot(message) {
    this.marketDataStats.snapshotsReceived++;
    
    this.log('\n📊 Market Data Snapshot Received');
    this.log('================================');
    
    // Parse market data entries
    const entries = this.parseMarketDataEntries(message);
    
    for (const entry of entries) {
      if (entry.type === '0') { // Bid
        this.marketDataStats.bidUpdates++;
        this.marketDataStats.lastBid = { price: entry.price, size: entry.size, time: entry.time };
        this.marketDataStats.allBids.push({ ...this.marketDataStats.lastBid, timestamp: Date.now() });
        this.log(`💰 BID: $${entry.price} (${entry.size} BTC) [Level ${entry.level || 1}]`);
      } else if (entry.type === '1') { // Ask/Offer
        this.marketDataStats.askUpdates++;
        this.marketDataStats.lastAsk = { price: entry.price, size: entry.size, time: entry.time };
        this.marketDataStats.allAsks.push({ ...this.marketDataStats.lastAsk, timestamp: Date.now() });
        this.log(`💸 ASK: $${entry.price} (${entry.size} BTC) [Level ${entry.level || 1}]`);
      } else if (entry.type === '2') { // Trade
        this.marketDataStats.tradesReceived++;
        this.marketDataStats.lastTrade = { price: entry.price, size: entry.size, time: entry.time };
        this.marketDataStats.allTrades.push({ ...this.marketDataStats.lastTrade, timestamp: Date.now() });
        this.log(`🔄 TRADE: $${entry.price} (${entry.size} BTC) ${entry.aggressorSide === '1' ? '[BUY]' : '[SELL]'}`);
      }
    }
    
    if (this.marketDataStats.lastBid && this.marketDataStats.lastAsk) {
      const spread = parseFloat(this.marketDataStats.lastAsk.price) - parseFloat(this.marketDataStats.lastBid.price);
      const spreadBps = (spread / parseFloat(this.marketDataStats.lastBid.price)) * 10000;
      this.log(`📈 SPREAD: $${spread.toFixed(2)} (${spreadBps.toFixed(1)} bps)`);
    }
    this.log('');
  }

  handleMarketDataIncremental(message) {
    this.marketDataStats.incrementalUpdatesReceived++;
    
    // Parse incremental updates
    const entries = this.parseMarketDataEntries(message);
    
    for (const entry of entries) {
      const action = entry.action === '0' ? 'NEW' : entry.action === '1' ? 'CHANGE' : 'DELETE';
      
      if (entry.type === '0') { // Bid
        this.marketDataStats.bidUpdates++;
        this.log(`📊 BID ${action}: $${entry.price} (${entry.size} BTC)`);
      } else if (entry.type === '1') { // Ask
        this.marketDataStats.askUpdates++;
        this.log(`📊 ASK ${action}: $${entry.price} (${entry.size} BTC)`);
      } else if (entry.type === '2') { // Trade
        this.marketDataStats.tradesReceived++;
        this.marketDataStats.allTrades.push({ 
          price: entry.price, 
          size: entry.size, 
          time: entry.time,
          timestamp: Date.now()
        });
        this.log(`🔄 TRADE: $${entry.price} (${entry.size} BTC) ${entry.aggressorSide === '1' ? '[BUY]' : '[SELL]'}`);
      }
    }
  }

  parseMarketDataEntries(message) {
    const entries = [];
    
    // Simple parsing - in production, use a proper FIX parser
    const fields = message.split(SOH);
    let currentEntry = {};
    
    for (const field of fields) {
      if (!field.includes('=')) continue;
      
      const [tag, value] = field.split('=');
      
      switch (tag) {
        case '279': // MDUpdateAction (for incremental)
          currentEntry.action = value;
          break;
        case '269': // MDEntryType
          if (Object.keys(currentEntry).length > 0) {
            entries.push({ ...currentEntry });
            currentEntry = {};
          }
          currentEntry.type = value;
          break;
        case '270': // MDEntryPx
          currentEntry.price = value;
          break;
        case '271': // MDEntrySize
          currentEntry.size = value;
          break;
        case '273': // MDEntryTime
          currentEntry.time = value;
          break;
        case '1023': // MDPriceLevel
          currentEntry.level = value;
          break;
        case '2446': // AggressorSide
          currentEntry.aggressorSide = value;
          break;
      }
    }
    
    if (Object.keys(currentEntry).length > 0) {
      entries.push(currentEntry);
    }
    
    return entries;
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
      this.log(`💓 Heartbeat sent (SeqNum: ${this.sequenceNumber})`);
    }
  }

  saveRawMessage(message, timestamp) {
    // Save to raw messages file
    fs.appendFileSync(this.rawMessagesFile, `[${timestamp}] ${message.replace(new RegExp(SOH, 'g'), '|')}\n`);
    
    // Add to structured data
    this.marketDataStats.allMessages.push({
      timestamp,
      message: message.replace(new RegExp(SOH, 'g'), '|'),
      rawMessage: message
    });
  }

  saveMarketDataToFile() {
    // Update session end time
    this.marketDataStats.sessionEnd = new Date().toISOString();
    
    // Create comprehensive data structure
    const marketDataExport = {
      sessionInfo: {
        start: this.marketDataStats.sessionStart,
        end: this.marketDataStats.sessionEnd,
        duration: '5 minutes',
        symbol: 'BTC-PYUSD',
        exchange: 'TrueX UAT'
      },
      statistics: {
        snapshotsReceived: this.marketDataStats.snapshotsReceived,
        incrementalUpdatesReceived: this.marketDataStats.incrementalUpdatesReceived,
        totalTrades: this.marketDataStats.tradesReceived,
        bidUpdates: this.marketDataStats.bidUpdates,
        askUpdates: this.marketDataStats.askUpdates,
        totalMessages: this.marketDataStats.allMessages.length
      },
      marketData: {
        bids: this.marketDataStats.allBids,
        asks: this.marketDataStats.allAsks,
        trades: this.marketDataStats.allTrades,
        lastBid: this.marketDataStats.lastBid,
        lastAsk: this.marketDataStats.lastAsk,
        lastTrade: this.marketDataStats.lastTrade
      },
      rawMessages: this.marketDataStats.allMessages
    };
    
    // Save to JSON file
    fs.writeFileSync(this.dataFile, JSON.stringify(marketDataExport, null, 2));
    
    this.log(`\n📁 Market data saved to: ${this.dataFile}`);
    this.log(`📁 Raw messages saved to: ${this.rawMessagesFile}`);
  }

  printFinalStats() {
    this.log('\n\n📊 Final Market Data Statistics');
    this.log('===============================');
    this.log(`Observation Duration: 5 minutes`);
    this.log(`Snapshots Received: ${this.marketDataStats.snapshotsReceived}`);
    this.log(`Incremental Updates: ${this.marketDataStats.incrementalUpdatesReceived}`);
    this.log(`Total Trades: ${this.marketDataStats.tradesReceived}`);
    this.log(`Bid Updates: ${this.marketDataStats.bidUpdates}`);
    this.log(`Ask Updates: ${this.marketDataStats.askUpdates}`);
    this.log(`Total Messages: ${this.marketDataStats.allMessages.length}`);
    
    if (this.marketDataStats.lastBid) {
      this.log(`Last Bid: $${this.marketDataStats.lastBid.price} (${this.marketDataStats.lastBid.size} BTC)`);
    }
    
    if (this.marketDataStats.lastAsk) {
      this.log(`Last Ask: $${this.marketDataStats.lastAsk.price} (${this.marketDataStats.lastAsk.size} BTC)`);
    }
    
    if (this.marketDataStats.lastTrade) {
      this.log(`Last Trade: $${this.marketDataStats.lastTrade.price} (${this.marketDataStats.lastTrade.size} BTC)`);
    }

    // Save all market data to structured files
    this.saveMarketDataToFile();
    
    this.log(`\n📁 Session logs saved to: ${this.logFile}`);
    this.log('\n✅ Market data observation completed successfully');
  }


  disconnect() {
    if (this.socket && this.isConnected) {
      this.log('\n🔌 Disconnecting from TrueX FIX Gateway...');
      this.socket.end();
    }
    
    if (this.logStream) {
      this.logStream.end();
    }
  }
}

// Run the market data observer
async function main() {
  const observer = new TrueXFIXMarketDataObserver();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    observer.disconnect();
    process.exit(0);
  });
  
  try {
    await observer.start();
    console.log('\n🎉 Market data observation completed');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Observer failed:', error.message);
    process.exit(1);
  }
}

// Start the observer
main();
