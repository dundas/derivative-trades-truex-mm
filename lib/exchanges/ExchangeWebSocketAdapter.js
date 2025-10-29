/**
 * Exchange WebSocket Adapter
 * 
 * This module provides a standardized interface for connecting to different
 * exchange WebSocket APIs. It handles the conversion of exchange-specific
 * data formats to a common format used by our trading system.
 */

import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Standard order book format used throughout the trading system
 * 
 * @typedef {Object} StandardOrderBook
 * @property {Array<Array<string|number>>} asks - Array of [price, size] pairs for asks
 * @property {Array<Array<string|number>>} bids - Array of [price, size] pairs for bids
 * @property {number} timestamp - Timestamp of the order book (milliseconds since epoch)
 * @property {number|string} sequenceNumber - Sequence number for ordering updates
 */

/**
 * Standard ticker format used throughout the trading system
 * 
 * @typedef {Object} StandardTicker
 * @property {number|string} ask - Best ask price
 * @property {number|string} bid - Best bid price
 * @property {number|string} last - Last trade price
 * @property {number|string} volume - 24h volume
 * @property {number} timestamp - Timestamp of the ticker (milliseconds since epoch)
 */

/**
 * Standard trade format used throughout the trading system
 * 
 * @typedef {Object} StandardTrade
 * @property {number|string} price - Trade price
 * @property {number|string} size - Trade size
 * @property {string} side - Trade side ('buy' or 'sell')
 * @property {number} timestamp - Timestamp of the trade (milliseconds since epoch)
 */

/**
 * ExchangeWebSocketAdapter provides a standardized interface to different exchange WebSocket APIs
 */
export class ExchangeWebSocketAdapter {
  /**
   * Create a new ExchangeWebSocketAdapter
   * 
   * @param {string} exchangeType - Type of exchange ('kraken', 'coinbase', etc.)
   * @param {Object} config - Configuration options
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.symbol] - Trading symbol 
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Function} [config.onOrderBookUpdate] - Callback for order book updates
   * @param {Function} [config.onTickerUpdate] - Callback for ticker updates
   * @param {Function} [config.onTradeUpdate] - Callback for trade updates
   * @param {Object} [additionalConfig] - Additional exchange-specific config
   */
  constructor(exchangeType, config = {}, additionalConfig = {}) {
    this.exchangeType = exchangeType.toLowerCase();
    this.config = config;
    this.additionalConfig = additionalConfig;
    this.client = null;
    
    // Set up logger
    if (config.logger && typeof config.logger.logMarket === 'function') {
      this.logger = config.logger;
    } else {
      this.logger = new TradingLogger({
        component: `${this.exchangeType}-adapter`,
        symbol: config.symbol || 'unknown',
        sessionId: config.sessionId || 'unknown'
      });
    }
    
    // Store callback handlers
    this.handlers = {
      onOrderBookUpdate: config.onOrderBookUpdate,
      onTickerUpdate: config.onTickerUpdate,
      onTradeUpdate: config.onTradeUpdate,
      onError: config.onError
    };
  }
  
  /**
   * Initialize the client connection
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.client) {
      return; // Client already initialized
    }

    try {
      this.logger.logMarket('INFO', `Initializing ${this.exchangeType} client...`);
      this.client = await this._createClientForExchange();
      this.logger.logMarket('INFO', `${this.exchangeType} client initialized successfully`);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to initialize ${this.exchangeType} client: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Create the appropriate client for the specified exchange
   * 
   * @private
   * @returns {Promise<Object>} Exchange-specific client instance
   */
  async _createClientForExchange() {
    switch (this.exchangeType) {
      case 'kraken':
        return this._createKrakenClient();
      case 'coinbase':
        return this._createCoinbaseClient();
      default:
        throw new Error(`Unsupported exchange type: ${this.exchangeType}`);
    }
  }
  
