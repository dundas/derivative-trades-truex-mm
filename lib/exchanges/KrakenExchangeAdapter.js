/**
 * Kraken Exchange Adapter for Adaptive Market Maker
 * 
 * This adapter implements the exchange interface for Kraken,
 * providing a consistent API for the Adaptive Market Maker.
 */

import { TradingLogger } from '../../../../utils/trading-logger.js';
import { AdaptiveMarketMakerExchangeAdapter } from './AdaptiveMarketMakerExchangeAdapter.js';
import { KrakenPrivateWebSocketAdapter } from '../../../../lib/exchanges/adapters/KrakenPrivateWebSocketAdapter.js';

/**
 * Kraken Exchange Adapter for Adaptive Market Maker
 * 
 * @extends AdaptiveMarketMakerExchangeAdapter
 */
export class KrakenExchangeAdapter extends AdaptiveMarketMakerExchangeAdapter {
  /**
   * Create a new KrakenExchangeAdapter
   * 
   * @param {Object} krakenClient - Kraken REST client instance
   * @param {Object} config - Configuration options
   * @param {string} config.symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Object} [config.krakenOptions] - Kraken-specific options
   * @param {boolean} [config.krakenOptions.useWebSocket] - Whether to use WebSocket for order operations
   * @param {string} [config.krakenOptions.token] - WebSocket authentication token
   * @param {string} [config.krakenOptions.apiKey] - API key for authentication
   * @param {string} [config.krakenOptions.apiSecret] - API secret for authentication
   */
  constructor(krakenClient, config = {}) {
    super(krakenClient, config);
    
    // Initialize logger with Kraken-specific component name
    this.logger = config.logger || new TradingLogger({
      component: 'KrakenExchangeAdapter',
      symbol: this.symbol,
      sessionId: this.sessionId
    });
    
    // Store Kraken-specific configuration
    this.krakenOptions = config.krakenOptions || {};
    
    // Initialize fee caching
    this.feeCache = {
      makerFee: null,
      takerFee: null,
      lastUpdated: null,
      volume: null,
      currency: null
    };
    this.feeRefreshIntervalMs = config.feeRefreshIntervalMs || 300000; // 5 minutes default
    this.fallbackFees = {
      maker: 0.0025, // Kraken standard maker fee
      taker: 0.004   // Kraken standard taker fee
    };
    
    // Initialize WebSocket adapter if enabled
    if (this.krakenOptions.useWebSocket) {
      this._initializeWebSocket();
    }
    
    this.logger.info('KrakenExchangeAdapter initialized', {
      symbol: this.symbol,
      useWebSocket: !!this.krakenOptions.useWebSocket,
      feeRefreshInterval: this.feeRefreshIntervalMs
    });
  }
  
  /**
   * Initialize WebSocket adapter for order operations
   * @private
   */
  _initializeWebSocket() {
    try {
      this.logger.info('Initializing Kraken WebSocket adapter');
      
      // Create WebSocket adapter
      this.wsAdapter = new KrakenPrivateWebSocketAdapter({
        logger: this.logger,
        sessionId: this.sessionId,
        onOrderUpdate: this._handleOrderUpdate.bind(this),
        onConnect: () => this.emit('wsConnect'),
        onError: (error) => this.emit('wsError', error),
        onClose: () => this.emit('wsClose')
      }, {
        token: this.krakenOptions.token,
        apiKey: this.krakenOptions.apiKey,
        apiSecret: this.krakenOptions.apiSecret
      });
      
      // Connect WebSocket
      this.wsAdapter.connect();
    } catch (error) {
      this.logger.error('Error initializing WebSocket adapter', {
        error: error.message,
        stack: error.stack
      });
    }
  }
  
