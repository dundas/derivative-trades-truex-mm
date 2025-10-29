/**
 * CentralizedOrderBookManager
 * 
 * A single source of truth for orderbook data processing across the entire system.
 * Implements the observer pattern, allowing components to subscribe to orderbook updates.
 */

class CentralizedOrderBookManager {
  /**
   * Create a new CentralizedOrderBookManager
   * 
   * @param {Object} options - Configuration options
   * @param {string} [options.symbol] - Symbol (optional but recommended)
   * @param {number} [options.bufferSize=20] - Size of the order book buffer
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.bufferSize = options.bufferSize || 20;
    this.logger = options.logger || console;
    this.symbol = typeof options.symbol === 'string' ? options.symbol : 'unknown';
    
    this.config = {
      bufferSize: this.bufferSize,
      logger: options.logger || console
    };
    
    this.listeners = [];
    this._latestOrderBook = null;
    this._orderBookBuffer = [];
    this._subscribers = [];
    
    // Track orderbook build status
    this._hasValidBids = false;
    this._hasValidAsks = false;
    this._lastBidUpdate = 0;
    this._lastAskUpdate = 0;
    this._snapshotRequested = false;
    
    // Only try to check if symbol is Kraken format if we have a valid string
    this.isKrakenSymbol = typeof this.symbol === 'string' && 
      (this.symbol.includes('BTC') || this.symbol.includes('XBT'));
    
    this.log('info', `CentralizedOrderBookManager initialized for ${this.symbol}`);
  }
  
  /**
   * Process a raw orderbook update
   * 
   * @param {Object} rawOrderBook - Raw orderbook data from exchange
   * @returns {Object|null} - Normalized orderbook or null if invalid
   */
  processOrderBook(rawOrderBook) {
    try {
      // Single normalization point
      const normalized = this._normalizeOrderBook(rawOrderBook);
      
      if (!normalized) {
        return null;
      }
      
      // Store in centralized location
      this._latestOrderBook = normalized;
      
      // Add to historical buffer
      this._addToBuffer(normalized);
      
      // Notify all listeners
      this._notifyListeners(normalized);
      
      return normalized;
    } catch (error) {
      this.log('error', `Error processing orderbook: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Process an order book update from an exchange
   * @param {Object} exchangeUpdate - Order book update from the exchange
   * @param {string} exchangeId - Exchange identifier
   * @returns {Object} - Processed order book
   */
  processOrderBookUpdate(exchangeUpdate, exchangeId = 'unknown') {
    try {
      if (!exchangeUpdate) {
        this.log('warn', `Received empty orderbook update from ${exchangeId}`);
        return null;
      }
      
      // Extract the order book data from the update
      const orderBook = exchangeUpdate.orderBook || exchangeUpdate;
      
      // Check for empty order book sides
      const bidCount = orderBook.bids ? orderBook.bids.length : 0;
      const askCount = orderBook.asks ? orderBook.asks.length : 0;
      
      if (bidCount === 0 && askCount === 0) {
        this.log('warn', `Received empty orderbook (no bids or asks) from ${exchangeId}`);
        return null;
      }
      
      // Always define these variables, regardless of what path the code takes
      const hasCompleteBids = bidCount > 0;
      const hasCompleteAsks = askCount > 0;
      
      // Create a normalized version of the order book
      const isPartialUpdate = orderBook.isPartialUpdate === true || 
                             (!hasCompleteBids || !hasCompleteAsks);
      
      // If we have a partial update, handle merging with previous data
      if (isPartialUpdate) {
        this._handlePartialUpdate(orderBook, hasCompleteBids, hasCompleteAsks);
      }
      
      // Add exchange metadata
      orderBook.exchange = exchangeId;
      orderBook.isPartialUpdate = isPartialUpdate;
      orderBook.timestamp = orderBook.timestamp || Date.now();
      orderBook.symbol = this.symbol;
      orderBook.hasCompleteBids = hasCompleteBids;
      orderBook.hasCompleteAsks = hasCompleteAsks;
      
      // Extract best bid and ask
      this._extractBestPrices(orderBook);
      
      // Store the processed order book
      this._latestOrderBook = orderBook;
      
      // Add to buffer with circular buffer logic
      this._addToBuffer(orderBook);
      
      // Notify all subscribers
      this._notifySubscribers(orderBook);
      
      return orderBook;
    } catch (error) {
      this.log('error', `Error processing order book update: ${error.message}`);
      console.error('Error processing order book update:', error);
      return null;
    }
  }
  
  /**
   * Process an order book update
   * 
   * @param {Object} orderBook - Order book data
   */
  processOrderBook(orderBook) {
    try {
      if (!orderBook) {
        this.log('warn', 'Received empty orderbook update');
        return null;
      }

      // Check for empty order book sides
      const bidCount = orderBook.bids ? orderBook.bids.length : 0;
      const askCount = orderBook.asks ? orderBook.asks.length : 0;

      if (bidCount === 0 && askCount === 0) {
        this.log('warn', 'Received empty orderbook (no bids or asks)');
        return null;
      }

      if (bidCount === 0 || askCount === 0) {
        this.log('warn', 'Empty orderbook side', { bidCount, askCount });
        // Continue processing - we might have partial updates
      }
      
      // Always define these variables, regardless of what happens later
      const hasCompleteBids = bidCount > 0;
      const hasCompleteAsks = askCount > 0;
      
      // Create a normalized orderbook
      let normalizedOrderBook = {
        ...orderBook,
        timestamp: orderBook.timestamp || Date.now(),
        hasCompleteBids,
        hasCompleteAsks,
        isPartialUpdate: orderBook.isPartialUpdate === true || (!hasCompleteBids || !hasCompleteAsks)
      };

      // Store the processed orderbook
      this._latestOrderBook = normalizedOrderBook;
      
      // Add to buffer with circular buffer logic
      this._addToBuffer(normalizedOrderBook);

      // Notify all subscribers
      this._notifySubscribers(normalizedOrderBook);
      
      return normalizedOrderBook;
    } catch (error) {
      this.log('error', `Error processing order book: ${error.message}`);
      console.error('Error processing order book:', error);
      return null;
    }
  }
  
  /**
   * Normalize and store an order book update
   * 
   * @param {Object} rawOrderBook - Raw order book data
   * @returns {Object} - Normalized order book
   */
  normalizeAndStore(rawOrderBook) {
    try {
      if (!rawOrderBook) {
        this.log('warn', 'Received empty order book data');
        return null;
      }
      
      // Normalize the order book
      const normalized = this._normalizeOrderBook(rawOrderBook);
      
      if (!normalized) {
        this.log('warn', 'Failed to normalize order book');
        return null;
      }
      
      // Check for empty order book sides
      const bidCount = normalized.bids ? normalized.bids.length : 0;
      const askCount = normalized.asks ? normalized.asks.length : 0;
      
      // Determine if this is a complete or partial orderbook
      const hasCompleteBids = bidCount > 0;
      const hasCompleteAsks = askCount > 0;
      const isPartialUpdate = normalized.isPartialUpdate === true || 
                             (!hasCompleteBids || !hasCompleteAsks);
      
      // Handle partial updates differently from complete snapshots
      if (isPartialUpdate) {
        this._handlePartialUpdate(normalized, hasCompleteBids, hasCompleteAsks);
      } else {
        this._handleFullSnapshot(normalized);
      }
      
      // Store in centralized location
      this._latestOrderBook = normalized;
      
      // Add to historical buffer
      this._addToBuffer(normalized);
      
      // Notify subscribers
      this._notifySubscribers(normalized);
      
      return normalized;
    } catch (error) {
      this.log('error', `Error normalizing and storing order book: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get the latest orderbook
   * 
   * @returns {Object|null} - Latest orderbook or null if none available
   */
  getLatestOrderBook() {
    return this._latestOrderBook;
  }
  
  /**
   * Check if there is a valid orderbook available
   * 
   * @returns {Boolean} - True if valid orderbook exists
   */
  hasValidOrderBook() {
    // Return true only if we have a valid orderbook with both sides
    return this._latestOrderBook && 
           this._latestOrderBook.isValid && 
           this._hasValidBids && 
           this._hasValidAsks && 
           this._latestOrderBook.bestBid > 0 && 
           this._latestOrderBook.bestAsk > 0;
  }
  
  /**
   * Subscribe to orderbook updates
   * 
   * @param {Function} listener - Callback function
   * @returns {Function} - Unsubscribe function
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Listener must be a function');
    }
    
    this.listeners.push(listener);
    
    // If we already have data, send it to the new listener
    if (this._latestOrderBook) {
      try {
        listener(this._latestOrderBook);
      } catch (error) {
        this.log('error', `Error in new listener: ${error.message}`);
      }
    }
    
    // Return unsubscribe function
    return () => this.unsubscribe(listener);
  }
  
  /**
   * Unsubscribe from orderbook updates
   * 
   * @param {Function} listener - The listener to remove
   */
  unsubscribe(listener) {
    this.listeners = this.listeners.filter(l => l !== listener);
  }
  
  /**
   * Get orderbook history buffer
   * 
   * @returns {Array} - Historical orderbook data
   */
  getOrderBookBuffer() {
    return this._orderBookBuffer;
  }
  
  /**
   * Add an orderbook to the buffer
   * 
   * @private
   * @param {Object} orderBook - Orderbook to add
   */
  _addToBuffer(orderBook) {
    this._orderBookBuffer.push({
      ...orderBook,
      timestamp: orderBook.timestamp || Date.now()
    });
    
    // Cap buffer size
    if (this._orderBookBuffer.length > this.config.bufferSize) {
      this._orderBookBuffer.shift();
    }
  }
  
  /**
   * Notify all listeners of an orderbook update
   * 
   * @private
   * @param {Object} orderBook - Normalized orderbook
   */
  _notifyListeners(orderBook) {
    this.listeners.forEach(listener => {
      try {
        listener(orderBook);
      } catch (error) {
        this.log('error', `Error in orderbook listener: ${error.message}`);
      }
    });
  }
  
  /**
   * Normalize orderbook data to a consistent format
   * 
   * @private
   * @param {Object} orderBook - Raw orderbook data
   * @returns {Object|null} - Normalized orderbook or null if invalid
   */
  _normalizeOrderBook(orderBook) {
    try {
      // Initialize the consolidated orderbook structure
      const consolidated = {
        bids: [],
        asks: [],
        timestamp: Date.now(),
        symbol: this.symbol
      };

      // 1. Handle standard format (arrays of bids/asks)
      if (Array.isArray(orderBook.bids) && Array.isArray(orderBook.asks)) {
        // Direct mapping - preserve structure but ensure consistent format
        orderBook.bids.forEach(bid => {
          if (Array.isArray(bid)) {
            consolidated.bids.push([bid[0].toString(), bid[1].toString()]);
          } else if (bid.price !== undefined && bid.qty !== undefined) {
            consolidated.bids.push([bid.price.toString(), bid.qty.toString()]);
          }
        });
        
        orderBook.asks.forEach(ask => {
          if (Array.isArray(ask)) {
            consolidated.asks.push([ask[0].toString(), ask[1].toString()]);
          } else if (ask.price !== undefined && ask.qty !== undefined) {
            consolidated.asks.push([ask.price.toString(), ask.qty.toString()]);
          }
        });
      }
      // 2. Handle Kraken WebSocket format
      else if (orderBook.a !== undefined || orderBook.b !== undefined || 
               orderBook.as !== undefined || orderBook.bs !== undefined) {
        
        // Process bids - Kraken uses 'b' for bids in updates and 'bs' in snapshots
        if (orderBook.bs && Array.isArray(orderBook.bs)) {
          orderBook.bs.forEach(bid => {
            consolidated.bids.push([bid[0].toString(), bid[1].toString()]);
          });
        } else if (orderBook.b && Array.isArray(orderBook.b)) {
          orderBook.b.forEach(bid => {
            consolidated.bids.push([bid[0].toString(), bid[1].toString()]);
          });
        }
        
        // Process asks - Kraken uses 'a' for asks in updates and 'as' in snapshots
        if (orderBook.as && Array.isArray(orderBook.as)) {
          orderBook.as.forEach(ask => {
            consolidated.asks.push([ask[0].toString(), ask[1].toString()]);
          });
        } else if (orderBook.a && Array.isArray(orderBook.a)) {
          orderBook.a.forEach(ask => {
            consolidated.asks.push([ask[0].toString(), ask[1].toString()]);
          });
        }
      }
      // 3. Handle unknown format
      else {
        this.log('warn', 'Unknown orderbook format received', {
          symbol: this.symbol,
          orderBookKeys: Object.keys(orderBook)
        });
        return null;
      }

      // Sort bids in descending order by price (highest bid first)
      if (consolidated.bids.length > 0) {
        consolidated.bids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
      }

      // Sort asks in ascending order by price (lowest ask first)
      if (consolidated.asks.length > 0) {
        consolidated.asks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
      }

      // Validate the orderbook
      if (!this._validateOrderBook(consolidated)) {
        return null;
      }

      return consolidated;
    } catch (error) {
      this.log('error', 'Failed to normalize orderbook', { 
        error: error.message,
        symbol: this.symbol
      });
      return null;
    }
  }
  
  /**
   * Validate an orderbook
   * 
   * @private
   * @param {Object} orderBook - Orderbook to validate
   * @returns {Boolean} - True if orderbook is valid
   */
  _validateOrderBook(orderBook) {
    // Basic structure validation
    if (!orderBook.bids || !orderBook.asks || 
        !Array.isArray(orderBook.bids) || !Array.isArray(orderBook.asks)) {
      this.log('warn', 'Invalid orderbook structure', { 
        hasBids: !!orderBook.bids, 
        hasAsks: !!orderBook.asks 
      });
      return false;
    }
    
    // Require at least one entry on both sides
    if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      this.log('warn', 'Empty orderbook side', { 
        bidCount: orderBook.bids.length, 
        askCount: orderBook.asks.length 
      });
      return false;
    }
    
    // Check if best bid and ask make sense (bid should be less than ask)
    if (orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      const bestBid = parseFloat(orderBook.bids[0][0]);
      const bestAsk = parseFloat(orderBook.asks[0][0]);
      
      if (bestBid >= bestAsk) {
        const inversionPct = ((bestBid - bestAsk) / bestAsk) * 100;
        
        // Log the inversion
        this.log('warn', 'Inverted orderbook detected', {
          bestBid,
          bestAsk,
          inversionPct: inversionPct.toFixed(4) + '%'
        });
        
        // Only reject if severe inversion
        if (inversionPct > 1.0) {
          this.log('warn', 'Rejecting severely inverted orderbook');
          return false;
        }
      }
    }
    
    return true;
  }
  
  /**
   * Log a message
   * 
   * @private
   * @param {String} level - Log level
   * @param {String} message - Message to log
   * @param {Object} data - Additional data
   */
  log(level, message, data = {}) {
    const logger = this.logger;
    const fullMessage = `[CentralizedOrderBookManager:${this.symbol}] ${message}`;
    
    if (!logger) {
      console.log(`${level.toUpperCase()}: ${fullMessage}`, data);
      return;
    }
    
    // Handle TradingLogger (has logMarket method)
    if (typeof logger.logMarket === 'function') {
      logger.logMarket(level.toUpperCase(), fullMessage, data);
      return;
    }
    
    // Handle standard logger methods
    if (typeof logger[level] === 'function') {
      logger[level](fullMessage, data);
      return;
    }
    
    // Fallback to basic levels if exact level doesn't exist
    if (level === 'debug' && typeof logger.log === 'function') {
      logger.log(fullMessage, data);
    } else if ((level === 'warn' || level === 'info') && typeof logger.log === 'function') {
      logger.log(fullMessage, data);
    } else if (level === 'error' && typeof logger.error === 'function') {
      logger.error(fullMessage, data);
    } else {
      // Ultimate fallback to console
      console.log(`${level.toUpperCase()}: ${fullMessage}`, data);
    }
  }
  
  /**
   * Handle a partial order book update
   * 
   * @private
   * @param {Object} orderBook - Partial order book update
   * @param {boolean} hasCompleteBids - Whether the update contains complete bids
   * @param {boolean} hasCompleteAsks - Whether the update contains complete asks
   */
  _handlePartialUpdate(orderBook, hasCompleteBids, hasCompleteAsks) {
    // If we don't have a latest order book yet, treat as full snapshot
    if (!this._latestOrderBook) {
      this._handleFullSnapshot(orderBook);
      return;
    }
    
    // Create a new order book based on the latest one
    const updatedOrderBook = {
      ...this._latestOrderBook,
      timestamp: Date.now()
    };
    
    // Update bids if the update has bids
    if (hasCompleteBids && orderBook.bids && orderBook.bids.length > 0) {
      updatedOrderBook.bids = orderBook.bids;
    }
    
    // Update asks if the update has asks
    if (hasCompleteAsks && orderBook.asks && orderBook.asks.length > 0) {
      updatedOrderBook.asks = orderBook.asks;
    }
    
    // Update the order book reference
    orderBook.bids = updatedOrderBook.bids;
    orderBook.asks = updatedOrderBook.asks;
    orderBook.timestamp = updatedOrderBook.timestamp;
  }
  
  /**
   * Handle a full order book snapshot
   * 
   * @private
   * @param {Object} orderBook - Full order book snapshot
   */
  _handleFullSnapshot(orderBook) {
    // Just use the full snapshot as is
    // Add a timestamp if not present
    if (!orderBook.timestamp) {
      orderBook.timestamp = Date.now();
    }
    
    // Ensure the structure is consistent
    if (!orderBook.bids) orderBook.bids = [];
    if (!orderBook.asks) orderBook.asks = [];
  }
  
  /**
   * Notify all subscribers about order book updates
   * 
   * @private
   * @param {Object} orderBook - Updated order book
   */
  _notifySubscribers(orderBook) {
    if (!this._subscribers || this._subscribers.length === 0) {
      return;
    }
    
    // Copy orderbook to avoid mutation by subscribers
    const orderBookCopy = JSON.parse(JSON.stringify(orderBook));
    
    // Call each subscriber with the updated order book
    this._subscribers.forEach(subscriber => {
      try {
        subscriber(orderBookCopy);
      } catch (error) {
        this.log('error', `Error in order book subscriber: ${error.message}`);
      }
    });
  }
  
  /**
   * Extract best bid and ask prices from an orderbook
   * 
   * @private
   * @param {Object} orderBook - Order book object
   * @returns {Object} - Order book with best prices extracted
   */
  _extractBestPrices(orderBook) {
    try {
      if (!orderBook) return orderBook;

      // Extract best bid if available
      if (orderBook.bids && orderBook.bids.length > 0) {
        const bestBidData = orderBook.bids[0]; // Highest bid (first in descending sorted array)
        if (bestBidData && bestBidData.length >= 2) {
          orderBook.bestBid = parseFloat(bestBidData[0]);
          orderBook.bestBidSize = parseFloat(bestBidData[1]);
        } else {
          this.log('warn', 'Invalid bid data structure when extracting best prices');
          orderBook.bestBid = 0;
          orderBook.bestBidSize = 0;
        }
      } else {
        orderBook.bestBid = 0;
        orderBook.bestBidSize = 0;
      }

      // Extract best ask if available
      if (orderBook.asks && orderBook.asks.length > 0) {
        const bestAskData = orderBook.asks[0]; // Lowest ask (first in ascending sorted array)
        if (bestAskData && bestAskData.length >= 2) {
          orderBook.bestAsk = parseFloat(bestAskData[0]);
          orderBook.bestAskSize = parseFloat(bestAskData[1]);
        } else {
          this.log('warn', 'Invalid ask data structure when extracting best prices');
          orderBook.bestAsk = 0;
          orderBook.bestAskSize = 0;
        }
      } else {
        orderBook.bestAsk = 0;
        orderBook.bestAskSize = 0;
      }

      // Calculate mid price and spread
      if (orderBook.bestBid > 0 && orderBook.bestAsk > 0) {
        orderBook.midPrice = (orderBook.bestBid + orderBook.bestAsk) / 2;
        orderBook.spread = orderBook.bestAsk - orderBook.bestBid;
        orderBook.spreadPercentage = (orderBook.spread / orderBook.midPrice) * 100;
      } else {
        orderBook.midPrice = 0;
        orderBook.spread = 0;
        orderBook.spreadPercentage = 0;
      }

      return orderBook;
    } catch (error) {
      this.log('error', `Error extracting best prices: ${error.message}`);
      // Ensure we return something even if extraction fails
      orderBook.bestBid = orderBook.bestBid || 0;
      orderBook.bestAsk = orderBook.bestAsk || 0;
      orderBook.midPrice = orderBook.midPrice || 0;
      return orderBook;
    }
  }
  
  /**
   * Validate market data and detect potential issues
   * Based on the PriceCalculator's calculateMarketBasedSpread method
   * 
   * @param {Object} orderBook - Current order book
   * @param {Array} orderBookBuffer - Buffer of recent order books
   * @returns {Object} Validation results including spread information
   */
  validateMarketData(orderBook, orderBookBuffer = []) {
    try {
      if (!orderBook) return { valid: false, reason: 'No orderbook provided' };
      
      // Extract basic data
      const hasBids = orderBook.bids && orderBook.bids.length > 0;
      const hasAsks = orderBook.asks && orderBook.asks.length > 0;
      
      if (!hasBids && !hasAsks) {
        return { valid: false, reason: 'Empty orderbook (no bids or asks)' };
      }
      
      const bestBid = hasBids ? parseFloat(orderBook.bids[0][0]) : 0;
      const bestAsk = hasAsks ? parseFloat(orderBook.asks[0][0]) : 0;
      
      // Basic validation
      const hasValidBid = hasBids && !isNaN(bestBid) && bestBid > 0;
      const hasValidAsk = hasAsks && !isNaN(bestAsk) && bestAsk > 0;
      
      if (!hasValidBid && !hasValidAsk) {
        return { valid: false, reason: 'No valid prices in orderbook' };
      }
      
      // Calculate midPrice
      let midPrice = 0;
      if (hasValidBid && hasValidAsk) {
        midPrice = (bestBid + bestAsk) / 2;
      } else if (hasValidBid) {
        midPrice = bestBid;
      } else if (hasValidAsk) {
        midPrice = bestAsk;
      }
      
      if (midPrice <= 0) {
        return { valid: false, reason: 'Invalid mid price calculated' };
      }
      
      // Check for inverted orderbook
      let isInverted = false;
      let currentSpread = 0;
      
      if (hasValidBid && hasValidAsk) {
        // Check for inverted orderbook (bid >= ask)
        if (bestBid >= bestAsk) {
          isInverted = true;
          this.log('warn', 'Inverted orderbook detected', {
            bestBid,
            bestAsk,
            inversionPct: ((bestBid - bestAsk) / bestAsk) * 100
          });
        }
        currentSpread = Math.abs(bestAsk - bestBid); // Use absolute value
      }
      
      // Calculate spread percentage
      const spreadPercentage = currentSpread / midPrice;
      
      // Analyze order book buffer for stability
      let isVolatile = false;
      let spreadStability = 'unknown';
      
      if (Array.isArray(orderBookBuffer) && orderBookBuffer.length > 2) {
        // Calculate average spread from buffer
        let totalSpread = 0;
        let validEntries = 0;
        
        for (const entry of orderBookBuffer) {
          if (entry.bids && entry.bids.length > 0 && entry.asks && entry.asks.length > 0) {
            const entryBid = parseFloat(entry.bids[0][0]);
            const entryAsk = parseFloat(entry.asks[0][0]);
            
            if (!isNaN(entryBid) && !isNaN(entryAsk) && entryBid > 0 && entryAsk > 0) {
              totalSpread += Math.abs(entryAsk - entryBid);
              validEntries++;
            }
          }
        }
        
        if (validEntries > 0) {
          const averageSpread = totalSpread / validEntries;
          const spreadDeviation = Math.abs(currentSpread - averageSpread) / averageSpread;
          
          // Check if current spread deviates significantly from average
          isVolatile = spreadDeviation > 0.5; // >50% deviation
          spreadStability = isVolatile ? 'unstable' : 'stable';
        }
      }
      
      return {
        valid: true,
        midPrice,
        bestBid,
        bestAsk,
        spread: currentSpread,
        spreadPercentage,
        isInverted,
        isVolatile,
        spreadStability,
        hasBids,
        hasAsks,
        bidCount: hasBids ? orderBook.bids.length : 0,
        askCount: hasAsks ? orderBook.asks.length : 0
      };
    } catch (error) {
      this.log('error', `Error validating market data: ${error.message}`);
      return { valid: false, reason: `Error during validation: ${error.message}` };
    }
  }
  
  /**
   * Process an incremental update from Kraken
   * This handles Kraken's format where updates may only include one side (bids or asks)
   * 
   * @param {string} symbol - Symbol
   * @param {Object} krakenOrderBook - Orderbook from Kraken
   * @returns {Object} - Processed orderbook
   */
  processExchangeUpdate(symbol, krakenOrderBook) {
    try {
      if (!krakenOrderBook) {
        this.log('warn', 'Received empty orderbook update from exchange');
        return null;
      }
      
      // Check for empty input
      const inputBidCount = krakenOrderBook.bids ? krakenOrderBook.bids.length : 0;
      const inputAskCount = krakenOrderBook.asks ? krakenOrderBook.asks.length : 0;
      
      // Check if this is an initial snapshot
      const isInitialSnapshot = krakenOrderBook.isInitialSnapshot || 
                               (krakenOrderBook.bs && krakenOrderBook.bs.length > 0) || 
                               (krakenOrderBook.as && krakenOrderBook.as.length > 0);
      
      // Log details about the received update
      const updateType = isInitialSnapshot ? 'snapshot' : 'incremental update';
      this.log('debug', `Processing ${updateType} for ${symbol}: bids=${inputBidCount}, asks=${inputAskCount}`);
      
      if (inputBidCount === 0 && inputAskCount === 0) {
        this.log('warn', 'Received empty orderbook (no bids or asks) from exchange');
        return null;
      }
      
      // We need to merge this data with our existing order book
      if (!this._latestOrderBook) {
        // First update - just use as-is
        this.log('info', `Creating initial orderbook for ${symbol}`);
        this._latestOrderBook = {
          symbol,
          bids: krakenOrderBook.bids || [],
          asks: krakenOrderBook.asks || [],
          timestamp: krakenOrderBook.timestamp || Date.now(),
          source: 'kraken',
          hasCompleteBids: inputBidCount > 0,
          hasCompleteAsks: inputAskCount > 0,
          isPartialUpdate: inputBidCount === 0 || inputAskCount === 0
        };
      } else {
        // Merge with existing book data
        this.log('debug', `Updating existing orderbook for ${symbol}`);
        const updatedOrderBook = {
          ...this._latestOrderBook,
          timestamp: krakenOrderBook.timestamp || Date.now()
        };
        
        // Only update the sides that are present in the update
        if (krakenOrderBook.bids && krakenOrderBook.bids.length > 0) {
          updatedOrderBook.bids = krakenOrderBook.bids;
          updatedOrderBook.hasCompleteBids = true;
          this._hasValidBids = true;
          this._lastBidUpdate = Date.now();
          this.log('debug', `Updated bids for ${symbol} (${krakenOrderBook.bids.length} levels)`);
        } else {
          updatedOrderBook.hasCompleteBids = updatedOrderBook.bids && updatedOrderBook.bids.length > 0;
        }
        
        if (krakenOrderBook.asks && krakenOrderBook.asks.length > 0) {
          updatedOrderBook.asks = krakenOrderBook.asks;
          updatedOrderBook.hasCompleteAsks = true;
          this._hasValidAsks = true;
          this._lastAskUpdate = Date.now();
          this.log('debug', `Updated asks for ${symbol} (${krakenOrderBook.asks.length} levels)`);
        } else {
          updatedOrderBook.hasCompleteAsks = updatedOrderBook.asks && updatedOrderBook.asks.length > 0;
        }
        
        // Update partial update flag
        updatedOrderBook.isPartialUpdate = !updatedOrderBook.hasCompleteBids || !updatedOrderBook.hasCompleteAsks;
        
        this._latestOrderBook = updatedOrderBook;
      }
      
      // Ensure final structure is consistent and complete
      if (!this._latestOrderBook.bids) this._latestOrderBook.bids = [];
      if (!this._latestOrderBook.asks) this._latestOrderBook.asks = [];
      
      // Double check and ensure these critical properties are defined
      const bidCount = this._latestOrderBook.bids.length;
      const askCount = this._latestOrderBook.asks.length;
      
      this._latestOrderBook.hasCompleteBids = bidCount > 0;
      this._latestOrderBook.hasCompleteAsks = askCount > 0;
      this._latestOrderBook.isPartialUpdate = !this._latestOrderBook.hasCompleteBids || !this._latestOrderBook.hasCompleteAsks;
      
      // Add exchange metadata
      this._latestOrderBook.exchange = 'kraken';
      this._latestOrderBook.symbol = symbol;
      
      // Extract best bid/ask for convenience
      this._extractBestPrices(this._latestOrderBook);
      
      // Enhanced validation using PriceCalculator approach
      const validation = this.validateMarketData(this._latestOrderBook, this._orderBookBuffer);
      
      // Add validation results to the orderbook
      this._latestOrderBook.validation = validation;
      
      // Track orderbook build status
      const hasBothSides = this._hasValidBids && this._hasValidAsks;
      
      // Set isValid based on both validation and having both sides
      this._latestOrderBook.isValid = validation.valid && hasBothSides;
      
      // Log enhanced validation information
      if (validation.valid) {
        if (hasBothSides) {
          if (validation.isInverted) {
            this.log('warn', `Valid but inverted orderbook: spread=${validation.spread.toFixed(8)}, percentage=${(validation.spreadPercentage * 100).toFixed(6)}%`);
          } else if (validation.isVolatile) {
            this.log('warn', `Volatile market detected: spread stability=${validation.spreadStability}`);
          } else {
            this.log('debug', `Valid orderbook: bids=${bidCount}, asks=${askCount}, bestBid=${this._latestOrderBook.bestBid}, bestAsk=${this._latestOrderBook.bestAsk}`);
          }
        } else {
          this.log('debug', `Partial orderbook build in progress: bids=${this._hasValidBids}, asks=${this._hasValidAsks}`);
        }
      } else {
        this.log('warn', `Invalid orderbook detected: ${validation.reason}`);
      }
      
      // Log build status
      this.log('debug', `Orderbook build status: hasBids=${this._hasValidBids}, hasAsks=${this._hasValidAsks}, isValid=${this._latestOrderBook.isValid}`);
      
      // Ensure orderbook has valid prices
      const hasValidPrices = this._latestOrderBook.bestBid > 0 && this._latestOrderBook.bestAsk > 0;
      
      if (hasValidPrices) {
        this.log('debug', `Valid orderbook: bids=${bidCount}, asks=${askCount}, bestBid=${this._latestOrderBook.bestBid}, bestAsk=${this._latestOrderBook.bestAsk}`);
      } else if (bidCount > 0 && askCount > 0) {
        this.log('warn', `Orderbook has bids and asks but invalid prices: bestBid=${this._latestOrderBook.bestBid}, bestAsk=${this._latestOrderBook.bestAsk}`);
      }
      
      // Log warning if we have empty sides
      if (bidCount === 0 || askCount === 0) {
        this.log('warn', 'Empty orderbook side', { bidCount, askCount });
      }
      
      // Add to buffer with circular buffer logic
      this._addToBuffer(this._latestOrderBook);
      
      // Notify all subscribers
      this._notifySubscribers(this._latestOrderBook);
      
      return this._latestOrderBook;
    } catch (error) {
      this.log('error', `Error processing exchange update: ${error.message}`);
      console.error('Error processing exchange update:', error);
      return null;
    }
  }
}

// Use a proper dual export that works in both module systems
export default CentralizedOrderBookManager;

// CommonJS compatibility export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CentralizedOrderBookManager;
}
