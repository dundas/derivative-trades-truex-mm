/**
 * Adaptive Market Maker Exchange Adapter
 * 
 * This adapter provides a standardized interface between the Adaptive Market Maker
 * and various exchange implementations. It handles order management, position tracking,
 * and market data access in a consistent way regardless of the underlying exchange.
 */

import { EventEmitter } from 'events';
import { TradingLogger } from '../../../lib/utils/trading-logger.js';
import { OrderStatus } from '../order/OrderStatus.js';

/**
 * Adaptive Market Maker Exchange Adapter
 * 
 * @extends EventEmitter
 */
export class AdaptiveMarketMakerExchangeAdapter extends EventEmitter {
  /**
   * Create a new AdaptiveMarketMakerExchangeAdapter
   * 
   * @param {Object} exchangeClient - Exchange client implementation (e.g., KrakenRESTClient)
   * @param {Object} config - Configuration options
   * @param {string} config.symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Object} [config.exchangeOptions] - Exchange-specific options
   */
  constructor(exchangeClient, config = {}) {
    super();
    
    // Store exchange client and configuration
    this.client = exchangeClient;
    this.config = config;
    this.symbol = config.symbol || 'BTC/USD';
    this.sessionId = config.sessionId || `amm-${Date.now()}`;
    
    // Initialize logger
    this.logger = config.logger || new TradingLogger({
      component: 'AdaptiveMarketMakerExchangeAdapter',
      symbol: this.symbol,
      sessionId: this.sessionId
    });
    
    // Store balance manager if provided
    this.balanceManager = config.balanceManager;
    this.orderManager = config.orderManager;
    this.fillManager = config.fillManager;
    
    // Set up event listeners for the exchange client
    if (this.client && typeof this.client.on === 'function') {
      // Listen for order updates
      this.client.on('orderUpdate', this._handleOrderUpdate.bind(this));
      
      // Listen for connection events
      this.client.on('connect', () => this.emit('connect'));
      this.client.on('disconnect', () => this.emit('disconnect'));
      this.client.on('error', (error) => this.emit('error', error));
    }
    
    this.logger.info('AdaptiveMarketMakerExchangeAdapter initialized', {
      symbol: this.symbol,
      exchangeType: this.client ? this.client.constructor.name : 'internal'
    });
  }
  
  /**
   * Register a callback for order updates
   * @param {Function} callback - Callback function for order updates
   */
  onOrderUpdate(callback) {
    this.on('orderUpdate', callback);
  }
  
  /**
   * Place an order on the exchange
   * @param {Object|string} orderOrSymbol - Order details object or symbol
   * @param {string} [orderOrSymbol.symbol] - Trading symbol
   * @param {string} [orderOrSymbol.side] - Order side ('buy' or 'sell')
   * @param {number} [orderOrSymbol.price] - Order price
   * @param {number} [orderOrSymbol.amount] - Order amount
   * @param {string} [orderOrSymbol.type] - Order type ('limit', 'market', etc.)
   * @param {Object} [orderOrSymbol.params] - Additional exchange-specific parameters
   * @param {string} [type] - Order type when using individual parameters
   * @param {string} [side] - Order side when using individual parameters
   * @param {number} [amount] - Order amount when using individual parameters
   * @param {number} [price] - Order price when using individual parameters
   * @param {Object} [params] - Additional parameters when using individual parameters
   * @returns {Promise<Object>} - Order response
   */
  async createOrder(orderOrSymbol, type, side, amount, price, params = {}) {
    try {
      let symbol, orderType, orderSide, orderAmount, orderPrice, orderParams;
      
      // Handle both object format and individual parameters
      if (typeof orderOrSymbol === 'object') {
        symbol = orderOrSymbol.symbol;
        orderType = orderOrSymbol.type;
        orderSide = orderOrSymbol.side;
        orderAmount = orderOrSymbol.amount;
        orderPrice = orderOrSymbol.price;
        orderParams = orderOrSymbol.params || {};
        
        // Extract additional order properties from the object
        if (orderOrSymbol.parentOrderId) {
          orderParams.parentOrderId = orderOrSymbol.parentOrderId;
        }
        if (orderOrSymbol.clientOrderId) {
          orderParams.clientOrderId = orderOrSymbol.clientOrderId;
        }
        if (orderOrSymbol.sessionId) {
          orderParams.sessionId = orderOrSymbol.sessionId;
        }
        if (orderOrSymbol.purpose) {
          orderParams.purpose = orderOrSymbol.purpose;
        }
        if (orderOrSymbol.pricingMetadata) {
          orderParams.pricingMetadata = orderOrSymbol.pricingMetadata;
        }
      } else {
        symbol = orderOrSymbol;
        orderType = type;
        orderSide = side;
        orderAmount = amount;
        orderPrice = price;
        orderParams = params;
      }
      
      this.logger.info('Creating order', { symbol, type: orderType, side: orderSide, amount: orderAmount, price: orderPrice });
      
      // Call the exchange client to place the order
      // Check if this is a KrakenWebSocketV2ExchangeAdapter that expects object format
      let order;
      if (this.client && this.client.constructor && this.client.constructor.name === 'KrakenWebSocketV2ExchangeAdapter') {
        // Use object format for KrakenWebSocketV2ExchangeAdapter to preserve parentOrderId and purpose
        order = await this.client.createOrder({
          symbol,
          type: orderType,
          side: orderSide,
          amount: orderAmount,
          price: orderPrice,
          clientOrderId: orderParams.clientOrderId,
          parentOrderId: orderParams.parentOrderId,
          purpose: orderParams.purpose,
          sessionId: orderParams.sessionId,
          pricingMetadata: orderParams.pricingMetadata
        });
      } else {
        // Use individual parameters format for other adapters
        order = await this.client.createOrder(symbol, orderType, orderSide, orderAmount, orderPrice, orderParams);
      }
      
      // Emit order created event
      this.emit('orderCreated', {
        id: order.id,
        clientOrderId: order.clientOrderId || orderParams.clientOrderId,
        symbol,
        side: orderSide,
        type: orderType,
        price: orderPrice,
        amount: orderAmount,
        status: order.status || OrderStatus.OPEN,
        timestamp: Date.now(),
        sessionId: orderParams.sessionId || this.sessionId,
        parentOrderId: orderParams.parentOrderId || order.parentOrderId || null,
        purpose: orderParams.purpose || order.purpose || null
      });
      
      return order;
    } catch (error) {
      const logDetails = typeof orderOrSymbol === 'object' 
        ? { order: orderOrSymbol, error: error.message, stack: error.stack }
        : { symbol: orderOrSymbol, type, side, amount, price, error: error.message, stack: error.stack };
      
      this.logger.error('Error creating order', logDetails);
      
      throw error;
    }
  }
  
