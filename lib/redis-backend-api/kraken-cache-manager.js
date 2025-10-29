import logger from '../../utils/logger.js';
import { RedisClient } from '../utils/redis-client.js';
import { KrakenRESTClient } from '../exchanges/KrakenRESTClient.js';

/**
 * Kraken Cache Manager - Integrates with Redis Backend API
 * 
 * This manager provides TTL-based caching for Kraken API data to eliminate
 * rate limiting and timeout issues across all services. It follows the same
 * patterns as other Redis Backend API managers.
 * 
 * Features:
 * - TTL-based automatic cache expiration
 * - Cache-miss-driven data refresh (no polling)
 * - Circuit breaker pattern for API failures
 * - Concurrent request deduplication
 * - Shared cache for all Kraken data types
 */
export class KrakenCacheManager {
  constructor(options = {}) {
    this.cacheTTL = options.cacheTTL || 3; // 3 seconds TTL
    this.historyWindow = options.historyWindow || 3600; // 1 hour in seconds
    this.circuitBreakerThreshold = options.circuitBreakerThreshold || 5;
    this.circuitBreakerResetTime = options.circuitBreakerResetTime || 60000; // 1 minute
    
    // Service state
    this.consecutiveFailures = 0;
    this.circuitBreakerOpen = false;
    this.lastCircuitBreakerOpen = null;
    this.activeFetches = new Map(); // Prevent concurrent fetches for same data type
    
    // Initialize clients
    this.redis = new RedisClient();
    this.kraken = new KrakenRESTClient();
    
    // Cache keys following Redis Backend API patterns
    this.CACHE_PREFIX = 'kraken-cache:';
    this.KEYS = {
      BALANCE: `${this.CACHE_PREFIX}balance`,
      FEES: `${this.CACHE_PREFIX}fees`, 
      OPEN_ORDERS: `${this.CACHE_PREFIX}open-orders`,
      TRADE_HISTORY: `${this.CACHE_PREFIX}trade-history`,
      HEALTH: `${this.CACHE_PREFIX}health`
    };
    
    // Periodic cleanup of stale active fetches (safety mechanism)
    this.cleanupInterval = setInterval(() => {
      this._cleanupStaleFetches();
    }, 60000); // Run every minute
    
    logger.info('[KrakenCacheManager] Initialized with TTL:', this.cacheTTL + 's');
  }

  /**
   * Cleanup stale fetches that might be stuck
   */
  _cleanupStaleFetches() {
    const staleThreshold = 120000; // 2 minutes
    const now = Date.now();
    let cleaned = 0;
    
    for (const [dataType, promise] of this.activeFetches.entries()) {
      // Check if promise has a timestamp (would need to add this)
      // For now, just clear the map if it grows too large
      if (this.activeFetches.size > 10) {
        this.activeFetches.clear();
        logger.warn('[KrakenCacheManager] Cleared all active fetches due to size limit');
        break;
      }
    }
  }

  /**
   * Initialize the cache manager (validate connections only)
   */
  async initialize() {
    logger.info('[KrakenCacheManager] Initializing cache manager...');
    
    try {
      // Validate Redis connection
      const pingResult = await this.redis.ping();
      if (!pingResult) {
        throw new Error('Redis connection failed');
      }
      
      // Try to validate Kraken API connection, but don't fail on rate limits
      try {
        await this.kraken.getAccountBalance();
        logger.info('[KrakenCacheManager] Kraken API connection validated');
      } catch (krakenError) {
        if (krakenError.message.includes('Rate limit') || krakenError.message.includes('EAPI:Rate limit')) {
          logger.warn('[KrakenCacheManager] Rate limit during initialization, will retry on first cache miss');
          this.consecutiveFailures = 1; // Track but don't fail
        } else {
          logger.warn('[KrakenCacheManager] Kraken API validation failed, will retry on first cache miss:', krakenError.message);
          this.consecutiveFailures = 1;
        }
      }
      
      // Update health status
      await this.updateHealthStatus('initialized');
      
      logger.info('[KrakenCacheManager] Cache manager initialized successfully');
      
    } catch (error) {
      logger.error('[KrakenCacheManager] Failed to initialize manager:', error.message);
      throw error;
    }
  }

