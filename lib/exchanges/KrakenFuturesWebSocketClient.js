/**
 * Kraken Futures WebSocket Client
 * 
 * This module provides a client for connecting to Kraken Futures WebSocket API
 * and handling futures market data streams.
 * 
 * API Documentation: https://docs.futures.kraken.com/#websocket-api
 */

import WebSocket from 'ws';
import EventEmitter from 'events';
import crypto from 'crypto';

// Kraken Futures WebSocket endpoints
const KRAKEN_FUTURES_WS_PUBLIC = 'wss://futures.kraken.com/ws/v1';
const KRAKEN_FUTURES_WS_PRIVATE = 'wss://futures.kraken.com/ws/v1';

// Note: Symbol conversion is not handled automatically
// Users must provide symbols in Kraken Futures format (e.g., PI_XBTUSD, PF_XRPUSD)

/**
 * Kraken Futures WebSocket Client
 */
export class KrakenFuturesWebSocketClient extends EventEmitter {
  /**
   * Create a new Kraken Futures WebSocket client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger instance
   * @param {string} [options.apiKey] - API key for authenticated endpoints
   * @param {string} [options.apiSecret] - API secret for authenticated endpoints
   * @param {number} [options.reconnectDelayMs=1000] - Initial reconnect delay
   * @param {number} [options.maxReconnectAttempts=10] - Max reconnection attempts
   * @param {number} [options.heartbeatIntervalMs=30000] - Heartbeat interval
   */
  constructor(options = {}) {
    super();
    
    this.options = options;
    this.logger = options.logger || console;
    
    // Connection state
    this.publicWs = null;
    this.privateWs = null;
    this.isPublicConnected = false;
    this.isPrivateConnected = false;
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelayMs = options.reconnectDelayMs || 1000;
    
    // Subscriptions tracking
    this.subscriptions = new Map();
    
    // Market data storage
    this.orderBooks = new Map();
    this.tickers = new Map();
    this.trades = new Map();
    
    // Heartbeat management
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.lastHeartbeat = Date.now();
    
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
    this._startHeartbeat = this._startHeartbeat.bind(this);
    this._stopHeartbeat = this._stopHeartbeat.bind(this);
    this._sendHeartbeat = this._sendHeartbeat.bind(this);
  }
  
  /**
   * Connect to Kraken Futures WebSocket API
   * 
   * @param {boolean} [includePrivate=false] - Whether to connect to private endpoints
   * @returns {Promise<void>}
   */
  async connect(includePrivate = false) {
    try {
      this.logger.info('[KrakenFuturesWS] Connecting to Kraken Futures WebSocket API...');
      
      // Always connect to public WebSocket
      await this._connectPublic();
      
      // Connect to private WebSocket if requested and credentials provided
      if (includePrivate && this.options.apiKey && this.options.apiSecret) {
        await this._connectPrivate();
      }
      
      // Start heartbeat
      this._startHeartbeat();
      
      this.logger.info('[KrakenFuturesWS] Successfully connected to Kraken Futures WebSocket API');
    } catch (error) {
      this.logger.error('[KrakenFuturesWS] Failed to connect:', error);
      throw error;
    }
  }
  
