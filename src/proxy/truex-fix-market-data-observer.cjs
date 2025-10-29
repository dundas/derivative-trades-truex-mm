const net = require('net');
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
 * TrueX FIX Market Data Observer
 * 
 * Simple market maker that:
 * 1. Connects via FIX
 * 2. Subscribes to BTC-PYUSD market data
 * 3. Observes market data for 5 minutes
 * 4. Logs all market data updates
 */
class TrueXFIXMarketDataObserver {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.isLoggedIn = false;
    this.sequenceNumber = 1;
    this.observationStartTime = null;
    this.observationDuration = 5 * 60 * 1000; // 5 minutes
    this.marketDataStats = {
      snapshotsReceived: 0,
      incrementalUpdatesReceived: 0,
      tradesReceived: 0,
      bidUpdates: 0,
      askUpdates: 0,
      lastBid: null,
      lastAsk: null,
      lastTrade: null
    };
  }

  async start() {
    console.log('🔌 TrueX FIX Market Data Observer');
    console.log('=================================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Symbol: BTC-PYUSD`);
    console.log(`Observation Duration: 5 minutes`);
    console.log('');

    try {
      await this.connect();
      await this.login();
      await this.subscribeToMarketData();
      await this.observeMarketData();
    } catch (error) {
      console.error('❌ Observer failed:', error.message);
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
        this.handleConnectionClosed();
      });

      this.socket.on('data', (data) => {
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
      }, 15000);
    });
  }

  async subscribeToMarketData() {
    return new Promise((resolve, reject) => {
      console.log('📡 Subscribing to BTC-PYUSD market data...');
      
      const apiKey = process.env.TRUEX_API_KEY;
      const apiSecret = process.env.TRUEX_SECRET_KEY;
      const mdReqId = `MD_BTC_${Date.now()}`;
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
      console.log(`   MDReqID: ${mdReqId}`);
      console.log(`   Symbol: ${symbol}`);
      console.log(`   SubscriptionType: 1 (Snapshot + Updates)`);
      console.log('');

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
    console.log('👀 Starting market data observation...');
    console.log('=====================================');
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
          // Print periodic status
          const remainingMinutes = Math.floor(remaining / 60000);
          const remainingSeconds = Math.floor((remaining % 60000) / 1000);
          process.stdout.write(`\r⏱️  Observing... ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')} remaining`);
        }
      }, 1000);
    });
  }

  handleFIXMessage(data) {
    const message = data.toString();
    const displayMessage = message.replace(new RegExp(SOH, 'g'), '|');
    
    // Debug: log all received messages
    console.log(`📨 RAW FIX MESSAGE: ${displayMessage}`);
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([^\x01]+)/);
    if (!msgTypeMatch) {
      console.log('⚠️  No message type found in:', displayMessage);
      return;
    }
    
    const msgType = msgTypeMatch[1];
    console.log(`📋 Message Type: ${msgType}`);
    
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
        if (this.loginRejecter) {
          this.loginRejecter(new Error('Login rejected'));
        }
        // Exit when we receive a logout
        this.handleConnectionClosed();
        break;

      case 'W': // Market Data Snapshot Full Refresh
        this.handleMarketDataSnapshot(message);
        if (this.mdSubscriptionResolver) {
          console.log('✅ Market data subscription successful');
          this.mdSubscriptionResolver();
          this.mdSubscriptionResolver = null;
        }
        break;

      case 'X': // Market Data Incremental Refresh
        this.handleMarketDataIncremental(message);
        break;

      case 'Y': // Market Data Request Reject
        console.log('❌ Market Data Request Rejected');
        const rejectTextMatch = message.match(/58=([^\x01]+)/);
        if (rejectTextMatch) {
          console.log(`   Reason: ${rejectTextMatch[1]}`);
        }
        if (this.mdSubscriptionRejecter) {
          this.mdSubscriptionRejecter(new Error('Market data subscription rejected'));
        }
        break;

      default:
        console.log(`📨 Other FIX message (${msgType}):`, displayMessage.substring(0, 100));
        break;
    }
  }

  handleMarketDataSnapshot(message) {
    this.marketDataStats.snapshotsReceived++;
    
    console.log('\n📊 Market Data Snapshot Received');
    console.log('================================');
    
    // Parse market data entries
    const entries = this.parseMarketDataEntries(message);
    
    for (const entry of entries) {
      if (entry.type === '0') { // Bid
        this.marketDataStats.bidUpdates++;
        this.marketDataStats.lastBid = { price: entry.price, size: entry.size, time: entry.time };
        console.log(`💰 BID: $${entry.price} (${entry.size} BTC) [Level ${entry.level || 1}]`);
      } else if (entry.type === '1') { // Ask/Offer
        this.marketDataStats.askUpdates++;
        this.marketDataStats.lastAsk = { price: entry.price, size: entry.size, time: entry.time };
        console.log(`💸 ASK: $${entry.price} (${entry.size} BTC) [Level ${entry.level || 1}]`);
      } else if (entry.type === '2') { // Trade
        this.marketDataStats.tradesReceived++;
        this.marketDataStats.lastTrade = { price: entry.price, size: entry.size, time: entry.time };
        console.log(`🔄 TRADE: $${entry.price} (${entry.size} BTC) ${entry.aggressorSide === '1' ? '[BUY]' : '[SELL]'}`);
      }
    }
    
    if (this.marketDataStats.lastBid && this.marketDataStats.lastAsk) {
      const spread = parseFloat(this.marketDataStats.lastAsk.price) - parseFloat(this.marketDataStats.lastBid.price);
      const spreadBps = (spread / parseFloat(this.marketDataStats.lastBid.price)) * 10000;
      console.log(`📈 SPREAD: $${spread.toFixed(2)} (${spreadBps.toFixed(1)} bps)`);
    }
    console.log('');
  }

  handleMarketDataIncremental(message) {
    this.marketDataStats.incrementalUpdatesReceived++;
    
    // Parse incremental updates
    const entries = this.parseMarketDataEntries(message);
    
    for (const entry of entries) {
      const action = entry.action === '0' ? 'NEW' : entry.action === '1' ? 'CHANGE' : 'DELETE';
      
      if (entry.type === '0') { // Bid
        this.marketDataStats.bidUpdates++;
        console.log(`📊 BID ${action}: $${entry.price} (${entry.size} BTC)`);
      } else if (entry.type === '1') { // Ask
        this.marketDataStats.askUpdates++;
        console.log(`📊 ASK ${action}: $${entry.price} (${entry.size} BTC)`);
      } else if (entry.type === '2') { // Trade
        this.marketDataStats.tradesReceived++;
        console.log(`🔄 TRADE: $${entry.price} (${entry.size} BTC) ${entry.aggressorSide === '1' ? '[BUY]' : '[SELL]'}`);
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

  printFinalStats() {
    console.log('\n\n📊 Final Market Data Statistics');
    console.log('===============================');
    console.log(`Observation Duration: 5 minutes`);
    console.log(`Snapshots Received: ${this.marketDataStats.snapshotsReceived}`);
    console.log(`Incremental Updates: ${this.marketDataStats.incrementalUpdatesReceived}`);
    console.log(`Total Trades: ${this.marketDataStats.tradesReceived}`);
    console.log(`Bid Updates: ${this.marketDataStats.bidUpdates}`);
    console.log(`Ask Updates: ${this.marketDataStats.askUpdates}`);
    
    if (this.marketDataStats.lastBid) {
      console.log(`Last Bid: $${this.marketDataStats.lastBid.price} (${this.marketDataStats.lastBid.size} BTC)`);
    }
    
    if (this.marketDataStats.lastAsk) {
      console.log(`Last Ask: $${this.marketDataStats.lastAsk.price} (${this.marketDataStats.lastAsk.size} BTC)`);
    }
    
    if (this.marketDataStats.lastTrade) {
      console.log(`Last Trade: $${this.marketDataStats.lastTrade.price} (${this.marketDataStats.lastTrade.size} BTC)`);
    }
    
    console.log('\n✅ Market data observation completed successfully');
  }

  handleConnectionClosed() {
    console.log('\n🚨 Connection closed unexpectedly - ending observation');
    
    // Print current stats before exiting
    this.printFinalStats();
    
    // Clean up and exit
    this.disconnect();
    
    // Exit the process
    process.exit(0);
  }

  disconnect() {
    if (this.socket && this.isConnected) {
      console.log('\n🔌 Disconnecting from TrueX FIX Gateway...');
      this.socket.end();
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
