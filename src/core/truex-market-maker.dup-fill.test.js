import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { TrueXMarketMaker } from './truex-market-maker.js';

class MockFix extends EventEmitter {
  constructor() {
    super();
    this.senderCompID = 'CLI_CLIENT';
    this.targetCompID = 'TRUEX_UAT_OE';
    this.msgSeqNum = 1;
    this.connect = jest.fn().mockResolvedValue(true);
    this.disconnect = jest.fn().mockResolvedValue(true);
    this.sendMessage = jest.fn().mockResolvedValue(true);
  }
  getUTCTimestamp() { return '20251007-15:00:00.000'; }
}

const makeRedisClient = () => ({
  hset: jest.fn().mockResolvedValue('OK'),
  expire: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({}),
  keys: jest.fn().mockResolvedValue([])
});

describe('TrueXMarketMaker duplicate fill handling (9.6)', () => {
  let auditLogger;
  let fix;
  let redisClient;
  let redisManager;
  let mm;
  let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    auditLogger = {
      logOrderEvent: jest.fn(),
      logFillEvent: jest.fn(),
      close: jest.fn()
    };
    fix = new MockFix();
    redisClient = makeRedisClient();
    redisManager = {
      flushOrders: jest.fn().mockResolvedValue({ success: 0, failed: 0, skipped: 0 }),
      flushFills: jest.fn().mockResolvedValue({ success: 0, failed: 0, skipped: 0 }),
      flushOHLC: jest.fn().mockResolvedValue({ success: 0, failed: 0, skipped: 0 }),
      getAllOrders: jest.fn().mockResolvedValue([]),
      getAllFills: jest.fn().mockResolvedValue([])
    };
    mm = new TrueXMarketMaker({
      sessionId: 'S-DUP',
      symbol: 'BTC/USD',
      logger,
      fixConnection: fix,
      redisClient,
      redisManager,
      pgManager: { initialize: jest.fn().mockResolvedValue(true), close: jest.fn().mockResolvedValue(true) },
      auditLogger
    });
  });

  it('skips duplicate fills by execID and logs once', async () => {
    // Seed an order to update
    await mm.placeOrder({ clientOrderId: 'OID-DUP', side: 'buy', type: '2', size: 1, price: 100 });

    // First fill
    await mm.handleFIXMessage({
      fields: {
        '35': '8', '39': '1', '150': 'F', '11': 'OID-DUP', '37': 'EXCH-DUP',
        '17': 'EXEC-DUP', '32': '0.5', '31': '100', '55': 'BTC/USD', '54': '1'
      }
    });

    // Duplicate fill with same execID
    await mm.handleFIXMessage({
      fields: {
        '35': '8', '39': '1', '150': 'F', '11': 'OID-DUP', '37': 'EXCH-DUP',
        '17': 'EXEC-DUP', '32': '0.25', '31': '101', '55': 'BTC/USD', '54': '1'
      }
    });

    // Expect only one fill audited
    expect(auditLogger.logFillEvent).toHaveBeenCalledTimes(1);
    // Duplicate detection metric incremented
    expect(mm.data.stats.duplicateFillsSkipped).toBe(1);
    // Only one fill stored
    expect(mm.data.getAllFills().length).toBe(1);
  });
});
