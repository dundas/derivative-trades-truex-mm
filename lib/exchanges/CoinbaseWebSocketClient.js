/**
 * Coinbase WebSocket Client
 * 
 * This module provides a client for connecting to Coinbase Advanced WebSocket API and
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

// Symbol mapping for Coinbase WebSocket API
const COINBASE_SYMBOL_MAP = {
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD'
};

// Reverse mapping to convert Coinbase symbols back to our format
const REVERSE_SYMBOL_MAP = {
  'BTC-USD': 'BTC/USD',
  'ETH-USD': 'ETH/USD'
};

/**
 * Coinbase WebSocket Client
 */
export class CoinbaseWebSocketClient {
  /**
   * Create a new Coinbase WebSocket client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger function
   * @param {Function} options.onOrderBookUpdate - Callback for orderbook updates
   * @param {Function} options.onTickerUpdate - Callback for ticker updates
   * @param {Function} options.onTradeUpdate - Callback for trade updates
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
    if (this.options.logger) {
      this.options.logger(level, message, data);
    } else {
      console[level](message, data);
    }
  }
  
  /**
   * Connect to Coinbase WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) {
      this.log('warn', 'Already connected to Coinbase WebSocket API');
      return;
    }
    
    try {
      this.log('info', 'Connecting to Coinbase WebSocket API...');
      
      if (this.isCloudflareEnv) {
        // In Cloudflare Workers environment
        try {
          // Dynamic import for WebSocketAdapter in Cloudflare environment
          const { WebSocketAdapter } = await import('../../utils/websocket-adapter.js');
          
          this.ws = new WebSocketAdapter('wss://advanced-trade-ws.coinbase.com');
          
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
        if (!WebSocketImpl) {
          throw new Error('WebSocket implementation not available');
        }
        
        this.ws = new WebSocketImpl('wss://advanced-trade-ws.coinbase.com');
        
        // Set up event listeners
        this.ws.on('open', this.handleOpen);
        this.ws.on('message', this.handleMessage);
        this.ws.on('close', this.handleClose);
        this.ws.on('error', this.handleError);
      }
      
      // Set up a timeout for the connection
      const connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          this.log('error', 'Connection to Coinbase WebSocket API timed out');
          this.handleError(new Error('Connection timeout'));
        }
      }, 10000); // 10 seconds timeout
      
      // Wait for the connection to be established
      return new Promise((resolve, reject) => {
        const onOpen = () => {
          clearTimeout(connectionTimeout);
          resolve();
        };
        
        const onError = (error) => {
          clearTimeout(connectionTimeout);
          reject(error);
        };
        
        if (this.isCloudflareEnv) {
          this.ws.addEventListener('open', onOpen);
          this.ws.addEventListener('error', onError);
        } else {
          this.ws.once('open', onOpen);
          this.ws.once('error', onError);
        }
      });
    } catch (error) {
      this.log('error', `Failed to connect to Coinbase WebSocket API: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Disconnect from Coinbase WebSocket API
   */
  disconnect() {
    if (!this.isConnected && !this.ws) {
      this.log('warn', 'Not connected to Coinbase WebSocket API');
      return;
    }
    
    this.log('info', 'Disconnecting from Coinbase WebSocket API...');
    
    // Stop data freshness monitoring
    this.stopDataFreshnessMonitoring();
    
    try {
      if (this.ws) {
        this.ws.close();
      }
    } catch (error) {
      this.log('error', `Error while disconnecting: ${error.message}`, { error });
    } finally {
      this.ws = null;
      this.isConnected = false;
    }
  }
  
