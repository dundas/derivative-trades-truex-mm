import {
  SessionManager,
  OrderManager,
  FillManager,
  KeyGenerator,
  ValidationUtils
} from '../../lib/redis-backend-api/index.js';

/**
 * TrueX Redis Manager - Layer 2: Redis Persistence
 * 
 * Manages Redis persistence using existing redis-backend-api managers.
 * Provides batch flush operations for orders, fills, and OHLC data.
 * 
 * Performance targets:
 * - Write latency: 10-50ms (network + Redis write)
 * - Batch size: 100 records per flush
 * - Flush frequency: Every 1 second
 */
export class TrueXRedisManager {
  constructor(options = {}) {
    const { sessionId, symbol, redisClient, logger } = options;
    
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    
    if (!symbol) {
      throw new Error('symbol is required');
    }
    
    if (!redisClient) {
      throw new Error('redisClient is required');
    }
    
    this.sessionId = sessionId;
    this.symbol = symbol;
    this.redisClient = redisClient;
    this.logger = logger || console;
    
    // Initialize KeyGenerator for consistent key patterns
    this.keyGenerator = new KeyGenerator({
      exchange: 'truex',
      symbol: symbol,
      strategy: 'adaptive',
      sessionId: sessionId
    });
    
    // Initialize ValidationUtils
    this.validationUtils = new ValidationUtils();
    
    // Initialize redis-backend-api managers
    this.sessionManager = new SessionManager({
      redis: redisClient,
      sessionId: sessionId,
      logger: logger,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils,
      enableCaching: false  // No caching at Redis layer for TrueX
    });
    
    this.orderManager = new OrderManager({
      redis: redisClient,
      sessionId: sessionId,
      logger: logger,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils,
      enableCaching: false
    });
    
    this.fillManager = new FillManager({
      redis: redisClient,
      sessionId: sessionId,
      logger: logger,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils,
      enableCaching: false
    });
    
    // OHLC data will be stored using custom keys
    // Format: adaptive:truex:btc-usd:${sessionId}:ohlc:${interval}:${timestamp}
    // Prefer generateCustomKey if available (newer API), otherwise fallback to generateKey
    if (typeof this.keyGenerator.generateCustomKey === 'function') {
      this.ohlcKeyPrefix = this.keyGenerator.generateCustomKey('ohlc');
    } else if (typeof this.keyGenerator.generateKey === 'function') {
      this.ohlcKeyPrefix = this.keyGenerator.generateKey('ohlc');
    } else {
      // Last-resort fallback; keep a sane default
      this.ohlcKeyPrefix = `adaptive:truex:${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${sessionId}:ohlc`;
    }
    
    // L2 snapshot key prefix
    if (typeof this.keyGenerator.generateCustomKey === 'function') {
      this.l2KeyPrefix = this.keyGenerator.generateCustomKey('l2');
    } else if (typeof this.keyGenerator.generateKey === 'function') {
      this.l2KeyPrefix = this.keyGenerator.generateKey('l2');
    } else {
      this.l2KeyPrefix = `adaptive:truex:${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${sessionId}:l2`;
    }

    // Dedup prefix for execID reservations (requires keyGenerator)
    if (typeof this.keyGenerator.generateCustomKey === 'function') {
      this.dedupKeyPrefix = this.keyGenerator.generateCustomKey('dedup');
    } else if (typeof this.keyGenerator.generateKey === 'function') {
      this.dedupKeyPrefix = this.keyGenerator.generateKey('dedup');
    } else {
      this.dedupKeyPrefix = `adaptive:truex:${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${sessionId}:dedup`;
    }
    
    // Statistics
    this.stats = {
      ordersFlushed: 0,
      fillsFlushed: 0,
      ohlcFlushed: 0,
      flushErrors: 0,
      lastFlushTime: 0,
      fillsDedupSkipped: 0
    };
  }
  
