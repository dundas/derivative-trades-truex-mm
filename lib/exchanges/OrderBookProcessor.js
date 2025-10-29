/**
 * OrderBook Processor
 * 
 * This module processes orderbook data and generates trading signals.
 * It can be used in both Node.js and Cloudflare Workers environments.
 */

/**
 * Process and analyze orderbook data
 */
export class OrderBookProcessor {
  /**
   * Create a new OrderBook Processor
   * 
   * @param {Object} options - Processor options
   * @param {Function} options.logger - Logger function
   * @param {Function} options.onSignalGenerated - Callback for generated signals
   */
  constructor(options = {}) {
    this.options = options;
    this.lastProcessedTimestamps = new Map();
    this.processingInterval = options.processingInterval || 1000; // 1 second
    this.signalThrottleInterval = options.signalThrottleInterval || 5000; // 5 seconds
    this.lastSignalTimestamps = new Map();
    
    // Bind methods
    this.processOrderBook = this.processOrderBook.bind(this);
    this.generateSignals = this.generateSignals.bind(this);
    this.calculateMetrics = this.calculateMetrics.bind(this);
    this.log = this.log.bind(this);
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
    } else {
      console[level](message, data);
    }
  }
  
  /**
   * Process an orderbook update
   * 
   * @param {string} symbol - Symbol
   * @param {Object} orderbook - Orderbook data
   * @returns {Object} - Processed orderbook with metrics
   */
  processOrderBook(symbol, orderbook) {
    if (!orderbook || !orderbook.bids || !orderbook.asks) {
      this.log('warn', `Insufficient orderbook data for ${symbol}`);
      return null;
    }
    
    // Check if we should process this update (throttle processing)
    const now = Date.now();
    const lastProcessed = this.lastProcessedTimestamps.get(symbol) || 0;
    
    if (now - lastProcessed < this.processingInterval) {
      return null;
    }
    
    this.lastProcessedTimestamps.set(symbol, now);
    
    // Calculate metrics
    const metrics = this.calculateMetrics(orderbook);
    
    // Generate signals
    const signals = this.generateSignals(orderbook, metrics);
    
    // Notify if signals were generated and throttle interval passed
    const lastSignalTime = this.lastSignalTimestamps.get(symbol) || 0;
    
    if (signals.length > 0 && now - lastSignalTime >= this.signalThrottleInterval) {
      this.lastSignalTimestamps.set(symbol, now);
      
      if (this.options.onSignalGenerated) {
        this.options.onSignalGenerated(symbol, signals, metrics);
      }
    }
    
    return {
      symbol,
      orderbook,
      metrics,
      signals,
      timestamp: now
    };
  }
  
  /**
   * Calculate metrics from orderbook data
   * 
   * @param {Object} orderbook - Orderbook data
   * @returns {Object} - Calculated metrics
   */
  calculateMetrics(orderbook) {
    if (!orderbook.bids || !orderbook.asks || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return {
        midPrice: null,
        bestBid: null,
        bestAsk: null,
        spread: null,
        spreadPercentage: null,
        bidVolume: 0,
        askVolume: 0,
        volumeRatio: null
      };
    }
    
    // Calculate mid price and other metrics
    const bestBid = parseFloat(orderbook.bids[0][0]);
    const bestAsk = parseFloat(orderbook.asks[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPercentage = (spread / bestBid) * 100;
    
    // Calculate volumes
    const bidVolume = orderbook.bids.reduce((sum, [price, size]) => sum + parseFloat(size), 0);
    const askVolume = orderbook.asks.reduce((sum, [price, size]) => sum + parseFloat(size), 0);
    const volumeRatio = bidVolume / (askVolume || 1);
    
    return {
      midPrice,
      bestBid,
      bestAsk,
      spread,
      spreadPercentage,
      bidVolume,
      askVolume,
      volumeRatio
    };
  }
  
  /**
   * Generate trading signals based on orderbook data
   * 
   * @param {Object} orderbook - The orderbook data with bids and asks
   * @param {Object} metrics - Calculated metrics
   * @returns {Array} - Array of signal objects with type, strength, and reason
   */
  generateSignals(orderbook, metrics) {
    const signals = [];
    
    // Skip if we don't have valid data
    if (!orderbook || !metrics || !orderbook.bids || !orderbook.asks) {
      return signals;
    }
    
    const { volumeRatio, spreadPercentage } = metrics;
    
    // Strong buy pressure when bid volume significantly exceeds ask volume
    if (volumeRatio > 1.5) {
      signals.push({
        type: 'BUY',
        strength: 'MEDIUM',
        reason: `Bid/Ask volume imbalance: ${volumeRatio.toFixed(2)}x more bid volume than ask volume`
      });
    }
    
    // Strong sell pressure when ask volume significantly exceeds bid volume
    if (volumeRatio < 0.67) {
      signals.push({
        type: 'SELL',
        strength: 'MEDIUM',
        reason: `Bid/Ask volume imbalance: ${(1/volumeRatio).toFixed(2)}x more ask volume than bid volume`
      });
    }
    
    // Tight spreads can indicate high liquidity and potentially less slippage
    if (spreadPercentage < 0.05) {
      signals.push({
        type: 'INFO',
        strength: 'LOW',
        reason: `Very tight spread (${spreadPercentage.toFixed(4)}%) indicates high liquidity`
      });
    }
    
    // Wide spreads can indicate low liquidity and potentially more slippage
    if (spreadPercentage > 0.5) {
      signals.push({
        type: 'WARNING',
        strength: 'MEDIUM',
        reason: `Wide spread (${spreadPercentage.toFixed(4)}%) indicates low liquidity`
      });
    }
    
    return signals;
  }
}
