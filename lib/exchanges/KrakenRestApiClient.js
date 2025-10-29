/**
 * Kraken REST API Client
 * 
 * This module provides a client for the Kraken REST API, specifically focused on
 * fetching OHLC (Open, High, Low, Close) data for multi-timeframe analysis.
 */

import fetch from 'node-fetch';

/**
 * Kraken REST API Client
 */
export class KrakenRestApiClient {
  /**
   * Create a new Kraken REST API Client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger function
   */
  constructor(options = {}) {
    this.options = options;
    this.baseUrl = 'https://api.kraken.com/0/public';
    
    // Bind methods
    this.log = this.log.bind(this);
    this.getOHLC = this.getOHLC.bind(this);
    this.convertSymbol = this.convertSymbol.bind(this);
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
      // Handle different types of loggers
      if (typeof this.options.logger === 'function') {
        // Function logger
        this.options.logger(level, message, data);
      } else if (typeof this.options.logger === 'object') {
        // Object logger with methods like info, error, etc.
        if (typeof this.options.logger[level] === 'function') {
          this.options.logger[level](message, data);
        } else if (typeof this.options.logger.log === 'function') {
          // Fallback to generic log method
          this.options.logger.log(level, message, data);
        } else {
          // Last resort fallback
          console[level](message, data);
        }
      } else {
        console[level](message, data);
      }
    } else {
      console[level](message, data);
    }
  }
  
  /**
   * Get OHLC data for a symbol
   * 
   * @param {string} symbol - Symbol in standard format (e.g., 'BTC/USD')
   * @param {number} interval - Interval in minutes (1, 5, 15, 30, 60, 240, 1440, 10080, 21600)
   * @param {number} since - Return committed OHLC data since given ID (optional)
   * @returns {Promise<Object>} - OHLC data
   */
  async getOHLC(symbol, interval = 1, since = null) {
    try {
      // Convert symbol to Kraken format
      const krakenSymbol = this.convertSymbol(symbol);
      
      // Build URL
      let url = `${this.baseUrl}/OHLC?pair=${krakenSymbol}&interval=${interval}`;
      if (since) {
        url += `&since=${since}`;
      }
      
      // Make request
      this.log('info', `Fetching OHLC data for ${symbol} with interval ${interval}`, { url });
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Check for errors
      if (data.error && data.error.length > 0) {
        throw new Error(`Kraken API error: ${data.error.join(', ')}`);
      }
      
      // Format response
      return this.formatOHLCResponse(data, krakenSymbol);
    } catch (error) {
      this.log('error', `Error fetching OHLC data: ${error.message}`, { error, symbol, interval });
      throw error;
    }
  }
  
  /**
   * Format OHLC response from Kraken API
   * 
   * @param {Object} data - Response data from Kraken API
   * @param {string} krakenSymbol - Symbol in Kraken format
   * @returns {Object} - Formatted OHLC data
   */
  formatOHLCResponse(data, krakenSymbol) {
    // Extract result for the symbol
    const result = data.result || {};
    const ohlcData = result[krakenSymbol] || [];
    const last = result.last || 0;
    
    // Format OHLC data
    const formattedData = ohlcData.map(item => ({
      time: parseInt(item[0], 10),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      vwap: parseFloat(item[5]),
      volume: parseFloat(item[6]),
      count: parseInt(item[7], 10)
    }));
    
    return {
      ohlc: formattedData,
      last,
      timestamp: Date.now()
    };
  }
  
  /**
   * Convert symbol to Kraken format
   * 
   * @param {string} symbol - Symbol in standard format (e.g., 'BTC/USD')
   * @returns {string} - Symbol in Kraken format (e.g., 'XBTUSD')
   */
  convertSymbol(symbol) {
    // Define symbol mapping for Kraken REST API
    const KRAKEN_SYMBOL_MAP = {
      'BTC/USD': 'XXBTZUSD',  // XBT is Kraken's code for Bitcoin, XXBTZUSD for OHLC
      'ETH/USD': 'XETHZUSD' // Assuming similar for ETH/USD
    };
    
    // Remove the slash for Kraken REST API
    const noSlashSymbol = symbol.replace('/', '');
    
    // Return mapped symbol or symbol without slash if no mapping exists
    return KRAKEN_SYMBOL_MAP[symbol] || noSlashSymbol;
  }
}
