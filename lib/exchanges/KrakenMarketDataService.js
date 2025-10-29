/**
 * Kraken Market Data Service
 * 
 * This module provides a service for managing market data from Kraken WebSocket API.
 * It integrates the WebSocket client, orderbook processor, and Redis adapter
 * to provide a complete solution for market data handling.
 */

import { KrakenWebSocketClient } from './KrakenWebSocketClient.js';
import { OrderBookProcessor } from './OrderBookProcessor.js';
import { UpstashRedisAdapter } from './UpstashRedisAdapter.js';

/**
 * Kraken Market Data Service
 */
export class KrakenMarketDataService {
  /**
   * Create a new Kraken Market Data Service
   * 
   * @param {Object} options - Service options
   * @param {Array<string>} options.symbols - Symbols to subscribe to
   * @param {number} options.orderBookDepth - Order book depth
   * @param {Object} options.redis - Redis options
   * @param {string} options.redis.url - Redis URL
   * @param {string} options.redis.token - Redis token
   * @param {boolean} options.useRedis - Whether to use Redis
   * @param {Function} options.logger - Logger function
   * @param {Function} options.onSignalGenerated - Callback for generated signals
   * @param {Function} options.onOrderBookUpdate - Callback for orderbook updates
   * @param {Function} options.onError - Callback for errors
   */
  constructor(options = {}) {
    this.options = {
      symbols: options.symbols || ['BTC/USD', 'ETH/USD'],
      orderBookDepth: options.orderBookDepth || 10,
      useRedis: options.useRedis || false,
      ...options
    };
    
    this.wsClient = null;
    this.processor = null;
    this.redis = null;
    this.isCloudflareEnv = typeof process === 'undefined';
    this.workerId = `worker-${Math.random().toString(36).substring(2, 9)}`;
    this.healthCheckInterval = null;
    
    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.handleOrderBookUpdate = this.handleOrderBookUpdate.bind(this);
    this.handleSignalGenerated = this.handleSignalGenerated.bind(this);
    this.handleError = this.handleError.bind(this);
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
   * Start the market data service
   * 
   * @returns {Promise<void>}
   */
  async start() {
    try {
      this.log('info', 'Starting Kraken Market Data Service...');
      
      // Create orderbook processor
      this.processor = new OrderBookProcessor({
        logger: this.log,
        onSignalGenerated: this.handleSignalGenerated
      });
      
      // Create WebSocket client
      this.wsClient = new KrakenWebSocketClient({
        logger: this.log,
        onOrderBookUpdate: this.handleOrderBookUpdate,
        onError: this.handleError
      });
      
      // Connect to WebSocket
      await this.wsClient.connect();
      
      // Subscribe to symbols
      await this.wsClient.subscribe(this.options.symbols, this.options.orderBookDepth);
      
      // Connect to Redis if enabled
      if (this.options.useRedis && this.options.redis) {
        this.redis = new UpstashRedisAdapter({
          url: this.options.redis.url,
          token: this.options.redis.token,
          logger: this.log
        });
        
        await this.redis.connect();
        
        // Start health check
        this.startHealthCheck();
      }
      
      this.log('info', 'Kraken Market Data Service started successfully');
    } catch (error) {
      this.log('error', `Failed to start Kraken Market Data Service: ${error.message}`, { error });
      await this.stop();
      throw error;
    }
  }
  
  /**
   * Stop the market data service
   * 
   * @returns {Promise<void>}
   */
  async stop() {
    this.log('info', 'Stopping Kraken Market Data Service...');
    
    // Stop health check
    this.stopHealthCheck();
    
    // Disconnect from WebSocket
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    
    // Disconnect from Redis
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
    
    this.log('info', 'Kraken Market Data Service stopped');
  }
  
  /**
   * Handle orderbook update
   * 
   * @param {string} symbol - Symbol
   * @param {Object} orderbook - Orderbook data
   */
  async handleOrderBookUpdate(symbol, orderbook) {
    try {
      // Process orderbook
      const processed = this.processor.processOrderBook(symbol, orderbook);
      
      // Store in Redis if enabled
      if (this.redis && processed) {
        await this.redis.storeOrderBook(symbol, processed);
      }
      
      // Notify listeners
      if (this.options.onOrderBookUpdate && processed) {
        this.options.onOrderBookUpdate(symbol, processed);
      }
    } catch (error) {
      this.log('error', `Error handling orderbook update: ${error.message}`, { error, symbol });
    }
  }
  
  /**
   * Handle signal generated
   * 
   * @param {string} symbol - Symbol
   * @param {Array} signals - Signals
   * @param {Object} metrics - Metrics
   */
  handleSignalGenerated(symbol, signals, metrics) {
    this.log('info', `Generated ${signals.length} trading signals for ${symbol}`);
    
    // Notify listeners
    if (this.options.onSignalGenerated) {
      this.options.onSignalGenerated(symbol, signals, metrics);
    }
  }
  
  /**
   * Handle error
   * 
   * @param {Error} error - Error
   */
  handleError(error) {
    this.log('error', `Kraken Market Data Service error: ${error.message}`, { error });
    
    // Notify listeners
    if (this.options.onError) {
      this.options.onError(error);
    }
  }
  
  /**
   * Start health check
   */
  startHealthCheck() {
    if (!this.redis) {
      return;
    }
    
    this.stopHealthCheck();
    
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.redis.trackConnectionHealth(this.workerId);
      } catch (error) {
        this.log('error', `Health check failed: ${error.message}`, { error });
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Stop health check
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
  
  /**
   * Get orderbook for a symbol
   * 
   * @param {string} symbol - Symbol
   * @returns {Promise<Object|null>}
   */
  async getOrderBook(symbol) {
    // Try to get from Redis first if enabled
    if (this.redis) {
      const redisOrderBook = await this.redis.getOrderBook(symbol);
      if (redisOrderBook) {
        return redisOrderBook;
      }
    }
    
    // Fall back to WebSocket client
    if (this.wsClient) {
      return this.wsClient.getOrderBook(symbol);
    }
    
    return null;
  }
  
  /**
   * Get all orderbooks
   * 
   * @returns {Promise<Map<string, Object>>}
   */
  async getAllOrderBooks() {
    if (this.wsClient) {
      return this.wsClient.getAllOrderBooks();
    }
    
    return new Map();
  }
}
