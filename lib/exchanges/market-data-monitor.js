/**
 * Market Data Diagnostic Monitor
 * 
 * A diagnostic tool for monitoring and validating market data from
 * the Centralized OrderBook Manager. This tool helps identify and debug
 * issues with market data propagation through the system.
 */

import CentralizedOrderBookManager from '../CentralizedOrderBookManager.js';
import { TradingLogger } from '../../../../utils/trading-logger.js';

class MarketDataMonitor {
  /**
   * Create a new MarketDataMonitor
   * 
   * @param {Object} config - Configuration
   * @param {string} config.symbol - Symbol to monitor
   * @param {Object} config.orderBookManager - OrderBookManager instance to monitor
   * @param {Object} [config.logger] - Logger
   * @param {number} [config.samplingInterval=5000] - Sampling interval in ms
   */
  constructor(config) {
    this.symbol = config.symbol;
    this.logger = config.logger || console;
    this.samplingInterval = config.samplingInterval || 5000;
    this.running = false;
    this.diagnosticData = {
      sampleCount: 0,
      validSamples: 0,
      invalidSamples: 0,
      lastSampleTime: null,
      bestBidHistory: [],
      bestAskHistory: [],
      spreadHistory: [],
      errors: [],
      volatilityEvents: [],
      invertedEvents: [],
      missingDataEvents: []
    };
    
    // Connect to the order book manager
    this.orderBookManager = config.orderBookManager;
    if (!this.orderBookManager) {
      throw new Error('OrderBookManager is required for MarketDataMonitor');
    }
    
    // Subscribe to order book updates
    this.unsubscribe = this.orderBookManager.subscribe(this._handleOrderBookUpdate.bind(this));
    
    this.log('info', `Market Data Monitor initialized for ${this.symbol}`);
  }
  
  /**
   * Handle order book updates from the centralized manager
   * 
   * @private
   * @param {Object} orderBook - Normalized order book
   */
  _handleOrderBookUpdate(orderBook) {
    // Record this update
    this.diagnosticData.sampleCount++;
    this.diagnosticData.lastSampleTime = Date.now();
    
    // Validate the orderbook
    if (!orderBook) {
      this._recordError('Received null orderbook');
      this.diagnosticData.invalidSamples++;
      return;
    }
    
    // Check for basic structure
    const hasBids = orderBook.bids && orderBook.bids.length > 0;
    const hasAsks = orderBook.asks && orderBook.asks.length > 0;
    
    if (!hasBids && !hasAsks) {
      this._recordError('Empty orderbook (no bids or asks)');
      this.diagnosticData.invalidSamples++;
      return;
    }
    
    // Extract key metrics
    const bestBid = hasBids ? parseFloat(orderBook.bids[0][0]) : 0;
    const bestAsk = hasAsks ? parseFloat(orderBook.asks[0][0]) : 0;
    const hasValidBid = hasBids && !isNaN(bestBid) && bestBid > 0;
    const hasValidAsk = hasAsks && !isNaN(bestAsk) && bestAsk > 0;
    
    // Record best bid/ask history
    if (hasValidBid) {
      this.diagnosticData.bestBidHistory.push({ time: Date.now(), value: bestBid });
      // Keep history to reasonable size
      if (this.diagnosticData.bestBidHistory.length > 100) {
        this.diagnosticData.bestBidHistory.shift();
      }
    }
    
    if (hasValidAsk) {
      this.diagnosticData.bestAskHistory.push({ time: Date.now(), value: bestAsk });
      // Keep history to reasonable size
      if (this.diagnosticData.bestAskHistory.length > 100) {
        this.diagnosticData.bestAskHistory.shift();
      }
    }
    
    // Check validation from orderbook if available
    if (orderBook.validation) {
      if (!orderBook.validation.valid) {
        this._recordError(`Orderbook validation failed: ${orderBook.validation.reason}`);
        this.diagnosticData.invalidSamples++;
        return;
      }
      
      // Check for inverted orderbook
      if (orderBook.validation.isInverted) {
        this.diagnosticData.invertedEvents.push({ 
          time: Date.now(), 
          bestBid, 
          bestAsk, 
          spread: orderBook.validation.spread 
        });
      }
      
      // Check for volatility
      if (orderBook.validation.isVolatile) {
        this.diagnosticData.volatilityEvents.push({
          time: Date.now(),
          spreadStability: orderBook.validation.spreadStability,
          spreadPercentage: orderBook.validation.spreadPercentage
        });
      }
      
      // Record spread
      this.diagnosticData.spreadHistory.push({
        time: Date.now(),
        value: orderBook.validation.spread,
        percentage: orderBook.validation.spreadPercentage
      });
      // Keep history to reasonable size
      if (this.diagnosticData.spreadHistory.length > 100) {
        this.diagnosticData.spreadHistory.shift();
      }
    } else {
      // Basic validation if validation object is not available
      if (hasValidBid && hasValidAsk) {
        // Calculate spread
        const spread = bestAsk - bestBid;
        
        // Record spread
        this.diagnosticData.spreadHistory.push({
          time: Date.now(),
          value: spread,
          percentage: spread / ((bestBid + bestAsk) / 2)
        });
        // Keep history to reasonable size
        if (this.diagnosticData.spreadHistory.length > 100) {
          this.diagnosticData.spreadHistory.shift();
        }
        
        // Check for inverted orderbook
        if (bestBid >= bestAsk) {
          this.diagnosticData.invertedEvents.push({ 
            time: Date.now(), 
            bestBid, 
            bestAsk, 
            spread 
          });
        }
      }
    }
    
    // Check for missing data on either side
    if (!hasValidBid || !hasValidAsk) {
      this.diagnosticData.missingDataEvents.push({
        time: Date.now(),
        missingBids: !hasValidBid,
        missingAsks: !hasValidAsk,
        bidCount: hasBids ? orderBook.bids.length : 0,
        askCount: hasAsks ? orderBook.asks.length : 0
      });
    }
    
    // Valid sample if we have either valid bid or ask
    if (hasValidBid || hasValidAsk) {
      this.diagnosticData.validSamples++;
    } else {
      this.diagnosticData.invalidSamples++;
    }
  }
  
