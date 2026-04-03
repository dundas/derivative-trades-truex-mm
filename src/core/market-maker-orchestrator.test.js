import { describe, it, expect, jest, beforeEach } from 'bun:test';
import { EventEmitter } from 'events';
import { MarketMakerOrchestrator } from './market-maker-orchestrator.js';

// Minimal mock for FIXConnection — tracks constructor options
class MockFIXConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this._constructorOptions = options;
    this.isLoggedOn = false;
    this.isConnected = false;
    this.connect = jest.fn().mockResolvedValue(undefined);
    this.disconnect = jest.fn().mockResolvedValue(undefined);
    this.sendMessage = jest.fn().mockResolvedValue({ raw: '', fields: {}, msgSeqNum: 1 });
    this.loadSequenceNumbers = jest.fn().mockResolvedValue(undefined);
  }
}

// -----------------------------------------------------------------------
// Task 1.4 — Orchestrator passes redisClient to FIXConnection
// -----------------------------------------------------------------------
describe('MarketMakerOrchestrator — Redis wiring (Task 1.4)', () => {
  it('should pass redisClient to fixOE when provided', () => {
    const mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const orch = new MarketMakerOrchestrator({
      truexHost: 'test.host',
      truexPort: 1234,
      senderCompID: 'TEST_SENDER',
      targetCompID: 'TEST_TARGET',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      redisClient: mockRedis,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    // fixOE should have the redis client reference
    expect(orch.fixOE.redisClient).toBe(mockRedis);
  });

  it('should expose redis as this.redis on the orchestrator', () => {
    const mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const orch = new MarketMakerOrchestrator({
      truexHost: 'test.host',
      truexPort: 1234,
      senderCompID: 'TEST_SENDER',
      targetCompID: 'TEST_TARGET',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      redisClient: mockRedis,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    expect(orch.redis).toBe(mockRedis);
  });

  it('should work without redisClient (backward compatible)', () => {
    const orch = new MarketMakerOrchestrator({
      truexHost: 'test.host',
      truexPort: 1234,
      senderCompID: 'TEST_SENDER',
      targetCompID: 'TEST_TARGET',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    // Should default to null, not throw
    expect(orch.redis).toBeNull();
    expect(orch.fixOE.redisClient).toBeNull();
  });

  it('should not pass redisClient to fixOE when a custom fixConnection is injected', () => {
    const mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const injectedFix = new MockFIXConnection();

    const orch = new MarketMakerOrchestrator({
      fixConnection: injectedFix,
      redisClient: mockRedis,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    // Injected fix is used as-is; orchestrator should still store redis
    expect(orch.fixOE).toBe(injectedFix);
    expect(orch.redis).toBe(mockRedis);
  });
});
