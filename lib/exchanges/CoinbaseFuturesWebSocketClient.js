/**
 * Coinbase Futures WebSocket Client
 * 
 * This module provides a client for connecting to Coinbase WebSocket API
 * and handling futures market data streams and private channels.
 * 
 * API Documentation: https://docs.cloud.coinbase.com/advanced-trade-api/docs/websocket
 */

import WebSocket from 'ws';
import EventEmitter from 'events';
import crypto from 'crypto';

// Coinbase WebSocket endpoints
const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';

// Channel names
const CHANNELS = {
  // Public channels
  HEARTBEAT: 'heartbeats',
  TICKER: 'ticker',
  TICKER_BATCH: 'ticker_batch',
  LEVEL2: 'level2',
  MARKET_TRADES: 'market_trades',
  
  // Private channels
  USER: 'user',
  FUTURES_BALANCE_SUMMARY: 'futures_balance_summary'
};

/**
 * Coinbase Futures WebSocket Client
 */
export class CoinbaseFuturesWebSocketClient extends EventEmitter {
  /**
   * Create a new Coinbase Futures WebSocket client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger instance
   * @param {string} options.apiKey - API key ID
   * @param {string} options.apiSecret - API private key (PEM format)
   * @param {number} [options.reconnectDelayMs=1000] - Initial reconnect delay
   * @param {number} [options.maxReconnectAttempts=10] - Max reconnection attempts
   * @param {number} [options.heartbeatIntervalMs=30000] - Heartbeat interval
   */
  constructor(options = {}) {
    super();
    
    this.options = options;
    this.logger = options.logger || console;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    
    // Connection state
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelayMs = options.reconnectDelayMs || 1000;
    
    // Subscriptions tracking
    this.subscriptions = new Map();
    this.sequenceNumbers = new Map();
    
    // Market data storage
    this.orderBooks = new Map();
    this.tickers = new Map();
    this.trades = new Map();
    
    // Heartbeat management
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.lastHeartbeat = Date.now();
    
    // Message queue for reconnection
    this.messageQueue = [];
    
    // Validate credentials if provided
    if (this.apiKey && this.apiSecret) {
      this._validateCredentials();
    }
    
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.unsubscribe = this.unsubscribe.bind(this);
    this._setupWebSocket = this._setupWebSocket.bind(this);
    this._handleMessage = this._handleMessage.bind(this);
    this._handleError = this._handleError.bind(this);
    this._handleClose = this._handleClose.bind(this);
    this._reconnect = this._reconnect.bind(this);
    this._authenticate = this._authenticate.bind(this);
    this._generateJWT = this._generateJWT.bind(this);
    this._startHeartbeat = this._startHeartbeat.bind(this);
    this._stopHeartbeat = this._stopHeartbeat.bind(this);
    this._checkHeartbeat = this._checkHeartbeat.bind(this);
  }
  
  /**
   * Validate API credentials format
   * @private
   */
  _validateCredentials() {
    if (!this.apiKey || typeof this.apiKey !== 'string') {
      throw new Error('Invalid API key format');
    }
    
    if (!this.apiSecret || !this.apiSecret.includes('-----BEGIN EC PRIVATE KEY-----')) {
      throw new Error('Invalid API secret format. Expected PEM format EC private key');
    }
  }
  
  /**
   * Generate JWT token for authentication
   * @private
   */
  _generateJWT() {
    const keyName = this.apiKey;
    const privateKey = this.apiSecret;
    const algorithm = 'ES256';
    const expiresIn = 120; // 2 minutes
    
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: keyName,
      iss: 'coinbase-cloud',
      nbf: now,
      exp: now + expiresIn,
      aud: ['retail_rest_api_proxy']
    };
    
    const header = {
      alg: algorithm,
      kid: keyName,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    // Create JWT
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const message = `${encodedHeader}.${encodedPayload}`;
    
    // Sign with EC private key
    const sign = crypto.createSign('SHA256');
    sign.update(message);
    sign.end();
    const signature = sign.sign(privateKey, 'base64url');
    
    return `${message}.${signature}`;
  }
  
