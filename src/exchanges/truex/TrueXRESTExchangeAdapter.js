import { BaseExchangeAdapter } from './BaseExchangeAdapter.js';
import { TrueXRESTClient } from './TrueXRESTClient.js';
import WebSocket from 'ws';

/**
 * TrueX REST Exchange Adapter
 * 
 * Implements the BaseExchangeAdapter interface using TrueX REST API
 * with optional WebSocket support for real-time market data
 */
export class TrueXRESTExchangeAdapter extends BaseExchangeAdapter {
  constructor(config) {
    super({
      ...config,
      exchangeName: 'TrueX',
      strategyName: config.strategyName || 'truex_rest_strategy'
    });
    
    // REST client configuration
    this.restClient = new TrueXRESTClient({
      baseURL: config.baseURL || 'https://prod.truex.co/api/v1',
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      userId: config.userId || config.apiKey, // userId might be same as apiKey
      timeout: config.timeout || 30000
    });
    
    // WebSocket configuration for market data
    this.wsUrl = config.wsUrl || 'wss://ws.truex.co';
    this.ws = null;
    this.wsConnected = false;
    this.wsReconnectAttempts = 0;
    this.wsMaxReconnectAttempts = config.maxReconnectAttempts || 5;
    this.wsReconnectDelay = config.initialReconnectDelayMs || 1000;
    
    // Market data subscriptions
    this.marketDataSubscriptions = new Set();
    
    // Polling intervals for REST fallback
    this.orderStatusPollInterval = null;
    this.orderBookPollInterval = null;
    this.balancePollInterval = null;
    
    // Polling configuration
    this.orderStatusPollIntervalMs = config.orderStatusPollIntervalMs || 1000;
    this.orderBookPollIntervalMs = config.orderBookPollIntervalMs || 500;
    this.balancePollIntervalMs = config.balancePollIntervalMs || 5000;
    
    // Cache for instrument mappings
    this.instrumentCache = new Map();
    this.instrumentCacheExpiry = 3600000; // 1 hour
  }

  /**
   * Connects to TrueX
   */
  async connect() {
    this.logger.info(`[TrueX REST] Connecting to TrueX...`);
    
    try {
      // Test REST connectivity
      const ping = await this.restClient.ping();
      if (!ping.success) {
        throw new Error(`REST API ping failed: ${ping.error}`);
      }
      
      this.logger.info(`[TrueX REST] REST API connected successfully`);
      
      // Load initial data
      await this._loadInstrumentData();
      await this._loadInitialBalances();
      
      // Connect WebSocket for market data (optional)
      if (this.wsUrl) {
        await this._connectWebSocket();
      }
      
      // Start polling for order updates
      this._startOrderStatusPolling();
      
      // Start balance polling
      this._startBalancePolling();
      
      this.logger.info(`[TrueX REST] Successfully connected`);
    } catch (error) {
      this.logger.error(`[TrueX REST] Connection failed: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Loads instrument data into cache
   */
  async _loadInstrumentData() {
    try {
      const response = await this.restClient.getInstruments({ page_size: 500 });
      
      if (response.data) {
        for (const instrument of response.data) {
          this.instrumentCache.set(instrument.symbol, {
            data: instrument,
            timestamp: Date.now()
          });
        }
      }
      
      this.logger.info(`[TrueX REST] Loaded ${this.instrumentCache.size} instruments`);
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to load instruments: ${error.message}`);
    }
  }

  /**
   * Gets instrument from cache or API
   */
  async _getInstrument(symbol) {
    // Check cache first
    const cached = this.instrumentCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.instrumentCacheExpiry) {
      return cached.data;
    }
    
