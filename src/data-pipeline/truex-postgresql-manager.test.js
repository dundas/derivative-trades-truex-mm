import { describe, it, expect, jest, beforeEach, mock } from 'bun:test';

// Mock PostgreSQL API
const mockDb = {
  initialize: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (/pg_try_advisory_lock/i.test(text)) {
      return { rows: [{ locked: true }] };
    }
    if (/pg_advisory_unlock/i.test(text)) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    // Default simulate success for DDL/DML queries
    return { rows: [] };
  }),
  bulk: {
    sessions: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0 })
    },
    orders: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0 })
    },
    fills: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0, skipped: 0 })
    }
  },
  migration: {
    markSessionAsMigrated: jest.fn().mockResolvedValue(true)
  },
  getStats: jest.fn().mockReturnValue({ totalConnections: 5 }),
  close: jest.fn().mockResolvedValue(true)
};

mock.module('../../lib/postgresql-api/index.js', () => ({
  PostgreSQLAPI: class PostgreSQLAPI { constructor() { return mockDb; } },
  createPostgreSQLAPIFromEnv: jest.fn(() => mockDb)
}));

// Import after mocking
const { TrueXPostgreSQLManager } = await import('./truex-postgresql-manager.js');

describe('TrueXPostgreSQLManager', () => {
  let pgManager;
  let mockLogger;
  let mockRedisManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    mockRedisManager = {
      sessionManager: {
        get: jest.fn().mockResolvedValue({
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          status: 'active'
        })
      },
      getAllOrders: jest.fn().mockResolvedValue([]),
      getAllFills: jest.fn().mockResolvedValue([]),
      getOHLCCandles: jest.fn().mockResolvedValue([])
    };
    
    pgManager = new TrueXPostgreSQLManager({
      db: mockDb,
      logger: mockLogger
    });
  });
  
  describe('Constructor', () => {
    it('should initialize with provided db', () => {
      expect(pgManager.db).toBe(mockDb);
      expect(pgManager.logger).toBe(mockLogger);
    });
    
    it('should initialize stats', () => {
      const stats = pgManager.getStats();
      expect(stats.sessionsMigrated).toBe(0);
      expect(stats.ordersMigrated).toBe(0);
      expect(stats.fillsMigrated).toBe(0);
      expect(stats.ohlcMigrated).toBe(0);
    });
  });
  
  describe('initialize()', () => {
    it('should initialize PostgreSQL connection', async () => {
      await pgManager.initialize();
      
      expect(mockDb.initialize).toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalled(); // Schema setup queries
    });

    it('adds immutable quote lifecycle storage without altering orders or fills', async () => {
      await pgManager.initialize();
      const sql = mockDb.query.mock.calls.map(([query]) => String(query)).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS quote_lifecycle_events');
      expect(sql).toContain('idx_quote_lifecycle_quote_ts');
      expect(sql).not.toContain('ALTER TABLE fills ADD COLUMN');
    });

    it('adds restart-safe reference decision, work, and immutable evidence storage', async () => {
      await pgManager.initialize();
      const sql = mockDb.query.mock.calls.map(([query]) => String(query)).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS reference_quote_decisions');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS reference_market_observations');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS fill_reference_markout_work');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS fill_reference_markout_evidence');
      expect(sql).toContain("CHECK (state IN ('pending', 'claimed', 'completed'))");
      expect(sql).toContain('idx_reference_markout_due');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v2');
      expect(sql).toContain('(product, quote_currency, source_exchange, source_type, observation_timestamp');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_reference_market_retention_v2');
      expect(sql).toContain('(received_timestamp, observation_timestamp)');
    });
    
    it('should create TrueX-specific schema', async () => {
      await pgManager.initialize();
      
      // Check that schema queries were executed
      const queryCalls = mockDb.query.mock.calls;
      const queries = queryCalls.map(call => call[0]);
      
      expect(queries.some(q => q.includes('ALTER TABLE orders'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS ohlc'))).toBe(true);
    });
    
    it('should handle initialization errors', async () => {
      mockDb.initialize.mockRejectedValueOnce(new Error('Connection failed'));
      
      await expect(pgManager.initialize()).rejects.toThrow('Connection failed');
    });
  });

  describe('quote lifecycle persistence', () => {
    const event = {
      eventId: 'event-1', schemaVersion: '1.0', eventType: 'create', timestamp: 1000,
      decisionTimestamp: 999, sessionId: 's-1', quoteId: 'Q-1', orderId: 'Q-1',
      symbol: 'BTC-PYUSD', side: 'buy', price: 100, size: 0.1, level: 1,
      action: 'place', policyId: 'default', context: { fairValue: 101 },
    };

    it('persists events append-only and offers bounded query/prune helpers', async () => {
      await pgManager.recordQuoteLifecycleEvent(event);
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO quote_lifecycle_events'), expect.arrayContaining(['event-1', '1.0']));
      await pgManager.getQuoteLifecycleEvents({ sessionId: 's-1', quoteId: 'Q-1', limit: 10 });
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM quote_lifecycle_events'), ['s-1', 'Q-1', 10]);
      await pgManager.pruneQuoteLifecycleEventsBefore(500);
      expect(mockDb.query).toHaveBeenCalledWith('DELETE FROM quote_lifecycle_events WHERE event_timestamp < $1', [500]);
    });

    it('surfaces persistence errors for the telemetry caller to handle', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('isolated db unavailable'));
      await expect(pgManager.recordQuoteLifecycleEvent(event)).rejects.toThrow('isolated db unavailable');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('quote telemetry write failed'));
    });
  });

  describe('reference mark-out persistence', () => {
    const decision = {
      eventId: 'event-1', decisionTimestamp: 1000, sessionId: 's-1', quoteId: 'Q-1',
      symbol: 'BTC-PYUSD', side: 'buy', level: 1, policyId: 'maker-v1', price: 100,
      size: 0.1, product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
      sourceType: 'top-of-book', sourceTimestamp: 990, receivedTimestamp: 995,
      bid: 99, ask: 101, midpoint: 100, basisTimestamp: 990, basisPrice: 1,
      basisAdjustmentBps: 0, available: true, unavailableReason: null,
    };

    it('stores decisions and schedules every horizon idempotently', async () => {
      await pgManager.recordReferenceQuoteDecision(decision);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (decision_id) DO NOTHING'),
        expect.arrayContaining(['event-1', 'Q-1', 'BTC-USD']),
      );
      await pgManager.scheduleReferenceMarkouts({
        fillId: 'F-1', executionId: 'E-1', quoteId: 'Q-1', sessionId: 's-1',
        fillTimestamp: 2000, decisionTimestamp: 1000, side: 'buy', level: 1,
        policyId: 'maker-v1', price: 100, size: 0.1, product: 'BTC-USD',
        quoteCurrency: 'USD', sourceExchange: 'coinbase', sourceType: 'top-of-book',
        horizonsMs: [60_000, 300_000], dueTimestamps: [62_000, 302_000],
        deadlineTimestamps: [92_000, 332_000],
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (fill_id, horizon_ms) DO NOTHING'),
        expect.arrayContaining([[60_000, 300_000], [62_000, 302_000]]),
      );
    });

    it('claims due work atomically with expired-lease recovery and skip-locked overlap safety', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{
        fill_id: 'F-1', horizon_ms: '60000', fill_timestamp: '2000', due_timestamp: '62000',
        deadline_timestamp: '92000', fill_price: '100', fill_size: '0.1', level: 1,
      }] });
      const rows = await pgManager.claimDueReferenceMarkouts({
        now: 62_001, claimToken: 'owner-1', leaseMs: 5000, batchSize: 10,
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/session_id = work\.session_id[\s\S]*FOR UPDATE OF work SKIP LOCKED[\s\S]*state = 'claimed'/),
        [62_001, 10, 'owner-1', 5000],
      );
      expect(rows[0]).toMatchObject({ fillId: 'F-1', horizonMs: 60_000, dueTimestamp: 62_000 });
    });

    it('persists immutable market samples and selects the earliest sample in the due window', async () => {
      await pgManager.recordReferenceMarketObservation({ ...decision, observationTimestamp: 995 });
      const firstObservationId = mockDb.query.mock.calls.at(-1)[1][0];
      await pgManager.recordReferenceMarketObservation({ ...decision, observationTimestamp: 996 });
      const secondObservationId = mockDb.query.mock.calls.at(-1)[1][0];
      expect(firstObservationId).not.toBe(secondObservationId);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (observation_id) DO NOTHING'),
        expect.arrayContaining(['BTC-USD', 990, 995]),
      );
      mockDb.query.mockResolvedValueOnce({ rows: [{
        observation_timestamp: '995', product: 'BTC-USD', quote_currency: 'USD',
        source_exchange: 'coinbase', source_type: 'top-of-book', source_timestamp: '990',
        received_timestamp: '995', bid: '99', ask: '101', midpoint: '100',
        basis_timestamp: '990', basis_price: '1', basis_adjustment_bps: '0',
      }] });
      const sample = await pgManager.getFirstReferenceMarketObservation({
        dueTimestamp: 980, deadlineTimestamp: 1000, product: 'BTC-USD',
        quoteCurrency: 'USD', sourceExchange: 'coinbase', sourceType: 'top-of-book',
        maxSourceAgeMs: 100, maxAbsBasisAdjustmentBps: 25,
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/observation_timestamp <= \$6[\s\S]*observation_timestamp >= 0 AND source_timestamp >= 0[\s\S]*received_timestamp >= 0 AND basis_timestamp >= 0[\s\S]*bid::text NOT IN \('NaN', 'Infinity', '-Infinity'\)[\s\S]*ask::text NOT IN \('NaN', 'Infinity', '-Infinity'\)[\s\S]*midpoint::text NOT IN \('NaN', 'Infinity', '-Infinity'\)[\s\S]*basis_price::text NOT IN \('NaN', 'Infinity', '-Infinity'\)[\s\S]*basis_adjustment_bps::text NOT IN \('NaN', 'Infinity', '-Infinity'\)[\s\S]*bid > 0 AND ask > 0 AND bid <= ask[\s\S]*basis_price > 0[\s\S]*source_timestamp <= received_timestamp[\s\S]*received_timestamp <= observation_timestamp[\s\S]*basis_timestamp <= observation_timestamp[\s\S]*ABS\(basis_adjustment_bps\) <= \$8[\s\S]*ORDER BY observation_timestamp ASC,[\s\S]*GREATEST\(source_timestamp, received_timestamp, basis_timestamp\) ASC/),
        ['BTC-USD', 'USD', 'coinbase', 'top-of-book', 980, 1000, 100, 25],
      );
      expect(sample).toMatchObject({ available: true, sourceTimestamp: 990, receivedTimestamp: 995 });
    });

    it('binds release and terminal evidence completion to the claim owner', async () => {
      await pgManager.releaseReferenceMarkoutClaim({ fillId: 'F-1', horizonMs: 60_000 }, 'owner-1', 'before-due');
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining("state = 'claimed' AND claim_token = $3"),
        ['F-1', 60_000, 'owner-1', 'before-due'],
      );
      await pgManager.completeReferenceMarkout(
        { fillId: 'F-1', horizonMs: 60_000 }, 'owner-1',
        { ...decision, observationTimestamp: 62_001 },
      );
      const sql = String(mockDb.query.mock.calls.at(-1)[0]);
      expect(sql).toContain('INSERT INTO fill_reference_markout_evidence');
      expect(sql).toContain("state = 'claimed' AND claim_token = $3");
      expect(sql).toContain("SET state = 'completed'");
    });

    it('prunes only terminal evidence and returns a bounded grouped coverage audit', async () => {
      await pgManager.pruneReferenceMarkoutEvidence(1000);
      const pruneSql = String(mockDb.query.mock.calls.at(-1)[0]);
      expect(pruneSql).toContain("work.state = 'completed'");
      expect(pruneSql).toContain("WHERE state = 'completed'");
      await pgManager.pruneReferenceQuoteDecisions(1000);
      expect(mockDb.query).toHaveBeenLastCalledWith(expect.stringContaining("work.state <> 'completed'"), [1000]);
      await pgManager.pruneReferenceMarketObservations(1000);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/work\.state <> 'completed'[\s\S]*observation\.observation_timestamp BETWEEN work\.due_timestamp AND work\.deadline_timestamp/),
        [1000],
      );
      const audit = await pgManager.getReferenceMarkoutCoverage({ fromTimestamp: 1, toTimestamp: 2, limit: 5000 });
      expect(mockDb.query).toHaveBeenLastCalledWith(expect.stringContaining('availability_reason'), [1, 2, 1001]);
      expect(audit).toEqual({ groups: [], truncated: false, limit: 1000 });
    });
  });
  
  describe('migrateFromRedis()', () => {
    beforeEach(async () => {
      await pgManager.initialize();
      jest.clearAllMocks();
    });
    
    it('should migrate all data types', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      mockRedisManager.getAllFills.mockResolvedValue([
        { fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1', sessionId: 'session-123' }
      ]);
      mockRedisManager.getOHLCCandles.mockResolvedValue([
        { symbol: 'BTC/USD', interval: '1m', timestamp: Date.now(), open: 50000, close: 50050 }
      ]);
      
      const results = await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      expect(results.sessions.success).toBe(1);
      expect(results.orders.success).toBe(1);
      expect(results.fills.success).toBe(1);
      expect(results.ohlc.success).toBe(1);
      expect(mockDb.migration.markSessionAsMigrated).toHaveBeenCalledWith('session-123');
    });
    
    it('should preserve FIX message data in orders', async () => {
      const order = {
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        msgSeqNum: 5,
        execReports: [{ execID: 'EXEC-1' }],
        data: {
          allFIXMessages: ['msg1', 'msg2'],
          truexMetadata: { senderCompID: 'CLI_CLIENT' }
        }
      };
      
      mockRedisManager.getAllOrders.mockResolvedValue([order]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const savedOrders = mockDb.bulk.orders.save.mock.calls[0][0];
      expect(savedOrders[0].msg_seq_num).toBe(5);
      expect(savedOrders[0].exec_reports).toHaveLength(1);
      expect(savedOrders[0].data.fixProtocolData).toHaveLength(2);
      expect(savedOrders[0].data.dataMigrationVersion).toBe('1.2.0');
    });
    
    it('should set deduplication keys for fills', async () => {
      const fill = {
        fillId: 'fill-1',
        execID: 'EXEC-1',
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD'
      };
      
      mockRedisManager.getAllFills.mockResolvedValue([fill]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const savedFills = mockDb.bulk.fills.save.mock.calls[0][0];
      expect(savedFills[0].deduplication_key).toBe('session-123_EXEC-1');
    });
    
    it('should handle empty data gracefully', async () => {
      const results = await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      expect(results.sessions.success).toBe(1);
      expect(results.orders.success).toBe(0);
      expect(results.fills.success).toBe(0);
      expect(results.ohlc.success).toBe(0);
    });
    
    it('should track migration statistics', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const stats = pgManager.getStats();
      expect(stats.sessionsMigrated).toBe(1);
      expect(stats.ordersMigrated).toBe(1);
      expect(stats.lastMigrationTime).toBeGreaterThan(0);
    });
  });
  
  describe('migrateSession()', () => {
    it('should migrate session data', async () => {
      const sessionData = {
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        status: 'active',
        metrics: { ordersPlaced: 10 }
      };
      
      mockRedisManager.sessionManager.get.mockResolvedValue(sessionData);
      
      const results = await pgManager.migrateSession(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      expect(mockDb.bulk.sessions.save).toHaveBeenCalled();
      
      const savedSession = mockDb.bulk.sessions.save.mock.calls[0][0][0];
      expect(savedSession.id).toBe('session-123');
      expect(savedSession.data).toEqual(sessionData);
    });
    
    it('should handle missing session data', async () => {
      mockRedisManager.sessionManager.get.mockResolvedValue(null);
      
      const results = await pgManager.migrateSession(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(0);
      expect(mockDb.bulk.sessions.save).not.toHaveBeenCalled();
    });
  });
  
  describe('migrateOrders()', () => {
    it('should migrate orders with enhanced data', async () => {
      const orders = [
        {
          orderId: 'order-1',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          msgSeqNum: 5,
          execReports: []
        }
      ];
      
      mockRedisManager.getAllOrders.mockResolvedValue(orders);
      
      const results = await pgManager.migrateOrders(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      const savedOrders = mockDb.bulk.orders.save.mock.calls[0][0];
      expect(savedOrders[0].data.originalRedisOrder).toBeDefined();
      expect(savedOrders[0].data.dataPreserved).toBe(true);
    });
  });
  
  describe('migrateFills()', () => {
    it('should migrate fills with deduplication keys', async () => {
      const fills = [
        {
          fillId: 'fill-1',
          execID: 'EXEC-1',
          orderId: 'order-1',
          sessionId: 'session-123',
          data: {
            executionReport: { execType: '2' }
          }
        }
      ];
      
      mockRedisManager.getAllFills.mockResolvedValue(fills);
      
      const results = await pgManager.migrateFills(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      const savedFills = mockDb.bulk.fills.save.mock.calls[0][0];
      expect(savedFills[0].execid).toBe('EXEC-1');
      expect(savedFills[0].data.executionReport).toBeDefined();
    });
  });
  
  describe('migrateOHLC()', () => {
    it('should migrate OHLC candles', async () => {
      const candles = [
        {
          symbol: 'BTC/USD',
          exchange: 'truex',
          interval: '1m',
          timestamp: 1696723200000,
          open: 50000,
          high: 50100,
          low: 49900,
          close: 50050,
          volume: 10,
          source: 'truex_executions',
          tradeCount: 5,
          isComplete: true,
          data: {}
        }
      ];
      
      mockRedisManager.getOHLCCandles.mockResolvedValue(candles);
      
      const results = await pgManager.migrateOHLC(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ohlc'),
        expect.arrayContaining(['BTC/USD', 'truex', '1m', 1696723200000])
      );
    });
    
    it('should handle OHLC upsert on conflict', async () => {
      const candles = [
        {
          symbol: 'BTC/USD',
          interval: '1m',
          timestamp: Date.now(),
          open: 50000,
          high: 50000,
          low: 50000,
          close: 50000,
          volume: 1
        }
      ];
      
      mockRedisManager.getOHLCCandles.mockResolvedValue(candles);
      
      await pgManager.migrateOHLC(mockRedisManager, 'session-123');
      
      const query = mockDb.query.mock.calls[0][0];
      expect(query).toContain('ON CONFLICT');
      expect(query).toContain('DO UPDATE SET');
    });
  });
  
  describe('getOHLCCandles()', () => {
    it('should retrieve OHLC candles', async () => {
      const candles = [
        { symbol: 'BTC/USD', interval: '1m', timestamp: 1696723200000 },
        { symbol: 'BTC/USD', interval: '1m', timestamp: 1696723260000 }
      ];
      
      mockDb.query.mockResolvedValue({ rows: candles });
      
      const result = await pgManager.getOHLCCandles('BTC/USD', '1m');
      
      expect(result).toHaveLength(2);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM ohlc'),
        ['BTC/USD', '1m']
      );
    });
    
    it('should filter by time range', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await pgManager.getOHLCCandles('BTC/USD', '1m', 1696723200000, 1696723300000);
      
      const [query, params] = mockDb.query.mock.calls[0];
      expect(query).toContain('timestamp >=');
      expect(query).toContain('timestamp <=');
      expect(params).toContain(1696723200000);
      expect(params).toContain(1696723300000);
    });
    
    it('should return empty array on error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Query failed'));
      
      const result = await pgManager.getOHLCCandles('BTC/USD', '1m');
      
      expect(result).toEqual([]);
    });
  });
  
  describe('getStats()', () => {
    beforeEach(() => {
      // Ensure advisory lock does not cause delays in this block
      jest.spyOn(pgManager, 'tryAcquireLock').mockResolvedValue(true);
      jest.spyOn(pgManager, 'releaseLock').mockResolvedValue();
    });
    
    it('should return statistics with db stats', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const stats = pgManager.getStats();
      
      expect(stats.sessionsMigrated).toBe(1);
      expect(stats.ordersMigrated).toBe(1);
      expect(stats.dbStats).toBeDefined();
      expect(stats.dbStats.totalConnections).toBe(5);
    });
  });
  
  describe('close()', () => {
    it('should close PostgreSQL connection', async () => {
      await pgManager.close();
      
      expect(mockDb.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[TrueXPostgreSQLManager] PostgreSQL connection closed'
      );
    });
  });
});
