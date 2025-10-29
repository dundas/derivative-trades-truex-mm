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

class MockPGManager {
  constructor() { this.initialize = jest.fn().mockResolvedValue(true); this.close = jest.fn().mockResolvedValue(true); }
}

describe('TrueXMarketMaker recovery wiring (7.2)', () => {
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
  });

  it('runs one-shot recovery on start when enabled', async () => {
    const executionRecovery = {
      recoverMissingExecutions: jest.fn().mockResolvedValue({ missingCount: 0, flushed: { success: 0, failed: 0, skipped: 0, errors: [] } })
    };

    mm = new TrueXMarketMaker({
      sessionId: 'S-REC',
      symbol: 'BTC/USD',
      logger,
      fixConnection: fix,
      redisClient,
      redisManager,
      pgManager: new MockPGManager(),
      auditLogger,
      enableRecoveryOnStart: true,
      executionRecovery
    });

    await mm.start();

    expect(executionRecovery.recoverMissingExecutions).toHaveBeenCalledWith('S-REC', { date: null });
  });

  it('runRecoveryOnce can perform detection only', async () => {
    const executionRecovery = {
      detectMissingExecutions: jest.fn().mockResolvedValue({ missingCount: 2 })
    };

    mm = new TrueXMarketMaker({
      sessionId: 'S-REC-2',
      symbol: 'BTC/USD',
      logger,
      fixConnection: fix,
      redisClient,
      redisManager,
      pgManager: new MockPGManager(),
      auditLogger,
      enableRecoveryOnStart: false,
      executionRecovery
    });

    // no need to start full orchestrator for detection-only call
    const res = await mm.runRecoveryOnce({ recover: false });
    expect(executionRecovery.detectMissingExecutions).toHaveBeenCalledWith('S-REC-2', { date: null });
    expect(res.missingCount).toBe(2);
  });
});