  /**
   * Reconnect to Coinbase WebSocket API
   */
  async reconnect() {
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.log('error', `Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }
    
    const delay = Math.min(30000, this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1)); // Exponential backoff
    
    this.log('info', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await this.connect();
      
      // Resubscribe to all channels
      for (const [key, options] of this.subscriptions.entries()) {
        const [channel, symbol] = key.split(':');
        await this.subscribe(channel, [symbol], options);
      }
      
      this.reconnectAttempts = 0; // Reset on successful reconnection
    } catch (error) {
      this.log('error', `Reconnection failed: ${error.message}`, { error });
      await this.reconnect(); // Try again
    }
  }
  
  /**
   * Handle WebSocket open event
   */
  handleOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.log('info', 'Connected to Coinbase WebSocket API');
    
    // Start monitoring data freshness
    this.startDataFreshnessMonitoring();
  }
  
  /**
   * Handle WebSocket close event
   * 
   * @param {Object} event - Close event
   */
  handleClose(event) {
    this.isConnected = false;
    
    // Stop data freshness monitoring
    this.stopDataFreshnessMonitoring();
    
    this.log('info', `Disconnected from Coinbase WebSocket API: ${event && event.reason ? event.reason : 'Unknown reason'}`);
    
    // Attempt to reconnect
    this.reconnect();
  }
  
  /**
   * Handle WebSocket error event
   * 
   * @param {Error} error - Error event
   */
  handleError(error) {
    this.log('error', `WebSocket error: ${error.message}`, { error });
    
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
      // Update last data timestamp for freshness monitoring
      this.lastDataTimestamp = Date.now();
      
      // Parse the message
      const message = JSON.parse(typeof data === 'string' ? data : data.toString());
      
      // Log incoming message for debugging
      this.log('debug', 'Received WebSocket message', { 
        channel: message.channel || 'unknown',
        type: message.type || 'unknown'
      });
      
      // Handle different message types
      if (message.type === 'snapshot' || message.type === 'l2update') {
        this.handleOrderBookUpdate(message);
      } else if (message.type === 'ticker') {
        this.handleTickerUpdate(message);
      } else if (message.type === 'match') {
        this.handleTradeUpdate(message);
      } else if (message.type === 'subscriptions') {
        this.log('info', 'Subscription confirmed', { 
          channels: message.channels ? message.channels.map(c => c.name).join(', ') : 'unknown'
        });
      } else if (message.type === 'error') {
        this.log('error', `WebSocket error message: ${message.message || 'Unknown error'}`, { message });
        
        if (this.options.onError) {
          this.options.onError(new Error(message.message || 'Unknown WebSocket error'));
        }
      }
    } catch (error) {
      this.log('error', `Failed to process WebSocket message: ${error.message}`, { error });
      
      if (this.options.onError) {
        this.options.onError(error);
      }
    }
  }
  
  /**
   * Normalize symbol to standard format
   * Converts from Coinbase format (BTC-USD) to standard format (BTC/USD)
   * 
   * @private
   * @param {string} symbol - Symbol in Coinbase format
   * @returns {string} - Symbol in standard format
   */
  _normalizeSymbol(symbol) {
    return REVERSE_SYMBOL_MAP[symbol] || symbol.replace('-', '/');
  }
  
  /**
   * Convert symbol to Coinbase format
   * Converts from standard format (BTC/USD) to Coinbase format (BTC-USD)
   * 
   * @private
   * @param {string} symbol - Symbol in standard format
   * @returns {string} - Symbol in Coinbase format
   */
  _convertToCoinbaseSymbol(symbol) {
    return COINBASE_SYMBOL_MAP[symbol] || symbol.replace('/', '-');
  }
  
  /**
   * Handle orderbook update
   * 
   * @param {Object} message - Orderbook update message
   */
  handleOrderBookUpdate(message) {
    try {
      if (!message.product_id) {
        this.log('warn', 'Received orderbook update without product_id', { message });
        return;
      }
      
      // Normalize symbol
      const symbol = this._normalizeSymbol(message.product_id);
      
      // Get existing orderbook or create new one
      const existingOrderBook = this.orderbooks.get(symbol) || {
        asks: [],
        bids: [],
        timestamp: Date.now(),
        sequenceNumber: message.sequence || 0
      };
      
      // Check if this is a snapshot or update
      if (message.type === 'snapshot') {
        // Handle full snapshot
        this.log('info', `Received orderbook snapshot for ${symbol}`, {
          askCount: message.asks ? message.asks.length : 0,
          bidCount: message.bids ? message.bids.length : 0,
          sequence: message.sequence
        });
        
        // Create new orderbook
        const orderbook = {
          asks: message.asks || [],
          bids: message.bids || [],
          timestamp: Date.now(),
          sequenceNumber: message.sequence || 0
        };
        
        // Store the orderbook
        this.orderbooks.set(symbol, orderbook);
        
        // Notify handler
        if (this.options.onOrderBookUpdate) {
          this.options.onOrderBookUpdate(symbol, orderbook);
        }
      } else if (message.type === 'l2update') {
        // Handle incremental update
        if (!message.changes || !Array.isArray(message.changes)) {
          this.log('warn', `Received invalid l2update for ${symbol}`, { message });
          return;
        }
        
        // Update the orderbook
        for (const [side, priceStr, sizeStr] of message.changes) {
          const price = priceStr;
          const size = sizeStr;
          
          const isAsk = side.toLowerCase() === 'sell';
          const isBid = side.toLowerCase() === 'buy';
          
          if (!isAsk && !isBid) {
            this.log('warn', `Unknown side in orderbook update: ${side}`, { message });
            continue;
          }
          
          const pricePoints = isAsk ? existingOrderBook.asks : existingOrderBook.bids;
          
          // Find existing price point
          const existingIndex = pricePoints.findIndex(pp => pp[0] === price);
          
          if (parseFloat(size) === 0) {
            // Remove price level
            if (existingIndex !== -1) {
              pricePoints.splice(existingIndex, 1);
            }
          } else {
            // Update or add price level
            if (existingIndex !== -1) {
              pricePoints[existingIndex] = [price, size];
            } else {
              pricePoints.push([price, size]);
              
              // Sort asks ascending, bids descending by price
              if (isAsk) {
                pricePoints.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
              } else {
                pricePoints.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
              }
            }
          }
        }
        
        // Update timestamp and sequence
        existingOrderBook.timestamp = Date.now();
        existingOrderBook.sequenceNumber = message.sequence || existingOrderBook.sequenceNumber;
        
        // Store the updated orderbook
        this.orderbooks.set(symbol, existingOrderBook);
        
        // Notify handler
        if (this.options.onOrderBookUpdate) {
          this.options.onOrderBookUpdate(symbol, existingOrderBook);
        }
      }
    } catch (error) {
      this.log('error', `Failed to process orderbook update: ${error.message}`, { error });
    }
  }
  
  /**
   * Handle ticker update
   * 
   * @param {Object} message - Ticker update message
   */
  handleTickerUpdate(message) {
    try {
      if (!message.product_id) {
        this.log('warn', 'Received ticker update without product_id', { message });
        return;
      }
      
      // Normalize symbol
      const symbol = this._normalizeSymbol(message.product_id);
      
      // Create ticker data
      const ticker = {
        ask: message.best_ask || null,
        bid: message.best_bid || null,
        last: message.price || null,
        volume: message.volume_24h || null,
        timestamp: new Date(message.time || Date.now()).getTime()
      };
      
      // Log ticker update
      this.log('debug', `Ticker update for ${symbol}`, {
        ask: ticker.ask,
        bid: ticker.bid,
        last: ticker.last,
        spread: ticker.ask && ticker.bid ? 
          (parseFloat(ticker.ask) - parseFloat(ticker.bid)).toFixed(2) : 'unknown'
      });
      
      // Notify handler
      if (this.options.onTickerUpdate) {
        this.options.onTickerUpdate(symbol, ticker);
      }
    } catch (error) {
      this.log('error', `Failed to process ticker update: ${error.message}`, { error });
    }
  }
  
  /**
   * Handle trade update
   * 
   * @param {Object} message - Trade update message
   */
  handleTradeUpdate(message) {
    try {
      if (!message.product_id) {
        this.log('warn', 'Received trade update without product_id', { message });
        return;
      }
      
      // Normalize symbol
      const symbol = this._normalizeSymbol(message.product_id);
      
      // Create trade data
      const trade = {
        price: message.price || null,
        size: message.size || null,
        side: message.side || 'unknown',
        timestamp: new Date(message.time || Date.now()).getTime()
      };
      
      // Log trade update
      this.log('debug', `Trade update for ${symbol}`, {
        price: trade.price,
        size: trade.size,
        side: trade.side
      });
      
      // Notify handler
      if (this.options.onTradeUpdate) {
        this.options.onTradeUpdate(symbol, [trade]); // Array for consistency with batch trade updates
      }
    } catch (error) {
      this.log('error', `Failed to process trade update: ${error.message}`, { error });
    }
  }
  
  /**
   * Subscribe to a channel for specified symbols
   * 
   * @param {string} channel - Channel name ('level2', 'ticker', 'matches')
   * @param {Array<string>} symbols - Symbols to subscribe to
   * @param {Object} options - Additional options
   * @returns {Promise<void>}
   */
  async subscribe(channel, symbols, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected to Coinbase WebSocket API');
    }
    
    try {
      // Map between our channel names and Coinbase's
      const channelMap = {
        'book': 'level2',
        'ticker': 'ticker',
        'trade': 'matches'
      };
      
      const coinbaseChannel = channelMap[channel] || channel;
      
      // Convert symbols to Coinbase format
      const coinbaseSymbols = symbols.map(s => this._convertToCoinbaseSymbol(s));
      
      this.log('info', `Subscribing to ${coinbaseChannel} for ${coinbaseSymbols.join(', ')}...`);
      
      // Create subscription message
      const subscribeMsg = {
        type: 'subscribe',
        product_ids: coinbaseSymbols,
        channels: [coinbaseChannel]
      };
      
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
   * Unsubscribe from a channel for specified symbols
   * 
   * @param {Array<string>} symbols - Symbols to unsubscribe from
   * @param {string} channel - Channel name ('level2', 'ticker', 'matches')
   * @returns {Promise<void>}
   */
  async unsubscribe(symbols, channel = 'book') {
    if (!this.isConnected) {
      throw new Error('Not connected to Coinbase WebSocket API');
    }
    
    try {
      // Map between our channel names and Coinbase's
      const channelMap = {
        'book': 'level2',
        'ticker': 'ticker',
        'trade': 'matches'
      };
      
      const coinbaseChannel = channelMap[channel] || channel;
      
      // Convert symbols to Coinbase format
      const coinbaseSymbols = symbols.map(s => this._convertToCoinbaseSymbol(s));
      
      this.log('info', `Unsubscribing from ${coinbaseChannel} for ${coinbaseSymbols.join(', ')}...`);
      
      // Create unsubscription message
      const unsubscribeMsg = {
        type: 'unsubscribe',
        product_ids: coinbaseSymbols,
        channels: [coinbaseChannel]
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
        this.subscriptions.delete(`${channel}:${symbol}`);
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

export default CoinbaseWebSocketClient;
