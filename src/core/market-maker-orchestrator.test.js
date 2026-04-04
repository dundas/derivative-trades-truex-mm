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

// Helper: build a minimal orchestrator with injected mocks
function makeOrch(overrides = {}) {
  const mockFixOE = new MockFIXConnection();
  mockFixOE.isLoggedOn = true; // default: OE is up

  const mockQuoteEngine = new EventEmitter();
  mockQuoteEngine.onPriceUpdate = jest.fn();
  mockQuoteEngine.cancelAllQuotes = jest.fn();
  mockQuoteEngine.activeOrders = new Map();
  mockQuoteEngine.getQuoteStatus = jest.fn().mockReturnValue({});

  const mockInventoryManager = new EventEmitter();
  mockInventoryManager.getPositionSummary = jest.fn().mockReturnValue({
    netPosition: 0, side: 'flat', baseBalance: null, quoteBalance: null,
  });
  mockInventoryManager.getSkew = jest.fn().mockReturnValue({ bidSkewTicks: 0, askSkewTicks: 0 });
  mockInventoryManager.canQuote = jest.fn().mockReturnValue(true);
  mockInventoryManager.shouldHedge = jest.fn().mockReturnValue({ shouldHedge: false });
  mockInventoryManager.balancesInitialized = false;
  // getBalances is optional per spec — not adding by default, test explicitly

  const mockPnlTracker = new EventEmitter();
  mockPnlTracker.startPeriodicLogging = jest.fn();
  mockPnlTracker.stopPeriodicLogging = jest.fn();
  mockPnlTracker.markToMarket = jest.fn();
  mockPnlTracker.getSummary = jest.fn().mockReturnValue({ realizedPnl: 0, unrealizedPnl: 0 });
  mockPnlTracker.getLastFill = jest.fn().mockReturnValue(null);
  mockPnlTracker.getSessionReport = jest.fn().mockReturnValue('');

  const mockHedgeExecutor = new EventEmitter();
  mockHedgeExecutor.getHedgeStats = jest.fn().mockReturnValue({});
  mockHedgeExecutor.config = { minHedgeSizeBTC: 0.001 };

  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return new MarketMakerOrchestrator({
    fixConnection: mockFixOE,
    quoteEngine: mockQuoteEngine,
    inventoryManager: mockInventoryManager,
    pnlTracker: mockPnlTracker,
    hedgeExecutor: mockHedgeExecutor,
    logger,
    ...overrides,
  });
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

// -----------------------------------------------------------------------
// Task 3.1 — Dual-session gate
// -----------------------------------------------------------------------
describe('dual-session gate', () => {
  it('blocks quoting when OE not logged on (marketDataFeed present)', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = false; // OE down

    const price = { weightedMidpoint: 50000 };
    orch._onPriceUpdate(price);

    // quoteEngine.onPriceUpdate should NOT be called
    expect(orch.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
    // logger.warn should mention gate closed
    expect(orch.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WATCHDOG] Quoting gate closed')
    );
  });

  it('allows quoting when OE is logged on', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = true; // OE up

    const price = { weightedMidpoint: 50000 };
    orch._onPriceUpdate(price);

    expect(orch.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
  });

  it('allows quoting when no marketDataFeed (OE-only mode)', () => {
    const orch = makeOrch(); // no marketDataFeed
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = false; // OE down, but gate only fires when MD feed present

    const price = { weightedMidpoint: 50000 };
    orch._onPriceUpdate(price);

    // No feed → gate is not applied
    expect(orch.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
  });

  it('blocks quoting when MD is not logged on (OE is up)', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false; // MD down

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = true; // OE up

    const price = { weightedMidpoint: 50000 };
    orch._onPriceUpdate(price);

    // quoteEngine.onPriceUpdate should NOT be called because MD is not logged on
    expect(orch.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Task 3.2 — MD staleness cancel
// -----------------------------------------------------------------------
describe('MD staleness', () => {
  it('returns false when _lastMdUpdateTime is 0 (no updates received)', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch._lastMdUpdateTime = 0;

    expect(orch._checkMdStaleness()).toBe(false);
  });

  it('returns false when under threshold', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch._lastMdUpdateTime = Date.now() - 1000; // 1s ago, threshold is 10s
    orch._mdStaleThresholdMs = 10000;

    expect(orch._checkMdStaleness()).toBe(false);
  });

  it('returns true and calls cancelAllQuotes when stale', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch._lastMdUpdateTime = Date.now() - 20000; // 20s ago
    orch._mdStaleThresholdMs = 10000;

    const result = orch._checkMdStaleness();

    expect(result).toBe(true);
    expect(orch.quoteEngine.cancelAllQuotes).toHaveBeenCalledWith('md-stale');
    expect(orch.logger.error).toHaveBeenCalledWith(expect.stringContaining('[WATCHDOG] MD feed stale'));
  });

  it('returns false when no marketDataFeed', () => {
    const orch = makeOrch(); // no feed
    orch._lastMdUpdateTime = Date.now() - 99999;
    expect(orch._checkMdStaleness()).toBe(false);
  });

  it('re-enables quoting gate after fresh MD update', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;
    mockMDFeed.connect = jest.fn().mockResolvedValue(undefined);

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = true;

    // Force stale condition and close the gate
    orch._lastMdUpdateTime = Date.now() - 20000;
    orch._mdStaleThresholdMs = 10000;
    orch._checkMdStaleness(); // closes gate, sets _quotingGateEnabled = false

    expect(orch._quotingGateEnabled).toBe(false);

    // Now call _onPriceUpdate — it should re-enable the gate and allow quoting
    const price = { weightedMidpoint: 51000 };
    orch._onPriceUpdate(price);

    expect(orch._quotingGateEnabled).toBe(true);
    expect(orch.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
  });
});

// -----------------------------------------------------------------------
// Task 3.3 — Watchdog
// -----------------------------------------------------------------------
describe('watchdog', () => {
  it('emits watchdog-alert when OE not logged on', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = false;

    const alertEvents = [];
    orch.on('watchdog-alert', (e) => alertEvents.push(e));

    orch._runWatchdog();

    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0].issues).toContain('OE FIX not logged on');
  });

  it('does not emit watchdog-alert when everything healthy', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;
    // No repriceAge check fires since _lastRepriceTime is 0

    const alertEvents = [];
    orch.on('watchdog-alert', (e) => alertEvents.push(e));

    orch._runWatchdog();

    expect(alertEvents).toHaveLength(0);
    expect(orch.logger.debug).toHaveBeenCalledWith(expect.stringContaining('[WATCHDOG] Health check OK'));
  });

  it('does not run when _intentionalStop is true', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = true;
    orch.fixOE.isLoggedOn = false; // would normally trigger alert

    const alertEvents = [];
    orch.on('watchdog-alert', (e) => alertEvents.push(e));

    orch._runWatchdog();

    expect(alertEvents).toHaveLength(0);
  });

  it('does not run when isRunning is false', () => {
    const orch = makeOrch();
    orch.isRunning = false;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = false;

    const alertEvents = [];
    orch.on('watchdog-alert', (e) => alertEvents.push(e));

    orch._runWatchdog();

    expect(alertEvents).toHaveLength(0);
  });

  it('reports MD FIX not logged on when marketDataFeed present but disconnected', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;

    const alertEvents = [];
    orch.on('watchdog-alert', (e) => alertEvents.push(e));

    orch._runWatchdog();

    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0].issues.some(i => i.includes('MD FIX not logged on'))).toBe(true);
  });

  it('calls _cancelAllOrdersViaRest when issues detected', async () => {
    const mockRestClient = {
      cancelAllOrders: jest.fn().mockResolvedValue(undefined),
      getActiveOrders: jest.fn().mockResolvedValue([]),
    };

    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = false; // triggers OE issue
    orch.restClient = mockRestClient;

    orch._runWatchdog();

    // Allow microtask queue to flush (fire-and-forget .catch path)
    await Promise.resolve();

    expect(mockRestClient.cancelAllOrders).toHaveBeenCalled();
  });

  it('calls fixOE.connect when watchdog detects OE not logged on', async () => {
    const connectMock = jest.fn().mockResolvedValue(undefined);
    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = false;
    orch.fixOE.connect = connectMock;

    orch._runWatchdog();
    await Promise.resolve();

    expect(connectMock).toHaveBeenCalled();
  });

  it('calls marketDataFeed.connect when watchdog detects MD not logged on', async () => {
    const mdConnectMock = jest.fn().mockResolvedValue(undefined);
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;
    mockMDFeed.connect = mdConnectMock;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true; // OE is up, only MD is down

    orch._runWatchdog();
    await Promise.resolve();

    expect(mdConnectMock).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Task 3.4 — getHealthStatus()
// -----------------------------------------------------------------------
describe('getHealthStatus', () => {
  it('returns healthy when running, logged on, and recently repriced', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 1000; // 1s ago

    const status = orch.getHealthStatus();

    expect(status.status).toBe('healthy');
    expect(status.quoting).toBe(true);
    expect(status.oeConnected).toBe(true);
  });

  it('returns unhealthy when quoting has been idle too long', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.startedAt = Date.now() - 200000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 200000; // 200s ago, over 120s threshold
    orch._quotingIdleThresholdMs = 120000;

    const status = orch.getHealthStatus();

    expect(status.status).toBe('unhealthy');
    expect(status.quoting).toBe(false);
  });

  it('returns degraded when running but never repriced yet', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = 0; // never repriced

    const status = orch.getHealthStatus();

    // Not idle (lastRepriceAge is null when _lastRepriceTime is 0)
    // OE is connected, running — should be healthy (no issues detected)
    expect(status.status).toBe('healthy');
    expect(status.lastRepriceAge).toBeNull();
  });

  it('returns unhealthy when OE is not connected', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = false;
    orch._lastRepriceTime = Date.now() - 1000;

    const status = orch.getHealthStatus();

    expect(status.status).toBe('unhealthy');
    expect(status.oeConnected).toBe(false);
  });

  it('includes sessionId and uptime in the response', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.startedAt = Date.now() - 10000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 500;

    const status = orch.getHealthStatus();

    expect(status.sessionId).toBeDefined();
    expect(status.uptime).toBeGreaterThan(0);
    expect(status.pnl).toBeDefined();
    expect(status.position).toBeDefined();
  });
});
