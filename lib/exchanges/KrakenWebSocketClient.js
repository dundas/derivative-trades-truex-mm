/**
 * Kraken WebSocket Client
 * 
 * This module provides a client for connecting to Kraken WebSocket API and
 * handling market data streams. It is compatible with both Node.js and
 * Cloudflare Workers environments.
 */

// Import WebSocket for Node.js environment
let WebSocketImpl;
if (typeof process !== 'undefined') {
  try {
    WebSocketImpl = require('ws');
  } catch (e) {
    // WebSocket will be provided by the environment in Cloudflare Workers
  }
}

// Symbol mapping for Kraken WebSocket API
const KRAKEN_SYMBOL_MAP = {
  'BTC/USD': 'XBT/USD',  // XBT is Kraken's code for Bitcoin
  'ETH/USD': 'ETH/USD'
};

// Reverse mapping to convert Kraken symbols back to our format
const REVERSE_SYMBOL_MAP = {
  'XBT/USD': 'BTC/USD',
  'ETH/USD': 'ETH/USD'
};

/**
 * Kraken WebSocket Client
 */
export class KrakenWebSocketClient {
  /**
   * Create a new Kraken WebSocket client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger function
   * @param {Function} options.onOrderBookUpdate - Callback for orderbook updates
   * @param {Function} options.onError - Callback for errors
   */
  constructor(options = {}) {
    this.options = options;
    this.ws = null;
    this.isConnected = false;
    this.isCloudflareEnv = typeof process === 'undefined';
    this.subscriptions = new Map();
    this.orderbooks = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    
    // Data staleness monitoring
    this.lastDataTimestamp = Date.now();
    this.staleDataThreshold = options.staleDataThreshold || 30000; // 30 seconds default
    this.dataFreshnessCheckInterval = null;
    this.monitoringActive = false;
    
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.unsubscribe = this.unsubscribe.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this.reconnect = this.reconnect.bind(this);
    this.getOrderBook = this.getOrderBook.bind(this);
    this.getAllOrderBooks = this.getAllOrderBooks.bind(this);
    this.log = this.log.bind(this);
    this.startDataFreshnessMonitoring = this.startDataFreshnessMonitoring.bind(this);
    this.stopDataFreshnessMonitoring = this.stopDataFreshnessMonitoring.bind(this);
    this.checkDataFreshness = this.checkDataFreshness.bind(this);
  }
  
  /**
   * Log a message
   * 
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [KrakenWebSocket] ${message}`;
    
    if (this.options.logger) {
      this.options.logger(level, formattedMessage, data);
    } else {
      console[level](formattedMessage, data);
    }
  }
  
  /**
   * Connect to Kraken WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) {
      this.log('warn', 'Already connected to Kraken WebSocket API');
      return;
    }
    
    try {
      this.log('info', 'Connecting to Kraken WebSocket API...');
      
      if (this.isCloudflareEnv) {
        // In Cloudflare Workers environment
        try {
          // Dynamic import for WebSocketAdapter in Cloudflare environment
          const { WebSocketAdapter } = await import('../../utils/websocket-adapter.js');
          
          this.ws = new WebSocketAdapter('wss://ws.kraken.com');
          
          // Set up event listeners
          this.ws.addEventListener('open', this.handleOpen);
          this.ws.addEventListener('message', (event) => this.handleMessage(event.data));
          this.ws.addEventListener('close', this.handleClose);
          this.ws.addEventListener('error', this.handleError);
        } catch (error) {
          this.log('error', `Failed to import WebSocketAdapter: ${error.message}`, { error });
          throw error;
        }
      } else {
        // In Node.js environment
        try {
          // Dynamic import for ws in Node.js environment
          const WebSocket = (await import('ws')).default;
          
          this.ws = new WebSocket('wss://ws.kraken.com');
          
          // Set up event listeners
          this.ws.on('open', this.handleOpen);
          this.ws.on('message', this.handleMessage);
          this.ws.on('close', this.handleClose);
          this.ws.on('error', this.handleError);
        } catch (error) {
          this.log('error', `Failed to import WebSocket: ${error.message}`, { error });
          throw error;
        }
      }
      
      // Wait for connection to be established
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);
        
        const onOpen = () => {
          clearTimeout(timeout);
          resolve();
        };
        
        const onError = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
        
        if (this.isCloudflareEnv) {
          this.ws.addEventListener('open', onOpen, { once: true });
          this.ws.addEventListener('error', onError, { once: true });
        } else {
          this.ws.once('open', onOpen);
          this.ws.once('error', onError);
        }
      });
      
      this.log('info', 'u2705 Connected to Kraken WebSocket API');
      
      // Start data freshness monitoring
      this.startDataFreshnessMonitoring();
    } catch (error) {
      this.log('error', `Failed to connect to Kraken WebSocket API: ${error.message}`, { error });
      this.isConnected = false;
      this.reconnect();
      throw error;
    }
  }
  
  /**
   * Disconnect from Kraken WebSocket API
   */
  disconnect() {
    if (!this.isConnected) {
      this.log('warn', 'Not connected to Kraken WebSocket API');
      return;
    }
    
    this.log('info', 'Disconnecting from Kraken WebSocket API...');
    
    // Stop data freshness monitoring
    this.stopDataFreshnessMonitoring();
    
    if (this.ws) {
      if (this.isCloudflareEnv) {
        this.ws.close();
      } else {
        this.ws.terminate();
      }
      
      this.ws = null;
    }
    
    this.isConnected = false;
    this.log('info', 'Disconnected from Kraken WebSocket API');
  }
  