  /**
   * Create a Kraken WebSocket client
   * 
   * @private
   * @returns {Promise<Object>} KrakenWebSocketClient instance
   */
  async _createKrakenClient() {
    try {
      const { KrakenWebSocketClient } = await import('../kraken/KrakenWebSocketClient.js');
      
      // Set up Kraken-specific options
      const krakenOptions = {
        ...this.additionalConfig,
        logger: (level, message, data) => {
          this.logger.logMarket(level.toUpperCase(), message, data);
        },
        onOrderBookUpdate: (symbol, data) => {
          if (this.handlers.onOrderBookUpdate) {
            // Standardize the order book format before passing to handler
            const standardOrderBook = this._standardizeKrakenOrderBook(symbol, data);
            this.handlers.onOrderBookUpdate(symbol, standardOrderBook);
          }
        },
        onTickerUpdate: (symbol, data) => {
          if (this.handlers.onTickerUpdate) {
            const standardTicker = this._standardizeKrakenTicker(symbol, data);
            this.handlers.onTickerUpdate(symbol, standardTicker);
          }
        },
        onTradeUpdate: (symbol, data) => {
          if (this.handlers.onTradeUpdate) {
            const standardTrades = this._standardizeKrakenTrades(symbol, data);
            this.handlers.onTradeUpdate(symbol, standardTrades);
          }
        },
        onError: (error) => {
          if (this.handlers.onError) {
            this.handlers.onError(error);
          }
        }
      };
      
      return new KrakenWebSocketClient(krakenOptions);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to create Kraken client: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Create a Coinbase WebSocket client
   * 
   * @private
   * @returns {Promise<Object>} CoinbaseWebSocketClient instance
   */
  async _createCoinbaseClient() {
    try {
      const { CoinbaseWebSocketClient } = await import('../coinbase/CoinbaseWebSocketClient.js');
      
      // Set up Coinbase-specific options
      const coinbaseOptions = {
        ...this.additionalConfig,
        logger: (level, message, data) => {
          this.logger.logMarket(level.toUpperCase(), message, data);
        },
        onOrderBookUpdate: (symbol, data) => {
          if (this.handlers.onOrderBookUpdate) {
            // Standardize the order book format before passing to handler
            const standardOrderBook = this._standardizeCoinbaseOrderBook(symbol, data);
            this.handlers.onOrderBookUpdate(symbol, standardOrderBook);
          }
        },
        onTickerUpdate: (symbol, data) => {
          if (this.handlers.onTickerUpdate) {
            const standardTicker = this._standardizeCoinbaseTicker(symbol, data);
            this.handlers.onTickerUpdate(symbol, standardTicker);
          }
        },
        onTradeUpdate: (symbol, data) => {
          if (this.handlers.onTradeUpdate) {
            const standardTrades = this._standardizeCoinbaseTrades(symbol, data);
            this.handlers.onTradeUpdate(symbol, standardTrades);
          }
        },
        onError: (error) => {
          if (this.handlers.onError) {
            this.handlers.onError(error);
          }
        }
      };
      
      return new CoinbaseWebSocketClient(coinbaseOptions);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to create Coinbase client: ${error.message}`, { error });
      throw new Error(`Coinbase WebSocket client not yet implemented: ${error.message}`);
    }
  }
  
  /**
   * Connect to the exchange WebSocket API
   * 
   * @returns {Promise<boolean>} True if connection was successful
   */
  async connect() {
    try {
      // Make sure client is initialized
      if (!this.client) {
        await this.initialize();
      }
      
      this.logger.logMarket('INFO', `Connecting to ${this.exchangeType} WebSocket API...`);
      await this.client.connect();
      this.logger.logMarket('INFO', `Connected to ${this.exchangeType} WebSocket API`);
      return true;
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to connect to ${this.exchangeType} WebSocket API: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Disconnect from the exchange WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.client) {
      this.logger.logMarket('WARN', `Not connected to ${this.exchangeType} WebSocket API`);
      return;
    }
    
    try {
      this.logger.logMarket('INFO', `Disconnecting from ${this.exchangeType} WebSocket API...`);
      await this.client.disconnect();
      this.logger.logMarket('INFO', `Disconnected from ${this.exchangeType} WebSocket API`);
      this.client = null;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error disconnecting from ${this.exchangeType} WebSocket API: ${error.message}`, { error });
    }
  }
  
  /**
   * Subscribe to a channel for specified symbols
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to subscribe to
   * @param {Object} [options] - Additional options
   * @returns {Promise<void>}
   */
  async subscribe(channel, symbols, options = {}) {
    try {
      // Make sure client is initialized
      if (!this.client) {
        await this.initialize();
      }
      
      this.logger.logMarket('INFO', `Subscribing to ${channel} for ${symbols.join(', ')} on ${this.exchangeType}...`);
      await this.client.subscribe(channel, symbols, options);
      this.logger.logMarket('INFO', `Subscribed to ${channel} for ${symbols.join(', ')} on ${this.exchangeType}`);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to subscribe to ${channel} on ${this.exchangeType}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Unsubscribe from a channel for specified symbols
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to unsubscribe from
   * @returns {Promise<void>}
   */
  async unsubscribe(channel, symbols) {
    if (!this.client) {
      this.logger.logMarket('WARN', `Not connected to ${this.exchangeType} WebSocket API`);
      return;
    }
    
    try {
      this.logger.logMarket('INFO', `Unsubscribing from ${channel} for ${symbols.join(', ')} on ${this.exchangeType}...`);
      await this.client.unsubscribe(symbols, channel);
      this.logger.logMarket('INFO', `Unsubscribed from ${channel} for ${symbols.join(', ')} on ${this.exchangeType}`);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to unsubscribe from ${channel} on ${this.exchangeType}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Get the current order book for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {StandardOrderBook|null} Standardized order book or null if not available
   */
  getOrderBook(symbol) {
    try {
      if (!this.client) {
        this.logger.logMarket('WARN', `Client not initialized for ${this.exchangeType}`);
        return null;
      }
      
      const exchangeOrderBook = this.client.getOrderBook(symbol);
      if (!exchangeOrderBook) return null;
      
      // Standardize the order book format
      return this._standardizeOrderBook(symbol, exchangeOrderBook);
    } catch (error) {
      this.logger.logMarket('ERROR', `Error getting order book for ${symbol}: ${error.message}`, { error });
      return null;
    }
  }
  
  /**
   * Standardize an order book from any exchange format to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Object} data - Exchange-specific order book data
   * @returns {StandardOrderBook} Standardized order book
   */
  _standardizeOrderBook(symbol, data) {
    switch (this.exchangeType) {
      case 'kraken':
        return this._standardizeKrakenOrderBook(symbol, data);
      case 'coinbase':
        return this._standardizeCoinbaseOrderBook(symbol, data);
      default:
        this.logger.logMarket('WARN', `No standardizer for ${this.exchangeType} order books`);
        return data;
    }
  }
  
  /**
   * Standardize a Kraken order book to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Object} data - Kraken-specific order book data
   * @returns {StandardOrderBook} Standardized order book
   */
  _standardizeKrakenOrderBook(symbol, data) {
    try {
      // Handle Kraken's format which uses 'a' and 'b' for asks and bids
      const hasAsks = (data.a && Array.isArray(data.a) && data.a.length > 0) || 
                     (data.as && Array.isArray(data.as) && data.as.length > 0) ||
                     (data.asks && Array.isArray(data.asks) && data.asks.length > 0);
      
      const hasBids = (data.b && Array.isArray(data.b) && data.b.length > 0) || 
                     (data.bs && Array.isArray(data.bs) && data.bs.length > 0) ||
                     (data.bids && Array.isArray(data.bids) && data.bids.length > 0);
      
      // Initialize with empty arrays
      let standardOrderBook = {
        asks: [],
        bids: [],
        timestamp: data.timestamp || Date.now(),
        sequenceNumber: data.sequenceNumber || data.ts || Date.now()
      };
      
      // Process asks (handle various possible formats)
      if (hasAsks) {
        if (data.asks && Array.isArray(data.asks)) {
          standardOrderBook.asks = data.asks.map(ask => [ask[0], ask[1]]);
        } else if (data.a && Array.isArray(data.a)) {
          standardOrderBook.asks = data.a.map(ask => [ask[0], ask[1]]);
        } else if (data.as && Array.isArray(data.as)) {
          standardOrderBook.asks = data.as.map(ask => [ask[0], ask[1]]);
        }
      }
      
      // Process bids (handle various possible formats)
      if (hasBids) {
        if (data.bids && Array.isArray(data.bids)) {
          standardOrderBook.bids = data.bids.map(bid => [bid[0], bid[1]]);
        } else if (data.b && Array.isArray(data.b)) {
          standardOrderBook.bids = data.b.map(bid => [bid[0], bid[1]]);
        } else if (data.bs && Array.isArray(data.bs)) {
          standardOrderBook.bids = data.bs.map(bid => [bid[0], bid[1]]);
        }
      }
      
      return standardOrderBook;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken order book: ${error.message}`, { error, data });
      
      // Return a minimal valid order book to prevent errors downstream
      return {
        asks: [],
        bids: [],
        timestamp: Date.now(),
        sequenceNumber: Date.now()
      };
    }
  }
  
  /**
   * Standardize a Coinbase order book to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Object} data - Coinbase-specific order book data
   * @returns {StandardOrderBook} Standardized order book
   */
  _standardizeCoinbaseOrderBook(symbol, data) {
    try {
      // Initialize with empty arrays
      const standardOrderBook = {
        asks: [],
        bids: [],
        timestamp: data.timestamp || Date.now(),
        sequenceNumber: data.sequenceNumber || data.sequence || Date.now()
      };
      
      // Process asks if present
      if (data.asks && Array.isArray(data.asks) && data.asks.length > 0) {
        standardOrderBook.asks = data.asks.map(ask => [
          typeof ask[0] === 'string' ? ask[0] : ask[0].toString(),
          typeof ask[1] === 'string' ? ask[1] : ask[1].toString()
        ]);
      }
      
      // Process bids if present
      if (data.bids && Array.isArray(data.bids) && data.bids.length > 0) {
        standardOrderBook.bids = data.bids.map(bid => [
          typeof bid[0] === 'string' ? bid[0] : bid[0].toString(),
          typeof bid[1] === 'string' ? bid[1] : bid[1].toString()
        ]);
      }
      
      return standardOrderBook;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Coinbase order book: ${error.message}`, { error, data });
      
      // Return a minimal valid order book to prevent errors downstream
      return {
        asks: [],
        bids: [],
        timestamp: Date.now(),
        sequenceNumber: Date.now()
      };
    }
  }
  
  /**
   * Standardize a Kraken ticker to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Object} data - Kraken-specific ticker data
   * @returns {StandardTicker} Standardized ticker
   */
  _standardizeKrakenTicker(symbol, data) {
    try {
      // Kraken ticker format uses 'a' for ask and 'b' for bid
      // Example: { a: ['1000.0', 1, 1], b: ['999.0', 1, 1], c: ['999.5', '0.01'], ... }
      return {
        ask: Array.isArray(data.a) ? data.a[0] : null,
        bid: Array.isArray(data.b) ? data.b[0] : null,
        last: Array.isArray(data.c) ? data.c[0] : null,
        volume: Array.isArray(data.v) ? data.v[1] : null, // 24h volume
        timestamp: data.timestamp || data.ts || Date.now()
      };
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken ticker: ${error.message}`, { error, data });
      
      // Return a minimal valid ticker to prevent errors downstream
      return {
        ask: null,
        bid: null,
        last: null,
        volume: null,
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * Standardize Kraken trades to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Array} trades - Kraken-specific trades data
   * @returns {Array<StandardTrade>} Standardized trades
   */
  _standardizeKrakenTrades(symbol, trades) {
    try {
      if (!Array.isArray(trades)) return [];
      
      // Kraken trade format: [price, volume, timestamp, side, orderType, miscellaneous]
      return trades.map(trade => ({
        price: trade[0],
        size: trade[1],
        side: trade[3] || 'unknown',
        timestamp: trade[2] || Date.now()
      }));
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken trades: ${error.message}`, { error, trades });
      return [];
    }
  }
  
  /**
   * Standardize Coinbase trades to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Array} trades - Coinbase-specific trades data
   * @returns {Array<StandardTrade>} Standardized trades
   */
  _standardizeCoinbaseTrades(symbol, trades) {
    try {
      if (!Array.isArray(trades)) return [];
      
      // Coinbase trades are objects in an array
      return trades.map(trade => ({
        price: trade.price || null,
        size: trade.size || null,
        side: trade.side || 'unknown',
        timestamp: new Date(trade.time || Date.now()).getTime()
      }));
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Coinbase trades: ${error.message}`, { error, trades });
      return [];
    }
  }
  
  /**
   * Standardize a Coinbase ticker to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol
   * @param {Object} data - Coinbase-specific ticker data
   * @returns {StandardTicker} Standardized ticker
   */
  _standardizeCoinbaseTicker(symbol, data) {
    try {
      // Coinbase ticker format uses different field names
      return {
        ask: data.best_ask || data.ask || null,
        bid: data.best_bid || data.bid || null,
        last: data.price || data.last_price || null,
        volume: data.volume_24h || data.volume || null,
        timestamp: new Date(data.time || Date.now()).getTime()
      };
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Coinbase ticker: ${error.message}`, { error, data });
      
      // Return a minimal valid ticker to prevent errors downstream
      return {
        ask: null,
        bid: null,
        last: null,
        volume: null,
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * Set event handlers directly, overriding those provided in the constructor
   * 
   * @param {Object} handlers - Event handlers
   * @param {Function} [handlers.onOrderBookUpdate] - Called when order book updates
   * @param {Function} [handlers.onTickerUpdate] - Called when ticker updates
   * @param {Function} [handlers.onTradeUpdate] - Called when trades occur
   * @param {Function} [handlers.onError] - Called on errors
   */
  setEventHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }
}

export default ExchangeWebSocketAdapter;