  /**
   * Record an error in the diagnostic data
   * 
   * @private
   * @param {string} message - Error message
   * @param {Object} [data] - Additional error data
   */
  _recordError(message, data = {}) {
    this.log('error', message, data);
    this.diagnosticData.errors.push({
      time: Date.now(),
      message,
      data
    });
    
    // Keep error history to reasonable size
    if (this.diagnosticData.errors.length > 50) {
      this.diagnosticData.errors.shift();
    }
  }
  
  /**
   * Start continuous monitoring
   * 
   * @returns {Object} This instance for chaining
   */
  start() {
    if (this.running) return this;
    
    this.running = true;
    this.log('info', `Starting market data monitoring for ${this.symbol}`);
    
    this._monitorInterval = setInterval(() => {
      this.generateReport();
    }, this.samplingInterval);
    
    return this;
  }
  
  /**
   * Stop monitoring
   * 
   * @returns {Object} This instance for chaining
   */
  stop() {
    if (!this.running) return this;
    
    clearInterval(this._monitorInterval);
    this.running = false;
    this.log('info', `Stopped market data monitoring for ${this.symbol}`);
    
    return this;
  }
  
  /**
   * Clean up resources
   */
  cleanup() {
    this.stop();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
  
  /**
   * Generate a diagnostic report
   * 
   * @returns {Object} Diagnostic report
   */
  generateReport() {
    const now = Date.now();
    const latestOrderBook = this.orderBookManager.getLatestOrderBook();
    
    // Calculate time since last update
    let timeSinceLastUpdate = 'Never';
    if (this.diagnosticData.lastSampleTime) {
      timeSinceLastUpdate = `${now - this.diagnosticData.lastSampleTime}ms`;
    }
    
    // Calculate health metrics
    const validRate = this.diagnosticData.sampleCount > 0 
      ? (this.diagnosticData.validSamples / this.diagnosticData.sampleCount * 100).toFixed(2)
      : '0.00';
    
    const report = {
      symbol: this.symbol,
      timestamp: now,
      sampleCount: this.diagnosticData.sampleCount,
      validSamples: this.diagnosticData.validSamples,
      invalidSamples: this.diagnosticData.invalidSamples,
      validRate: `${validRate}%`,
      timeSinceLastUpdate,
      currentOrderBook: latestOrderBook ? {
        hasValidBids: latestOrderBook.bids && latestOrderBook.bids.length > 0,
        hasValidAsks: latestOrderBook.asks && latestOrderBook.asks.length > 0,
        bidCount: latestOrderBook.bids ? latestOrderBook.bids.length : 0,
        askCount: latestOrderBook.asks ? latestOrderBook.asks.length : 0,
        bestBid: latestOrderBook.bestBid || 'N/A',
        bestAsk: latestOrderBook.bestAsk || 'N/A',
        midPrice: latestOrderBook.midPrice || 'N/A',
        spread: latestOrderBook.spread || 'N/A',
        isValid: latestOrderBook.isValid !== undefined ? latestOrderBook.isValid : 'Unknown',
      } : 'No data available',
      recentErrors: this.diagnosticData.errors.slice(-5),
      recentInvertedEvents: this.diagnosticData.invertedEvents.slice(-5),
      recentVolatilityEvents: this.diagnosticData.volatilityEvents.slice(-5),
      recentMissingDataEvents: this.diagnosticData.missingDataEvents.slice(-5)
    };
    
    // Log the report summary
    this.log('info', `Market data health: ${validRate}% valid [${this.diagnosticData.validSamples}/${this.diagnosticData.sampleCount}]`, {
      symbol: this.symbol,
      latestUpdate: timeSinceLastUpdate,
      currentBid: latestOrderBook ? latestOrderBook.bestBid : 'N/A',
      currentAsk: latestOrderBook ? latestOrderBook.bestAsk : 'N/A',
      errorCount: this.diagnosticData.errors.length,
      invertedCount: this.diagnosticData.invertedEvents.length,
      volatilityCount: this.diagnosticData.volatilityEvents.length,
      missingDataCount: this.diagnosticData.missingDataEvents.length
    });
    
    return report;
  }
  
  /**
   * Wrapper for logging that works with different logger types
   * 
   * @param {string} level - Log level
   * @param {string} message - Message to log
   * @param {Object} data - Additional data
   */
  log(level, message, data = {}) {
    const logger = this.logger;
    const fullMessage = `[MarketDataMonitor:${this.symbol}] ${message}`;
    
    if (!logger) {
      console.log(`${level}: ${fullMessage}`, data);
      return;
    }
    
    // Handle TradingLogger (has logMarket method)
    if (typeof logger.logMarket === 'function') {
      logger.logMarket(level, fullMessage, data);
      return;
    }
    
    // Handle standard logger methods
    if (typeof logger[level.toLowerCase()] === 'function') {
      logger[level.toLowerCase()](fullMessage, data);
      return;
    }
    
    // Fallback to basic log method
    if (typeof logger.log === 'function') {
      logger.log(`${level}: ${fullMessage}`, data);
    } else {
      // Ultimate fallback to console
      console.log(`${level}: ${fullMessage}`, data);
    }
  }
}

export default MarketDataMonitor;