  /**
   * Reconnect to Kraken WebSocket API
   */
  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', 'Maximum reconnect attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    
    this.log('info', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await this.connect();
      
      // Resubscribe to all channels
      for (const [key, options] of this.subscriptions.entries()) {
        const [channel, symbol] = key.split(':');
        await this.subscribe(channel, [symbol], options);
      }
      
      this.reconnectAttempts = 0;
    } catch (error) {
      this.log('error', `Reconnect failed: ${error.message}`, { error });
    }
  }
  
  /**
   * Handle WebSocket open event
   */
  handleOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.log('info', 'WebSocket connection established');
  }
  
  /**
   * Handle WebSocket close event
   * 
   * @param {Object} event - Close event
   */
  handleClose(event) {
    this.isConnected = false;
    this.log('info', 'WebSocket connection closed', { code: event.code, reason: event.reason });
    
    // Reconnect if not closed intentionally
    if (event.code !== 1000) {
      this.reconnect();
    }
  }
  
  /**
   * Handle WebSocket error event
   * 
   * @param {Error} error - Error event
   */
  handleError(error) {
    this.log('error', 'WebSocket error', { error });
    
    // Notify listeners
    if (this.options.onError) {
      this.options.onError(error);
    }
  }
  
  /**
   * Handle WebSocket message event
   * 
   * @param {string|Buffer} data - Message data
   */
  handleMessage(data) {
    try {
      // Parse message data
      const message = JSON.parse(data);
      
      // Reset data freshness timer
      this.lastDataTimestamp = Date.now();
      
      // Handle different message types
      if (message.event) {
        // System or subscription messages
        this.log('info', `Received system message: ${message.event}`, { message });
        this.handleSystemMessage(message);
      } else if (Array.isArray(message)) {
        // Channel data messages
        const messageType = 'array';
        const messageLength = message.length;
        const firstElement = typeof message[0];
        const secondElement = typeof message[1];
        const channelName = message[2] || '';
        const pair = message[3] || '';
        
        // Log message details for debugging
        const dataPreview = {};
        if (typeof message[1] === 'object') {
          Object.keys(message[1]).forEach(key => {
            dataPreview[key] = Array.isArray(message[1][key]) ? 
              `Array[${message[1][key].length}]` : 
              typeof message[1][key];
          });
        }
        
        this.log('debug', 'Array message received:', {
          messageType,
          messageLength,
          firstElement,
          secondElement,
          channelName,
          pair,
          dataPreview
        });
        
        // Process based on channel name
        if (typeof channelName === 'string' && channelName.startsWith('book')) {
          // Orderbook data
          const symbol = this._normalizeSymbol(pair);
          this.log('debug', `Received ${channelName} update for ${pair}`, {});
          this.log('debug', `Processing orderbook for ${symbol}`, {});
          
          if (this.options && this.options.onOrderBookUpdate) {
            this.options.onOrderBookUpdate(symbol, message[1]);
          }
        } else if (typeof channelName === 'string' && channelName === 'ticker') {
          // Ticker data
          const symbol = this._normalizeSymbol(pair);
          this.log('debug', `Received ticker update for ${pair}`, {});
          
          if (this.options && this.options.onTickerUpdate) {
            this.options.onTickerUpdate(symbol, message[1]);
          }
        } else if (typeof channelName === 'string' && channelName === 'trade') {
          // Trade data
          const symbol = this._normalizeSymbol(pair);
          this.log('debug', `Received trade update for ${pair}`, {});
          
          if (this.options && this.options.onTradeUpdate) {
            this.options.onTradeUpdate(symbol, message[1]);
          }
        } else if (typeof channelName === 'object' && message[1] && (message[1].a || message[1].b)) {
          // This appears to be a malformed orderbook message where channelName is actually part of the data
          // Try to extract the symbol from the pair field which should be 'book-10'
          if (typeof pair === 'string' && pair.startsWith('book')) {
            const symbol = this._normalizeSymbol(message[3] || '');
            this.log('debug', `Received malformed orderbook update, attempting recovery`, {});
            
            if (this.options && this.options.onOrderBookUpdate && symbol) {
              // If we have a symbol, pass the orderbook data to the handler
              this.options.onOrderBookUpdate(symbol, message[1]);
            }
          } else {
            this.log('warning', `Received malformed message with object as channelName`, { message });
          }
        } else {
          // Unknown channel
          this.log('warning', `Received update for unknown channel: ${typeof channelName === 'string' ? channelName : 'unknown'}`, {});
        }
      } else {
        // Unknown message format
        this.log('warning', 'Received unknown message format', { message });
      }
    } catch (error) {
      this.log('error', `Failed to handle message: ${error.message}`, { error });
    }
  }
  
  /**
   * Handle system message
   * 
   * @param {Object} message - System message
   */
  handleSystemMessage(message) {
    // This method is now handled directly in handleMessage
    // for better compatibility with the test script approach
  }
  
  /**
   * Normalize symbol to standard format
   * Converts from Kraken format (XBT/USD) to standard format (BTC/USD)
   * 
   * @private
   * @param {string} symbol - Symbol in Kraken format
   * @returns {string} - Symbol in standard format
   */
  _normalizeSymbol(symbol) {
    // Replace XBT with BTC
    if (symbol.includes('XBT')) {
      return symbol.replace('XBT', 'BTC');
    }
    return symbol;
  }
  
  /**
   * Handle orderbook update
   * 
   * @param {Array} message - Orderbook update message
   */
  handleOrderBookUpdate(message) {
    try {
      const channelId = message[0];
      const data = message[1];
      const channelName = message[2];
      const pair = message[3];
      
      // Convert Kraken pair back to our format
      const symbol = REVERSE_SYMBOL_MAP[pair] || pair;
      
      this.log('debug', `Processing orderbook for ${symbol}`);
      
      // Initialize orderbook if not exists
      if (!this.orderbooks.has(symbol)) {
        this.orderbooks.set(symbol, {
          bids: [],
          asks: [],
          timestamp: Date.now()
        });
      }
      
      const orderbook = this.orderbooks.get(symbol);
      
      // Kraken sends 'as'/'bs' for snapshot and 'a'/'b' for updates
      // Update bids
      if (data.bs) {
        // Initial snapshot
        this.log('debug', `Received initial snapshot with ${data.bs.length} bids`);
        orderbook.bids = data.bs.map(bid => [bid[0], bid[1]]);  // Price, volume
        orderbook.bids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));  // Sort descending
      } else if (data.b && data.b.length > 0) {
        // Incremental update
        data.b.forEach(bid => {
          const price = bid[0];
          const volume = bid[1];
          
          // Remove price level if volume is 0
          if (parseFloat(volume) === 0) {
            orderbook.bids = orderbook.bids.filter(b => b[0] !== price);
            return;
          }
          
          // Update or add price level
          const existingIndex = orderbook.bids.findIndex(b => b[0] === price);
          if (existingIndex !== -1) {
            orderbook.bids[existingIndex] = [price, volume];
          } else {
            orderbook.bids.push([price, volume]);
            // Sort bids in descending order by price
            orderbook.bids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
          }
        });
      }
      
      // Update asks
      if (data.as) {
        // Initial snapshot
        this.log('debug', `Received initial snapshot with ${data.as.length} asks`);
        orderbook.asks = data.as.map(ask => [ask[0], ask[1]]);  // Price, volume
        orderbook.asks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));  // Sort ascending
      } else if (data.a && data.a.length > 0) {
        // Incremental update
        data.a.forEach(ask => {
          const price = ask[0];
          const volume = ask[1];
          
          // Remove price level if volume is 0
          if (parseFloat(volume) === 0) {
            orderbook.asks = orderbook.asks.filter(a => a[0] !== price);
            return;
          }
          
          // Update or add price level
          const existingIndex = orderbook.asks.findIndex(a => a[0] === price);
          if (existingIndex !== -1) {
            orderbook.asks[existingIndex] = [price, volume];
          } else {
            orderbook.asks.push([price, volume]);
            // Sort asks in ascending order by price
            orderbook.asks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
          }
        });
      }
      
      // Update timestamp
      orderbook.timestamp = Date.now();
      
      // Calculate mid price
      if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
        const bestBid = parseFloat(orderbook.bids[0][0]);
        const bestAsk = parseFloat(orderbook.asks[0][0]);
        orderbook.midPrice = (bestBid + bestAsk) / 2;
      }
      
      // Notify listeners
      if (this.options.onOrderBookUpdate) {
        this.options.onOrderBookUpdate(symbol, orderbook);
      }
    } catch (error) {
      this.log('error', `Failed to handle orderbook update: ${error.message}`, { error, message });
    }
  }
  
  /**
   * Subscribe to a channel for specified symbols
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to subscribe to
   * @param {Object} options - Additional options
   * @param {number} options.depth - Orderbook depth (only for 'book' channel)
   * @returns {Promise<void>}
   */
  async subscribe(channel, symbols, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected to Kraken WebSocket API');
    }
    
    try {
      // Convert symbols to Kraken format
      const krakenPairs = symbols.map(s => KRAKEN_SYMBOL_MAP[s] || s);
      
      this.log('info', `Subscribing to ${channel} updates for ${krakenPairs.join(', ')}...`);
      
      // Create subscription message based on channel type
      const subscribeMsg = {
        event: 'subscribe',
        pair: krakenPairs,
        subscription: {
          name: channel
        }
      };
      
      // Add depth parameter for orderbook channel
      if (channel === 'book' && options.depth) {
        subscribeMsg.subscription.depth = options.depth;
      }
      
      this.log('debug', `Subscription message: ${JSON.stringify(subscribeMsg)}`);
      
      // Send subscription message
      if (this.isCloudflareEnv) {
        this.ws.send(JSON.stringify(subscribeMsg));
      } else {
        this.ws.send(JSON.stringify(subscribeMsg));
      }
      
      // Store subscriptions
      for (const symbol of symbols) {
        this.subscriptions.set(`${channel}:${symbol}`, options);
      }
      
      this.log('info', `Subscription request sent for ${symbols.length} symbols on ${channel} channel`);
    } catch (error) {
      this.log('error', `Failed to subscribe: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Unsubscribe from orderbook updates
   * 
   * @param {Array<string>} symbols - Symbols to unsubscribe from
   * @returns {Promise<void>}
   */
  async unsubscribe(symbols) {
    if (!this.isConnected) {
      throw new Error('Not connected to Kraken WebSocket API');
    }
    
    try {
      // Convert symbols to Kraken format
      const krakenPairs = symbols.map(s => KRAKEN_SYMBOL_MAP[s] || s);
      
      this.log('info', `Unsubscribing from orderbook updates for ${krakenPairs.join(', ')}...`);
      
      // Create unsubscription message
      const unsubscribeMsg = {
        event: 'unsubscribe',
        pair: krakenPairs,
        subscription: {
          name: 'book'  // Kraken will match this with the 'book-{depth}' channel
        }
      };
      
      this.log('debug', `Unsubscription message: ${JSON.stringify(unsubscribeMsg)}`);
      
      // Send unsubscription message
      if (this.isCloudflareEnv) {
        this.ws.send(JSON.stringify(unsubscribeMsg));
      } else {
        this.ws.send(JSON.stringify(unsubscribeMsg));
      }
      
      // Remove subscriptions
      for (const symbol of symbols) {
        this.subscriptions.delete(`book:${symbol}`);
      }
      
      this.log('info', `Unsubscription request sent for ${symbols.length} symbols`);
    } catch (error) {
      this.log('error', `Failed to unsubscribe: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Get orderbook for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {Object|null}
   */
  getOrderBook(symbol) {
    return this.orderbooks.get(symbol) || null;
  }
  
  /**
   * Get all orderbooks
   * 
   * @returns {Map<string, Object>}
   */
  getAllOrderBooks() {
    return new Map(this.orderbooks);
  }
  
  /**
   * Start monitoring data freshness to detect stale connections
   */
  startDataFreshnessMonitoring() {
    if (this.monitoringActive) {
      return; // Already monitoring
    }
    
    this.monitoringActive = true;
    this.lastDataTimestamp = Date.now(); // Reset timestamp
    
    this.log('info', `Starting data freshness monitoring (stale threshold: ${this.staleDataThreshold}ms)`);
    
    // Check data freshness every 5 seconds
    this.dataFreshnessCheckInterval = setInterval(this.checkDataFreshness, 5000);
  }
  
  /**
   * Stop monitoring data freshness
   */
  stopDataFreshnessMonitoring() {
    if (!this.monitoringActive) {
      return; // Not monitoring
    }
    
    this.log('info', 'Stopping data freshness monitoring');
    
    if (this.dataFreshnessCheckInterval) {
      clearInterval(this.dataFreshnessCheckInterval);
      this.dataFreshnessCheckInterval = null;
    }
    
    this.monitoringActive = false;
  }
  
  /**
   * Check if data is stale and force reconnection if needed
   */
  checkDataFreshness() {
    if (!this.isConnected) {
      return; // Not connected
    }
    
    const now = Date.now();
    const dataAge = now - this.lastDataTimestamp;
    
    if (dataAge > this.staleDataThreshold) {
      this.log('warn', `Data is stale (${dataAge}ms old, threshold: ${this.staleDataThreshold}ms). Forcing reconnection.`);
      
      // Force a reconnection
      this.disconnect();
      this.reconnect();
    }
  }
}