    // Fetch from API
    try {
      const instrument = await this.restClient.getInstrument(symbol);
      if (instrument) {
        this.instrumentCache.set(symbol, {
          data: instrument,
          timestamp: Date.now()
        });
      }
      return instrument;
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to get instrument ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Loads initial balance data
   */
  async _loadInitialBalances() {
    try {
      await this.fetchBalances();
      this.logger.info(`[TrueX REST] Initial balances loaded`);
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to load initial balances: ${error.message}`);
    }
  }

  /**
   * Connects to WebSocket for market data
   */
  async _connectWebSocket() {
    return new Promise((resolve, reject) => {
      this.logger.info(`[TrueX REST] Connecting to WebSocket for market data...`);
      
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => {
        this.logger.info(`[TrueX REST] WebSocket connected`);
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;
        
        // Authenticate WebSocket connection
        this._authenticateWebSocket();
        
        // Resubscribe to market data
        for (const symbol of this.marketDataSubscriptions) {
          this._subscribeWebSocketMarketData(symbol);
        }
        
        resolve();
      });
      
      this.ws.on('message', (data) => {
        this._handleWebSocketMessage(data);
      });
      
      this.ws.on('error', (error) => {
        this.logger.error(`[TrueX REST] WebSocket error: ${error.message}`);
        this.wsConnected = false;
      });
      
      this.ws.on('close', () => {
        this.logger.warn(`[TrueX REST] WebSocket disconnected`);
        this.wsConnected = false;
        this._handleWebSocketDisconnect();
      });
      
      // Set connection timeout
      setTimeout(() => {
        if (!this.wsConnected) {
          this.logger.warn(`[TrueX REST] WebSocket connection timeout, using REST polling`);
          resolve(); // Don't reject, just use REST polling
        }
      }, 10000);
    });
  }

  /**
   * Authenticates WebSocket connection
   */
  _authenticateWebSocket() {
    const timestamp = Date.now().toString();
    const message = `${timestamp}WEBSOCKET_AUTH`;
    const signature = crypto
      .createHmac('sha256', this.restClient.apiSecret)
      .update(message)
      .digest('hex');
    
    this.ws.send(JSON.stringify({
      type: 'auth',
      api_key: this.restClient.apiKey,
      timestamp: timestamp,
      signature: signature
    }));
  }

  /**
   * Handles WebSocket messages
   */
  _handleWebSocketMessage(data) {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'orderbook':
          this._handleWebSocketOrderBook(message);
          break;
        case 'trade':
          this._handleWebSocketTrade(message);
          break;
        case 'auth_result':
          if (message.success) {
            this.logger.info(`[TrueX REST] WebSocket authenticated`);
          } else {
            this.logger.error(`[TrueX REST] WebSocket authentication failed`);
          }
          break;
        default:
          this.logger.debug(`[TrueX REST] Unknown WebSocket message type: ${message.type}`);
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to handle WebSocket message: ${error.message}`);
    }
  }

  /**
   * Handles WebSocket order book updates
   */
  _handleWebSocketOrderBook(message) {
    const orderBook = {
      symbol: message.symbol,
      bids: message.bids || [],
      asks: message.asks || [],
      timestamp: message.timestamp || Date.now()
    };
    
    this._emitOrderBookUpdate(orderBook);
  }

  /**
   * Handles WebSocket trade updates
   */
  _handleWebSocketTrade(message) {
    const trade = {
      symbol: message.symbol,
      price: parseFloat(message.price),
      amount: parseFloat(message.quantity),
      side: message.side,
      timestamp: message.timestamp || Date.now()
    };
    
    this._emitTradeUpdate(trade);
  }

  /**
   * Handles WebSocket disconnection
   */
  _handleWebSocketDisconnect() {
    if (this.wsReconnectAttempts < this.wsMaxReconnectAttempts) {
      this.wsReconnectAttempts++;
      const delay = Math.min(
        this.wsReconnectDelay * Math.pow(2, this.wsReconnectAttempts - 1),
        30000
      );
      
      this.logger.info(`[TrueX REST] Reconnecting WebSocket in ${delay}ms (attempt ${this.wsReconnectAttempts})`);
      
      setTimeout(() => {
        this._connectWebSocket().catch(() => {
          // Ignore error, will retry or fall back to REST
        });
      }, delay);
    } else {
      this.logger.warn(`[TrueX REST] Max WebSocket reconnection attempts reached, using REST polling only`);
      this._startOrderBookPolling();
    }
  }

