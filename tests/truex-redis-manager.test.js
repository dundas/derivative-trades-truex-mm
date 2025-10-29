import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock redis-backend-api
const mockSessionManager = {
  update: jest.fn()
};

const mockOrderManager = {
  add: jest.fn(),
  getAll: jest.fn()
};

const mockFillManager = {
  add: jest.fn(),
  getAll: jest.fn()
};

const mockKeyGenerator = {
  generateKey: jest.fn((type) => `adaptive:truex:btc-usd:session-123:${type}`)
};

const mockValidationUtils = {};

jest.unstable_mockModule('../../../../lib/redis-backend-api/index.js', () => ({
  SessionManager: jest.fn(() => mockSessionManager),
  OrderManager: jest.fn(() => mockOrderManager),
  FillManager: jest.fn(() => mockFillManager),
  KeyGenerator: jest.fn(() => mockKeyGenerator),
  ValidationUtils: jest.fn(() => mockValidationUtils)
}));

// Import after mocking
const { TrueXRedisManager } = await import('./truex-redis-manager.js');

describe('TrueXRedisManager', () => {
  let redisManager;
  let mockRedisClient;
  let mockLogger;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    mockRedisClient = {
      hset: jest.fn().mockResolvedValue('OK'),
      hgetall: jest.fn().mockResolvedValue({}),
      expire: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([])
    };
    
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    redisManager = new TrueXRedisManager({
      sessionId: 'session-123',
      symbol: 'BTC/USD',
      redisClient: mockRedisClient,
      logger: mockLogger
    });
  });
  
  describe('Constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(redisManager.sessionId).toBe('session-123');
      expect(redisManager.symbol).toBe('BTC/USD');
      expect(redisManager.redisClient).toBe(mockRedisClient);
    });
    
    it('should throw error if sessionId is missing', () => {
      expect(() => new TrueXRedisManager({
        symbol: 'BTC/USD',
        redisClient: mockRedisClient
      })).toThrow('sessionId is required');
    });
    
    it('should throw error if symbol is missing', () => {
      expect(() => new TrueXRedisManager({
        sessionId: 'session-123',
        redisClient: mockRedisClient
      })).toThrow('symbol is required');
    });
    
    it('should throw error if redisClient is missing', () => {
      expect(() => new TrueXRedisManager({
        sessionId: 'session-123',
        symbol: 'BTC/USD'
      })).toThrow('redisClient is required');
    });
    
    it('should initialize managers', () => {
      expect(redisManager.sessionManager).toBeDefined();
      expect(redisManager.orderManager).toBeDefined();
      expect(redisManager.fillManager).toBeDefined();
    });
    
    it('should initialize stats', () => {
      const stats = redisManager.getStats();
      expect(stats.ordersFlushed).toBe(0);
      expect(stats.fillsFlushed).toBe(0);
      expect(stats.ohlcFlushed).toBe(0);
    });
  });
  
  describe('flushOrders()', () => {
    it('should flush orders to Redis', async () => {
      const orders = [
        {
          orderId: 'order-1',
          clientOrderId: 'CLI-1',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'limit',
          size: 0.1,
          price: 50000,
          status: 'OPEN'
        },
        {
          orderId: 'order-2',
          clientOrderId: 'CLI-2',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          side: 'sell',
          type: 'limit',
          size: 0.1,
          price: 51000,
          status: 'OPEN'
        }
      ];
      
      mockOrderManager.add.mockResolvedValue(true);
      
      const results = await redisManager.flushOrders(orders);
      
      expect(results.success).toBe(2);
      expect(results.failed).toBe(0);
      expect(mockOrderManager.add).toHaveBeenCalledTimes(2);
      expect(redisManager.getStats().ordersFlushed).toBe(2);
    });
    
    it('should handle empty orders array', async () => {
      const results = await redisManager.flushOrders([]);
      
      expect(results.success).toBe(0);
      expect(results.failed).toBe(0);
      expect(mockOrderManager.add).not.toHaveBeenCalled();
    });
    
    it('should handle Redis errors', async () => {
      const orders = [{
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD'
      }];
      
      mockOrderManager.add.mockRejectedValue(new Error('Redis error'));
      
      const results = await redisManager.flushOrders(orders);
      
      expect(results.success).toBe(0);
      expect(results.failed).toBe(1);
      expect(results.errors).toHaveLength(1);
      expect(results.errors[0].orderId).toBe('order-1');
    });
    
    it('should preserve FIX message data', async () => {
      const order = {
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        msgSeqNum: 5,
        execReports: [{ execID: 'EXEC-1' }],
        data: {
          originalFIXMessage: '8=FIXT.1.1...',
          allFIXMessages: ['msg1', 'msg2'],
          truexMetadata: {
            senderCompID: 'CLI_CLIENT',
            targetCompID: 'TRUEX_UAT_OE'
          }
        }
      };
      
      mockOrderManager.add.mockResolvedValue(true);
      
      await redisManager.flushOrders([order]);
      
      const callArg = mockOrderManager.add.mock.calls[0][0];
      expect(callArg.data.originalFIXMessage).toBe('8=FIXT.1.1...');
      expect(callArg.data.allFIXMessages).toHaveLength(2);
      expect(callArg.data.execReports).toHaveLength(1);
    });
  });
  
  describe('flushFills()', () => {
    it('should flush fills to Redis', async () => {
      const fills = [
        {
          fillId: 'fill-1',
          execID: 'EXEC-1',
          orderId: 'order-1',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          side: 'buy',
          quantity: 0.1,
          price: 50000
        },
        {
          fillId: 'fill-2',
          execID: 'EXEC-2',
          orderId: 'order-1',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          side: 'buy',
          quantity: 0.05,
          price: 50050
        }
      ];
      
      mockFillManager.add.mockResolvedValue(true);
      
      const results = await redisManager.flushFills(fills);
      
      expect(results.success).toBe(2);
      expect(results.failed).toBe(0);
      expect(mockFillManager.add).toHaveBeenCalledTimes(2);
      expect(redisManager.getStats().fillsFlushed).toBe(2);
    });
    
    it('should handle empty fills array', async () => {
      const results = await redisManager.flushFills([]);
      
      expect(results.success).toBe(0);
      expect(mockFillManager.add).not.toHaveBeenCalled();
    });
    
    it('should set deduplication key', async () => {
      const fill = {
        fillId: 'fill-1',
        execID: 'EXEC-1',
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD'
      };
      
      mockFillManager.add.mockResolvedValue(true);
      
      await redisManager.flushFills([fill]);
      
      const callArg = mockFillManager.add.mock.calls[0][0];
      expect(callArg.deduplicationKey).toBe('session-123_EXEC-1');
    });
    
    it('should preserve execution report data', async () => {
      const fill = {
        fillId: 'fill-1',
        execID: 'EXEC-1',
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        data: {
          executionReport: { execType: '2', ordStatus: '2' },
          originalFIXMessage: '8=FIXT.1.1...'
        }
      };
      
      mockFillManager.add.mockResolvedValue(true);
      
      await redisManager.flushFills([fill]);
      
      const callArg = mockFillManager.add.mock.calls[0][0];
      expect(callArg.data.executionReport).toBeDefined();
      expect(callArg.data.originalFIXMessage).toBe('8=FIXT.1.1...');
    });
  });
  
  describe('flushOHLC()', () => {
    it('should flush OHLC candles to Redis', async () => {
      const candles = [
        {
          symbol: 'BTC/USD',
          interval: '1m',
          timestamp: 1696723200000,
          open: 50000,
          high: 50100,
          low: 49900,
          close: 50050,
          volume: 10,
          source: 'truex_executions',
          tradeCount: 5,
          isComplete: true
        }
      ];
      
      const results = await redisManager.flushOHLC(candles);
      
      expect(results.success).toBe(1);
      expect(results.failed).toBe(0);
      expect(mockRedisClient.hset).toHaveBeenCalled();
      expect(mockRedisClient.expire).toHaveBeenCalled();
      expect(redisManager.getStats().ohlcFlushed).toBe(1);
    });
    
    it('should generate correct OHLC keys', async () => {
      const candle = {
        symbol: 'BTC/USD',
        interval: '1m',
        timestamp: 1696723200000,
        open: 50000,
        close: 50050
      };
      
      await redisManager.flushOHLC([candle]);
      
      const key = mockRedisClient.hset.mock.calls[0][0];
      expect(key).toContain('ohlc');
      expect(key).toContain('1m');
      expect(key).toContain('1696723200000');
    });
    
    it('should handle empty candles array', async () => {
      const results = await redisManager.flushOHLC([]);
      
      expect(results.success).toBe(0);
      expect(mockRedisClient.hset).not.toHaveBeenCalled();
    });
    
    it('should handle Redis errors', async () => {
      const candles = [{
        symbol: 'BTC/USD',
        interval: '1m',
        timestamp: Date.now()
      }];
      
      mockRedisClient.hset.mockRejectedValue(new Error('Redis error'));
      
      const results = await redisManager.flushOHLC(candles);
      
      expect(results.success).toBe(0);
      expect(results.failed).toBe(1);
      expect(results.errors).toHaveLength(1);
    });
  });
  
  describe('updateSession()', () => {
    it('should update session in Redis', async () => {
      const updates = {
        status: 'active',
        metrics: { ordersPlaced: 10 }
      };
      
      mockSessionManager.update.mockResolvedValue(true);
      
      const result = await redisManager.updateSession(updates);
      
      expect(result.success).toBe(true);
      expect(mockSessionManager.update).toHaveBeenCalledWith(updates);
    });
    
    it('should handle update errors', async () => {
      mockSessionManager.update.mockRejectedValue(new Error('Update failed'));
      
      const result = await redisManager.updateSession({});
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });
  
  describe('getAllOrders()', () => {
    it('should retrieve all orders from Redis', async () => {
      const orders = [
        { orderId: 'order-1', symbol: 'BTC/USD' },
        { orderId: 'order-2', symbol: 'BTC/USD' }
      ];
      
      mockOrderManager.getAll.mockResolvedValue(orders);
      
      const result = await redisManager.getAllOrders();
      
      expect(result).toEqual(orders);
      expect(mockOrderManager.getAll).toHaveBeenCalled();
    });
    
    it('should return empty array on error', async () => {
      mockOrderManager.getAll.mockRejectedValue(new Error('Redis error'));
      
      const result = await redisManager.getAllOrders();
      
      expect(result).toEqual([]);
    });
  });
  
  describe('getAllFills()', () => {
    it('should retrieve all fills from Redis', async () => {
      const fills = [
        { fillId: 'fill-1', execID: 'EXEC-1' },
        { fillId: 'fill-2', execID: 'EXEC-2' }
      ];
      
      mockFillManager.getAll.mockResolvedValue(fills);
      
      const result = await redisManager.getAllFills();
      
      expect(result).toEqual(fills);
      expect(mockFillManager.getAll).toHaveBeenCalled();
    });
  });
  
  describe('getOHLCCandles()', () => {
    it('should retrieve OHLC candles from Redis', async () => {
      const keys = [
        'adaptive:truex:btc-usd:session-123:ohlc:1m:1696723200000',
        'adaptive:truex:btc-usd:session-123:ohlc:1m:1696723260000'
      ];
      
      mockRedisClient.keys.mockResolvedValue(keys);
      mockRedisClient.hgetall
        .mockResolvedValueOnce({ timestamp: 1696723200000, open: 50000, close: 50050 })
        .mockResolvedValueOnce({ timestamp: 1696723260000, open: 50050, close: 50100 });
      
      const result = await redisManager.getOHLCCandles('1m');
      
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe(1696723200000);
      expect(result[1].timestamp).toBe(1696723260000);
    });
    
    it('should filter by time range', async () => {
      const keys = [
        'adaptive:truex:btc-usd:session-123:ohlc:1m:1696723200000',
        'adaptive:truex:btc-usd:session-123:ohlc:1m:1696723260000',
        'adaptive:truex:btc-usd:session-123:ohlc:1m:1696723320000'
      ];
      
      mockRedisClient.keys.mockResolvedValue(keys);
      mockRedisClient.hgetall
        .mockResolvedValueOnce({ timestamp: 1696723200000 })
        .mockResolvedValueOnce({ timestamp: 1696723260000 })
        .mockResolvedValueOnce({ timestamp: 1696723320000 });
      
      const result = await redisManager.getOHLCCandles('1m', 1696723250000, 1696723300000);
      
      expect(result).toHaveLength(1);
      expect(result[0].timestamp).toBe(1696723260000);
    });
    
    it('should return empty array on error', async () => {
      mockRedisClient.keys.mockRejectedValue(new Error('Redis error'));
      
      const result = await redisManager.getOHLCCandles('1m');
      
      expect(result).toEqual([]);
    });
  });
  
  describe('getStats()', () => {
    it('should return statistics', async () => {
      // Flush some data
      mockOrderManager.add.mockResolvedValue(true);
      mockFillManager.add.mockResolvedValue(true);
      
      await redisManager.flushOrders([{ orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }]);
      await redisManager.flushFills([{ fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }]);
      await redisManager.flushOHLC([{ symbol: 'BTC/USD', interval: '1m', timestamp: Date.now() }]);
      
      const stats = redisManager.getStats();
      
      expect(stats.ordersFlushed).toBe(1);
      expect(stats.fillsFlushed).toBe(1);
      expect(stats.ohlcFlushed).toBe(1);
      expect(stats.sessionId).toBe('session-123');
      expect(stats.symbol).toBe('BTC/USD');
    });
  });
  
  describe('close()', () => {
    it('should close manager', async () => {
      await redisManager.close();
      
      expect(mockLogger.info).toHaveBeenCalledWith('[TrueXRedisManager] Manager closed');
    });
  });
});