  /**
   * Connect to Coinbase WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      this.logger.info('[CoinbaseFuturesWS] Connecting to Coinbase WebSocket API...');
      
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(COINBASE_WS_URL);
        
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);
        
        this.ws.once('open', () => {
          clearTimeout(timeout);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.logger.info('[CoinbaseFuturesWS] WebSocket connected');
          
          // Authenticate if credentials provided
          if (this.apiKey && this.apiSecret) {
            this._authenticate()
              .then(() => {
                this._startHeartbeat();
                resolve();
              })
              .catch(reject);
          } else {
            this._startHeartbeat();
            resolve();
          }
        });
        
        this.ws.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        
        // Set up message handlers
        this._setupWebSocket();
      });
    } catch (error) {
      this.logger.error('[CoinbaseFuturesWS] Failed to connect:', error);
      throw error;
    }
  }
  
  /**
   * Set up WebSocket event handlers
   * 
   * @private
   */
  _setupWebSocket() {
    this.ws.on('message', (data) => this._handleMessage(data));
    this.ws.on('error', (error) => this._handleError(error));
    this.ws.on('close', (code, reason) => this._handleClose(code, reason));
    this.ws.on('pong', () => {
      this.lastHeartbeat = Date.now();
    });
  }
  
  /**
   * Authenticate WebSocket connection
   * 
   * @private
   */
  async _authenticate() {
    return new Promise((resolve, reject) => {
      try {
        const jwt = this._generateJWT();
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        const authMessage = {
          type: 'subscribe',
          product_ids: [],
          channel: 'user',
          jwt: jwt,
          timestamp: timestamp
        };
        
        this.logger.info('[CoinbaseFuturesWS] Sending authentication message');
        this.ws.send(JSON.stringify(authMessage));
        
        // Wait for authentication response
        const handleAuthResponse = (data) => {
          try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'subscriptions' && message.channels) {
              const userChannel = message.channels.find(ch => ch.name === 'user');
              if (userChannel) {
                this.isAuthenticated = true;
                this.logger.info('[CoinbaseFuturesWS] Authentication successful');
                this.ws.removeListener('message', handleAuthResponse);
                resolve();
              }
            } else if (message.type === 'error') {
              this.logger.error('[CoinbaseFuturesWS] Authentication error:', message);
              this.ws.removeListener('message', handleAuthResponse);
              reject(new Error(message.message || 'Authentication failed'));
            }
          } catch (error) {
            // Continue listening for auth response
          }
        };
        
        this.ws.on('message', handleAuthResponse);
        
        // Timeout after 5 seconds
        setTimeout(() => {
          this.ws.removeListener('message', handleAuthResponse);
          reject(new Error('Authentication timeout'));
        }, 5000);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Handle incoming WebSocket message
   * 
   * @private
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Update heartbeat timestamp
      this.lastHeartbeat = Date.now();
      
      // Handle different message types
      switch (message.type) {
        case 'subscriptions':
          this._handleSubscriptionMessage(message);
          break;
          
        case 'heartbeat':
          this._handleHeartbeat(message);
          break;
          
        case 'ticker':
          this._handleTicker(message);
          break;
          
        case 'l2_data':
          this._handleLevel2(message);
          break;
          
        case 'trade':
          this._handleTrade(message);
          break;
          
        case 'user':
          this._handleUserMessage(message);
          break;
          
        case 'futures_balance_summary':
          this._handleFuturesBalanceSummary(message);
          break;
          
        case 'error':
          this._handleErrorMessage(message);
          break;
          
        default:
          this.logger.debug('[CoinbaseFuturesWS] Unknown message type:', message.type);
      }
    } catch (error) {
      this.logger.error('[CoinbaseFuturesWS] Failed to parse message:', error, data.toString());
    }
  }
  