  /**
   * Subscribes to WebSocket market data
   */
  _subscribeWebSocketMarketData(symbol) {
    if (this.ws && this.wsConnected) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'orderbook',
        symbol: symbol
      }));
      
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'trades',
        symbol: symbol
      }));
    }
  }

  /**
   * Starts polling for order status updates
   */
  _startOrderStatusPolling() {
    if (this.orderStatusPollInterval) {
      clearInterval(this.orderStatusPollInterval);
    }
    
    this.orderStatusPollInterval = setInterval(async () => {
      await this._pollOrderStatuses();
    }, this.orderStatusPollIntervalMs);
  }

  /**
   * Polls for order status updates
   */
  async _pollOrderStatuses() {
    try {
      // Get active orders from REST API
      const response = await this.restClient.getActiveOrders();
      
      if (response.data) {
        for (const apiOrder of response.data) {
          const order = this.restClient.parseOrder(apiOrder);
          
          // Check if order exists in our cache
          const cachedOrder = this.activeOrders.get(order.id);
          
          if (cachedOrder) {
            // Check for status changes
            if (cachedOrder.status !== order.status || 
                cachedOrder.filled !== order.filled) {
              
              // Update order
              await this._updateOrderStatus(order.id, order.status, {
                filled: order.filled,
                remaining: order.remaining
              });
              
              // Check for new fills
              if (order.filled > cachedOrder.filled) {
                await this._checkForNewFills(order.id, cachedOrder.filled);
              }
            }
          } else {
            // New order detected, store it
            await this._storeOrder(order);
          }
        }
        
        // Check for canceled/completed orders
        for (const [orderId, cachedOrder] of this.activeOrders) {
          const found = response.data.find(o => o.id === orderId);
          if (!found && (cachedOrder.status === 'open' || cachedOrder.status === 'partially-filled')) {
            // Order no longer active, check final status
            await this._checkOrderFinalStatus(orderId);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Order status polling error: ${error.message}`);
    }
  }

  /**
   * Checks for new fills on an order
   */
  async _checkForNewFills(orderId, previousFilledAmount) {
    try {
      const trades = await this.restClient.getOrderTrades({ order_id: orderId });
      
      if (trades.data) {
        for (const trade of trades.data) {
          const tradeAmount = parseFloat(trade.quantity);
          const totalFilled = trades.data
            .slice(0, trades.data.indexOf(trade) + 1)
            .reduce((sum, t) => sum + parseFloat(t.quantity), 0);
          
          if (totalFilled > previousFilledAmount) {
            // New fill detected
            const fillData = {
              orderId: orderId,
              fillId: trade.id,
              price: parseFloat(trade.price),
              amount: tradeAmount,
              side: trade.order_side,
              timestamp: new Date(trade.created_at).getTime(),
              fee: parseFloat(trade.fee || 0)
            };
            
            await this._processFill(fillData);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to check fills for order ${orderId}: ${error.message}`);
    }
  }

  /**
   * Checks final status of an order
   */
  async _checkOrderFinalStatus(orderId) {
    try {
      const response = await this.restClient.getOrders({ id: orderId });
      
      if (response.data && response.data.length > 0) {
        const apiOrder = response.data[0];
        const order = this.restClient.parseOrder(apiOrder);
        
        await this._updateOrderStatus(order.id, order.status, {
          filled: order.filled,
          remaining: order.remaining
        });
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to check final status for order ${orderId}: ${error.message}`);
    }
  }

  /**
   * Starts polling for order book updates (fallback when WebSocket unavailable)
   */
  _startOrderBookPolling() {
    if (this.orderBookPollInterval) {
      clearInterval(this.orderBookPollInterval);
    }
    
    if (this.marketDataSubscriptions.size > 0 && !this.wsConnected) {
      this.orderBookPollInterval = setInterval(async () => {
        for (const symbol of this.marketDataSubscriptions) {
          await this._pollOrderBook(symbol);
        }
      }, this.orderBookPollIntervalMs);
    }
  }

  /**
   * Polls order book via REST
   */
  async _pollOrderBook(symbol) {
    try {
      const quote = await this.restClient.getMarketQuoteBySymbol(symbol);
      
      if (quote.data) {
        const orderBook = {
          symbol: symbol,
          bids: quote.data.bids || [],
          asks: quote.data.asks || [],
          timestamp: Date.now()
        };
        
        this._emitOrderBookUpdate(orderBook);
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to poll order book for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Starts polling for balance updates
   */
  _startBalancePolling() {
    if (this.balancePollInterval) {
      clearInterval(this.balancePollInterval);
    }
    
    this.balancePollInterval = setInterval(async () => {
      await this.fetchBalances();
    }, this.balancePollIntervalMs);
  }

  /**
   * Creates a new order
   */
  async createOrder(orderParams) {
    const {
      symbol = this.tradingPair,
      type = 'limit',
      side,
      price,
      amount,
      clientId,
      params = {}
    } = orderParams;
    
    // Validate required fields
    if (!side || !amount) {
      throw new Error('Missing required order parameters: side and amount are required');
    }
    
    if (type === 'limit' && !price) {
      throw new Error('Price is required for limit orders');
    }
    
    // Format order for API
    const order = this.restClient.formatOrder({
      clientOrderId: clientId,
      type,
      side,
      symbol,
      amount,
      price,
      timeInForce: params.timeInForce,
      postOnly: params.postOnly,
      clientId: params.clientId
    });
    
    try {
      // Create order via REST API
      const response = await this.restClient.createOrder(order);
      
      if (response.data) {
        const createdOrder = this.restClient.parseOrder(response.data);
        
        // Store order
        await this._storeOrder(createdOrder);
        
        return createdOrder;
      } else {
        throw new Error('Invalid response from create order API');
      }
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to create order: ${error.message}`, { order });
      throw error;
    }
  }

  /**
   * Cancels an order
   */
  async cancelOrder(orderId, params = {}) {
    try {
      // Get order details
      const order = this.activeOrders.get(orderId);
      if (!order) {
        throw new Error(`Order not found: ${orderId}`);
      }
      
      // Cancel via REST API
      await this.restClient.cancelOrder(order.clientOrderId);
      
      // Update order status
      await this._updateOrderStatus(orderId, 'canceled');
      
      return { id: orderId, status: 'canceled' };
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to cancel order ${orderId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetches current balances
   */
  async fetchBalances() {
    try {
      const response = await this.restClient.getBalances();
      
      if (response.data) {
        const balances = {};
        
        for (const balance of response.data) {
          const asset = balance.asset?.name || balance.asset_id;
          balances[asset] = {
            free: parseFloat(balance.available || 0),
            used: parseFloat(balance.reserved || 0),
            total: parseFloat(balance.total || 0)
          };
        }
        
        this.currentBalances = balances;
        this._emitBalancesUpdated(balances);
        
        return balances;
      }
      
      return {};
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to fetch balances: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetches open positions (spot trading has implicit positions in balances)
   */
  async fetchPositions() {
    return {};
  }

  /**
   * Cancels all managed orders
   */
  async cancelAllManagedOrders(reason) {
    try {
      const results = await this.restClient.cancelAllOrders();
      
      // Update local order states
      for (const result of results) {
        if (result.success) {
          const order = Array.from(this.activeOrders.values())
            .find(o => o.clientOrderId === result.ref_order_id);
          
          if (order) {
            await this._updateOrderStatus(order.id, 'canceled');
          }
        }
      }
      
      return results;
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to cancel all orders: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancels all open buy orders
   */
  async cancelOpenBuyOrders(reason) {
    const results = [];
    
    for (const [orderId, order] of this.activeOrders) {
      if (order.side === 'buy' && (order.status === 'open' || order.status === 'partially-filled')) {
        try {
          await this.cancelOrder(orderId);
          results.push({ orderId, success: true });
        } catch (error) {
          results.push({ orderId, success: false, error: error.message });
        }
      }
    }
    
    return results;
  }

  /**
   * Gets order status
   */
  async getOrderStatus(orderId) {
    // Check local cache first
    const cachedOrder = this.activeOrders.get(orderId);
    if (cachedOrder) {
      return cachedOrder;
    }
    
    // Fetch from API
    try {
      const response = await this.restClient.getOrders({ id: orderId });
      
      if (response.data && response.data.length > 0) {
        return this.restClient.parseOrder(response.data[0]);
      }
      
      throw new Error(`Order not found: ${orderId}`);
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to get order status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets list of tradable pairs
   */
  async getTradablePairs() {
    try {
      const response = await this.restClient.getInstruments({ page_size: 500 });
      
      if (response.data) {
        return response.data.map(instrument => instrument.symbol);
      }
      
      return [];
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to get tradable pairs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets pair details
   */
  async getPairDetails(pair) {
    try {
      const instrument = await this._getInstrument(pair);
      
      if (!instrument) {
        throw new Error(`Instrument not found: ${pair}`);
      }
      
      return {
        symbol: instrument.symbol,
        base: instrument.base_asset?.name,
        quote: instrument.quote_asset?.name,
        minOrderSize: parseFloat(instrument.min_quantity || 0.001),
        minPriceIncrement: parseFloat(instrument.tick_size || 0.01),
        precision: {
          amount: instrument.quantity_precision || 8,
          price: instrument.price_precision || 2
        },
        fees: {
          maker: parseFloat(instrument.maker_fee || 0.001),
          taker: parseFloat(instrument.taker_fee || 0.002)
        }
      };
    } catch (error) {
      this.logger.error(`[TrueX REST] Failed to get pair details: ${error.message}`);
      throw error;
    }
  }

  /**
   * Subscribes to market data
   */
  async subscribeMarketData(symbol) {
    this.marketDataSubscriptions.add(symbol);
    
    if (this.wsConnected) {
      // Use WebSocket
      this._subscribeWebSocketMarketData(symbol);
    } else {
      // Start REST polling if not already running
      if (!this.orderBookPollInterval) {
        this._startOrderBookPolling();
      }
    }
    
    this.logger.info(`[TrueX REST] Subscribed to market data for ${symbol}`);
  }

  /**
   * Unsubscribes from market data
   */
  async unsubscribeMarketData(symbol) {
    this.marketDataSubscriptions.delete(symbol);
    
    if (this.wsConnected) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'orderbook',
        symbol: symbol
      }));
      
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'trades',
        symbol: symbol
      }));
    }
    
    // Stop polling if no more subscriptions
    if (this.marketDataSubscriptions.size === 0 && this.orderBookPollInterval) {
      clearInterval(this.orderBookPollInterval);
      this.orderBookPollInterval = null;
    }
    
    this.logger.info(`[TrueX REST] Unsubscribed from market data for ${symbol}`);
  }

  /**
   * Disconnects from TrueX
   */
  async disconnect() {
    this.logger.info(`[TrueX REST] Disconnecting...`);
    
    // Stop polling intervals
    if (this.orderStatusPollInterval) {
      clearInterval(this.orderStatusPollInterval);
      this.orderStatusPollInterval = null;
    }
    
    if (this.orderBookPollInterval) {
      clearInterval(this.orderBookPollInterval);
      this.orderBookPollInterval = null;
    }
    
    if (this.balancePollInterval) {
      clearInterval(this.balancePollInterval);
      this.balancePollInterval = null;
    }
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }
    
    this.logger.info(`[TrueX REST] Disconnected successfully`);
  }
}

export default TrueXRESTExchangeAdapter;