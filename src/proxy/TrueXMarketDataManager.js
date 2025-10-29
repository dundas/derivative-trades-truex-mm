const net = require('net');
const EventEmitter = require('events');
require('dotenv').config({ path: '.env' });

const {
  SOH,
  buildTrueXLogonMessage,
  buildMarketDataRequest,
  parseMarketDataSnapshot,
  parseMarketDataIncremental
} = require('./fix-message-builder.cjs');

/**
 * TrueX Market Data Subscription Manager
 * 
 * Manages persistent FIX connections to TrueX for real-time market data.
 * Handles automatic reconnection, subscription management, and data parsing.
 * 
 * Events:
 * - 'connected' - FIX session established
 * - 'disconnected' - FIX session lost
 * - 'market_data' - New market data received
 * - 'error' - Connection or parsing errors
 */
class TrueXMarketDataManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.proxyHost = options.proxyHost || '129.212.145.83';
    this.proxyPort = options.proxyPort || 3004;
    this.apiKey = options.apiKey || process.env.TRUEX_API_KEY;
    this.apiSecret = options.apiSecret || process.env.TRUEX_SECRET_KEY;
    this.reconnectInterval = options.reconnectInterval || 5000;
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    
    // Connection state
    this.socket = null;
    this.isConnected = false;
    this.isLoggedIn = false;
    this.msgSeqNum = 1;
    this.lastHeartbeat = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    
    // Subscription management
    this.subscriptions = new Map();
    this.marketData = new Map();
    
    // Market data processing
    this.priceHistory = new Map();
    this.ohlcData = new Map();
    this.lastUpdateTime = new Map();
    
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('TrueX API credentials required');
    }
  }

  /**
   * Start the market data manager
   */
  async start() {
    console.log('🚀 Starting TrueX Market Data Manager');
    await this.connect();
  }

  /**
   * Stop the market data manager
   */
  async stop() {
    console.log('🛑 Stopping TrueX Market Data Manager');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    
    this.isConnected = false;
    this.isLoggedIn = false;
  }

  /**
   * Connect to TrueX FIX gateway
   */
  async connect() {
    if (this.socket) {
      console.log('⚠️ Already connected or connecting');
      return;
    }
    
    console.log(`🔌 Connecting to TrueX via proxy ${this.proxyHost}:${this.proxyPort}`);
    
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.handleConnectionError(new Error('Connection timeout'));
          reject(new Error('Connection timeout'));
        }
      }, 15000);
      
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true, this.heartbeatInterval);
      
      this.socket.connect(this.proxyPort, this.proxyHost, () => {
        console.log('✅ Connected to TrueX proxy');
        this.isConnected = true;
        
        // Wait for proxy setup, then send logon
        setTimeout(async () => {
          try {
            await this.sendLogon();
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve();
            }
          } catch (error) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              reject(error);
            }
          }
        }, 3000);
      });
      
      this.socket.on('data', (data) => {
        this.handleMessage(data);
      });
      
      this.socket.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(error);
        }
        this.handleConnectionError(error);
      });
      
      this.socket.on('close', () => {
        clearTimeout(timeout);
        this.handleConnectionClose();
      });
    });
  }

  /**
   * Send FIX logon message
   */
  async sendLogon() {
    console.log('🔐 Sending FIX Logon...');
    const { message } = buildTrueXLogonMessage(this.apiKey, this.apiSecret);
    
    this.socket.write(message, 'utf8');
    this.msgSeqNum++;
    
    // Wait for logon response
    return new Promise((resolve, reject) => {
      const checkLogon = (attempts = 0) => {
        if (this.isLoggedIn) {
          console.log('✅ FIX Logon successful');
          this.emit('connected');
          this.startHeartbeat();
          resolve();
        } else if (attempts < 50) { // 5 second timeout
          setTimeout(() => checkLogon(attempts + 1), 100);
        } else {
          reject(new Error('Logon timeout'));
        }
      };
      setTimeout(() => checkLogon(), 500);
    });
  }

  /**
   * Handle incoming FIX messages
   */
  handleMessage(data) {
    const message = data.toString();
    const displayMessage = message.replace(new RegExp(SOH, 'g'), '|');
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([^]+)/);
    if (!msgTypeMatch) {
      console.log('⚠️ Invalid message format');
      return;
    }
    
    const msgType = msgTypeMatch[1];
    
    switch (msgType) {
      case 'A': // Logon
        console.log('✅ Logon accepted');
        this.isLoggedIn = true;
        break;
        
      case '5': // Logout
        console.log('❌ Logout received');
        const textMatch = message.match(/58=([^]+)/);
        const reason = textMatch ? textMatch[1] : 'Unknown reason';
        this.emit('error', new Error(`Session logout: ${reason}`));
        break;
        
      case '0': // Heartbeat
        console.log('💓 Heartbeat received');
        this.lastHeartbeat = Date.now();
        break;
        
      case 'W': // Market Data Snapshot
        this.handleMarketDataSnapshot(message);
        break;
        
      case 'X': // Market Data Incremental Update
        this.handleMarketDataIncremental(message);
        break;
        
      case 'Y': // Market Data Request Reject
        this.handleMarketDataReject(message);
        break;
        
      default:
        console.log(`📨 Unhandled message type: ${msgType}`);
        console.log(`   Message: ${displayMessage}`);
    }
  }

  /**
   * Handle Market Data Snapshot (full refresh)
   */
  handleMarketDataSnapshot(message) {
    const parsed = parseMarketDataSnapshot(message);
    
    console.log('📊 Market Data Snapshot:');
    console.log(`   Symbol: ${parsed.symbol}`);
    console.log(`   Entries: ${parsed.noMDEntries}`);
    
    // Update market data store
    if (parsed.symbol) {
      this.updateMarketData(parsed.symbol, parsed, 'snapshot');
    }
    
    this.emit('market_data', {
      type: 'snapshot',
      symbol: parsed.symbol,
      data: parsed
    });
  }

  /**
   * Handle Market Data Incremental Update
   */
  handleMarketDataIncremental(message) {
    const parsed = parseMarketDataIncremental(message);
    
    console.log('📈 Market Data Update:');
    console.log(`   Symbol: ${parsed.symbol}`);
    
    // Update market data store  
    if (parsed.symbol) {
      this.updateMarketData(parsed.symbol, parsed, 'incremental');
    }
    
    this.emit('market_data', {
      type: 'incremental',
      symbol: parsed.symbol,
      data: parsed
    });
  }

  /**
   * Handle Market Data Request Reject
   */
  handleMarketDataReject(message) {
    const textMatch = message.match(/58=([^]+)/);
    const reason = textMatch ? textMatch[1] : 'Unknown reason';
    
    console.log('❌ Market Data Request Rejected:', reason);
    this.emit('error', new Error(`Market data request rejected: ${reason}`));
  }

  /**
   * Update internal market data store and generate OHLC
   */
  updateMarketData(symbol, data, type) {
    // Store raw market data
    this.marketData.set(symbol, {
      ...data,
      timestamp: Date.now(),
      type
    });
    
    this.lastUpdateTime.set(symbol, Date.now());
    
    // TODO: Parse bid/offer/trade data and update OHLC
    // This requires proper parsing of NoMDEntries groups
    // For now, store the raw data for the trading logic to use
  }

  /**
   * Subscribe to market data for a symbol
   */
  async subscribeToSymbol(symbol) {
    if (!this.isLoggedIn) {
      throw new Error('Not logged in - cannot subscribe');
    }
    
    if (this.subscriptions.has(symbol)) {
      console.log(`⚠️ Already subscribed to ${symbol}`);
      return;
    }
    
    const mdReqId = `MD_${symbol}_${Date.now()}`;
    console.log(`📡 Subscribing to market data: ${symbol}`);
    
    const { message } = buildMarketDataRequest(
      this.apiKey,
      this.apiSecret,
      mdReqId,
      symbol,
      this.msgSeqNum.toString()
    );
    
    this.socket.write(message, 'utf8');
    this.msgSeqNum++;
    
    this.subscriptions.set(symbol, {
      mdReqId,
      subscribed: Date.now()
    });
    
    console.log(`✅ Market data subscription sent for ${symbol}`);
  }

  /**
   * Get latest market data for a symbol
   */
  getMarketData(symbol) {
    return this.marketData.get(symbol) || null;
  }

  /**
   * Get OHLC data for a symbol (when implemented)
   */
  getOHLC(symbol, interval = '1m') {
    return this.ohlcData.get(`${symbol}_${interval}`) || null;
  }

  /**
   * Get all subscribed symbols
   */
  getSubscribedSymbols() {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Start heartbeat monitoring
   */
  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    this.heartbeatTimer = setInterval(() => {
      if (this.lastHeartbeat && Date.now() - this.lastHeartbeat > this.heartbeatInterval * 2) {
        console.log('💔 Heartbeat timeout - connection may be lost');
        this.handleConnectionError(new Error('Heartbeat timeout'));
      }
    }, this.heartbeatInterval);
  }

  /**
   * Handle connection errors
   */
  handleConnectionError(error) {
    console.error('❌ Connection error:', error.message);
    this.emit('error', error);
    this.scheduleReconnect();
  }

  /**
   * Handle connection close
   */
  handleConnectionClose() {
    console.log('🔌 Connection closed');
    this.isConnected = false;
    this.isLoggedIn = false;
    this.socket = null;
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  /**
   * Schedule automatic reconnection
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    console.log(`🔄 Reconnecting in ${this.reconnectInterval / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        
        // Resubscribe to all symbols
        const symbols = this.getSubscribedSymbols();
        for (const symbol of symbols) {
          await this.subscribeToSymbol(symbol);
        }
      } catch (error) {
        console.error('🔄 Reconnection failed:', error.message);
        this.scheduleReconnect();
      }
    }, this.reconnectInterval);
  }
}

module.exports = TrueXMarketDataManager;