  /**
   * Place an order on the exchange, using WebSocket if available
   * @param {string} symbol - Trading symbol
   * @param {string} type - Order type ('limit', 'market', etc.)
   * @param {string} side - Order side ('buy' or 'sell')
   * @param {number} amount - Order amount
   * @param {number} price - Order price
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Order response
   */
  async createOrder(symbol, type, side, amount, price, params = {}) {
    try {
      // Use WebSocket for order placement if available
      if (this.wsAdapter && this.wsAdapter.isConnected()) {
        this.logger.info('Creating order via WebSocket', { symbol, type, side, amount, price });
        
        // Prepare order parameters for WebSocket
        const wsParams = {
          ordertype: type,
          type: side,
          volume: amount.toString(),
          pair: symbol,
          ...params
        };
        
        // Add price for limit orders
        if (type === 'limit') {
          wsParams.price = price.toString();
        }
        
        // Place order via WebSocket
        const order = await this.wsAdapter.addOrder(wsParams);
        
        // Emit order created event
        this.emit('orderCreated', {
          id: order.txid,
          clientOrderId: order.userref,
          symbol,
          side,
          type,
          price,
          amount,
          status: 'open',
          timestamp: Date.now()
        });
        
        return order;
      }
      
      // Fall back to REST API
      return super.createOrder(symbol, type, side, amount, price, params);
    } catch (error) {
      this.logger.error('Error creating order', {
        symbol, type, side, amount, price,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }
  
  /**
   * Cancel an order on the exchange, using WebSocket if available
   * @param {string} orderId - ID of the order to cancel
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Cancellation response
   */
  async cancelOrder(orderId, params = {}) {
    try {
      // Use WebSocket for order cancellation if available
      if (this.wsAdapter && this.wsAdapter.isConnected()) {
        this.logger.info('Cancelling order via WebSocket', { orderId });
        
        // Cancel order via WebSocket
        const result = await this.wsAdapter.cancelOrder(orderId);
        
        // Emit order cancelled event
        this.emit('orderCancelled', {
          id: orderId,
          status: 'cancelled',
          timestamp: Date.now()
        });
        
        return result;
      }
      
      // Fall back to REST API
      return super.cancelOrder(orderId, params);
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
   * Normalize Kraken order book data to a standard format
   * @param {Object} orderBook - Kraken order book data
   * @returns {Object} - Normalized order book data
   */
  _normalizeOrderBook(orderBook) {
    try {
      // Check if already normalized
      if (orderBook.bids && Array.isArray(orderBook.bids) && 
          orderBook.asks && Array.isArray(orderBook.asks)) {
        return orderBook;
      }
      
      // Kraken-specific normalization
      const normalized = {
        bids: [],
        asks: [],
        timestamp: Date.now()
      };
      
      // Normalize bids
      if (orderBook.bids) {
        normalized.bids = orderBook.bids.map(bid => [
          parseFloat(bid[0]), // price
          parseFloat(bid[1])  // amount
        ]);
      }
      
      // Normalize asks
      if (orderBook.asks) {
        normalized.asks = orderBook.asks.map(ask => [
          parseFloat(ask[0]), // price
          parseFloat(ask[1])  // amount
        ]);
      }
      
      return normalized;
    } catch (error) {
      this.logger.error('Error normalizing order book', {
        error: error.message,
        stack: error.stack
      });
      
      return orderBook;
    }
  }
  
  /**
   * Get the current order book for a symbol with Kraken-specific normalization
   * @param {string} symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [params] - Additional exchange-specific parameters
   * @returns {Promise<Object>} - Normalized order book data
   */
  async getOrderBook(symbol = this.symbol, params = {}) {
    try {
      const orderBook = await super.getOrderBook(symbol, params);
      return this._normalizeOrderBook(orderBook);
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
   * Normalize Kraken balance data to a standard format
   * @param {Object} balances - Kraken balance data
   * @returns {Object} - Normalized balance data
   */
  _normalizeBalances(balances) {
    try {
      const normalized = {};
      
      // Process each currency
      Object.entries(balances).forEach(([currency, amount]) => {
        // Convert Kraken currency codes to standard format
        // e.g., 'XXBT' -> 'BTC', 'ZUSD' -> 'USD'
        let standardCurrency = currency;
        
        if (currency.startsWith('X') && currency.length === 4) {
          // Handle crypto currencies (XXBT -> BTC)
          standardCurrency = currency.substring(1);
          if (standardCurrency === 'XBT') standardCurrency = 'BTC';
        } else if (currency.startsWith('Z') && currency.length === 4) {
          // Handle fiat currencies (ZUSD -> USD)
          standardCurrency = currency.substring(1);
        }
        
        // Create normalized balance entry
        normalized[standardCurrency] = {
          total: parseFloat(amount),
          available: parseFloat(amount), // Kraken doesn't provide available balance directly
          reserved: 0 // Kraken doesn't provide reserved balance directly
        };
      });
      
      return normalized;
    } catch (error) {
      this.logger.error('Error normalizing balances', {
        error: error.message,
        stack: error.stack
      });
      
      return balances;
    }
  }
  
  /**
   * Get account balances with Kraken-specific normalization
   * @returns {Promise<Object>} - Normalized account balances
   */
  async getBalances() {
    try {
      // Check if the client has a getBalances method
      if (typeof this.client.getBalances === 'function') {
        const balances = await super.getBalances();
        return this._normalizeBalances(balances);
      }
      
      // If the client doesn't have a getBalances method, check for Kraken-specific methods
      this.logger.debug('Client does not have getBalances method, checking for Kraken methods');
      
      // For Kraken, we can use the getAccountBalance method
      if (typeof this.client.getAccountBalance === 'function') {
        this.logger.debug('Using KrakenRESTClient.getAccountBalance()');
        const response = await this.client.getAccountBalance();
        
        // Kraken returns balance data in the result property
        const balances = response.result || {};
        return this._normalizeBalances(balances);
      }
      
      // If in non-production environment, warn and use mock data
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn('No balance methods available and not in production, using mock data');
        
        // Create mock balances for testing
        const mockBalances = {
          'BTC': '1.0',
          'USD': '50000.0',
          'ETH': '10.0'
        };
        
        return this._normalizeBalances(mockBalances);
      }
      
      // In production, throw an error
      throw new Error('No balance methods available in KrakenRESTClient');
    } catch (error) {
      this.logger.error('Error getting balances', {
        error: error.message,
        stack: error.stack
      });
      
      // In production, rethrow the error
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      
      // In non-production environments, return mock data with a warning
      this.logger.warn('Not in production - returning mock balances due to error');
      return {
        'BTC': { total: 1.0, available: 1.0, reserved: 0 },
        'USD': { total: 50000.0, available: 50000.0, reserved: 0 },
        'ETH': { total: 10.0, available: 10.0, reserved: 0 }
      };
    }
  }
  
  /**
   * Get positions for the account
   * @returns {Promise<Array>} - Account positions
   */
  async getPositions() {
    try {
      this.logger.debug('Getting positions');
      
      // Check if the client has a getPositions method
      if (typeof this.client.getPositions === 'function') {
        // Call the exchange client to get positions
        return await this.client.getPositions();
      }
      
      // If the client doesn't have a getPositions method, we need to derive positions from other data
      this.logger.debug('Client does not have getPositions method, deriving positions from other data');
      
      // For Kraken spot trading, positions are represented by balances
      // For futures/margin trading, additional implementation would be needed
      
      // Get balances from our enhanced getBalances method (which uses getAccountBalance)
      const balances = await this.getBalances();
      if (!balances) {
        this.logger.warn('No balances available to derive positions');
        return [];
      }
      
      // Get the base and quote currencies from the symbol
      const [baseCurrency, quoteCurrency] = this.symbol.split('/');
      
      // Create a position object based on the base currency balance
      const positions = [];
      
      if (balances[baseCurrency]) {
        const baseBalance = balances[baseCurrency].total || 0;
        
        if (baseBalance > 0) {
          // Get current market price
          try {
            const ticker = await this.getTicker();
            const currentPrice = ticker?.last || ticker?.bid || 0;
            
            if (currentPrice) {
              positions.push({
                symbol: this.symbol,
                size: baseBalance,
                side: 'long',  // In spot trading, a positive balance is a long position
                entryPrice: 0, // We don't know the entry price from balance data
                markPrice: currentPrice,
                positionValue: baseBalance * currentPrice,
                unrealizedPnl: 0, // We can't calculate PnL without entry price
                liquidationPrice: 0 // Not applicable for spot trading
              });
            } else {
              this.logger.warn('Could not determine current price for position calculation');
            }
          } catch (tickerError) {
            this.logger.error('Error getting ticker for position calculation', {
              error: tickerError.message,
              stack: tickerError.stack
            });
            
            // Add position without price-dependent data
            positions.push({
              symbol: this.symbol,
              size: baseBalance,
              side: 'long',
              entryPrice: 0,
              markPrice: 0,
              positionValue: 0,
              unrealizedPnl: 0,
              liquidationPrice: 0
            });
          }
        }
      }
      
      // If we have quote currency balances, they represent cash positions
      if (balances[quoteCurrency]) {
        const quoteBalance = balances[quoteCurrency].total || 0;
        if (quoteBalance > 0) {
          positions.push({
            symbol: quoteCurrency,
            size: quoteBalance,
            side: 'cash',  // Cash balance
            entryPrice: 1,
            markPrice: 1,
            positionValue: quoteBalance,
            unrealizedPnl: 0,
            liquidationPrice: 0
          });
        }
      }
      
      return positions;
    } catch (error) {
      this.logger.error('Error getting positions', {
        error: error.message,
        stack: error.stack
      });
      
      // In production, we should throw to ensure issues are apparent
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      
      // In non-production environments, return empty array with warning
      this.logger.warn('Not in production - returning empty positions array due to error');
      return [];
    }
  }
}

export default KrakenExchangeAdapter;