  /**
   * Flush orders to Redis in batch
   */
  async flushOrders(orders) {
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
    
    if (!orders || orders.length === 0) {
      return results;
    }
    
    this.logger.debug(`[TrueXRedisManager] Flushing ${orders.length} orders to Redis`);
    
    for (const order of orders) {
      try {
        // Basic validation
        if (!order || !order.orderId || !order.symbol || !order.sessionId) {
          this.logger.warn('[TrueXRedisManager] Skipping invalid order (missing orderId/symbol/sessionId)');
          results.skipped++;
          continue;
        }
        // Prepare order data for Redis
        const orderData = {
          // Required by redis-backend-api OrderManager.validateOrderData
          id: order.orderId,
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          exchangeOrderId: order.exchangeOrderId,
          sessionId: order.sessionId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          size: order.size,
          price: order.price,
          status: order.status,
          filledSize: order.filledSize || 0,
          remainingSize: order.remainingSize,
          avgFillPrice: order.avgFillPrice,
          createdAt: order.createdAt,
          sentAt: order.sentAt,
          acknowledgedAt: order.acknowledgedAt,
          updatedAt: order.updatedAt,
          filledAt: order.filledAt,
          cancelledAt: order.cancelledAt,
          msgSeqNum: order.msgSeqNum,
          data: {
            originalFIXMessage: order.data?.originalFIXMessage,
            allFIXMessages: order.data?.allFIXMessages || [],
            execReports: order.execReports || [],
            truexMetadata: {
              senderCompID: order.data?.truexMetadata?.senderCompID,
              targetCompID: order.data?.truexMetadata?.targetCompID,
              msgSeqNum: order.msgSeqNum
            }
          }
        };
        
        await this.orderManager.add(orderData);
        results.success++;
        this.stats.ordersFlushed++;
      } catch (error) {
        this.logger.error(`[TrueXRedisManager] Failed to flush order ${order.orderId}:`, error.message);
        results.failed++;
        results.errors.push({ orderId: order.orderId, error: error.message });
        this.stats.flushErrors++;
      }
    }
    
    this.stats.lastFlushTime = Date.now();
    this.logger.info(`[TrueXRedisManager] Orders flushed: ${results.success} success, ${results.failed} failed`);
    
    return results;
  }

  // Try to reserve an execID using Redis NX semantics; returns true if reserved, false if exists or unsupported
  async tryReserveExecId(execID, ttlSeconds = 86400) {
    try {
      const key = `${this.dedupKeyPrefix}:exec:${execID}`;
      if (typeof this.redisClient.set === 'function') {
        // Upstash/node-redis style: set(key, value, { NX: true, EX: ttl }) returns 'OK' or null
        const res = await this.redisClient.set(key, '1', { NX: true, EX: ttlSeconds });
        return !!res; // truthy on success
      }
      if (typeof this.redisClient.setnx === 'function') {
        // Legacy style: setnx returns 1 on success, 0 on exists
        const res = await this.redisClient.setnx(key, '1');
        if (res === 1 && typeof this.redisClient.expire === 'function') {
          await this.redisClient.expire(key, ttlSeconds);
        }
        return res === 1;
      }
      // If no NX support, cannot guarantee cross-instance dedup
      return true; // allow write to proceed rather than block
    } catch (e) {
      this.logger.warn(`[TrueXRedisManager] execID reservation failed for ${execID}: ${e.message}`);
      return true; // fail-open to avoid data loss
    }
  }
  
