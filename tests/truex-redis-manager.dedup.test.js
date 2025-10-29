import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const makeLogger = () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() });

const makeRedis = (impl = 'set') => {
  const base = {
    hset: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(1),
  };
  if (impl === 'set') {
    return { ...base, set: jest.fn().mockResolvedValue('OK') };
  }
  if (impl === 'setnx') {
    return { ...base, setnx: jest.fn().mockResolvedValue(1) };
  }
  return base; // no NX support
};

// Minimal stub for FillManager.add used internally via redis-backend-api
jest.unstable_mockModule('../../../../lib/redis-backend-api/index.js', () => ({
  default: {},
  SessionManager: jest.fn().mockImplementation(() => ({ update: jest.fn() })),
  OrderManager: jest.fn().mockImplementation(() => ({ add: jest.fn() })),
  FillManager: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue('OK'), getAll: jest.fn().mockResolvedValue([]) })),
  KeyGenerator: jest.fn().mockImplementation(({ exchange, symbol, strategy, sessionId }) => ({
    generateCustomKey: (ns) => `adaptive:${exchange}:${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g,'-')}:${sessionId}:${ns}`,
    generateKey: (ns) => `adaptive:${exchange}:${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g,'-')}:${sessionId}:${ns}`,
  })),
  ValidationUtils: jest.fn().mockImplementation(() => ({}))
}));

const { TrueXRedisManager: ManagerUnderTest } = await import('./truex-redis-manager.js');

describe('TrueXRedisManager Redis-side dedup (7.6)', () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('uses SET NX EX path and skips duplicate fills', async () => {
    const redis = makeRedis('set');
    const mgr = new ManagerUnderTest({ sessionId: 'S1', symbol: 'BTC/USD', redisClient: redis, logger });

    const fills = [
      { fillId: 'F1', execID: 'E1', orderId: 'O1', sessionId: 'S1', symbol: 'BTC/USD', side: 'buy', quantity: 1, price: 100, timestamp: Date.now() },
      { fillId: 'F2', execID: 'E1', orderId: 'O1', sessionId: 'S1', symbol: 'BTC/USD', side: 'buy', quantity: 1, price: 100, timestamp: Date.now() },
    ];

    // First reservation OK, second returns null (already exists)
    redis.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null);

    const res = await mgr.flushFills(fills);

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(res.success).toBe(1);
    expect(res.skipped).toBe(1);
    expect(mgr.stats.fillsDedupSkipped).toBe(1);
  });

  it('falls back to SETNX + EXPIRE when setnx is available', async () => {
    const redis = makeRedis('setnx');
    const mgr = new ManagerUnderTest({ sessionId: 'S1', symbol: 'BTC/USD', redisClient: redis, logger });

    const fills = [ { fillId: 'F1', execID: 'E2', orderId: 'O1', sessionId: 'S1', symbol: 'BTC/USD', side: 'buy', quantity: 1, price: 100, timestamp: Date.now() } ];

    const res = await mgr.flushFills(fills);

    expect(redis.setnx).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(1);
  });

  it('fails open if NX not supported, still writes the fill', async () => {
    const redis = makeRedis('none');
    const mgr = new ManagerUnderTest({ sessionId: 'S1', symbol: 'BTC/USD', redisClient: redis, logger });

    const fills = [ { fillId: 'F1', execID: 'E3', orderId: 'O1', sessionId: 'S1', symbol: 'BTC/USD', side: 'buy', quantity: 1, price: 100, timestamp: Date.now() } ];

    const res = await mgr.flushFills(fills);
    expect(res.success).toBe(1);
  });
});
