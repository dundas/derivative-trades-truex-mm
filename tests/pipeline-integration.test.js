import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TrueXMarketMaker } from '../truex-market-maker.js';

class StubRedisManager {
  constructor() {
    this.orders = [];
    this.fills = [];
    this.ohlc = [];
  }
  async flushOrders(arr) { this.orders.push(...arr); return { success: arr.length, failed: 0, skipped: 0 }; }
  async flushFills(arr) { this.fills.push(...arr); return { success: arr.length, failed: 0, skipped: 0 }; }
  async flushOHLC(arr) { this.ohlc.push(...arr); return { success: arr.length, failed: 0, skipped: 0 }; }
  async getAllOrders() { return this.orders; }
  async getAllFills() { return this.fills; }
  async getOHLCCandles() { return this.ohlc; }
}

class StubPGManager {
  constructor() {
    this.initialize = jest.fn().mockResolvedValue(true);
    this.close = jest.fn().mockResolvedValue(true);
    this.migrateFromRedis = jest.fn(async (redis, sessionId) => {
      const orders = await redis.getAllOrders();
      const fills = await redis.getAllFills();
      const ohlc = await redis.getOHLCCandles('1m');
      this.lastMigration = { orders: orders.length, fills: fills.length, ohlc: ohlc.length, sessionId };
      return {
        sessions: { success: 1, failed: 0 },
        orders: { success: orders.length, failed: 0 },
        fills: { success: fills.length, failed: 0, skipped: 0 },
        ohlc: { success: ohlc.length, failed: 0 }
      };
    });
  }
}

class StubFix { constructor() { this.senderCompID = 'CLI_CLIENT'; this.targetCompID = 'TRUEX_UAT_OE'; this.msgSeqNum = 1; this.connect = jest.fn(); this.disconnect = jest.fn(); this.sendMessage = jest.fn(); } getUTCTimestamp(){ return '20251007-00:00:00.000'; } }

const makeRedisClient = () => ({ hset: jest.fn(), expire: jest.fn(), hgetall: jest.fn(), keys: jest.fn(), scan: jest.fn() });

describe('Integration: Memory → Redis → PostgreSQL', () => {
  let mm; let stubRedis; let stubPG; let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    stubRedis = new StubRedisManager();
    stubPG = new StubPGManager();
    mm = new TrueXMarketMaker({
      sessionId: 'S-INTEG',
      symbol: 'BTC/USD',
      logger,
      fixConnection: new StubFix(),
      redisClient: makeRedisClient(),
      redisManager: stubRedis,
      pgManager: stubPG,
      auditLogger: { logOrderEvent: jest.fn(), logFillEvent: jest.fn(), close: jest.fn() }
    });
  });

  it('flushes pending data to Redis and migrates to Postgres', async () => {
    // Seed memory with one order, one fill, and one OHLC candle
    const now = Date.now();
    mm.data.addOrder({ orderId: 'OID-INT', sessionId: 'S-INTEG', symbol: 'BTC/USD', side: 'buy', type: '2', size: 1, price: 100, status: 'CREATED', createdAt: now });
    mm.data.addFill({ fillId: 'FID-INT', execID: 'EXEC-INT', orderId: 'OID-INT', sessionId: 'S-INTEG', symbol: 'BTC/USD', side: 'buy', quantity: 1, price: 100, timestamp: now });
    mm.data.addOHLC({ symbol: 'BTC/USD', exchange: 'truex', interval: '1m', timestamp: now - 60_000, open: 100, high: 110, low: 95, close: 105, volume: 10, isComplete: true });

    // Flush to Redis (stub collects)
    await mm.flushToRedis();

    expect(stubRedis.orders.length).toBeGreaterThanOrEqual(1);
    expect(stubRedis.fills.length).toBeGreaterThanOrEqual(1);
    expect(stubRedis.ohlc.length).toBeGreaterThanOrEqual(1);

    // Migrate to Postgres (stub records counts)
    await mm.migrateToPostgres();

    expect(stubPG.migrateFromRedis).toHaveBeenCalled();
    expect(stubPG.lastMigration).toBeDefined();
    expect(stubPG.lastMigration.orders).toBeGreaterThanOrEqual(1);
    expect(stubPG.lastMigration.fills).toBeGreaterThanOrEqual(1);
    expect(stubPG.lastMigration.ohlc).toBeGreaterThanOrEqual(1);
  });
});