  /**
   * Cancel an order on the exchange
   * @param {string} orderId - ID of the order to cancel
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Cancellation response
   */
  async cancelOrder(orderId, params = {}) {
    try {
      this.logger.info('Cancelling order', { orderId });
      
      // Call the exchange client to cancel the order
      const result = await this.client.cancelOrder(orderId, params);
      
      // Emit order cancelled event
      this.emit('orderCancelled', {
        id: orderId,
        status: OrderStatus.CANCELLED,
        timestamp: Date.now()
      });
      
      return result;
    } catch (error) {
      this.logger.error('Error cancelling order', {
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get the status of an order
   * @param {string} orderId - ID of the order
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Order status
   */
  async getOrderStatus(orderId, params = {}) {
    try {
      this.logger.debug('Getting order status', { orderId });
      
      // Call the exchange client to get the order status
      return await this.client.getOrderStatus(orderId, params);
    } catch (error) {
      this.logger.error('Error getting order status', {
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get all open orders
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Array>} - Open orders
   */
  async getOpenOrders(params = {}) {
    try {
      this.logger.debug('Getting open orders');
      
      // Call the exchange client to get open orders
      return await this.client.getOpenOrders(params);
    } catch (error) {
      this.logger.error('Error getting open orders', {
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Cancel all managed orders
   * @param {string} reason - Reason for cancellation
   * @returns {Promise<Array>} - Array of cancellation results
   */
  async cancelAllManagedOrders(reason = 'session_ending') {
    try {
      this.logger.info('Canceling all managed orders', { reason });
      
      // Get all open orders from the order manager if available
      let openOrders = [];
      if (this.orderManager && typeof this.orderManager.getAll === 'function') {
        const allOrders = await this.orderManager.getAll();
        openOrders = allOrders.filter(order => 
          ['open', 'pending', 'new', 'partially_filled'].includes(order.status?.toLowerCase())
        );
      } else {
        // Fallback to exchange API
        openOrders = await this.getOpenOrders();
      }
      
      this.logger.info(`Found ${openOrders.length} open orders to cancel`);
      
      const cancelResults = [];
      for (const order of openOrders) {
        try {
          const result = await this.cancelOrder(order.id || order.orderId, { reason });
          cancelResults.push({ orderId: order.id || order.orderId, success: true, result });
        } catch (error) {
          this.logger.error(`Failed to cancel order ${order.id || order.orderId}`, { error: error.message });
          cancelResults.push({ orderId: order.id || order.orderId, success: false, error: error.message });
        }
      }
      
      return cancelResults;
    } catch (error) {
      this.logger.error('Error in cancelAllManagedOrders', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
  
  /**
   * Cancel all open buy orders only
   * @param {string} reason - Reason for cancellation
   * @returns {Promise<Array>} - Array of cancellation results
   */
  async cancelOpenBuyOrders(reason = 'session_ending') {
    try {
      this.logger.info('Canceling all open buy orders', { reason });
      
      // Get all open orders from the order manager if available
      let openOrders = [];
      if (this.orderManager && typeof this.orderManager.getAll === 'function') {
        const allOrders = await this.orderManager.getAll();
        openOrders = allOrders.filter(order => 
          order.side === 'buy' &&
          ['open', 'pending', 'new', 'partially_filled'].includes(order.status?.toLowerCase())
        );
      } else {
        // Fallback to exchange API and filter for buy orders
        const allOpenOrders = await this.getOpenOrders();
        openOrders = allOpenOrders.filter(order => order.side === 'buy');
      }
      
      this.logger.info(`Found ${openOrders.length} open buy orders to cancel`);
      
      const cancelResults = [];
      for (const order of openOrders) {
        try {
          const result = await this.cancelOrder(order.id || order.orderId, { reason });
          cancelResults.push({ orderId: order.id || order.orderId, success: true, result });
        } catch (error) {
          this.logger.error(`Failed to cancel buy order ${order.id || order.orderId}`, { error: error.message });
          cancelResults.push({ orderId: order.id || order.orderId, success: false, error: error.message });
        }
      }
      
      return cancelResults;
    } catch (error) {
      this.logger.error('Error in cancelOpenBuyOrders', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
  
  /**
   * Get account balances
   * @returns {Promise<Object>} - Account balances
   */
  async getBalances() {
    try {
      this.logger.debug('Getting balances');
      
      // Use the BalanceManager if available for consistent balance tracking
      if (this.balanceManager) {
        this.logger.debug('Using BalanceManager to retrieve balances');
        const balance = await this.balanceManager.getBalance();
        const [base, quote] = this.symbol.split('/');
        
        // Convert the BalanceManager format to the exchange adapter format
        const balances = {
          [quote]: balance.total || 0,
          [base]: balance.baseAmount || 0
        };
        
        this.logger.debug(`Retrieved balances from BalanceManager: ${JSON.stringify(balances)}`);
        return balances;
      }
      
      // Call the exchange client to get balances as a fallback
      this.logger.debug('Falling back to exchange client for balances');
      return await this.client.getBalances();
    } catch (error) {
      this.logger.error('Error getting balances', {
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get positions for the account
   * @returns {Promise<Array>} - Account positions
   */
  async getPositions() {
    try {
      this.logger.debug('Getting positions');
      
      // Use the BalanceManager if available for consistent position tracking
      if (this.balanceManager) {
        this.logger.debug('Using BalanceManager to retrieve positions');
        const balance = await this.balanceManager.getBalance();
        const [base, quote] = this.symbol.split('/');
        
        // If there's no position, return empty array
        if (!balance.baseAmount || balance.baseAmount === 0) {
          this.logger.debug('No active positions found via BalanceManager');
          return [];
        }
        
        // Create position object from balance data
        const position = {
          symbol: base,
          size: balance.baseAmount,
          entryPrice: balance.entryPrice || 0,
          markPrice: balance.lastPrice || 0,
          pnl: 0,
          unrealizedPnl: 0
        };
        
        // Calculate unrealized P&L if we have a mark price and entry price
        if (balance.lastPrice && balance.entryPrice) {
          position.unrealizedPnl = position.size * (balance.lastPrice - balance.entryPrice);
        }
        
        this.logger.debug(`Retrieved position from BalanceManager: ${JSON.stringify(position)}`);
        return [position];
      }
      
      // Call the exchange client to get positions as a fallback
      this.logger.debug('Falling back to exchange client for positions');
      return await this.client.getPositions();
    } catch (error) {
      this.logger.error('Error getting positions', {
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get the current order book for a symbol
   * @param {string} symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Order book data
   */
  async getOrderBook(symbol = this.symbol, params = {}) {
    try {
      this.logger.debug('Getting order book', { symbol, params });
      
      // Call the exchange client to get the order book
      return await this.client.getOrderBook(symbol, params);
    } catch (error) {
      this.logger.error('Error getting order book', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get ticker information for a symbol
   * @param {string} symbol - Trading symbol (e.g., 'BTC/USD')
   * @returns {Promise<Object>} - Ticker data
   */
  async getTicker(symbol = this.symbol) {
    try {
      this.logger.debug('Getting ticker', { symbol });
      
      // Call the exchange client to get the ticker
      return await this.client.getTicker(symbol);
    } catch (error) {
      this.logger.error('Error getting ticker', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get recent trades for a symbol
   * @param {string} symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Array>} - Recent trades
   */
  async getTrades(symbol = this.symbol, params = {}) {
    try {
      this.logger.debug('Getting trades', { symbol, params });
      
      // Call the exchange client to get trades
      return await this.client.getTrades(symbol, params);
    } catch (error) {
      this.logger.error('Error getting trades', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Get OHLC data for a symbol
   * @param {string} symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Array>} - OHLC data
   */
  async getOHLC(symbol = this.symbol, params = {}) {
    try {
      this.logger.debug('Getting OHLC data', { symbol, params });
      
      // Call the exchange client to get OHLC data
      return await this.client.getOHLC(symbol, params);
    } catch (error) {
      this.logger.error('Error getting OHLC data', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Handle order update from the exchange client
   * @param {Object} update - Order update data
   * @private
   */
  _handleOrderUpdate(update) {
    try {
      this.logger.debug('Received order update', { update });
      
      // Emit order update event
      this.emit('orderUpdate', update);
    } catch (error) {
      this.logger.error('Error handling order update', {
        error: error.message,
        stack: error.stack,
        update
      });
    }
  }
}

export default AdaptiveMarketMakerExchangeAdapter;
