import { EventEmitter } from 'events';
import { TrueXDataManager } from './truex-data-manager.js';
import { TrueXRedisManager } from './truex-redis-manager.js';
import { TrueXPostgreSQLManager } from './truex-postgresql-manager.js';
import { AuditLogger } from './audit-logger.js';

/**
 * DataPipelineManager - Orchestrates the 3-tier data pipeline lifecycle.
 *
 * Tiers:
 *   Layer 0: AuditLogger (append-only JSONL, synchronous writes)
 *   Layer 1: TrueXDataManager (in-memory cache, <1ms)
 *   Layer 2: TrueXRedisManager (Redis persistence, flushed every 1s)
 *   Layer 3: TrueXPostgreSQLManager (PG analytics, migrated every 5min)
 *
 * Events: 'flush-complete', 'migration-complete', 'error'
 */
export class DataPipelineManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.sessionId = options.sessionId;
    this.symbol = options.symbol || 'BTC-PYUSD';
    this.logger = options.logger || console;

    // --- Timer configuration ---
    this.redisFlushIntervalMs = options.redisFlushIntervalMs || 1000;
    this.pgMigrationIntervalMs = options.pgMigrationIntervalMs || 300000; // 5 min
    this.cleanupIntervalMs = options.cleanupIntervalMs || 1800000; // 30 min
    this.maxBatchSize = options.maxBatchSize || 100;

    // --- Layer 0: Audit Logger ---
    this.auditLogger = options.auditLogger || new AuditLogger({
      logDir: options.auditLogDir || './logs/truex-audit',
      logger: this.logger,
    });

    // --- Layer 1: Memory Cache ---
    this.dataManager = options.dataManager || new TrueXDataManager({
      logger: this.logger,
    });

    // --- Layer 2: Redis (optional — graceful degradation without it) ---
    this.redisManager = options.redisManager || null;
    this.redisUrl = options.redisUrl || null;

    // --- Layer 3: PostgreSQL (optional — graceful degradation without it) ---
    // Only auto-connects if pgUrl is provided and no pgManager injected
    this.pgManager = options.pgManager || null;
    this.pgUrl = options.pgUrl || null;
    this.pgSslCa = options.pgSslCa;
    this.referenceQueryOptions = options.referenceQueryOptions || null;

    // --- Timer configuration (direct PG flush when Redis unavailable) ---
    this.pgFlushIntervalMs = options.pgFlushIntervalMs || 5000; // 5s direct PG flush

    // --- State ---
    this.isRunning = false;
    this._flushTimer = null;
    this._pgFlushTimer = null;
    this._migrationTimer = null;
    this._cleanupTimer = null;

    // --- Statistics ---
    this.stats = {
      flushCycles: 0,
      pgFlushCycles: 0,
      migrationCycles: 0,
      cleanupCycles: 0,
      flushErrors: 0,
      pgFlushErrors: 0,
      migrationErrors: 0,
      lastFlushTime: 0,
      lastPgFlushTime: 0,
      lastMigrationTime: 0,
      lastCleanupTime: 0,
    };
  }

  /**
   * Start the pipeline: connect Redis/PG (if configured), start timers.
   */
  async start() {
    if (this.isRunning) return;

    this.logger.info('[DataPipeline] Starting data pipeline...');

    // Connect Redis if URL provided but no manager injected
    if (!this.redisManager && this.redisUrl) {
      try {
        const Redis = (await import('ioredis')).default;
        const redisClient = new Redis(this.redisUrl, {
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null, // Don't retry during health check
        });

        // Verify Redis is actually reachable (ioredis uses lazy connect)
        const pong = await Promise.race([
          redisClient.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis PING timeout')), 5000)),
        ]);
        if (pong !== 'PONG') throw new Error(`Unexpected Redis PING response: ${pong}`);

        this.redisManager = new TrueXRedisManager({
          sessionId: this.sessionId,
          symbol: this.symbol,
          redisClient,
          logger: this.logger,
        });
        this.logger.info('[DataPipeline] Redis connected and verified');
      } catch (err) {
        this.logger.warn(`[DataPipeline] Redis unavailable (non-fatal): ${err.message}`);
        this.redisManager = null;
      }
    }

    // Connect PG if not injected but pgUrl is configured
    if (!this.pgManager && this.pgUrl) {
      try {
        this.pgManager = new TrueXPostgreSQLManager({
          logger: this.logger, pgUrl: this.pgUrl,
          sslCa: this.pgSslCa,
          referenceQueryOptions: this.referenceQueryOptions,
        });
        await this.pgManager.initialize();
        this.logger.info('[DataPipeline] PostgreSQL connected');
      } catch (err) {
        this.logger.warn(`[DataPipeline] PostgreSQL connection failed (non-fatal): ${err.message}`);
        this.pgManager = null;
      }
    }

    // Start timers
    if (this.redisManager) {
      this._flushTimer = setInterval(() => this._flushToRedis(), this.redisFlushIntervalMs);
    }

    if (this.pgManager && this.redisManager) {
      // Full path: Memory → Redis → PG
      this._migrationTimer = setInterval(() => this._migrateToPostgres(), this.pgMigrationIntervalMs);
    } else if (this.pgManager && !this.redisManager) {
      // Direct path: Memory → PG (when Redis unavailable)
      this._pgFlushTimer = setInterval(() => this._flushToPostgres(), this.pgFlushIntervalMs);
      this.logger.info('[DataPipeline] Using direct Memory → PostgreSQL flush (no Redis)');
    }

    this._cleanupTimer = setInterval(() => this._cleanupMemory(), this.cleanupIntervalMs);

    // Save initial session record to PG
    if (this.pgManager) {
      this._saveSessionToPostgres('running').catch(err => {
        this.logger.warn(`[DataPipeline] Session save failed (non-fatal): ${err.message}`);
      });
    }

    this.isRunning = true;
    this.logger.info('[DataPipeline] Data pipeline started');
  }

  /**
   * Stop the pipeline: final flush, stop timers, disconnect.
   */
  async stop() {
    if (!this.isRunning) return;

    this.logger.info('[DataPipeline] Stopping data pipeline...');

    // Stop timers
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    if (this._pgFlushTimer) { clearInterval(this._pgFlushTimer); this._pgFlushTimer = null; }
    if (this._migrationTimer) { clearInterval(this._migrationTimer); this._migrationTimer = null; }
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }

    // Final flush to Redis
    if (this.redisManager) {
      try {
        await this._flushToRedis();
      } catch (err) {
        this.logger.error(`[DataPipeline] Final Redis flush failed: ${err.message}`);
      }
    }

    // Final migration/flush to PG
    if (this.pgManager && this.redisManager) {
      try {
        await this._migrateToPostgres();
      } catch (err) {
        this.logger.error(`[DataPipeline] Final PG migration failed: ${err.message}`);
      }
    } else if (this.pgManager) {
      try {
        await this._flushToPostgres();
      } catch (err) {
        this.logger.error(`[DataPipeline] Final PG flush failed: ${err.message}`);
      }
    }

    // Update session record with final status
    if (this.pgManager) {
      try {
        await this._saveSessionToPostgres('stopped');
      } catch (err) {
        this.logger.warn(`[DataPipeline] Session final save failed: ${err.message}`);
      }
    }

    this.isRunning = false;
    this.logger.info('[DataPipeline] Data pipeline stopped');
  }

  /**
   * Add a fill event — routes to memory cache + audit log.
   */
  addFill(fill) {
    // Audit log (synchronous, durable)
    if (this.auditLogger) {
      this.auditLogger.logFillEvent(fill);
    }

    // Memory cache (queues for Redis flush)
    try {
      this.dataManager.addFill(fill);
    } catch (err) {
      // Duplicate fill or validation error — not critical
      this.logger.debug(`[DataPipeline] Fill not added to memory: ${err.message}`);
    }
  }

  /**
   * Add an order event — routes to memory cache.
   */
  addOrder(order) {
    this.dataManager.addOrder(order);
  }

  /**
   * Update an order — routes to memory cache.
   */
  updateOrder(orderId, updates) {
    return this.dataManager.updateOrder(orderId, updates);
  }

  /**
   * Log a FIX message — routes to audit logger.
   */
  logFIXMessage(message, metadata = {}) {
    if (this.auditLogger) {
      this.auditLogger.logFIXMessage(message, metadata);
    }
  }

  /**
   * Log an error — routes to audit logger.
   */
  logError(error, context = {}) {
    if (this.auditLogger) {
      this.auditLogger.logError(error, context);
    }
  }

  /**
   * Get pipeline statistics.
   */
  getStats() {
    return {
      pipeline: { ...this.stats },
      memory: this.dataManager.getStats(),
      redis: this.redisManager ? this.redisManager.stats : null,
      postgres: this.pgManager ? { connected: true, stats: this.pgManager.stats } : null,
      audit: this.auditLogger ? this.auditLogger.stats : null,
      isRunning: this.isRunning,
      hasRedis: !!this.redisManager,
      hasPostgres: !!this.pgManager,
    };
  }

  // --- Internal: flush pending writes from memory → Redis ---

  async _flushToRedis() {
    try {
      const pendingOrders = this.dataManager.getPendingOrders(this.maxBatchSize);
      const pendingFills = this.dataManager.getPendingFills(this.maxBatchSize);
      const pendingOHLC = this.dataManager.getPendingOHLC(this.maxBatchSize);

      let flushed = false;

      if (pendingOrders.length > 0) {
        await this.redisManager.flushOrders(pendingOrders);
        flushed = true;
      }

      if (pendingFills.length > 0) {
        await this.redisManager.flushFills(pendingFills);
        flushed = true;
      }

      if (pendingOHLC.length > 0) {
        await this.redisManager.flushOHLC(pendingOHLC);
        flushed = true;
      }

      this.stats.flushCycles++;
      this.stats.lastFlushTime = Date.now();

      if (flushed) {
        this.emit('flush-complete', {
          orders: pendingOrders.length,
          fills: pendingFills.length,
          ohlc: pendingOHLC.length,
        });
      }
    } catch (err) {
      this.stats.flushErrors++;
      this.logger.error(`[DataPipeline] Redis flush error: ${err.message}`);

      // Redis is down — switch to direct PG flush if available
      if (this.pgManager && !this._pgFlushTimer) {
        this.logger.warn('[DataPipeline] Redis unreachable — switching to direct Memory → PG flush');
        if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
        if (this._migrationTimer) { clearInterval(this._migrationTimer); this._migrationTimer = null; }
        this.redisManager = null;
        this._pgFlushTimer = setInterval(() => this._flushToPostgres(), this.pgFlushIntervalMs);
      }

      this.emit('error', { phase: 'flush', error: err });
    }
  }

  // --- Internal: migrate accumulated data from Redis → PostgreSQL ---

  async _migrateToPostgres() {
    try {
      const results = await this.pgManager.migrateFromRedis(this.redisManager, this.sessionId);
      this.stats.migrationCycles++;
      this.stats.lastMigrationTime = Date.now();

      this.emit('migration-complete', results);
    } catch (err) {
      this.stats.migrationErrors++;
      this.logger.error(`[DataPipeline] PG migration error: ${err.message}`);
      this.emit('error', { phase: 'migration', error: err });
    }
  }

  // --- Internal: flush pending writes directly from memory → PostgreSQL ---

  async _flushToPostgres() {
    try {
      const pendingOrders = this.dataManager.getPendingOrders(this.maxBatchSize);
      const pendingFills = this.dataManager.getPendingFills(this.maxBatchSize);

      let flushedOrders = 0;
      let flushedFills = 0;

      if (pendingOrders.length > 0) {
        // Deduplicate: keep latest state per orderId (avoids PG bulk insert conflict)
        const orderMap = new Map();
        for (const o of pendingOrders) {
          const id = o.orderId || o.id;
          orderMap.set(id, o);
        }
        const pgOrders = Array.from(orderMap.values()).map(o => ({
          id: o.orderId || o.id,
          sessionid: o.sessionId || this.sessionId,
          clientorderid: o.clOrdID || o.orderId,
          symbol: o.symbol || this.symbol,
          side: o.side,
          status: o.status,
          size: o.size || o.quantity,
          price: o.price,
          timestamp: o.timestamp || Date.now(),
          exchange: 'truex',
          data: o,
        }));
        try {
          const result = await this.pgManager.db.bulk.orders.save(pgOrders);
          flushedOrders = result.success || pgOrders.length;
        } catch (err) {
          this.logger.warn(`[DataPipeline] PG orders flush error: ${err.message}`);
        }
      }

      if (pendingFills.length > 0) {
        const pgFills = pendingFills.map(f => ({
          id: f.fillId || f.id,
          orderid: f.orderId,
          sessionid: f.sessionId || this.sessionId,
          clientorderid: f.orderId,
          symbol: f.symbol || this.symbol,
          side: f.side,
          size: f.quantity || f.size,
          quantity: f.quantity || f.size,
          amount: f.quantity || f.size,
          price: f.price,
          execid: f.execID,
          timestamp: f.timestamp || Date.now(),
          data: f,
        }));
        try {
          const result = await this.pgManager.db.bulk.fills.save(pgFills);
          flushedFills = result.success || pgFills.length;
        } catch (err) {
          this.logger.warn(`[DataPipeline] PG fills flush error: ${err.message}`);
        }
      }

      this.stats.pgFlushCycles++;
      this.stats.lastPgFlushTime = Date.now();

      if (flushedOrders > 0 || flushedFills > 0) {
        this.logger.info(`[DataPipeline] PG flush: ${flushedOrders} orders, ${flushedFills} fills`);
        this.emit('pg-flush-complete', { orders: flushedOrders, fills: flushedFills });
      }
    } catch (err) {
      this.stats.pgFlushErrors++;
      this.logger.error(`[DataPipeline] Direct PG flush error: ${err.message}`);
      this.emit('error', { phase: 'pg-flush', error: err });
    }
  }

  // --- Internal: save session record to PostgreSQL ---

  async _saveSessionToPostgres(status) {
    const session = {
      id: this.sessionId,
      sessionid: this.sessionId,
      symbol: this.symbol,
      exchange: 'truex',
      tradingmode: 'paper',
      status,
      startedat: this._startedAt || Date.now(),
      lastupdated: Date.now(),
      data: {
        pipelineStats: this.getStats(),
      },
    };
    if (status === 'stopped') {
      session.endedat = Date.now();
      session.duration = Date.now() - (this._startedAt || Date.now());
    }
    if (!this._startedAt) {
      this._startedAt = Date.now();
    }
    await this.pgManager.db.bulk.sessions.save([session]);
    this.logger.info(`[DataPipeline] Session ${this.sessionId} saved to PG (status=${status})`);
  }

  // --- Internal: clean up old completed orders from memory ---

  _cleanupMemory() {
    const cleaned = this.dataManager.cleanup();
    this.stats.cleanupCycles++;
    this.stats.lastCleanupTime = Date.now();

    if (cleaned > 0) {
      this.logger.info(`[DataPipeline] Memory cleanup: evicted ${cleaned} old orders`);
    }
  }
}
