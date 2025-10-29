/**
 * Coinbase WebSocket Adapter
 * 
 * This module provides a standardized interface to the Coinbase WebSocket API.
 * It handles the conversion of Coinbase-specific data formats to the common
 * format used by our trading system.
 */

import { ExchangeWebSocketAdapter } from './ExchangeWebSocketAdapter.js';
import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Coinbase WebSocket Adapter
 * 
 * @extends ExchangeWebSocketAdapter
 */
export class CoinbaseWebSocketAdapter extends ExchangeWebSocketAdapter {
  /**
   * Create a new CoinbaseWebSocketAdapter
   * 
   * @param {Object} config - Configuration options
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.symbol] - Trading symbol 
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Function} [config.onOrderBookUpdate] - Callback for order book updates
   * @param {Function} [config.onTickerUpdate] - Callback for ticker updates
   * @param {Function} [config.onTradeUpdate] - Callback for trade updates
   * @param {Object} [additionalConfig] - Additional Coinbase-specific config
   */
  constructor(config = {}, additionalConfig = {}) {
    // Call parent constructor with 'coinbase' as the exchange type
    super('coinbase', config, additionalConfig);
    
    // Map for converting standard symbols to Coinbase symbols
    this.symbolMap = {
      'BTC/USD': 'BTC-USD',
      'ETH/USD': 'ETH-USD'
    };
    
    // Map for converting Coinbase symbols to standard symbols
    this.reverseSymbolMap = {
      'BTC-USD': 'BTC/USD',
      'ETH-USD': 'ETH/USD'
    };
    
    this.forceTestMode = additionalConfig.forceTestMode || config.useTestMode || false;
  }
  