  /**
   * Flush fills to Redis in batch with deduplication
   */
  async flushFills(fills) {
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
    
    if (!fills || fills.length === 0) {
      return results;
    }
    
    this.logger.debug(`[TrueXRedisManager] Flushing ${fills.length} fills to Redis`);
    
    for (const fill of fills) {
      try {
        // Basic validation
        if (!fill || !fill.fillId || !fill.execID || !fill.orderId || !fill.sessionId) {
          this.logger.warn('[TrueXRedisManager] Skipping invalid fill (missing fillId/execID/orderId/sessionId)');
          results.skipped++;
          continue;
        }
        // Redis-side dedup via execID reservation (cross-instance safety)
        const reserved = await this.tryReserveExecId(fill.execID);
        if (!reserved) {
          this.logger.warn(`[TrueXRedisManager] Duplicate fill execID detected, skipping: ${fill.execID}`);
          results.skipped++;
          this.stats.fillsDedupSkipped++;
          continue;
        }
        
        // Prepare fill data for Redis
        const fillData = {
          // Required by redis-backend-api ValidationUtils.validateFillData
          id: fill.fillId,
          fillId: fill.fillId,
          execID: fill.execID,
          orderId: fill.orderId,
          exchangeOrderId: fill.exchangeOrderId,
          sessionId: fill.sessionId,
          symbol: fill.symbol,
          side: fill.side,
          quantity: fill.quantity,
          // Standardize size for validation convenience
          size: fill.quantity,
          price: fill.price,
          fee: fill.fee || 0,
          feeAsset: fill.feeAsset,
          total: fill.total,
          netTotal: fill.netTotal,
          timestamp: fill.timestamp,
          receivedAt: fill.receivedAt,
          execType: fill.execType,
          ordStatus: fill.ordStatus,
          data: {
            executionReport: fill.data?.executionReport,
            originalFIXMessage: fill.data?.originalFIXMessage
          },
          source: fill.source,
          deduplicationKey: fill.deduplicationKey || `${fill.sessionId}_${fill.execID}`
        };
        
        await this.fillManager.add(fillData);
        results.success++;
        this.stats.fillsFlushed++;
      } catch (error) {
        this.logger.error(`[TrueXRedisManager] Failed to flush fill ${fill.fillId}:`, error.message);
        results.failed++;
        results.errors.push({ fillId: fill.fillId, error: error.message });
        this.stats.flushErrors++;
      }
    }
    
    this.stats.lastFlushTime = Date.now();
    this.logger.info(`[TrueXRedisManager] Fills flushed: ${results.success} success, ${results.failed} failed`);
    
    return results;
  }
  
  /**
   * Flush OHLC candles to Redis
   */
  async flushOHLC(candles) {
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
    
    if (!candles || candles.length === 0) {
      return results;
    }
    
    this.logger.debug(`[TrueXRedisManager] Flushing ${candles.length} OHLC candles to Redis`);
    
    for (const candle of candles) {
      try {
        // Basic validation
        if (!candle || !candle.symbol || !candle.interval || !candle.timestamp) {
          this.logger.warn('[TrueXRedisManager] Skipping invalid OHLC candle (missing symbol/interval/timestamp)');
          results.skipped++;
          continue;
        }
        // Generate OHLC key: adaptive:truex:btc-usd:${sessionId}:ohlc:${interval}:${timestamp}
        const key = `${this.ohlcKeyPrefix}:${candle.interval}:${candle.timestamp}`;
        
        const ohlcData = {
          symbol: candle.symbol,
          exchange: 'truex',
          interval: candle.interval,
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          source: candle.source,
          tradeCount: candle.tradeCount,
          isComplete: candle.isComplete,
          data: candle.data || {}
        };
        
        // Store as hash in Redis
        await this.redisClient.hset(key, ohlcData);
        
        // Set expiration (optional - keep for session duration + buffer)
        await this.redisClient.expire(key, 86400); // 24 hours
        
        // Maintain an index list of keys to avoid KEYS/SCAN in restricted environments
        const indexKey = `${this.ohlcKeyPrefix}:${candle.interval}:index`;
        if (typeof this.redisClient.lpush === 'function') {
          try {
            await this.redisClient.lpush(indexKey, key);
          } catch (e) {
            this.logger.warn(`[TrueXRedisManager] Failed to update OHLC index list: ${e.message}`);
          }
        }
        
        results.success++;
        this.stats.ohlcFlushed++;
      } catch (error) {
        this.logger.error(`[TrueXRedisManager] Failed to flush OHLC candle:`, error.message);
        results.failed++;
        results.errors.push({ timestamp: candle.timestamp, error: error.message });
        this.stats.flushErrors++;
      }
    }
    
    this.stats.lastFlushTime = Date.now();
    this.logger.info(`[TrueXRedisManager] OHLC flushed: ${results.success} success, ${results.failed} failed`);
    
    return results;
  }
  
