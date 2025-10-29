/**
 * KrakenClientAdapter
 * 
 * This module provides an adapter for the KrakenWebSocketClient class to make it compatible
 * with the existing OrderBookProcessor and other market data components.
 */

import { KrakenWebSocketClient } from './KrakenWebSocketClient.js';

/**
 * KrakenClientAdapter
 * 
 * Adapts the KrakenWebSocketClient class to work with the OrderBookProcessor and other
 * market data components.
 */
export class KrakenClientAdapter {
  /**
   * Create a new KrakenClientAdapter
   * 
   * @param {Object} options - Adapter options
   * @param {Function} options.logger - Logger function
   * @param {Function} options.onOrderBookUpdate - Callback for orderbook updates
   * @param {Function} options.onError - Callback for errors
   */
  constructor(options = {}) {
    this.options = options;
    this.isConnected = false;
    this.orderbooks = new Map();
    this.subscriptions = new Map();
    
    // Create KrakenWebSocketClient instance
    this.client = new KrakenWebSocketClient({
      logger: (level, message, data) => this.log(level, message, data),
      onOrderBookUpdate: (symbol, orderbook) => {
        // Store orderbook
        this.orderbooks.set(symbol, orderbook);
        
        // Notify listeners
        if (this.options.onOrderBookUpdate) {
          this.options.onOrderBookUpdate(symbol, this.formatOrderBook(orderbook));
        }
      },
      onError: (error) => {
        this.log('error', `WebSocket error: ${error.message}`, { error });
        
        // Notify listeners
        if (this.options.onError) {
          this.options.onError(error);
        }
      }
    });
    
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.unsubscribe = this.unsubscribe.bind(this);
    this.getOrderBook = this.getOrderBook.bind(this);
    this.getAllOrderBooks = this.getAllOrderBooks.bind(this);
    this.log = this.log.bind(this);
    this.formatOrderBook = this.formatOrderBook.bind(this);
    this.convertSymbol = this.convertSymbol.bind(this);
    this.convertSymbolBack = this.convertSymbolBack.bind(this);
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
    }
  }
  
  /**
   * Connect to Kraken WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      this.log('info', 'Connecting to Kraken WebSocket API...');
      
      // Connect to Kraken WebSocket API using our KrakenWebSocketClient
      await this.client.connect();
      this.isConnected = true;
      this.log('info', 'Connected to Kraken WebSocket API');
    } catch (error) {
      this.log('error', 'Failed to connect to Kraken WebSocket API', { error });
      
      // Notify listeners
      if (this.options.onError) {
        this.options.onError(error);
      }
      
      throw error;
    }
  }
  
  /**
   * Disconnect from Kraken WebSocket API
   */
  async disconnect() {
    if (!this.isConnected) {
      this.log('warn', 'Not connected to Kraken WebSocket API');
      return;
    }
    
    this.log('info', 'Disconnecting from Kraken WebSocket API...');
    
    try {
      await this.client.disconnect();
      this.isConnected = false;
      this.log('info', 'Disconnected from Kraken WebSocket API');
    } catch (error) {
      this.log('error', 'Failed to disconnect from Kraken WebSocket API', { error });
      
      // Notify listeners
      if (this.options.onError) {
        this.options.onError(error);
      }
    }
  }
  
  /**
   * Subscribe to orderbook updates
   * 
   * @param {Array<string>} symbols - Symbols to subscribe to
   * @param {number} depth - Orderbook depth
   * @returns {Promise<void>}
   */
  async subscribe(symbols, depth = 10) {
    if (!this.isConnected) {
      throw new Error('Not connected to Kraken WebSocket API');
    }
    
    try {
      // Use the KrakenWebSocketClient to subscribe to orderbook updates
      await this.client.subscribe(symbols, depth);
      
      // Store subscriptions
      for (const symbol of symbols) {
        this.subscriptions.set(symbol, depth);
      }
      
      this.log('info', `Subscribed to ${symbols.length} symbols`);
    } catch (error) {
      this.log('error', `Subscription error: ${error.message}`, { error });
      
      // Notify listeners
      if (this.options.onError) {
        this.options.onError(error);
      }
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
      this.log('warn', 'Not connected to Kraken WebSocket API');
      return;
    }
    
    try {
      // Use the KrakenWebSocketClient to unsubscribe from orderbook updates
      await this.client.unsubscribe(symbols);
      
      // Remove subscriptions and orderbooks
      for (const symbol of symbols) {
        this.subscriptions.delete(symbol);
        this.orderbooks.delete(symbol);
      }
      
      this.log('info', `Unsubscribed from ${symbols.length} symbols`);
    } catch (error) {
      this.log('error', `Unsubscribe error: ${error.message}`, { error });
      
      // Notify listeners
      if (this.options.onError) {
        this.options.onError(error);
      }
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
    return this.orderbooks;
  }
  
  /**
   * Format orderbook data from Kraken format to our format
   * 
   * @param {Object} data - Orderbook data in Kraken format
   * @returns {Object} - Orderbook data in our format
   */
  formatOrderBook(data) {
    // Extract bids and asks
    const bids = data.bids || [];
    const asks = data.asks || [];
    
    // Convert to our format
    return {
      bids: bids.map(level => [level.price.toString(), level.volume.toString()]),
      asks: asks.map(level => [level.price.toString(), level.volume.toString()])
    };
  }
  
  /**
   * Convert symbol to Kraken format
   * 
   * @param {string} symbol - Symbol in standard format (e.g., 'BTC/USD')
   * @returns {string} - Symbol in Kraken format (e.g., 'XBT/USD')
   */
  convertSymbol(symbol) {
    // Define symbol mapping for Kraken WebSocket API
    const KRAKEN_SYMBOL_MAP = {
      'BTC/USD': 'XBT/USD',  // XBT is Kraken's code for Bitcoin
      'ETH/USD': 'ETH/USD'
    };
    
    // Return mapped symbol or original if no mapping exists
    return KRAKEN_SYMBOL_MAP[symbol] || symbol;
  }
  
  /**
   * Convert symbol from Kraken format back to standard format
   * 
   * @param {string} symbol - Symbol in Kraken format (e.g., 'XBT/USD')
   * @returns {string} - Symbol in standard format (e.g., 'BTC/USD')
   */
  convertSymbolBack(symbol) {
    // Define reverse symbol mapping for Kraken WebSocket API
    const REVERSE_SYMBOL_MAP = {
      'XBT/USD': 'BTC/USD',
      'ETH/USD': 'ETH/USD'
    };
    
    // Return mapped symbol or original if no mapping exists
    return REVERSE_SYMBOL_MAP[symbol] || symbol;
  }
}
