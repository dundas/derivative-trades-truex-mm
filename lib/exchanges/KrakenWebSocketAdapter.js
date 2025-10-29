/**
 * Kraken WebSocket Adapter
 * 
 * This module provides a standardized interface to the Kraken WebSocket API.
 * It handles the conversion of Kraken-specific data formats to the common
 * format used by our trading system.
 */

import { ExchangeWebSocketAdapter } from './ExchangeWebSocketAdapter.js';
import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Kraken WebSocket Adapter
 * 
 * @extends ExchangeWebSocketAdapter
 */
export class KrakenWebSocketAdapter extends ExchangeWebSocketAdapter {
  /**
   * Create a new KrakenWebSocketAdapter
   * 
   * @param {Object} config - Configuration options
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.symbol] - Trading symbol 
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Function} [config.onOrderBookUpdate] - Callback for order book updates
   * @param {Function} [config.onTickerUpdate] - Callback for ticker updates
   * @param {Function} [config.onTradeUpdate] - Callback for trade updates
   * @param {Object} [additionalConfig] - Additional Kraken-specific config
   */
  constructor(config = {}, additionalConfig = {}) {
    // Call parent constructor with 'kraken' as the exchange type
    super('kraken', config, additionalConfig);
    
    // Map for converting Kraken symbols to standard symbols
    this.symbolMap = {
      'XBT/USD': 'BTC/USD',
      'ETH/USD': 'ETH/USD'
    };
    
    // Map for converting standard symbols to Kraken symbols
    this.reverseSymbolMap = {
      'BTC/USD': 'XBT/USD',
      'ETH/USD': 'ETH/USD'
    };
    
    this.forceTestMode = additionalConfig.forceTestMode || config.useTestMode || false;
  }
  