  /**
   * Create a Coinbase WebSocket client
   * 
   * @private
   * @returns {Promise<Object>} CoinbaseWebSocketClient instance
   */
  async _createCoinbaseClient() {
    if (this.forceTestMode) {
      this.logger.logMarket('WARN', 'Using mock Coinbase WebSocket client for testing');
      return this._createMockClient();
    }
    
    try {
      // Import the CoinbaseWebSocketClient dynamically
      const { CoinbaseWebSocketClient } = await import('../coinbase/CoinbaseWebSocketClient.js');
      
      // Configure Coinbase-specific options
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
      
      // Create and return the Coinbase client
      return new CoinbaseWebSocketClient(coinbaseOptions);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to create Coinbase client: ${error.message}`, { error });
      
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
    this.logger.logMarket('INFO', 'Creating mock Coinbase WebSocket client for testing');
    
    const mockOrderBook = {
      asks: [['41000.1', '0.5'], ['41000.2', '1.3']],
      bids: [['40999.9', '2.2'], ['40999.8', '3.1']],
      sequence: Date.now(),
      time: new Date().toISOString()
    };
    
    const orderBooks = new Map();
    orderBooks.set('BTC/USD', mockOrderBook);
    
    return {
      connect: async () => {
        this.logger.logMarket('INFO', 'Mock Coinbase client connected');
        return true;
      },
      disconnect: async () => {
        this.logger.logMarket('INFO', 'Mock Coinbase client disconnected');
        return true;
      },
      subscribe: async (channel, symbols, options) => {
        this.logger.logMarket('INFO', `Mock Coinbase client subscribed to ${channel} for ${symbols.join(', ')}`);
        return true;
      },
      unsubscribe: async (symbols, channel) => {
        this.logger.logMarket('INFO', `Mock Coinbase client unsubscribed from ${channel || 'all channels'} for ${symbols.join(', ')}`);
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
   * Subscribe to a channel for specified symbols with Coinbase-specific adjustments
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to subscribe to in standard format (e.g., 'BTC/USD')
   * @param {Object} [options] - Additional options
   * @returns {Promise<void>}
   */
  async subscribe(channel, symbols, options = {}) {
    try {
      // Convert standard symbols to Coinbase format
      const coinbaseSymbols = symbols.map(symbol => this._convertToCoinbaseSymbol(symbol));
      
      this.logger.logMarket('INFO', `Subscribing to ${channel} for ${symbols.join(', ')} on Coinbase...`, {
        standardSymbols: symbols,
        coinbaseSymbols,
        channel
      });
      
      // Map our standard channel names to Coinbase channel names
      const channelMap = {
        'book': 'level2',
        'ticker': 'ticker',
        'trade': 'matches'
      };
      
      const coinbaseChannel = channelMap[channel] || channel;
      
      // Call client.subscribe with Coinbase-specific parameters
      await this.client.subscribe(coinbaseChannel, coinbaseSymbols, options);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to subscribe to ${channel} on Coinbase: ${error.message}`, {
        error,
        symbols
      });
      throw error;
    }
  }
  
  /**
   * Unsubscribe from a channel for specified symbols with Coinbase-specific adjustments
   * 
   * @param {string} channel - Channel name ('book', 'ticker', 'trade')
   * @param {Array<string>} symbols - Symbols to unsubscribe from in standard format (e.g., 'BTC/USD')
   * @returns {Promise<void>}
   */
  async unsubscribe(channel, symbols) {
    try {
      // Convert standard symbols to Coinbase format
      const coinbaseSymbols = symbols.map(symbol => this._convertToCoinbaseSymbol(symbol));
      
      this.logger.logMarket('INFO', `Unsubscribing from ${channel} for ${symbols.join(', ')} on Coinbase...`, {
        standardSymbols: symbols,
        coinbaseSymbols,
        channel
      });
      
      // Map our standard channel names to Coinbase channel names
      const channelMap = {
        'book': 'level2',
        'ticker': 'ticker',
        'trade': 'matches'
      };
      
      const coinbaseChannel = channelMap[channel] || channel;
      
      // Call client.unsubscribe with Coinbase-specific parameters
      await this.client.unsubscribe(coinbaseSymbols, coinbaseChannel);
    } catch (error) {
      this.logger.logMarket('ERROR', `Failed to unsubscribe from ${channel} on Coinbase: ${error.message}`, {
        error,
        symbols
      });
      throw error;
    }
  }
  
  /**
   * Convert a standard symbol to Coinbase format
   * 
   * @private
   * @param {string} standardSymbol - Symbol in standard format (e.g., 'BTC/USD')
   * @returns {string} Symbol in Coinbase format (e.g., 'BTC-USD')
   */
  _convertToCoinbaseSymbol(standardSymbol) {
    return this.symbolMap[standardSymbol] || standardSymbol.replace('/', '-');
  }
  
  /**
   * Convert a Coinbase symbol to standard format
   * 
   * @private
   * @param {string} coinbaseSymbol - Symbol in Coinbase format (e.g., 'BTC-USD')
   * @returns {string} Symbol in standard format (e.g., 'BTC/USD')
   */
  _convertToStandardSymbol(coinbaseSymbol) {
    return this.reverseSymbolMap[coinbaseSymbol] || coinbaseSymbol.replace('-', '/');
  }
  
  /**
   * Standardize a Coinbase order book to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol (in standard format)
   * @param {Object} data - Coinbase-specific order book data
   * @returns {Object} Standardized order book
   */
  _standardizeCoinbaseOrderBook(symbol, data) {
    try {
      this.logger.logMarket('DEBUG', 'Standardizing Coinbase order book', {
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined',
        hasAsks: data && data.asks ? true : false,
        hasBids: data && data.bids ? true : false
      });
      
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
      
      // Log standardized order book summary for verification
      if (standardOrderBook.asks.length > 0 || standardOrderBook.bids.length > 0) {
        const topAsk = standardOrderBook.asks.length > 0 ? standardOrderBook.asks[0][0] : 'none';
        const topBid = standardOrderBook.bids.length > 0 ? standardOrderBook.bids[0][0] : 'none';
        
        this.logger.logMarket('DEBUG', 'Standardized Coinbase order book', {
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
      this.logger.logMarket('ERROR', `Error standardizing Coinbase order book: ${error.message}`, { 
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
   * Standardize a Coinbase ticker to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol (in standard format)
   * @param {Object} data - Coinbase-specific ticker data
   * @returns {Object} Standardized ticker
   */
  _standardizeCoinbaseTicker(symbol, data) {
    try {
      // Log raw data for debugging
      this.logger.logMarket('DEBUG', 'Standardizing Coinbase ticker', {
        symbol,
        dataKeys: data ? Object.keys(data).join(',') : 'undefined'
      });
      
      // Coinbase ticker format uses different field names
      const standardTicker = {
        ask: data.best_ask || data.ask || null,
        bid: data.best_bid || data.bid || null,
        last: data.price || data.last_price || null,
        volume: data.volume_24h || data.volume || null,
        timestamp: new Date(data.time || Date.now()).getTime()
      };
      
      // Log standardized ticker for verification
      this.logger.logMarket('DEBUG', 'Standardized Coinbase ticker', {
        symbol,
        ask: standardTicker.ask,
        bid: standardTicker.bid,
        last: standardTicker.last,
        spread: standardTicker.ask && standardTicker.bid ? 
          parseFloat(standardTicker.ask) - parseFloat(standardTicker.bid) : 'unknown'
      });
      
      return standardTicker;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Coinbase ticker: ${error.message}`, { 
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
   * Standardize Coinbase trades to our standard format
   * 
   * @private
   * @param {string} symbol - Symbol (in standard format)
   * @param {Array} trades - Coinbase-specific trades data
   * @returns {Array} Standardized trades
   */
  _standardizeCoinbaseTrades(symbol, trades) {
    try {
      if (!Array.isArray(trades)) {
        this.logger.logMarket('WARN', 'Invalid Coinbase trades data (not an array)', {
          symbol,
          trades
        });
        return [];
      }
      
      // Log raw data for debugging
      this.logger.logMarket('DEBUG', 'Standardizing Coinbase trades', {
        symbol,
        tradeCount: trades.length
      });
      
      // Coinbase trades are objects in an array
      const standardTrades = trades.map(trade => ({
        price: trade.price || null,
        size: trade.size || null,
        side: trade.side || 'unknown',
        timestamp: new Date(trade.time || Date.now()).getTime()
      }));
      
      // Log standardized trades summary for verification
      this.logger.logMarket('DEBUG', 'Standardized Coinbase trades', {
        symbol,
        tradeCount: standardTrades.length,
        buyCount: standardTrades.filter(t => t.side === 'buy').length,
        sellCount: standardTrades.filter(t => t.side === 'sell').length
      });
      
      return standardTrades;
    } catch (error) {
      this.logger.logMarket('ERROR', `Error standardizing Coinbase trades: ${error.message}`, { 
        error, 
        symbol,
        tradeCount: Array.isArray(trades) ? trades.length : 'invalid'
      });
      return [];
    }
  }
}

export default CoinbaseWebSocketAdapter;