  /**
   * Connect to public WebSocket endpoint
   * 
   * @private
   */
  async _connectPublic() {
    return new Promise((resolve, reject) => {
      try {
        this.publicWs = new WebSocket(KRAKEN_FUTURES_WS_PUBLIC);
        
        const timeout = setTimeout(() => {
          reject(new Error('Public WebSocket connection timeout'));
        }, 10000);
        
        this.publicWs.once('open', () => {
          clearTimeout(timeout);
          this.isPublicConnected = true;
          this.reconnectAttempts = 0;
          this.logger.info('[KrakenFuturesWS] Public WebSocket connected');
          resolve();
        });
        
        this.publicWs.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        
        // Set up message handlers
        this._setupWebSocket(this.publicWs, 'public');
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Connect to private WebSocket endpoint
   * 
   * @private
   */
  async _connectPrivate() {
    return new Promise((resolve, reject) => {
      try {
        this.privateWs = new WebSocket(KRAKEN_FUTURES_WS_PRIVATE);
        
        const timeout = setTimeout(() => {
          reject(new Error('Private WebSocket connection timeout'));
        }, 10000);
        
        this.privateWs.once('open', () => {
          clearTimeout(timeout);
          this.isPrivateConnected = true;
          this.logger.info('[KrakenFuturesWS] Private WebSocket connected');
          
          // Send authentication message
          this._authenticate()
            .then(() => resolve())
            .catch(reject);
        });
        
        this.privateWs.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        
        // Set up message handlers
        this._setupWebSocket(this.privateWs, 'private');
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Set up WebSocket event handlers
   * 
   * @private
   */
  _setupWebSocket(ws, type) {
    ws.on('message', (data) => this._handleMessage(data, type));
    ws.on('error', (error) => this._handleError(error, type));
    ws.on('close', (code, reason) => this._handleClose(code, reason, type));
    ws.on('pong', () => {
      this.lastHeartbeat = Date.now();
    });
  }
  
  /**
   * Authenticate private WebSocket connection
   * 
   * @private
   */
  async _authenticate() {
    return new Promise((resolve, reject) => {
      // Request challenge
      const challengeRequest = {
        event: 'challenge',
        api_key: this.options.apiKey
      };
      
      this.privateWs.send(JSON.stringify(challengeRequest));
      
      // Handle challenge response
      const handleChallenge = (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.event === 'challenge' && message.message) {
            // Sign the challenge
            const challenge = message.message;
            const hash = crypto.createHash('sha256').update(challenge).digest();
            const decodedSecret = Buffer.from(this.options.apiSecret, 'base64');
            const hmac = crypto.createHmac('sha512', decodedSecret);
            hmac.update(hash);
            const signedChallenge = hmac.digest('base64');
            
            // Store for use in subscriptions
            this.authChallenge = {
              original_challenge: challenge,
              signed_challenge: signedChallenge
            };
            
            this.privateWs.removeListener('message', handleChallenge);
            resolve();
          }
        } catch (error) {
          this.privateWs.removeListener('message', handleChallenge);
          reject(error);
        }
      };
      
      this.privateWs.on('message', handleChallenge);
      
      // Timeout after 5 seconds
      setTimeout(() => {
        this.privateWs.removeListener('message', handleChallenge);
        reject(new Error('Authentication challenge timeout'));
      }, 5000);
    });
  }
  
  /**
   * Handle incoming WebSocket message
   * 
   * @private
   */
  _handleMessage(data, type) {
    try {
      const message = JSON.parse(data.toString());
      
      // Update heartbeat timestamp
      this.lastHeartbeat = Date.now();
      
      // Handle different message types
      if (message.event === 'subscribed') {
        this._handleSubscriptionConfirmation(message);
      } else if (message.event === 'unsubscribed') {
        this._handleUnsubscriptionConfirmation(message);
      } else if (message.event === 'error') {
        this._handleErrorMessage(message);
      } else if (message.event === 'heartbeat') {
        // Heartbeat received
        this.emit('heartbeat', { type, timestamp: Date.now() });
      } else if (message.feed) {
        // Market data message
        this._handleMarketData(message);
      } else {
        this.logger.debug('[KrakenFuturesWS] Unknown message type:', message);
      }
    } catch (error) {
      this.logger.error('[KrakenFuturesWS] Failed to parse message:', error, data.toString());
    }
  }
  
  /**
   * Handle market data messages
   * 
   * @private
   */
  _handleMarketData(message) {
    const { feed, product_id } = message;
    const symbol = product_id; // Use product_id directly without conversion
    
    switch (feed) {
      case 'book':
      case 'book_snapshot':
        this._handleOrderBook(symbol, message);
        break;
        
      case 'ticker':
      case 'ticker_lite':
        this._handleTicker(symbol, message);
        break;
        
      case 'trade':
      case 'trade_snapshot':
        this._handleTrade(symbol, message);
        break;
        
      case 'candle_1m':
      case 'candle_5m':
      case 'candle_15m':
      case 'candle_30m':
      case 'candle_1h':
      case 'candle_4h':
      case 'candle_12h':
      case 'candle_1d':
        this._handleCandle(symbol, message);
        break;
        
      // Private channels
      case 'fills':
        this._handleFills(message);
        break;
        
      case 'open_orders':
      case 'open_orders_verbose':
        this._handleOpenOrders(message);
        break;
        
      case 'open_positions':
        this._handleOpenPositions(message);
        break;
        
      case 'account_balances_and_margins':
      case 'balances':
        this._handleBalances(message);
        break;
        
      case 'deposits_withdrawals':
        this._handleDepositsWithdrawals(message);
        break;
        
      case 'account_log':
        this._handleAccountLog(message);
        break;
        
      case 'notifications_auth':
        this._handleNotifications(message);
        break;
        
      default:
        this.logger.debug('[KrakenFuturesWS] Unknown feed type:', feed);
    }
  }
  
  /**
   * Handle order book update
   * 
   * @private
   */
  _handleOrderBook(symbol, message) {
    const { feed, bids = [], asks = [], timestamp } = message;
    
    // Initialize order book if needed
    if (!this.orderBooks.has(symbol)) {
      this.orderBooks.set(symbol, {
        bids: [],
        asks: [],
        timestamp: 0
      });
    }
    
    const orderBook = this.orderBooks.get(symbol);
    
    if (feed === 'book_snapshot') {
      // Replace entire order book
      // Kraken Futures sends objects with price/qty properties, not arrays
      orderBook.bids = (bids || []).map(bid => ({ 
        price: parseFloat(bid.price), 
        size: parseFloat(bid.qty) 
      }));
      orderBook.asks = (asks || []).map(ask => ({ 
        price: parseFloat(ask.price), 
        size: parseFloat(ask.qty) 
      }));
    } else {
      // Incremental update
      this._updateOrderBookSide(orderBook.bids, bids, false);
      this._updateOrderBookSide(orderBook.asks, asks, true);
    }
    
    orderBook.timestamp = timestamp;
    
    // Calculate mid price
    if (orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      orderBook.midPrice = (orderBook.bids[0].price + orderBook.asks[0].price) / 2;
    }
    
    // Emit update
    this.emit('orderBookUpdate', {
      symbol,
      bids: orderBook.bids,
      asks: orderBook.asks,
      midPrice: orderBook.midPrice,
      timestamp
    });
  }
  
  /**
   * Update order book side with incremental changes
   * 
   * @private
   */
  _updateOrderBookSide(side, updates, isAsk) {
    (updates || []).forEach(update => {
      // Handle both array format [price, qty] and object format {price, qty}
      const priceFloat = parseFloat(Array.isArray(update) ? update[0] : update.price);
      const qtyFloat = parseFloat(Array.isArray(update) ? update[1] : update.qty);
      
      // Find existing price level
      const index = side.findIndex(level => level.price === priceFloat);
      
      if (qtyFloat === 0) {
        // Remove price level
        if (index !== -1) {
          side.splice(index, 1);
        }
      } else {
        // Update or add price level
        if (index !== -1) {
          side[index].size = qtyFloat;
        } else {
          side.push({ price: priceFloat, size: qtyFloat });
        }
      }
    });
    
    // Sort: bids descending, asks ascending
    side.sort((a, b) => isAsk ? a.price - b.price : b.price - a.price);
  }
  
  /**
   * Handle ticker update
   * 
   * @private
   */
  _handleTicker(symbol, message) {
    const ticker = {
      symbol,
      bid: parseFloat(message.bid || 0),
      ask: parseFloat(message.ask || 0),
      last: parseFloat(message.last || 0),
      volume: parseFloat(message.volume || 0),
      volume24h: parseFloat(message.volume_24h || 0),
      markPrice: parseFloat(message.markPrice || 0),
      indexPrice: parseFloat(message.indexPrice || 0),
      openInterest: parseFloat(message.openInterest || 0),
      fundingRate: parseFloat(message.fundingRate || 0),
      timestamp: message.timestamp
    };
    
    this.tickers.set(symbol, ticker);
    this.emit('tickerUpdate', ticker);
  }
  
  /**
   * Handle trade update
   * 
   * @private
   */
  _handleTrade(symbol, message) {
    // Kraken Futures sends trade data in an array format within the message
    if (message.trades && Array.isArray(message.trades)) {
      // Handle multiple trades in the message
      message.trades.forEach(tradeData => {
        const trade = {
          symbol,
          price: parseFloat(tradeData.price),
          size: parseFloat(tradeData.qty || tradeData.size),
          side: tradeData.side,
          timestamp: tradeData.time || message.timestamp,
          tradeId: tradeData.uid || tradeData.trade_id
        };
        
        this._processTradeUpdate(symbol, trade);
      });
    } else {
      // Handle single trade format
      const trade = {
        symbol,
        price: parseFloat(message.price),
        size: parseFloat(message.qty || message.size),
        side: message.side,
        timestamp: message.time || message.timestamp,
        tradeId: message.uid || message.trade_id
      };
      
      this._processTradeUpdate(symbol, trade);
    }
  }
  
  /**
   * Process individual trade update
   * 
   * @private
   */
  _processTradeUpdate(symbol, trade) {
    // Store last N trades
    if (!this.trades.has(symbol)) {
      this.trades.set(symbol, []);
    }
    
    const trades = this.trades.get(symbol);
    trades.push(trade);
    
    // Keep only last 100 trades
    if (trades.length > 100) {
      trades.shift();
    }
    
    this.emit('tradeUpdate', trade);
  }
  
  /**
   * Handle candle/OHLC update
   * 
   * @private
   */
  _handleCandle(symbol, message) {
    const { feed, timestamp, open, high, low, close, volume } = message;
    
    // Extract timeframe from feed name
    const timeframe = feed.replace('candle_', '');
    
    const candle = {
      symbol,
      timeframe,
      timestamp,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume)
    };
    
    this.emit('candleUpdate', candle);
  }
  
  /**
   * Subscribe to market data feeds
   * 
   * @param {string} feedType - Feed type ('book', 'ticker', 'trade', etc.)
   * @param {Array<string>} [symbols] - Symbols in Kraken Futures format (e.g., 'PI_XBTUSD')
   * @param {Object} [options] - Additional options
   * @param {boolean} [options.isPrivate] - Whether this is a private channel
   * @returns {Promise<void>}
   */
  async subscribe(feedType, symbols = [], options = {}) {
    const isPrivateChannel = this._isPrivateChannel(feedType) || options.isPrivate;
    
    if (isPrivateChannel && !this.isPrivateConnected) {
      throw new Error('Not connected to private WebSocket for authenticated feeds');
    } else if (!isPrivateChannel && !this.isPublicConnected) {
      throw new Error('Not connected to public WebSocket');
    }
    
    try {
      this.logger.info(`[KrakenFuturesWS] Subscribing to ${feedType}${symbols.length ? ' for ' + symbols.join(', ') : ''}`);
      
      const subscribeMsg = {
        event: 'subscribe',
        feed: feedType
      };
      
      // Add product_ids only if symbols are provided (public channels)
      if (symbols && symbols.length > 0) {
        subscribeMsg.product_ids = symbols;
      }
      
      // Add authentication for private channels
      if (isPrivateChannel && this.authChallenge) {
        subscribeMsg.original_challenge = this.authChallenge.original_challenge;
        subscribeMsg.signed_challenge = this.authChallenge.signed_challenge;
      }
      
      const ws = isPrivateChannel ? this.privateWs : this.publicWs;
      ws.send(JSON.stringify(subscribeMsg));
      
      // Track subscriptions
      if (symbols && symbols.length > 0) {
        symbols.forEach(symbol => {
          const key = `${feedType}:${symbol}`;
          this.subscriptions.set(key, { feedType, symbol, options, isPrivate: isPrivateChannel });
        });
      } else {
        // Private channels without symbols
        this.subscriptions.set(feedType, { feedType, options, isPrivate: isPrivateChannel });
      }
      
    } catch (error) {
      this.logger.error('[KrakenFuturesWS] Subscription failed:', error);
      throw error;
    }
  }
  
  /**
   * Check if a channel is private
   * 
   * @private
   */
  _isPrivateChannel(feedType) {
    const privateChannels = [
      'fills',
      'open_orders',
      'open_orders_verbose',
      'open_positions',
      'account_balances_and_margins',
      'balances',
      'deposits_withdrawals',
      'account_log',
      'notifications_auth'
    ];
    
    return privateChannels.includes(feedType);
  }
  
  /**
   * Unsubscribe from market data feeds
   * 
   * @param {string} feedType - Feed type
   * @param {Array<string>} symbols - Symbols in Kraken Futures format
   * @returns {Promise<void>}
   */
  async unsubscribe(feedType, symbols) {
    if (!this.isPublicConnected) {
      throw new Error('Not connected to Kraken Futures WebSocket API');
    }
    
    try {
      this.logger.info(`[KrakenFuturesWS] Unsubscribing from ${feedType} for ${symbols.join(', ')}`);
      
      const unsubscribeMsg = {
        event: 'unsubscribe',
        feed: feedType,
        product_ids: symbols
      };
      
      this.publicWs.send(JSON.stringify(unsubscribeMsg));
      
      // Remove from tracked subscriptions
      symbols.forEach(symbol => {
        const key = `${feedType}:${symbol}`;
        this.subscriptions.delete(key);
      });
      
    } catch (error) {
      this.logger.error('[KrakenFuturesWS] Unsubscription failed:', error);
      throw error;
    }
  }
  
  /**
   * Disconnect from Kraken Futures WebSocket API
   */
  disconnect() {
    this.logger.info('[KrakenFuturesWS] Disconnecting from Kraken Futures WebSocket API');
    
    this._stopHeartbeat();
    
    if (this.publicWs) {
      this.publicWs.close();
      this.publicWs = null;
      this.isPublicConnected = false;
    }
    
    if (this.privateWs) {
      this.privateWs.close();
      this.privateWs = null;
      this.isPrivateConnected = false;
    }
    
    this.subscriptions.clear();
    this.orderBooks.clear();
    this.tickers.clear();
    this.trades.clear();
  }
  
  /**
   * Handle WebSocket error
   * 
   * @private
   */
  _handleError(error, type) {
    this.logger.error(`[KrakenFuturesWS] ${type} WebSocket error:`, error);
    this.emit('error', { type, error });
  }
  
  /**
   * Handle WebSocket close
   * 
   * @private
   */
  _handleClose(code, reason, type) {
    this.logger.info(`[KrakenFuturesWS] ${type} WebSocket closed:`, { code, reason });
    
    if (type === 'public') {
      this.isPublicConnected = false;
    } else {
      this.isPrivateConnected = false;
    }
    
    this.emit('close', { type, code, reason });
    
    // Attempt reconnection if not intentional close
    if (code !== 1000) {
      this._reconnect(type);
    }
  }
  
  /**
   * Reconnect to WebSocket
   * 
   * @private
   */
  async _reconnect(type) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`[KrakenFuturesWS] Max reconnection attempts reached for ${type}`);
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1);
    
    this.logger.info(`[KrakenFuturesWS] Reconnecting ${type} in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        if (type === 'public') {
          await this._connectPublic();
        } else {
          await this._connectPrivate();
        }
        
        // Resubscribe to all feeds
        for (const [key, sub] of this.subscriptions.entries()) {
          const { feedType, symbol, options } = sub;
          await this.subscribe(feedType, [symbol], options);
        }
        
      } catch (error) {
        this.logger.error(`[KrakenFuturesWS] Reconnection failed for ${type}:`, error);
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
    if (this.publicWs && this.isPublicConnected) {
      this.publicWs.ping();
    }
    
    if (this.privateWs && this.isPrivateConnected) {
      this.privateWs.ping();
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
      this.logger.warn('[KrakenFuturesWS] Heartbeat timeout, forcing reconnection');
      
      if (this.publicWs) {
        this.publicWs.close();
      }
      
      if (this.privateWs) {
        this.privateWs.close();
      }
    }
  }
  
  
  /**
   * Handle subscription confirmation
   * 
   * @private
   */
  _handleSubscriptionConfirmation(message) {
    this.logger.info('[KrakenFuturesWS] Subscription confirmed:', message);
    this.emit('subscribed', message);
  }
  
  /**
   * Handle unsubscription confirmation
   * 
   * @private
   */
  _handleUnsubscriptionConfirmation(message) {
    this.logger.info('[KrakenFuturesWS] Unsubscription confirmed:', message);
    this.emit('unsubscribed', message);
  }
  
  /**
   * Handle error message
   * 
   * @private
   */
  _handleErrorMessage(message) {
    this.logger.error('[KrakenFuturesWS] Error message received:', message);
    this.emit('error', { type: 'message', error: message.error });
  }
  
  /**
   * Get current order book for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {Object|null} Order book data
   */
  getOrderBook(symbol) {
    return this.orderBooks.get(symbol) || null;
  }
  
  /**
   * Get current ticker for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {Object|null} Ticker data
   */
  getTicker(symbol) {
    return this.tickers.get(symbol) || null;
  }
  
  /**
   * Get recent trades for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {Array} Trade data
   */
  getTrades(symbol) {
    return this.trades.get(symbol) || [];
  }
  
  // ============================================
  // Private Channel Handlers
  // ============================================
  
  /**
   * Handle fills update
   * 
   * @private
   */
  _handleFills(message) {
    const fills = message.fills || [];
    
    fills.forEach(fill => {
      const fillData = {
        fillId: fill.fill_id,
        orderId: fill.order_id,
        cliOrdId: fill.cliOrdId,
        symbol: fill.symbol,
        side: fill.side,
        size: parseFloat(fill.size),
        price: parseFloat(fill.price),
        fillType: fill.fillType,
        timestamp: new Date(fill.fillTime).getTime()
      };
      
      this.emit('fillUpdate', fillData);
    });
  }
  
  /**
   * Handle open orders update
   * 
   * @private
   */
  _handleOpenOrders(message) {
    const orders = message.orders || [];
    
    const orderData = orders.map(order => ({
      orderId: order.order_id,
      cliOrdId: order.cliOrdId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      size: parseFloat(order.filled) + parseFloat(order.unfilledSize),
      filled: parseFloat(order.filled),
      unfilled: parseFloat(order.unfilledSize),
      limitPrice: order.limitPrice ? parseFloat(order.limitPrice) : null,
      stopPrice: order.stopPrice ? parseFloat(order.stopPrice) : null,
      status: order.status,
      timestamp: new Date(order.receivedTime).getTime()
    }));
    
    this.emit('openOrdersUpdate', orderData);
  }
  
  /**
   * Handle open positions update
   * 
   * @private
   */
  _handleOpenPositions(message) {
    const positions = message.positions || [];
    
    const positionData = positions.map(pos => ({
      symbol: pos.symbol,
      side: pos.side,
      size: parseFloat(pos.size),
      price: parseFloat(pos.price),
      pnl: parseFloat(pos.pnl || 0),
      unrealizedFunding: parseFloat(pos.unrealizedFunding || 0)
    }));
    
    this.emit('openPositionsUpdate', positionData);
  }
  
  /**
   * Handle balances update
   * 
   * @private
   */
  _handleBalances(message) {
    const balances = message.balances || {};
    
    const balanceData = Object.entries(balances).map(([currency, data]) => ({
      currency,
      balance: parseFloat(data.balance || 0),
      availableBalance: parseFloat(data.availableBalance || 0),
      initialMargin: parseFloat(data.initialMargin || 0),
      maintenanceMargin: parseFloat(data.maintenanceMargin || 0),
      pnl: parseFloat(data.pnl || 0),
      unrealizedFunding: parseFloat(data.unrealizedFunding || 0)
    }));
    
    this.emit('balancesUpdate', balanceData);
  }
  
  /**
   * Handle deposits/withdrawals update
   * 
   * @private
   */
  _handleDepositsWithdrawals(message) {
    this.emit('depositsWithdrawalsUpdate', message);
  }
  
  /**
   * Handle account log update
   * 
   * @private
   */
  _handleAccountLog(message) {
    this.emit('accountLogUpdate', message);
  }
  
  /**
   * Handle notifications update
   * 
   * @private
   */
  _handleNotifications(message) {
    this.emit('notificationsUpdate', message);
  }
}