  /**
   * Fetch data from cache or Kraken API (cache-miss-driven)
   */
  async fetchWithCache(dataType, fetchFunction) {
    // Check if circuit breaker is open (atomic check and reset)
    if (this.circuitBreakerOpen) {
      const now = Date.now();
      const timeSinceOpen = now - this.lastCircuitBreakerOpen;
      
      if (timeSinceOpen > this.circuitBreakerResetTime) {
        // Use a mutex-like pattern to ensure only one reset happens
        if (this.circuitBreakerOpen) { // Double-check pattern
          logger.info('[KrakenCacheManager] Resetting circuit breaker');
          // Reset in atomic order to prevent race conditions
          this.consecutiveFailures = 0;
          this.circuitBreakerOpen = false;
        }
      } else {
        throw new Error(`Circuit breaker open for ${dataType}, API temporarily unavailable`);
      }
    }

    const cacheKey = this.KEYS[dataType.toUpperCase().replace('-', '_')];
    
    try {
      // Try to get from cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsedData = JSON.parse(cached);
        logger.debug(`[KrakenCacheManager] Cache hit for ${dataType}`);
        return {
          success: true,
          data: parsedData.data,
          timestamp: parsedData.timestamp,
          age: Date.now() - parsedData.timestamp,
          fromCache: true,
          source: 'redis-cache'
        };
      }
      
      // Cache miss - check if we're already fetching this data type
      if (this.activeFetches.has(dataType)) {
        logger.debug(`[KrakenCacheManager] Waiting for active fetch of ${dataType}`);
        return await this.activeFetches.get(dataType);
      }
      
      // Start fresh fetch
      logger.debug(`[KrakenCacheManager] Cache miss for ${dataType}, fetching from Kraken`);
      const fetchPromise = this.performFetch(dataType, fetchFunction, cacheKey);
      this.activeFetches.set(dataType, fetchPromise);
      
      try {
        const result = await fetchPromise;
        return result;
      } finally {
        // Always cleanup active fetches, even if promise is rejected
        this.activeFetches.delete(dataType);
      }
      
    } catch (error) {
      logger.error(`[KrakenCacheManager] Error fetching ${dataType}:`, error.message);
      return {
        success: false,
        error: error.message,
        dataType: dataType,
        source: 'kraken-api-error'
      };
    }
  }

  /**
   * Perform the actual fetch and cache operation
   */
  async performFetch(dataType, fetchFunction, cacheKey) {
    const startTime = Date.now();
    
    try {
      // Execute the fetch function
      const data = await fetchFunction();
      
      // Cache the result with TTL
      const cacheData = {
        data: data,
        timestamp: Date.now()
      };
      
      await this.redis.set(cacheKey, JSON.stringify(cacheData), { ex: this.cacheTTL });
      
      // Reset consecutive failures on success
      this.consecutiveFailures = 0;
      await this.updateHealthStatus('healthy');
      
      const duration = Date.now() - startTime;
      logger.debug(`[KrakenCacheManager] Fresh ${dataType} fetched and cached in ${duration}ms`);
      
      return {
        success: true,
        data: data,
        timestamp: cacheData.timestamp,
        age: 0,
        fromCache: false,
        fetchDuration: duration,
        source: 'kraken-api-fresh'
      };
      
    } catch (error) {
      this.consecutiveFailures++;
      logger.error(`[KrakenCacheManager] Failed to fetch ${dataType} (${this.consecutiveFailures}/${this.circuitBreakerThreshold}):`, error.message);
      
      // Update health status
      await this.updateHealthStatus('degraded', error.message);
      
      // Check if we should open circuit breaker
      if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
        this.circuitBreakerOpen = true;
        this.lastCircuitBreakerOpen = Date.now();
        logger.error('[KrakenCacheManager] Circuit breaker opened due to consecutive failures');
        await this.updateHealthStatus('circuit-breaker-open', `${this.consecutiveFailures} consecutive failures`);
      }
      
      throw error;
    }
  }

  /**
   * Get cached balance data (Redis Backend API style)
   */
  async getBalance() {
    try {
      const result = await this.fetchWithCache('balance', () => this.kraken.getAccountBalance());
      return {
        success: result.success,
        balance: result.data,
        metadata: {
          timestamp: result.timestamp,
          age: result.age,
          fromCache: result.fromCache,
          source: result.source
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        balance: null
      };
    }
  }

  /**
   * Get cached fees data (Redis Backend API style)
   */
  async getFees() {
    try {
      const result = await this.fetchWithCache('fees', () => this.kraken.getCurrentFees());
      return {
        success: result.success,
        fees: result.data,
        metadata: {
          timestamp: result.timestamp,
          age: result.age,
          fromCache: result.fromCache,
          source: result.source
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        fees: null
      };
    }
  }

  /**
   * Get cached open orders data (Redis Backend API style)
   */
  async getOpenOrders() {
    try {
      const result = await this.fetchWithCache('open-orders', () => this.kraken.getOpenOrders());
      return {
        success: result.success,
        orders: result.data,
        metadata: {
          timestamp: result.timestamp,
          age: result.age,
          fromCache: result.fromCache,
          source: result.source
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        orders: null
      };
    }
  }

  /**
   * Get cached trade history data (Redis Backend API style)
   */
  async getTradeHistory() {
    try {
      const result = await this.fetchWithCache('trade-history', () => {
        const since = Math.floor(Date.now() / 1000) - this.historyWindow;
        return this.kraken.getTradeHistory({ since });
      });
      return {
        success: result.success,
        trades: result.data,
        metadata: {
          timestamp: result.timestamp,
          age: result.age,
          fromCache: result.fromCache,
          source: result.source,
          sinceWindow: this.historyWindow
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        trades: null
      };
    }
  }

  /**
   * Update service health status
   */
  async updateHealthStatus(status, message = '') {
    try {
      const health = {
        status,
        message,
        timestamp: Date.now(),
        consecutiveFailures: this.consecutiveFailures,
        circuitBreakerOpen: this.circuitBreakerOpen,
        cacheTTL: this.cacheTTL
      };
      
      await this.redis.set(this.KEYS.HEALTH, JSON.stringify(health), { ex: 300 }); // 5 min expiry
    } catch (error) {
      logger.error('[KrakenCacheManager] Failed to update health status:', error.message);
    }
  }

  /**
   * Get service health status (Redis Backend API style)
   */
  async getHealth() {
    try {
      const healthData = await this.redis.get(this.KEYS.HEALTH);
      if (!healthData) {
        return {
          success: true,
          health: {
            status: 'unknown',
            message: 'No health data available',
            timestamp: Date.now()
          }
        };
      }
      
      return {
        success: true,
        health: JSON.parse(healthData)
      };
    } catch (error) {
      logger.error('[KrakenCacheManager] Failed to get health status:', error.message);
      return {
        success: false,
        error: error.message,
        health: {
          status: 'error',
          message: `Health check failed: ${error.message}`,
          timestamp: Date.now()
        }
      };
    }
  }

  /**
   * Clear all cached data (Redis Backend API style)
   */
  async clearCache() {
    try {
      const keys = Object.values(this.KEYS);
      const deleted = await this.redis.del(...keys);
      logger.info(`[KrakenCacheManager] Cleared ${deleted} cache keys`);
      return {
        success: true,
        clearedKeys: deleted,
        message: `Cleared ${deleted} cache keys`
      };
    } catch (error) {
      logger.error('[KrakenCacheManager] Failed to clear cache:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get cached ticker data (Redis Backend API style)
   */
  async getTicker(symbol) {
    try {
      const result = await this.fetchWithCache(`ticker_${symbol}`, () => this.kraken.getTicker(symbol));
      return {
        success: result.success,
        ticker: result.data,
        metadata: {
          timestamp: result.timestamp,
          age: result.age,
          fromCache: result.fromCache,
          source: result.source
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        ticker: null
      };
    }
  }

  /**
   * Get cache statistics (Redis Backend API style)
   */
  async getCacheStats() {
    try {
      const stats = {
        cacheTTL: this.cacheTTL,
        circuitBreakerOpen: this.circuitBreakerOpen,
        consecutiveFailures: this.consecutiveFailures,
        activeFetches: this.activeFetches.size,
        cacheKeys: {}
      };

      // Check each cache key status
      for (const [name, key] of Object.entries(this.KEYS)) {
        const exists = await this.redis.exists(key);
        const ttl = exists ? await this.redis.ttl(key) : -1;
        stats.cacheKeys[name.toLowerCase()] = {
          exists: !!exists,
          ttl: ttl,
          key: key
        };
      }

      return {
        success: true,
        stats: stats
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cleanup resources and intervals
   */
  async cleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clear any pending fetches
    this.activeFetches.clear();
    
    // Close Redis connection if needed
    if (this.redis && this.redis.disconnect) {
      await this.redis.disconnect();
    }
    
    logger.info('[KrakenCacheManager] Cleanup completed');
  }
}

// Factory function following Redis Backend API patterns
export function createKrakenCacheManager(options = {}) {
  return new KrakenCacheManager(options);
}

export default KrakenCacheManager;