  /**
   * Update session data in Redis
   */
  async updateSession(updates) {
    try {
      await this.sessionManager.update(updates);
      this.logger.debug(`[TrueXRedisManager] Session updated`);
      return { success: true };
    } catch (error) {
      this.logger.error(`[TrueXRedisManager] Failed to update session:`, error.message);
      this.stats.flushErrors++;
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get all orders from Redis
   */
  async getAllOrders() {
    try {
      return await this.orderManager.getAll();
    } catch (error) {
      this.logger.error(`[TrueXRedisManager] Failed to get orders:`, error.message);
      return [];
    }
  }
  
  /**
   * Get all fills from Redis
   */
  async getAllFills() {
    try {
      return await this.fillManager.getAll();
    } catch (error) {
      this.logger.error(`[TrueXRedisManager] Failed to get fills:`, error.message);
      return [];
    }
  }
  
  /**
   * Get OHLC candles from Redis for a specific interval
   */
  async getOHLCCandles(interval, startTime, endTime) {
    try {
      const pattern = `${this.ohlcKeyPrefix}:${interval}:*`;
      let keys = [];
      
      // Prefer index list to avoid KEYS/SCAN
      const indexKey = `${this.ohlcKeyPrefix}:${interval}:index`;
      if (typeof this.redisClient.lrange === 'function') {
        try {
          const indexed = await this.redisClient.lrange(indexKey, 0, -1);
          if (Array.isArray(indexed) && indexed.length > 0) {
            keys = indexed;
          }
        } catch (e) {
          this.logger.warn(`[TrueXRedisManager] Failed to read OHLC index list: ${e.message}`);
        }
      }
      
      // Fallbacks
      if (keys.length === 0) {
        if (typeof this.redisClient.scanKeys === 'function') {
          keys = await this.redisClient.scanKeys(pattern, 1000);
        } else if (typeof this.redisClient.keys === 'function') {
          keys = await this.redisClient.keys(pattern);
        }
      }
      
      const candles = [];
      for (const key of keys) {
        const data = await this.redisClient.hgetall(key);
        
        // Filter by time range if specified
        if (startTime && data.timestamp < startTime) continue;
        if (endTime && data.timestamp > endTime) continue;
        
        candles.push(data);
      }
      
      // Sort by timestamp
      candles.sort((a, b) => a.timestamp - b.timestamp);
      
      return candles;
    } catch (error) {
      this.logger.error(`[TrueXRedisManager] Failed to get OHLC candles:`, error.message);
      return [];
    }
  }
  
  /**
   * Publish L2 order book snapshot to Redis
   * Stores a hash at l2:<depth>:<ts> and optionally updates an index list
   */
  async flushL2Snapshot(depthSnapshot, depth = 10) {
    try {
      if (!depthSnapshot || !Array.isArray(depthSnapshot.bids) || !Array.isArray(depthSnapshot.asks)) {
        this.logger.warn('[TrueXRedisManager] Invalid L2 snapshot payload');
        return { success: false, error: 'invalid payload' };
      }

      const ts = depthSnapshot.ts || Date.now();
      const key = `${this.l2KeyPrefix}:depth${depth}:${ts}`;

      // Serialize bids/asks as JSON strings for hash fields
      const payload = {
        symbol: this.symbol,
        depth,
        ts,
        bids: JSON.stringify(depthSnapshot.bids),
        asks: JSON.stringify(depthSnapshot.asks)
      };

      await this.redisClient.hset(key, payload);
      await this.redisClient.expire(key, 3600); // 1 hour retention for L2

      const indexKey = `${this.l2KeyPrefix}:depth${depth}:index`;
      if (typeof this.redisClient.lpush === 'function') {
        try {
          await this.redisClient.lpush(indexKey, key);
          // Trim list to last 600 entries (~10 minutes at 1s cadence)
          if (typeof this.redisClient.ltrim === 'function') {
            await this.redisClient.ltrim(indexKey, 0, 599);
          }
        } catch (e) {
          this.logger.warn(`[TrueXRedisManager] Failed to update L2 index list: ${e.message}`);
        }
      }

      return { success: true, key };
    } catch (error) {
      this.logger.error('[TrueXRedisManager] Failed to flush L2 snapshot:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      sessionId: this.sessionId,
      symbol: this.symbol
    };
  }
  
  /**
   * Close Redis connection (if needed)
   */
  async close() {
    // Redis client is managed externally, so we don't close it here
    this.logger.info('[TrueXRedisManager] Manager closed');
  }
}