  /**
   * Handle subscription confirmation message
   * 
   * @private
   */
  _handleSubscriptionMessage(message) {
    this.logger.info('[CoinbaseFuturesWS] Subscription update:', message);
    this.emit('subscriptions', message);
  }
  
  /**
   * Handle heartbeat message
   * 
   * @private
   */
  _handleHeartbeat(message) {
    this.emit('heartbeat', {
      counter: message.counter,
      timestamp: message.timestamp
    });
  }
  
  /**
   * Handle ticker update
   * 
   * @private
   */
  _handleTicker(message) {
    const { product_id, events } = message;
    
    if (!events || events.length === 0) return;
    
    // Use the latest ticker event
    const latestEvent = events[events.length - 1];
    const ticker = latestEvent.tickers?.[0];
    
    if (!ticker) return;
    
    const tickerData = {
      productId: product_id,
      type: ticker.type,
      price: parseFloat(ticker.price || 0),
      volume24h: parseFloat(ticker.volume_24_h || 0),
      low24h: parseFloat(ticker.low_24_h || 0),
      high24h: parseFloat(ticker.high_24_h || 0),
      low52w: parseFloat(ticker.low_52_w || 0),
      high52w: parseFloat(ticker.high_52_w || 0),
      pricePercentChange24h: parseFloat(ticker.price_percent_chg_24_h || 0),
      timestamp: latestEvent.timestamp
    };
    
    this.tickers.set(product_id, tickerData);
    this.emit('ticker', tickerData);
  }
  
