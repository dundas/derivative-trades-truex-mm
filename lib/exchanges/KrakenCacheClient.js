/**
 * Kraken Cache Client
 * 
 * A shared client that other services can use to access cached Kraken data
 * instead of making direct API calls. This prevents rate limiting and timeouts.
 * 
 * Features:
 * - Provides cached open orders, closed orders, and trades
 * - Fallback to direct API calls if cache is unavailable
 * - Data freshness indicators
 * - Automatic retry logic
 * 
 * Usage:
 * const client = new KrakenCacheClient();
 * await client.initialize();
 * const openOrders = await client.getOpenOrders();
 */

import { RedisClient } from '../utils/redis-client.js';
import { KrakenRESTClient } from './KrakenRESTClient.js';
import { createLogger } from '../../services/market-maker/utils/logger-factory.js';

export class KrakenCacheClient {
  constructor(options = {}) {
    this.options = options;
    this.logger = options.logger || createLogger('kraken-cache-client');
    
    // Redis connection
    this.redis = null;
    
    // Fallback Kraken API client
    this.fallbackClient = null;
    this.useFallback = options.useFallback !== false; // Default: enabled
    
    // Redis keys (must match KrakenDataReconciler)
    this.redisKeys = {
      openOrders: 'kraken:cache:open-orders',
      closedOrders: 'kraken:cache:closed-orders',
      trades: 'kraken:cache:trades',
      lastUpdate: 'kraken:cache:last-update',
      stats: 'kraken:cache:stats'
    };
    
    // Cache configuration
    // Default max age to 60s; allow override via options or env KRAKEN_CACHE_MAX_AGE_MS
    const envMaxAge = process.env.KRAKEN_CACHE_MAX_AGE_MS ? parseInt(process.env.KRAKEN_CACHE_MAX_AGE_MS, 10) : undefined;
    this.maxCacheAge = options.maxCacheAge || envMaxAge || 60000; // 60 seconds default
    // Write-through TTL for Redis keys (seconds). Default 60s; override via env KRAKEN_CACHE_TTL_SECONDS or options.cacheTTLSeconds
    const envTtl = process.env.KRAKEN_CACHE_TTL_SECONDS ? parseInt(process.env.KRAKEN_CACHE_TTL_SECONDS, 10) : undefined;
    this.cacheTTLSeconds = options.cacheTTLSeconds || envTtl || 60;
    this.fallbackTimeout = options.fallbackTimeout || 30000; // 30 second API timeout
    
    // Statistics
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      fallbackCalls: 0,
      errors: 0
    };
  }
  
  /**
   * Initialize the cache client
   */
  async initialize() {
    try {
      this.logger.info('🚀 Initializing Kraken Cache Client...');
      
      // Initialize Redis connection
      this.redis = new RedisClient({
        debug: false
      });
      
      // Test Redis connection
      const testKey = `kraken:cache:test:${Date.now()}`;
      await this.redis.set(testKey, 'test', 'EX', 5);
      const testValue = await this.redis.get(testKey);
      await this.redis.del(testKey);
      
      if (testValue !== 'test') {
        throw new Error('Redis connection test failed');
      }
      
      // Initialize fallback client if enabled
      if (this.useFallback) {
        this.fallbackClient = new KrakenRESTClient({
          apiKey: process.env.KRAKEN_API_KEY,
          apiSecret: process.env.KRAKEN_API_SECRET
        });
        this.logger.info('✅ Fallback API client initialized');
      }
      
      this.logger.info('✅ Kraken Cache Client initialized successfully');
      
    } catch (error) {
      this.logger.error('❌ Failed to initialize Kraken Cache Client:', error);
      throw error;
    }
  }
  
  /**
   * Get open orders from cache or fallback to API
   */
  async getOpenOrders() {
    return await this._getCachedDataWithFallback('openOrders', async () => {
      if (!this.fallbackClient) {
        throw new Error('Fallback API client not available');
      }
      const result = await this.fallbackClient.getOpenOrders();
      return {
        data: result,
        source: 'api-fallback',
        timestamp: Date.now(),
        count: Object.keys(result.open || {}).length
      };
    });
  }
  
  /**
   * Get closed orders from cache or fallback to API
   */
  async getClosedOrders(options = {}) {
    const startTime = options.start || (Math.floor(Date.now() / 1000) - (24 * 3600)); // Default: last 24h
    
    return await this._getCachedDataWithFallback('closedOrders', async () => {
      if (!this.fallbackClient) {
        throw new Error('Fallback API client not available');
      }
      const result = await this.fallbackClient.getClosedOrders({ start: startTime });
      return {
        data: result,
        source: 'api-fallback',
        timestamp: Date.now(),
        count: Object.keys(result.closed || {}).length,
        startTime: startTime
      };
    });
  }
  
  /**
   * Find specific orders by their IDs from cached data
   * This replaces the getOrdersInfo method for cache-based lookups
   * @param {Array} orderIds - Array of Kraken order IDs to find
   * @returns {Object} Object with order ID as key and order info as value
   */
  async findOrdersByIds(orderIds) {
    try {
      // First try to find orders in open orders cache
      const openOrdersData = await this.getOpenOrders();
      const foundOrders = {};
      
      if (openOrdersData.success && openOrdersData.data && openOrdersData.data.open) {
        for (const orderId of orderIds) {
          if (openOrdersData.data.open[orderId]) {
            foundOrders[orderId] = openOrdersData.data.open[orderId];
          }
        }
      }
      
      // For orders not found in open orders, search closed orders cache
      const remainingOrderIds = orderIds.filter(id => !foundOrders[id]);
      if (remainingOrderIds.length > 0) {
        const closedOrdersData = await this.getClosedOrders();
        if (closedOrdersData.success && closedOrdersData.data && closedOrdersData.data.closed) {
          for (const orderId of remainingOrderIds) {
            if (closedOrdersData.data.closed[orderId]) {
              foundOrders[orderId] = closedOrdersData.data.closed[orderId];
            }
          }
        }
      }
      
      // Log cache performance
      const foundCount = Object.keys(foundOrders).length;
      const totalRequested = orderIds.length;
      this.logger.debug(`Found ${foundCount}/${totalRequested} orders in cache (${Math.round(foundCount/totalRequested*100)}% hit rate)`);
      
      return foundOrders;
      
    } catch (error) {
      this.logger.error('Error finding orders by IDs:', error);
      
      // Fallback to direct API call if cache fails and fallback is enabled
      if (this.useFallback && this.fallbackClient) {
        this.logger.warn('Cache lookup failed, falling back to direct API call for order lookup');
        try {
          return await this.fallbackClient.getOrdersInfo(orderIds);
        } catch (fallbackError) {
          this.logger.error('Fallback API call also failed:', fallbackError);
          return {};
        }
      }
      
      return {};
    }
  }

  /**
   * Get trades from cache or fallback to API
   */
  async getTradesHistory(options = {}) {
    const startTime = options.start || (Math.floor(Date.now() / 1000) - (24 * 3600)); // Default: last 24h
    
    return await this._getCachedDataWithFallback('trades', async () => {
      if (!this.fallbackClient) {
        throw new Error('Fallback API client not available');
      }
      const result = await this.fallbackClient.getTradeHistory({ start: startTime });
      return {
        data: result,
        source: 'api-fallback',
        timestamp: Date.now(),
        count: Object.keys(result.trades || {}).length,
        startTime: startTime
      };
    });
  }
  
  /**
   * Generic method to get cached data with fallback
   * @private
   */
  async _getCachedDataWithFallback(dataType, fallbackFn) {
    try {
      // Try to get from cache first
      const cachedData = await this._getCachedData(dataType);
      
      if (cachedData.success && !cachedData.isStale) {
        this.stats.cacheHits++;
        this.logger.debug(`✅ Cache hit for ${dataType} (age: ${Math.round(cachedData.age/1000)}s)`);
        return cachedData;
      }
      
      // Cache miss or stale data
      this.stats.cacheMisses++;
      
      if (cachedData.success && cachedData.isStale) {
        this.logger.warn(`⚠️ Cached ${dataType} is stale (age: ${Math.round(cachedData.age/1000)}s), trying fallback...`);
      } else {
        this.logger.warn(`❌ Cache miss for ${dataType}, trying fallback...`);
      }
      
      // Try fallback API if enabled
      if (this.useFallback && fallbackFn) {
        try {
          this.stats.fallbackCalls++;
          const fallbackData = await Promise.race([
            fallbackFn(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Fallback API timeout')), this.fallbackTimeout)
            )
          ]);
          
          this.logger.info(`✅ Fallback API success for ${dataType}`);

          // Ensure timestamp exists on the blob we cache
          const cacheBlob = {
            ...fallbackData,
            timestamp: fallbackData.timestamp || Date.now(),
            source: fallbackData.source || 'api-fallback'
          };

          // Persist to Redis with TTL so subsequent calls use cache
          try {
            const redisKey = this.redisKeys[dataType];
            if (!redisKey) throw new Error(`Invalid data type for caching: ${dataType}`);
            await this.redis.set(redisKey, JSON.stringify(cacheBlob), { ex: this.cacheTTLSeconds });
            this.logger.debug(`💾 Cached ${dataType} to Redis with TTL ${this.cacheTTLSeconds}s`);
          } catch (persistErr) {
            this.logger.warn(`⚠️ Failed to persist ${dataType} to Redis cache: ${persistErr.message}`);
          }

          return {
            ...cacheBlob,
            success: true,
            age: 0,
            isStale: false,
            fallbackUsed: true
          };
          
        } catch (fallbackError) {
          this.stats.errors++;
          this.logger.error(`❌ Fallback API failed for ${dataType}:`, fallbackError.message);
          
          // If we have stale cached data, return it as last resort
          if (cachedData.success && cachedData.isStale) {
            this.logger.warn(`🔄 Returning stale cached data for ${dataType} as last resort`);
            return {
              ...cachedData,
              fallbackFailed: true,
              fallbackError: fallbackError.message
            };
          }
          
          throw fallbackError;
        }
      }
      
      // No fallback available, return stale data if we have it
      if (cachedData.success && cachedData.isStale) {
        this.logger.warn(`🔄 Returning stale cached data for ${dataType} (no fallback available)`);
        return cachedData;
      }
      
      // No data available at all
      throw new Error(`No cached data available for ${dataType} and fallback is disabled or failed`);
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`❌ Failed to get ${dataType}:`, error);
      throw error;
    }
  }
  
  /**
   * Get cached data from Redis
   * @private
   */
  async _getCachedData(dataType) {
    try {
      const redisKey = this.redisKeys[dataType];
      if (!redisKey) {
        throw new Error(`Invalid data type: ${dataType}`);
      }
      
      const cachedData = await this.redis.get(redisKey);
      
      if (!cachedData) {
        return {
          success: false,
          error: 'No cached data available',
          timestamp: null
        };
      }
      
      const parsedData = JSON.parse(cachedData);
      
      // Check data freshness
      const age = Date.now() - parsedData.timestamp;
      const isStale = age > this.maxCacheAge;
      
      return {
        ...parsedData,
        age: age,
        isStale: isStale,
        success: true
      };
      
    } catch (error) {
      this.logger.error(`❌ Failed to get cached ${dataType}:`, error);
      return {
        success: false,
        error: error.message,
        timestamp: null
      };
    }
  }
  
  /**
   * Check if the cache reconciler service is running
   */
  async checkReconcilerStatus() {
    try {
      const lastUpdate = await this.redis.get(this.redisKeys.lastUpdate);
      
      if (!lastUpdate) {
        return {
          isRunning: false,
          error: 'No reconciler activity detected',
          lastUpdate: null
        };
      }
      
      const updateData = JSON.parse(lastUpdate);
      const timeSinceLastUpdate = Date.now() - updateData.timestamp;
      const isRunning = timeSinceLastUpdate < 300000; // Consider running if updated within 5 minutes
      
      return {
        isRunning: isRunning,
        lastUpdate: updateData.timestamp,
        timeSinceLastUpdate: timeSinceLastUpdate,
        lastUpdateData: updateData
      };
      
    } catch (error) {
      this.logger.error('❌ Failed to check reconciler status:', error);
      return {
        isRunning: false,
        error: error.message,
        lastUpdate: null
      };
    }
  }
  
  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const statsData = await this.redis.get(this.redisKeys.stats);
      const reconcilerStats = statsData ? JSON.parse(statsData) : null;
      
      return {
        client: this.stats,
        reconciler: reconcilerStats,
        reconcilerStatus: await this.checkReconcilerStatus()
      };
      
    } catch (error) {
      this.logger.error('❌ Failed to get cache statistics:', error);
      return {
        client: this.stats,
        reconciler: null,
        error: error.message
      };
    }
  }
  
  /**
   * Get local client statistics (synchronous)
   */
  getStats() {
    const totalCalls = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalCalls > 0 ? Math.round((this.stats.cacheHits / totalCalls) * 100) : 0;
    
    return {
      ...this.stats,
      totalCalls,
      hitRate
    };
  }

  /**
   * Close the cache client
   */
  async close() {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}