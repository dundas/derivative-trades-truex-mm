import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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

jest.unstable_mockModule('../../../../lib/postgresql-api/index.js', () => ({
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
      expect(savedFills[0].exec_id).toBe('EXEC-1');
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