  /**
   * Handle level2 order book update
   * 
   * @private
   */
  _handleLevel2(message) {
    const { product_id, events } = message;
    
    if (!events || events.length === 0) return;
    
    // Initialize order book if needed
    if (!this.orderBooks.has(product_id)) {
      this.orderBooks.set(product_id, {
        bids: new Map(),
        asks: new Map(),
        sequence: 0
      });
    }
    
    const orderBook = this.orderBooks.get(product_id);
    
    // Process all events in order
    events.forEach(event => {
      const { updates } = event;
      
      if (!updates) return;
      
      // Update bids
      if (updates.bid) {
        updates.bid.forEach(([price, size]) => {
          const priceFloat = parseFloat(price);
          const sizeFloat = parseFloat(size);
          
          if (sizeFloat === 0) {
            orderBook.bids.delete(priceFloat);
          } else {
            orderBook.bids.set(priceFloat, sizeFloat);
          }
        });
      }
      
      // Update asks
      if (updates.ask) {
        updates.ask.forEach(([price, size]) => {
          const priceFloat = parseFloat(price);
          const sizeFloat = parseFloat(size);
          
          if (sizeFloat === 0) {
            orderBook.asks.delete(priceFloat);
          } else {
            orderBook.asks.set(priceFloat, sizeFloat);
          }
        });
      }
    });
    
    // Convert to sorted arrays
    const bids = Array.from(orderBook.bids.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
      
    const asks = Array.from(orderBook.asks.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    
    const midPrice = bids.length > 0 && asks.length > 0
      ? (bids[0].price + asks[0].price) / 2
      : 0;
    
    const orderBookUpdate = {
      productId: product_id,
      bids,
      asks,
      midPrice,
      timestamp: events[events.length - 1].timestamp
    };
    
    this.emit('orderBook', orderBookUpdate);
  }
  
  /**
   * Handle trade update
   * 
   * @private
   */
  _handleTrade(message) {
    const { product_id, events } = message;
    
    if (!events || events.length === 0) return;
    
    // Store last N trades per product
    if (!this.trades.has(product_id)) {
      this.trades.set(product_id, []);
    }
    
    const productTrades = this.trades.get(product_id);
    
    events.forEach(event => {
      const { trades } = event;
      
      if (!trades) return;
      
      trades.forEach(trade => {
        const tradeData = {
          productId: product_id,
          tradeId: trade.trade_id,
          price: parseFloat(trade.price || 0),
          size: parseFloat(trade.size || 0),
          side: trade.side,
          time: trade.time,
          timestamp: event.timestamp
        };
        
        productTrades.push(tradeData);
        
        // Keep only last 100 trades
        if (productTrades.length > 100) {
          productTrades.shift();
        }
        
        this.emit('trade', tradeData);
      });
    });
  }
  
  /**
   * Handle user channel messages
   * 
   * @private
   */
  _handleUserMessage(message) {
    const { events } = message;
    
    if (!events || events.length === 0) return;
    
    events.forEach(event => {
      // Handle order updates
      if (event.orders) {
        event.orders.forEach(order => {
          this.emit('orderUpdate', {
            orderId: order.order_id,
            clientOrderId: order.client_order_id,
            productId: order.product_id,
            userId: order.user_id,
            side: order.side,
            status: order.status,
            timeInForce: order.time_in_force,
            createdTime: order.created_time,
            completionPercentage: parseFloat(order.completion_percentage || 0),
            filledSize: parseFloat(order.filled_size || 0),
            averageFilledPrice: parseFloat(order.average_filled_price || 0),
            numberOfFills: parseInt(order.number_of_fills || 0),
            filledValue: parseFloat(order.filled_value || 0),
            pendingCancel: order.pending_cancel,
            totalFees: parseFloat(order.total_fees || 0),
            orderType: order.order_type,
            triggerStatus: order.trigger_status,
            rejectReason: order.reject_reason,
            settled: order.settled,
            productType: order.product_type,
            orderConfiguration: order.order_configuration,
            timestamp: event.timestamp
          });
        });
      }
      
      // Handle fill updates
      if (event.fills) {
        event.fills.forEach(fill => {
          this.emit('fillUpdate', {
            entryId: fill.entry_id,
            tradeId: fill.trade_id,
            orderId: fill.order_id,
            tradeTime: fill.trade_time,
            tradeType: fill.trade_type,
            price: parseFloat(fill.price || 0),
            size: parseFloat(fill.size || 0),
            commission: parseFloat(fill.commission || 0),
            productId: fill.product_id,
            sequenceTimestamp: fill.sequence_timestamp,
            liquidityIndicator: fill.liquidity_indicator,
            sizeInQuote: fill.size_in_quote,
            userId: fill.user_id,
            side: fill.side,
            timestamp: event.timestamp
          });
        });
      }
    });
  }
  
  /**
   * Handle futures balance summary messages
   * 
   * @private
   */
  _handleFuturesBalanceSummary(message) {
    const { events } = message;
    
    if (!events || events.length === 0) return;
    
    events.forEach(event => {
      if (event.futures_balance_summary) {
        const summary = event.futures_balance_summary;
        
        this.emit('futuresBalanceSummary', {
          balances: summary.balances || [],
          portfolioValue: parseFloat(summary.portfolio_value || 0),
          buyingPower: parseFloat(summary.buying_power || 0),
          totalUsdBalance: parseFloat(summary.total_usd_balance || 0),
          cfmUsdAvailableForWithdrawal: parseFloat(summary.cfm_usd_available_for_withdrawal || 0),
          portfolioInitialMargin: parseFloat(summary.portfolio_initial_margin || 0),
          portfolioMaintenanceMargin: parseFloat(summary.portfolio_maintenance_margin || 0),
          portfolioMarginViolation: summary.portfolio_margin_violation,
          unrealizedPnl: parseFloat(summary.unrealized_pnl || 0),
          dailyRealizedPnl: parseFloat(summary.daily_realized_pnl || 0),
          timestamp: event.timestamp
        });
      }
    });
  }
  
  /**
   * Handle error message
   * 
   * @private
   */
  _handleErrorMessage(message) {
    this.logger.error('[CoinbaseFuturesWS] Error message received:', message);
    this.emit('error', { type: 'message', error: message });
  }
  
  /**
   * Subscribe to channels
   * 
   * @param {Array<string>} channels - Channel names to subscribe
   * @param {Array<string>} [productIds] - Product IDs for market data channels
   * @returns {Promise<void>}
   */
  async subscribe(channels, productIds = []) {
    if (!this.isConnected) {
      throw new Error('Not connected to Coinbase WebSocket API');
    }
    
    try {
      this.logger.info(`[CoinbaseFuturesWS] Subscribing to channels:`, { channels, productIds });
      
      const subscribeMsg = {
        type: 'subscribe',
        channels: channels.map(channel => {
          const channelConfig = { name: channel };
          
          // Add product IDs for market data channels
          if (productIds.length > 0 && this._isMarketDataChannel(channel)) {
            channelConfig.product_ids = productIds;
          }
          
          return channelConfig;
        })
      };
      
      // Add authentication for private channels
      if (this._hasPrivateChannel(channels) && this.isAuthenticated) {
        subscribeMsg.jwt = this._generateJWT();
        subscribeMsg.timestamp = Math.floor(Date.now() / 1000).toString();
      }
      
      this.ws.send(JSON.stringify(subscribeMsg));
      
      // Track subscriptions
      channels.forEach(channel => {
        if (productIds.length > 0) {
          productIds.forEach(productId => {
            const key = `${channel}:${productId}`;
            this.subscriptions.set(key, { channel, productId });
          });
        } else {
          this.subscriptions.set(channel, { channel });
        }
      });
      
    } catch (error) {
      this.logger.error('[CoinbaseFuturesWS] Subscription failed:', error);
      throw error;
    }
  }
  
  /**
   * Unsubscribe from channels
   * 
   * @param {Array<string>} channels - Channel names to unsubscribe
   * @param {Array<string>} [productIds] - Product IDs for market data channels
   * @returns {Promise<void>}
   */
  async unsubscribe(channels, productIds = []) {
    if (!this.isConnected) {
      throw new Error('Not connected to Coinbase WebSocket API');
    }
    
    try {
      this.logger.info(`[CoinbaseFuturesWS] Unsubscribing from channels:`, { channels, productIds });
      
      const unsubscribeMsg = {
        type: 'unsubscribe',
        channels: channels.map(channel => {
          const channelConfig = { name: channel };
          
          // Add product IDs for market data channels
          if (productIds.length > 0 && this._isMarketDataChannel(channel)) {
            channelConfig.product_ids = productIds;
          }
          
          return channelConfig;
        })
      };
      
      // Add authentication for private channels
      if (this._hasPrivateChannel(channels) && this.isAuthenticated) {
        unsubscribeMsg.jwt = this._generateJWT();
        unsubscribeMsg.timestamp = Math.floor(Date.now() / 1000).toString();
      }
      
      this.ws.send(JSON.stringify(unsubscribeMsg));
      
      // Remove from tracked subscriptions
      channels.forEach(channel => {
        if (productIds.length > 0) {
          productIds.forEach(productId => {
            const key = `${channel}:${productId}`;
            this.subscriptions.delete(key);
          });
        } else {
          this.subscriptions.delete(channel);
        }
      });
      
    } catch (error) {
      this.logger.error('[CoinbaseFuturesWS] Unsubscription failed:', error);
      throw error;
    }
  }
  
  /**
   * Check if channel is a market data channel
   * 
   * @private
   */
  _isMarketDataChannel(channel) {
    return [
      CHANNELS.TICKER,
      CHANNELS.TICKER_BATCH,
      CHANNELS.LEVEL2,
      CHANNELS.MARKET_TRADES
    ].includes(channel);
  }
  
  /**
   * Check if any channel is private
   * 
   * @private
   */
  _hasPrivateChannel(channels) {
    return channels.some(channel => 
      [CHANNELS.USER, CHANNELS.FUTURES_BALANCE_SUMMARY].includes(channel)
    );
  }
  
  /**
   * Disconnect from Coinbase WebSocket API
   */
  disconnect() {
    this.logger.info('[CoinbaseFuturesWS] Disconnecting from Coinbase WebSocket API');
    
    this._stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.isAuthenticated = false;
    }
    
    this.subscriptions.clear();
    this.orderBooks.clear();
    this.tickers.clear();
    this.trades.clear();
    this.sequenceNumbers.clear();
  }
  
  /**
   * Handle WebSocket error
   * 
   * @private
   */
  _handleError(error) {
    this.logger.error('[CoinbaseFuturesWS] WebSocket error:', error);
    this.emit('error', { type: 'connection', error });
  }
  
  /**
   * Handle WebSocket close
   * 
   * @private
   */
  _handleClose(code, reason) {
    this.logger.info('[CoinbaseFuturesWS] WebSocket closed:', { code, reason });
    
    this.isConnected = false;
    this.isAuthenticated = false;
    
    this.emit('close', { code, reason });
    
    // Attempt reconnection if not intentional close
    if (code !== 1000) {
      this._reconnect();
    }
  }
  
  /**
   * Reconnect to WebSocket
   * 
   * @private
   */
  async _reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('[CoinbaseFuturesWS] Max reconnection attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1);
    
    this.logger.info(`[CoinbaseFuturesWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        await this.connect();
        
        // Resubscribe to all channels
        const channelGroups = new Map();
        
        // Group subscriptions by channel
        for (const [key, sub] of this.subscriptions.entries()) {
          const { channel, productId } = sub;
          
          if (!channelGroups.has(channel)) {
            channelGroups.set(channel, []);
          }
          
          if (productId) {
            channelGroups.get(channel).push(productId);
          }
        }
        
        // Resubscribe to each channel group
        for (const [channel, productIds] of channelGroups.entries()) {
          await this.subscribe([channel], productIds);
        }
        
      } catch (error) {
        this.logger.error('[CoinbaseFuturesWS] Reconnection failed:', error);
      }
    }, delay);
  }
  
  /**
   * Start heartbeat monitoring
   * 
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      this._sendHeartbeat();
      this._checkHeartbeat();
    }, this.heartbeatIntervalMs);
  }
  
  /**
   * Stop heartbeat monitoring
   * 
   * @private
   */
  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * Send heartbeat ping
   * 
   * @private
   */
  _sendHeartbeat() {
    if (this.ws && this.isConnected) {
      this.ws.ping();
    }
  }
  
  /**
   * Check heartbeat health
   * 
   * @private
   */
  _checkHeartbeat() {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - this.lastHeartbeat;
    
    // If no heartbeat for 2 intervals, consider connection dead
    if (timeSinceLastHeartbeat > this.heartbeatIntervalMs * 2) {
      this.logger.warn('[CoinbaseFuturesWS] Heartbeat timeout, forcing reconnection');
      
      if (this.ws) {
        this.ws.close();
      }
    }
  }
  
  /**
   * Get current order book for a product
   * 
   * @param {string} productId - Product ID
   * @returns {Object|null} Order book data
   */
  getOrderBook(productId) {
    const orderBook = this.orderBooks.get(productId);
    
    if (!orderBook) return null;
    
    // Convert to sorted arrays
    const bids = Array.from(orderBook.bids.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
      
    const asks = Array.from(orderBook.asks.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    
    const midPrice = bids.length > 0 && asks.length > 0
      ? (bids[0].price + asks[0].price) / 2
      : 0;
    
    return {
      productId,
      bids,
      asks,
      midPrice,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get current ticker for a product
   * 
   * @param {string} productId - Product ID
   * @returns {Object|null} Ticker data
   */
  getTicker(productId) {
    return this.tickers.get(productId) || null;
  }
  
  /**
   * Get recent trades for a product
   * 
   * @param {string} productId - Product ID
   * @returns {Array} Trade data
   */
  getTrades(productId) {
    return this.trades.get(productId) || [];
  }
  
  /**
   * Get WebSocket channel constants
   * 
   * @returns {Object} Channel constants
   */
  static get CHANNELS() {
    return CHANNELS;
  }
}