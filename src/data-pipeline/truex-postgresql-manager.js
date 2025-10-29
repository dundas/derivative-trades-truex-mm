import { createPostgreSQLAPIFromEnv } from '../../lib/postgresql-api/index.js';

/**
 * TrueX PostgreSQL Manager - Layer 3: Analytics & Long-term Storage
 * 
 * Manages PostgreSQL persistence using the unified PostgreSQL API.
 * Provides batch migration from Redis to PostgreSQL for analytics and backup.
 * 
 * Performance targets:
 * - Migration frequency: Every 5 minutes
 * - Batch size: 1000 records per bulk insert
 * - Deduplication: Via unique constraints (fills, ohlc)
 * - Query performance: Indexed on sessionId, timestamp, status
 */
export class TrueXPostgreSQLManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // Create PostgreSQL API instance
    if (options.db) {
      this.db = options.db;
    } else {
      this.db = createPostgreSQLAPIFromEnv();
    }
    
    // Statistics
    this.stats = {
      sessionsMigrated: 0,
      ordersMigrated: 0,
      fillsMigrated: 0,
      ohlcMigrated: 0,
      migrationErrors: 0,
      lastMigrationTime: 0
    };

    // Advisory lock keys (two-int variant). Keep A constant by subsystem and vary B by scope.
    // Using fixed A ensures locks share the same namespace for TrueX; B distinguishes schema vs session.
    this.schemaLockA = 874521; // arbitrary constant namespace
    this.schemaLockB = 1001;   // schema changes
    this.migrationLockA = 874521; // same namespace, per-session B derived from sessionId
  }
  
  /**
   * Initialize PostgreSQL connection and ensure schema exists
   */
  async initialize() {
    try {
      await this.db.initialize();
      
      // Ensure TrueX-specific schema additions exist
      await this.ensureTrueXSchema();
      
      this.logger.info('[TrueXPostgreSQLManager] PostgreSQL API initialized');
      return true;
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Initialization failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Ensure TrueX-specific schema additions exist
   * Adds columns for FIX protocol data if they don't exist
   */
  async ensureTrueXSchema() {
    return this.withAdvisoryLock(this.schemaLockA, this.schemaLockB, async () => {
      try {
        // Add msg_seq_num to orders table if it doesn't exist
        await this.db.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS msg_seq_num INTEGER
        `);
        
        // Add exec_reports JSONB column to orders if it doesn't exist
        await this.db.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS exec_reports JSONB DEFAULT '[]'::jsonb
        `);
        
        // Create OHLC table if it doesn't exist
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS ohlc (
            id SERIAL PRIMARY KEY,
            symbol TEXT NOT NULL,
            exchange TEXT NOT NULL,
            interval TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            open NUMERIC NOT NULL,
            high NUMERIC NOT NULL,
            low NUMERIC NOT NULL,
            close NUMERIC NOT NULL,
            volume NUMERIC NOT NULL,
            source TEXT,
            trade_count INTEGER,
            is_complete BOOLEAN DEFAULT false,
            data JSONB,
            created_at TIMESTAMP DEFAULT NOW(),
            CONSTRAINT unique_ohlc_candle UNIQUE (symbol, exchange, interval, timestamp)
          )
        `);
        
        // Create indexes for OHLC table
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_ohlc_symbol_interval_timestamp 
          ON ohlc(symbol, interval, timestamp)
        `);
        
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_ohlc_timestamp 
          ON ohlc(timestamp)
        `);
        
        // Create index on exec_id for fills deduplication
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_fills_execid 
          ON fills(execid)
        `);
        
        this.logger.info('[TrueXPostgreSQLManager] TrueX schema additions ensured');
        return true;
      } catch (error) {
        this.logger.error(`[TrueXPostgreSQLManager] Schema setup failed: ${error.message}`);
        throw error;
      }
    }, { timeoutMs: 30000 });
  }
  
  /**
   * Migrate data from Redis to PostgreSQL
   */
  async migrateFromRedis(redisManager, sessionId) {
    const results = {
      sessions: { success: 0, failed: 0 },
      orders: { success: 0, failed: 0 },
      fills: { success: 0, failed: 0, skipped: 0 },
      ohlc: { success: 0, failed: 0 }
    };
    
    const lockB = this.hashStringToInt32(`truex:${sessionId}:migration`);
    return this.withAdvisoryLock(this.migrationLockA, lockB, async () => {
      try {
        this.logger.info(`[TrueXPostgreSQLManager] Starting migration for session ${sessionId}`);
        
        // 1. Migrate session data
        const sessionResult = await this.migrateSession(redisManager, sessionId);
        results.sessions = sessionResult;
        
        // 2. Migrate orders with enhanced data preservation
        const ordersResult = await this.migrateOrders(redisManager, sessionId);
        results.orders = ordersResult;
        
        // 3. Migrate fills with deduplication
        const fillsResult = await this.migrateFills(redisManager, sessionId);
        results.fills = fillsResult;
        
        // 4. Migrate OHLC data
        const ohlcResult = await this.migrateOHLC(redisManager, sessionId);
        results.ohlc = ohlcResult;
        
        // 5. Mark session as migrated only if all parts succeeded without failures
        const totalFailed = (results.sessions.failed || 0)
          + (results.orders.failed || 0)
          + (results.fills.failed || 0)
          + (results.ohlc.failed || 0);
        if (totalFailed === 0) {
          await this.db.migration.markSessionAsMigrated(sessionId);
        } else {
          const err = new Error(`Partial migration detected (failed=${totalFailed}). Session will not be marked as migrated.`);
          err.migrationResults = results;
          throw err;
        }
        
        this.stats.lastMigrationTime = Date.now();
        this.logger.info(`[TrueXPostgreSQLManager] Migration completed:`, results);
        
        return results;
      } catch (error) {
        this.logger.error(`[TrueXPostgreSQLManager] Migration failed: ${error.message}`);
        this.stats.migrationErrors++;
        throw error;
      }
    }, { timeoutMs: 60000 });
  }

  /**
   * Acquire an advisory lock and run the provided async function, releasing the lock afterward.
   * Retries for up to timeoutMs if lock cannot be acquired immediately.
   */
  async withAdvisoryLock(lockA, lockB, fn, { timeoutMs = 15000, retryDelayMs = 250 } = {}) {
    const acquired = await this.tryAcquireLock(lockA, lockB, { timeoutMs, retryDelayMs });
    if (!acquired) {
      throw new Error(`Could not acquire advisory lock (${lockA}, ${lockB}) within ${timeoutMs}ms`);
    }
    try {
      return await fn();
    } finally {
      await this.releaseLock(lockA, lockB);
    }
  }

  async tryAcquireLock(lockA, lockB, { timeoutMs = 15000, retryDelayMs = 250 } = {}) {
    const start = Date.now();
    while (true) {
      const res = await this.db.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [lockA, lockB]);
      const locked = res?.rows?.[0]?.locked === true;
      if (locked) return true;
      if ((Date.now() - start) >= timeoutMs) return false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  async releaseLock(lockA, lockB) {
    try {
      await this.db.query('SELECT pg_advisory_unlock($1, $2)', [lockA, lockB]);
    } catch (e) {
      this.logger.warn(`[TrueXPostgreSQLManager] Failed to release advisory lock (${lockA}, ${lockB}): ${e.message}`);
    }
  }

  // Simple 32-bit hash for strings (deterministic per sessionId), for advisory lock key B
  hashStringToInt32(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0; // Convert to 32-bit integer
    }
    // Ensure non-negative by flipping sign bit if needed
    if (hash < 0) hash = Math.abs(hash);
    return hash;
  }
  
  /**
   * Migrate session data
   */
  async migrateSession(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      const sessionData = await redisManager.sessionManager.get();
      
      if (sessionData) {
        const session = {
          id: sessionId,
          sessionid: sessionId,
          ...sessionData,
          data: sessionData,  // Preserve complete Redis data
          last_updated: Date.now()
        };
        
        const saveResult = await this.db.bulk.sessions.save([session]);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        this.stats.sessionsMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Session migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate orders with FIX data preservation
   */
  async migrateOrders(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      const orders = await redisManager.getAllOrders();
      
      if (orders && orders.length > 0) {
        const enhancedOrders = orders.map(order => ({
          ...order,
          id: order.orderId,
          orderid: order.orderId,
          sessionid: sessionId,
          msg_seq_num: order.msgSeqNum,
          exec_reports: order.execReports || [],
          data: {
            // Store complete original Redis order
            originalRedisOrder: { ...order },
            
            // Migration metadata
            dataMigrationVersion: '1.2.0',
            dataMigratedAt: Date.now(),
            dataPreserved: true,
            
            // Preserve FIX-specific fields
            fixProtocolData: order.data?.allFIXMessages || [],
            execReports: order.execReports || [],
            truexMetadata: order.data?.truexMetadata
          }
        }));
        
        const saveResult = await this.db.bulk.orders.save(enhancedOrders);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        this.stats.ordersMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Orders migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate fills with deduplication
   */
  async migrateFills(redisManager, sessionId) {
    const results = { success: 0, failed: 0, skipped: 0 };
    
    try {
      const fills = await redisManager.getAllFills();
      
      if (fills && fills.length > 0) {
        const enhancedFills = fills.map(fill => ({
          ...fill,
          id: fill.fillId,
          fillid: fill.fillId,
          sessionid: sessionId,
          execid: fill.execID,
          orderid: fill.orderId,
          deduplication_key: fill.deduplicationKey || `${sessionId}_${fill.execID}`,
          data: {
            executionReport: fill.data?.executionReport,
            originalFIXMessage: fill.data?.originalFIXMessage,
            dataMigrationVersion: '1.2.0',
            dataMigratedAt: Date.now()
          }
        }));
        
        const saveResult = await this.db.bulk.fills.save(enhancedFills);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        results.skipped += saveResult.skipped || 0;
        this.stats.fillsMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Fills migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate OHLC data
   */
  async migrateOHLC(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      // Get OHLC candles from Redis (assuming 1m interval for now)
      const candles = await redisManager.getOHLCCandles('1m');
      
      if (candles && candles.length > 0) {
        for (const candle of candles) {
          try {
            await this.db.query(`
              INSERT INTO ohlc (
                symbol, exchange, interval, timestamp,
                open, high, low, close, volume,
                source, trade_count, is_complete, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (symbol, exchange, interval, timestamp) DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close = EXCLUDED.close,
                volume = EXCLUDED.volume,
                is_complete = EXCLUDED.is_complete,
                data = EXCLUDED.data
            `, [
              candle.symbol,
              candle.exchange || 'truex',
              candle.interval,
              candle.timestamp,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.volume,
              candle.source,
              candle.tradeCount || 0,
              candle.isComplete || false,
              JSON.stringify(candle.data || {})
            ]);
            
            results.success++;
            this.stats.ohlcMigrated++;
          } catch (error) {
            this.logger.error(`[TrueXPostgreSQLManager] OHLC candle migration failed: ${error.message}`);
            results.failed++;
          }
        }
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] OHLC migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Get OHLC candles for analysis
   */
  async getOHLCCandles(symbol, interval, startTime, endTime) {
    try {
      let query = `
        SELECT * FROM ohlc 
        WHERE symbol = $1 AND interval = $2
      `;
      const params = [symbol, interval];
      
      if (startTime) {
        query += ` AND timestamp >= $${params.length + 1}`;
        params.push(startTime);
      }
      
      if (endTime) {
        query += ` AND timestamp <= $${params.length + 1}`;
        params.push(endTime);
      }
      
      query += ` ORDER BY timestamp ASC`;
      
      const result = await this.db.query(query, params);
      return result.rows;
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Failed to get OHLC candles: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      dbStats: this.db.getStats()
    };
  }
  
  /**
   * Close PostgreSQL connection
   */
  async close() {
    await this.db.close();
    this.logger.info('[TrueXPostgreSQLManager] PostgreSQL connection closed');
  }
}