  /**
   * Create a Kraken WebSocket client
   * 
   * @private
   * @returns {Promise<Object>} KrakenWebSocketClient instance
   */
  async _createKrakenClient() {
    if (this.forceTestMode) {
      this.logger.logMarket('WARN', 'Using mock Kraken WebSocket client for testing');
      return this._createMockClient();
    }
    
    try {
      // Import the KrakenWebSocketClient dynamically
      const { KrakenWebSocketClient } = await import('../kraken/KrakenWebSocketClient.js');
      
      // Configure Kraken-specific options
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
      
      // Create and return the Kraken client
      return new KrakenWebSocketClient(krakenOptions);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to create Kraken client: ${error.message}`, { error });
      
      // For testing purposes, create a mock client if the real one fails to load
      return this._createMockClient();
    }
  }
  
  /**
   * Create a mock client for testing purposes
   * 
   * @private
   * @returns {Object} Mock client
   */
  _createMockClient() {
    this.logger.logMarket('INFO', 'Creating mock Kraken WebSocket client for testing');
    
    const mockOrderBook = {
      asks: [['40000.1', '1.5'], ['40000.2', '2.3']],
      bids: [['39999.9', '3.2'], ['39999.8', '4.1']],
      ts: Date.now()
    };
    
    const orderBooks = new Map();
    orderBooks.set('BTC/USD', mockOrderBook);
    
    return {
      connect: async () => {
        this.logger.logMarket('INFO', 'Mock Kraken client connected');
        return true;
      },
      disconnect: async () => {
        this.logger.logMarket('INFO', 'Mock Kraken client disconnected');
        return true;
      },
      subscribe: async (channel, symbols, options) => {
        this.logger.logMarket('INFO', `Mock Kraken client subscribed to ${channel} for ${symbols.join(', ')}`);
        return true;
      },
      unsubscribe: async (symbols, channel) => {
        this.logger.logMarket('INFO', `Mock Kraken client unsubscribed from ${channel || 'all channels'} for ${symbols.join(', ')}`);
        return true;
      },
      getOrderBook: (symbol) => {
        // Return a mock order book or the one from the map
        return orderBooks.get(symbol) || mockOrderBook;
      },
      getAllOrderBooks: () => {
        return orderBooks;
      }
    };
  }
  
  /**
   * Subscribe to a channel for specified symbols with Kraken-specific adjustments
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to subscribe to in standard format (e.g., 'BTC/USD')
   * @param {Object} [options] - Additional options
   * @returns {Promise<void>}
   */
  async subscribe(channel, symbols, options = {}) {
    try {
      // Convert standard symbols to Kraken format
      const krakenSymbols = symbols.map(symbol => this._convertToKrakenSymbol(symbol));
      
      this.logger.logMarket('INFO', `Subscribing to ${channel} for ${symbols.join(', ')} on Kraken...`, {
        standardSymbols: symbols,
        krakenSymbols,
        channel
      });
      
      // Call client.subscribe with Kraken-specific symbols
      await this.client.subscribe(channel, krakenSymbols, options);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to subscribe to ${channel} on Kraken: ${error.message}`, {
        error,
        symbols
      });
      throw error;
    }
  }
  
  /**
   * Convert a standard symbol to Kraken format
   * 
   * @private
   * @param {string} standardSymbol - Symbol in standard format (e.g., 'BTC/USD')
   * @returns {string} Symbol in Kraken format (e.g., 'XBT/USD')
   */
  _convertToKrakenSymbol(standardSymbol) {
    return this.reverseSymbolMap[standardSymbol] || standardSymbol;
  }
  
  /**
   * Convert a Kraken symbol to standard format
   * 
   * @private
   * @param {string} krakenSymbol - Symbol in Kraken format (e.g., 'XBT/USD')
   * @returns {string} Symbol in standard format (e.g., 'BTC/USD')
   */
  _convertToStandardSymbol(krakenSymbol) {
    return this.symbolMap[krakenSymbol] || krakenSymbol;
  }
  
  /**
   * Standardize a Kraken order book to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol (in standard format)
   * @param {Object} data - Kraken-specific order book data
   * @returns {StandardOrderBook} Standardized order book
   */
  _standardizeKrakenOrderBook(symbol, data) {
    try {
      this.logger.logMarket('DEBUG', 'Standardizing Kraken order book', {
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined',
        hasAsks: data && (data.a || data.asks) ? true : false,
        hasBids: data && (data.b || data.bids) ? true : false
      });
      
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
      
      // Log order book structure for debugging
      const askFormat = hasAsks ? 
        (data.asks ? 'asks' : (data.a ? 'a' : (data.as ? 'as' : 'none'))) : 'none';
      const bidFormat = hasBids ? 
        (data.bids ? 'bids' : (data.b ? 'b' : (data.bs ? 'bs' : 'none'))) : 'none';
      
      this.logger.logMarket('DEBUG', 'Kraken order book format detection', {
        askFormat,
        bidFormat,
        timestamp: standardOrderBook.timestamp
      });
      
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
      
      // Log standardized order book summary for verification
      if (standardOrderBook.asks.length > 0 || standardOrderBook.bids.length > 0) {
        const topAsk = standardOrderBook.asks.length > 0 ? standardOrderBook.asks[0][0] : 'none';
        const topBid = standardOrderBook.bids.length > 0 ? standardOrderBook.bids[0][0] : 'none';
        
        this.logger.logMarket('DEBUG', 'Standardized Kraken order book', {
          symbol,
          askCount: standardOrderBook.asks.length,
          bidCount: standardOrderBook.bids.length,
          topAsk,
          topBid,
          spread: topAsk !== 'none' && topBid !== 'none' ? 
            parseFloat(topAsk) - parseFloat(topBid) : 'unknown'
        });
      }
      
      return standardOrderBook;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken order book: ${error.message}`, { 
        error, 
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined'
      });
      
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
   * @param {string} symbol - Symbol (in standard format)
   * @param {Object} data - Kraken-specific ticker data
   * @returns {StandardTicker} Standardized ticker
   */
  _standardizeKrakenTicker(symbol, data) {
    try {
      // Log raw data for debugging
      this.logger.logMarket('DEBUG', 'Standardizing Kraken ticker', {
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined'
      });
      
      // Kraken ticker format uses 'a' for ask and 'b' for bid
      // Example: { a: ['1000.0', 1, 1], b: ['999.0', 1, 1], c: ['999.5', '0.01'], ... }
      const standardTicker = {
        ask: Array.isArray(data.a) ? data.a[0] : null,
        bid: Array.isArray(data.b) ? data.b[0] : null,
        last: Array.isArray(data.c) ? data.c[0] : null,
        volume: Array.isArray(data.v) ? data.v[1] : null, // 24h volume
        timestamp: data.timestamp || data.ts || Date.now()
      };
      
      // Log standardized ticker for verification
      this.logger.logMarket('DEBUG', 'Standardized Kraken ticker', {
        symbol,
        ask: standardTicker.ask,
        bid: standardTicker.bid,
        last: standardTicker.last,
        spread: standardTicker.ask && standardTicker.bid ? 
          parseFloat(standardTicker.ask) - parseFloat(standardTicker.bid) : 'unknown'
      });
      
      return standardTicker;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken ticker: ${error.message}`, { 
        error, 
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined'
      });
      
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
   * @param {string} symbol - Symbol (in standard format)
   * @param {Array} trades - Kraken-specific trades data
   * @returns {Array<StandardTrade>} Standardized trades
   */
  _standardizeKrakenTrades(symbol, trades) {
    try {
      if (!Array.isArray(trades)) {
        this.logger.logMarket('WARN', 'Invalid Kraken trades data (not an array)', {
          symbol,
          trades
        });
        return [];
      }
      
      // Log raw data for debugging
      this.logger.logMarket('DEBUG', 'Standardizing Kraken trades', {
        symbol,
        tradeCount: trades.length
      });
      
      // Kraken trade format: [price, volume, timestamp, side, orderType, miscellaneous]
      const standardTrades = trades.map(trade => ({
        price: trade[0],
        size: trade[1],
        side: trade[3] || 'unknown',
        timestamp: trade[2] || Date.now()
      }));
      
      // Log standardized trades summary for verification
      this.logger.logMarket('DEBUG', 'Standardized Kraken trades', {
        symbol,
        tradeCount: standardTrades.length,
        buyCount: standardTrades.filter(t => t.side === 'buy').length,
        sellCount: standardTrades.filter(t => t.side === 'sell').length
      });
      
      return standardTrades;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Kraken trades: ${error.message}`, { 
        error, 
        symbol,
        tradeCount: Array.isArray(trades) ? trades.length : 'invalid'
      });
      return [];
    }
  }
}

export default KrakenWebSocketAdapter;
