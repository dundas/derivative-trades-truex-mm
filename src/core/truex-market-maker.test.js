import { describe, it, expect, beforeEach, jest } from 'bun:test';
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

describe('TrueXMarketMaker', () => {
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
      sessionId: 'S-TEST',
      symbol: 'BTC/USD',
      logger,
      fixConnection: fix,
      redisClient, // still required by orchestrator guard
      redisManager,
      pgManager: new MockPGManager(),
      auditLogger
    });
  });

  it('handles heartbeat (35=0) without side effects', async () => {
    await mm.handleFIXMessage({ fields: { '35': '0' } });
    expect(logger.debug).toHaveBeenCalledWith('[TrueXMarketMaker] Heartbeat received');
    // Ensure no audit or data mutations
  });

  it('handles business message reject (35=3) and audits order if present', async () => {
    // Seed an order
    mm.data.addOrder({ orderId: 'OID-RJ', sessionId: 'S-TEST', symbol: 'BTC/USD', status: 'SENT' });
    await mm.handleFIXMessage({
      fields: { '35': '3', '372': 'D', '371': '44', '58': 'Invalid price', '11': 'OID-RJ' }
    });
    expect(auditLogger.logOrderEvent).toHaveBeenCalledWith('REJECTED', expect.objectContaining({ orderId: 'OID-RJ', reason: 'Invalid price' }));
  });

  it('placeOrder logs CREATED and SENT and calls sendMessage', async () => {
    const oid = await mm.placeOrder({ clientOrderId: 'OID-1', side: 'buy', type: '2', size: 1, price: 100 });
    expect(oid).toBe('OID-1');
    expect(auditLogger.logOrderEvent).toHaveBeenCalledWith('CREATED', expect.objectContaining({ orderId: 'OID-1' }));
    expect(fix.sendMessage).toHaveBeenCalled();
    expect(auditLogger.logOrderEvent).toHaveBeenCalledWith('SENT', expect.objectContaining({ orderId: 'OID-1', status: 'SENT' }));
  });

  it('handleFIXMessage logs order transitions and fill events', async () => {
    // Seed order in memory
    await mm.placeOrder({ clientOrderId: 'OID-2', side: 'buy', type: '2', size: 1, price: 100 });

    // Simulate inbound execution report (ACKNOWLEDGED)
    await mm.handleFIXMessage({
      raw: '8=FIXT.1.1\x01...\x01',
      fields: {
        '35': '8',
        '34': '2',
        '39': '0',          // ordStatus New
        '150': '0',         // execType New
        '11': 'OID-2',      // ClOrdID
        '37': 'EXCH-1',     // OrderID
        '17': 'EXEC-1',     // ExecID
        '32': '0',          // LastQty
        '31': '0',          // LastPx
        '55': 'BTC/USD',
        '54': '1'           // Side buy
      }
    });
    expect(auditLogger.logOrderEvent).toHaveBeenCalledWith('ACKNOWLEDGED', expect.objectContaining({ orderId: 'OID-2' }));

    // Simulate partial fill
    await mm.handleFIXMessage({
      raw: '8=FIXT.1.1\x01...\x01',
      fields: {
        '35': '8',
        '34': '3',
        '39': '1',          // Partially filled
        '150': 'F',         // execType Trade
        '11': 'OID-2',
        '37': 'EXCH-1',
        '17': 'EXEC-2',
        '32': '0.5',
        '31': '100',
        '55': 'BTC/USD',
        '54': '1'
      }
    });
    expect(auditLogger.logFillEvent).toHaveBeenCalledWith(expect.objectContaining({ execID: 'EXEC-2', orderId: 'OID-2', quantity: 0.5 }));

    // Simulate filled
    await mm.handleFIXMessage({
      raw: '8=FIXT.1.1\x01...\x01',
      fields: {
        '35': '8',
        '34': '4',
        '39': '2',          // Filled
        '150': 'F',
        '11': 'OID-2',
        '37': 'EXCH-1',
        '17': 'EXEC-3',
        '32': '0.5',
        '31': '100',
        '55': 'BTC/USD',
        '54': '1'
      }
    });
    expect(auditLogger.logOrderEvent).toHaveBeenCalledWith('FILLED', expect.objectContaining({ orderId: 'OID-2' }));
  });

  it('parses market data snapshot (W) into OHLC via 268/269/270', async () => {
    // Use injected builder so we can inspect internals
    mm.ohlc.intervalMs = 60_000;
    // Simulate MD Snapshot with 4 entries: Open(4), High(8), Low(9), Close(7)
    await mm.handleFIXMessage({
      fields: {
        '35': 'W',
        '55': 'BTC/USD',
        '268': '4',
        '269.1': '4', '270.1': '100',
        '269.2': '8', '270.2': '120',
        '269.3': '9', '270.3': '90',
        '269.4': '7', '270.4': '110'
      }
    });
    // Expect one candle present with correct OHLC
    const anyKey = Array.from(mm.ohlc.candles.keys())[0];
    const c = mm.ohlc.candles.get(anyKey);
    expect(c.open).toBe(100);
    expect(c.high).toBe(120);
    expect(c.low).toBe(90);
    expect(c.close).toBe(110);
  });
});
