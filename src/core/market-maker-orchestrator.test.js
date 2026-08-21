import { describe, it, expect, jest, beforeEach } from 'bun:test';
import { EventEmitter } from 'events';
import { MarketMakerOrchestrator } from './market-maker-orchestrator.js';
import { FIXConnection } from '../fix-protocol/fix-connection.js';

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
  mockQuoteEngine.suspendQuoting = jest.fn();
  mockQuoteEngine.resumeQuoting = jest.fn();
  mockQuoteEngine.invalidateQueuedWork = jest.fn();
  mockQuoteEngine.clearPendingReplacement = jest.fn();
  mockQuoteEngine.activeOrders = new Map();
  mockQuoteEngine.getQuoteStatus = jest.fn().mockReturnValue({});

  const mockInventoryManager = new EventEmitter();
  mockInventoryManager.getPositionSummary = jest.fn().mockReturnValue({
    netPosition: 0, side: 'flat', baseBalance: null, quoteBalance: null, balancesInitialized: false,
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
  it('passes validated FIX liveness settings to the owned connection', () => {
    const orch = new MarketMakerOrchestrator({
      truexHost: 'test.host', truexPort: 1234,
      apiKey: 'test-key', apiSecret: 'test-secret',
      heartbeatInterval: 20,
      testRequestIdleMultiplier: 1.5,
      testRequestTimeoutMultiplier: 0.75,
      maxLivenessDetectionSeconds: 90,
    });
    expect(orch.fixOE.heartbeatInterval).toBe(20);
    expect(orch.fixOE.testRequestIdleMultiplier).toBe(1.5);
    expect(orch.fixOE.testRequestTimeoutMultiplier).toBe(0.75);
    expect(orch.fixOE.maxLivenessDetectionSeconds).toBe(90);
  });

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

describe('strict EBBO presence verification', () => {
  it('uses the strict dispatch predicate, not legacy EBBO freshness', () => {
    const presenceController = { observe: jest.fn().mockReturnValue({ alerts: [] }) };
    const capitalReservationManager = {
      getReservations: jest.fn().mockReturnValue([]),
      getStatus: jest.fn().mockReturnValue({ state: 'normal', blockedSides: [] }),
      getQuoteCapacity: jest.fn().mockReturnValue(1),
    };
    const orch = makeOrch({ presenceController, capitalReservationManager });
    orch.quoteEngine.config = { strictTruexMakerSafety: true };
    orch.quoteEngine._strictEbboState = jest.fn().mockReturnValue({ usable: false });
    orch.quoteEngine._isTruexEbboFresh = jest.fn().mockReturnValue(true);
    orch._lastMdUpdateTime = Date.now();
    orch._lastMidPrice = 100;

    orch._getContinuityStatus();

    expect(presenceController.observe).toHaveBeenCalledWith(expect.objectContaining({ venueHealthy: false }));
    expect(orch.quoteEngine._strictEbboState).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// coinbase-mirror anchor config threads through to the QuoteEngine
// -----------------------------------------------------------------------
describe('MarketMakerOrchestrator — anchor config wiring', () => {
  function makeRealEngineOrch(overrides) {
    return new MarketMakerOrchestrator({
      truexHost: 'test.host', truexPort: 1234,
      senderCompID: 'TEST_SENDER', targetCompID: 'TEST_TARGET',
      apiKey: 'test-key', apiSecret: 'test-secret',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      ...overrides,
    });
  }

  it('forwards quoteAnchorMode, coinbaseAnchorBufferTicks, and anchorExchange to the engine', () => {
    const orch = makeRealEngineOrch({
      quoteAnchorMode: 'coinbase-mirror',
      coinbaseAnchorBufferTicks: 2,
      anchorExchange: 'kraken', // non-default — proves it is actually threaded
    });
    expect(orch.quoteEngine.config.quoteAnchorMode).toBe('coinbase-mirror');
    expect(orch.quoteEngine.config.coinbaseAnchorBufferTicks).toBe(2);
    expect(orch.quoteEngine.config.anchorExchange).toBe('kraken');
  });

  it('forwards self-cross guard timing to the engine', () => {
    const orch = makeRealEngineOrch({
      pendingSelfCrossGuardMs: 1234,
      cancellingSelfCrossGuardMs: 2345,
    });

    expect(orch.quoteEngine.config.pendingSelfCrossGuardMs).toBe(1234);
    expect(orch.quoteEngine.config.cancellingSelfCrossGuardMs).toBe(2345);
  });

  it('forwards observe dispatch mode to the engine', () => {
    const orch = makeRealEngineOrch({ quoteDispatchMode: 'observe' });

    expect(orch.quoteEngine.config.quoteDispatchMode).toBe('observe');
  });

  it('forwards self-match prevention instruction from env when option is unset', () => {
    const previousValue = process.env.TRUEX_SELF_MATCH_PREVENTION_INSTRUCTION;
    process.env.TRUEX_SELF_MATCH_PREVENTION_INSTRUCTION = '1';

    try {
      const orch = makeRealEngineOrch({});

      expect(orch.quoteEngine.config.selfMatchPreventionInstruction).toBe('1');
    } finally {
      if (previousValue === undefined) {
        delete process.env.TRUEX_SELF_MATCH_PREVENTION_INSTRUCTION;
      } else {
        process.env.TRUEX_SELF_MATCH_PREVENTION_INSTRUCTION = previousValue;
      }
    }
  });

  it('defaults to mid mode / coinbase anchor when unset', () => {
    const orch = makeRealEngineOrch({});
    expect(orch.quoteEngine.config.quoteAnchorMode).toBe('mid');
    expect(orch.quoteEngine.config.anchorExchange).toBe('coinbase');
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

  it('blocks quoting when no marketDataFeed and OE is not logged on (OE-only mode)', () => {
    const orch = makeOrch(); // no marketDataFeed
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = false;

    const price = { weightedMidpoint: 50000 };
    orch._onPriceUpdate(price);

    expect(orch.quoteEngine.suspendQuoting).toHaveBeenCalled();
    expect(orch.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
    expect(orch.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
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

  it('reports MD feed not ready when marketDataFeed present but unhealthy', () => {
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
    expect(alertEvents[0].issues.some(i => i.includes('MD feed not ready'))).toBe(true);
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

  it('prefers marketDataFeed.restart when watchdog detects MD not logged on', async () => {
    const mdConnectMock = jest.fn().mockResolvedValue(undefined);
    const mdRestartMock = jest.fn().mockResolvedValue(undefined);
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;
    mockMDFeed.connect = mdConnectMock;
    mockMDFeed.restart = mdRestartMock;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;

    orch._runWatchdog();
    await Promise.resolve();

    expect(mdRestartMock).toHaveBeenCalledTimes(1);
    expect(mdConnectMock).not.toHaveBeenCalled();
  });

  it('calls marketDataFeed.connect only once per watchdog tick when MD is stale', async () => {
    const mdConnectMock = jest.fn().mockResolvedValue(undefined);
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;
    mockMDFeed.connect = mdConnectMock;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;
    orch._lastMdUpdateTime = Date.now() - 130000;
    orch._mdStaleThresholdMs = 120000;

    orch._runWatchdog();
    await Promise.resolve();

    expect(mdConnectMock).toHaveBeenCalledTimes(1);
  });

  it('prefers marketDataFeed.restart when MD is stale', async () => {
    const mdConnectMock = jest.fn().mockResolvedValue(undefined);
    const mdRestartMock = jest.fn().mockResolvedValue(undefined);
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;
    mockMDFeed.connect = mdConnectMock;
    mockMDFeed.restart = mdRestartMock;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;
    orch._lastMdUpdateTime = Date.now() - 130000;
    orch._mdStaleThresholdMs = 120000;

    orch._runWatchdog();
    await Promise.resolve();

    expect(mdRestartMock).toHaveBeenCalledTimes(1);
    expect(mdConnectMock).not.toHaveBeenCalled();
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

  it('surfaces stale execution-critical feeds as degraded without treating observer mode as a live quote path', () => {
    const orch = makeOrch({ truexEbboPollIntervalMs: 1000, pyusdUsdPollIntervalMs: 1000 });
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 1000;
    orch.quoteEngine.config = {
      strictTruexMakerSafety: true,
      quoteDispatchMode: 'observe',
      truexMakerEbboMaxAgeMs: 10000,
    };
    orch._truexEbboLastSuccessAt = Date.now() - 20000;
    orch._truexEbboCurrentBackoffMs = 1500;
    orch._truexEbboPollInFlight = true;
    orch._pyusdUsdLastSuccessAt = Date.now() - 20000;
    orch._pyusdUsdCurrentBackoffMs = 7500;

    const status = orch.getHealthStatus();

    expect(status.status).toBe('degraded');
    expect(status.quoteDispatchMode).toBe('observe');
    expect(status.feedHealth.truexEbbo).toMatchObject({
      enabled: true, fresh: false, requiredForOrderDispatch: true,
      currentBackoffMs: 1500, inFlight: true,
    });
    expect(status.feedHealth.pyusdUsd).toMatchObject({
      enabled: true, fresh: false, requiredForOrderDispatch: false,
      currentBackoffMs: 7500, inFlight: false,
    });
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

  it('sets mdConnected true when marketDataFeed reports logged on (e.g. Coinbase adapter)', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = true;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 1000;

    const status = orch.getHealthStatus();

    expect(status.mdConnected).toBe(true);
    expect(status.status).toBe('healthy');
  });

  it('sets mdConnected false when marketDataFeed is not ready (e.g. stale Coinbase)', () => {
    const mockMDFeed = new EventEmitter();
    mockMDFeed.isLoggedOn = false;

    const orch = makeOrch({ marketDataFeed: mockMDFeed });
    orch.isRunning = true;
    orch.startedAt = Date.now() - 5000;
    orch.fixOE.isLoggedOn = true;
    orch._lastRepriceTime = Date.now() - 1000;

    const status = orch.getHealthStatus();

    expect(status.mdConnected).toBe(false);
    expect(status.status).toBe('unhealthy');
  });
});

// -----------------------------------------------------------------------
// Task 4.3 — AlertManager wired into Orchestrator
// -----------------------------------------------------------------------
describe('AlertManager integration in Orchestrator', () => {
  function makeAlertManager() {
    return {
      sendAlert: jest.fn().mockResolvedValue({ sent: true }),
      sendRecovery: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('alerts at warn level when FIX emits logon-reset-fallback', async () => {
    const mockAlertManager = makeAlertManager();
    const orch = makeOrch({ alertManager: mockAlertManager });
    orch._wireEvents(); // listeners only attached in start() — wire directly for unit test

    orch.fixOE.emit('logon-reset-fallback', {
      targetCompID: 'TRUEX_PROD_OE',
      consecutiveTimeouts: 3,
      threshold: 3,
      fallbackAttempt: 1,
      maxFallbacks: 3,
    });
    await Promise.resolve();

    expect(mockAlertManager.sendAlert).toHaveBeenCalledTimes(1);
    const [arg] = mockAlertManager.sendAlert.mock.calls[0];
    expect(arg.reason).toBe('FIX logon-reset fallback fired');
    expect(arg.level).toBe('warn');
    expect(arg.details.targetCompID).toBe('TRUEX_PROD_OE');
    expect(arg.details.fallbackAttempt).toBe(1);
  });

  it('alerts at error level when FIX emits logon-reset-fallback-exhausted', async () => {
    const mockAlertManager = makeAlertManager();
    const orch = makeOrch({ alertManager: mockAlertManager });
    orch._wireEvents();

    orch.fixOE.emit('logon-reset-fallback-exhausted', {
      targetCompID: 'TRUEX_PROD_OE',
      attempts: 3,
    });
    await Promise.resolve();

    expect(mockAlertManager.sendAlert).toHaveBeenCalledTimes(1);
    const [arg] = mockAlertManager.sendAlert.mock.calls[0];
    expect(arg.reason).toBe('FIX logon-reset fallback exhausted');
    expect(arg.level).toBe('error');
    expect(arg.details.attempts).toBe(3);
  });

  it('calls alertManager.sendAlert when watchdog detects a failure', async () => {
    const mockAlertManager = makeAlertManager();
    const orch = makeOrch({ alertManager: mockAlertManager });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = false; // triggers OE issue

    orch._runWatchdog();
    await Promise.resolve(); // flush fire-and-forget

    expect(mockAlertManager.sendAlert).toHaveBeenCalledTimes(1);
    const [arg] = mockAlertManager.sendAlert.mock.calls[0];
    expect(arg.reason).toContain('OE FIX not logged on');
    expect(arg.level).toBe('error');
  });

  it('calls alertManager.sendRecovery when a watchdog issue clears', async () => {
    const mockAlertManager = makeAlertManager();
    const orch = makeOrch({ alertManager: mockAlertManager });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true;
    orch._activeWatchdogIssues = new Set(['Quoting idle']);
    orch._lastRepriceTime = Date.now() - 1000; // actively quoting
    orch._quotingIdleThresholdMs = 120000;

    orch._runWatchdog();
    await Promise.resolve();

    expect(mockAlertManager.sendRecovery).toHaveBeenCalledTimes(1);
    const [arg] = mockAlertManager.sendRecovery.mock.calls[0];
    expect(arg.reason).toBe('Quoting idle');
    expect(orch._activeWatchdogIssues.has('Quoting idle')).toBe(false);
  });

  it('does not call sendAlert when zero balances suppress the quoting-idle issue', async () => {
    const mockAlertManager = makeAlertManager();
    const orch = makeOrch({ alertManager: mockAlertManager });
    orch.isRunning = true;
    orch._intentionalStop = false;
    orch.fixOE.isLoggedOn = true; // OE fine — no OE issue

    // Quoting idle with ZERO balances — should NOT push the idle issue
    orch._lastRepriceTime = Date.now() - 200000; // 200s ago, well over 120s threshold
    orch._quotingIdleThresholdMs = 120000;
    // inventoryManager.getPositionSummary already returns baseBalance: null, quoteBalance: null
    // which means baseTotal=0, quoteTotal=0, hasBalance=false

    orch._runWatchdog();
    await Promise.resolve();

    expect(mockAlertManager.sendAlert).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Task 2.0 — Balance snapshot job (FR-2)
// -----------------------------------------------------------------------
describe('balance snapshot job', () => {
  function makePostgresManager({ queryFn } = {}) {
    return {
      db: {
        query: queryFn || jest.fn().mockResolvedValue({ rows: [] }),
      },
    };
  }

  function makeInventoryWithBalances(base = 0.044, quote = 100) {
    const inv = new EventEmitter();
    inv.getPositionSummary = jest.fn().mockReturnValue({
      netPosition: 0, side: 'flat',
      baseBalance: { available: base, held: 0, total: base },
      quoteBalance: { available: quote, held: 0, total: quote },
      balancesInitialized: true,
    });
    inv.getSkew = jest.fn().mockReturnValue({ bidSkewTicks: 0, askSkewTicks: 0 });
    inv.canQuote = jest.fn().mockReturnValue(true);
    inv.shouldHedge = jest.fn().mockReturnValue({ shouldHedge: false });
    inv.balancesInitialized = false;
    return inv;
  }

  it('stores _lastMidPrice when _onPriceUpdate fires with weightedMidpoint', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch.fixOE.isLoggedOn = true;

    orch._onPriceUpdate({ weightedMidpoint: 83000 });

    expect(orch._lastMidPrice).toBe(83000);
  });

  it('_lastMidPrice starts as null before any price update', () => {
    const orch = makeOrch();
    expect(orch._lastMidPrice).toBeNull();
  });

  it('_takeBalanceSnapshot inserts a row with correct values', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances(0.044, 200);

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch._lastMidPrice = 83000;
    orch.sessionId = 'test-session-1';

    await orch._takeBalanceSnapshot();

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toContain('INSERT INTO balance_snapshots');
    expect(sql).toContain('ON CONFLICT');            // FR-1.2 deduplication guard
    expect(params[0]).toBe('test-session-1');     // session_id
    expect(typeof params[1]).toBe('number');        // timestamp (unix ms)
    expect(params[2]).toBeCloseTo(0.044, 8);        // btc_qty
    expect(params[3]).toBeCloseTo(200, 4);          // pyusd_qty
    expect(params[4]).toBe(83000);                  // btc_mid_price
    // portfolio_value_pyusd = 0.044 * 83000 + 200 = 3652 + 200 = 3852
    expect(params[5]).toBeCloseTo(3852, 2);
  });

  it('_takeBalanceSnapshot stores null portfolio_value when _lastMidPrice is null', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances(0.044, 200);

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch._lastMidPrice = null;

    await orch._takeBalanceSnapshot();

    const [, params] = querySpy.mock.calls[0];
    expect(params[4]).toBeNull();  // btc_mid_price null
    expect(params[5]).toBeNull();  // portfolio_value_pyusd null
  });

  it('_takeBalanceSnapshot does NOT throw when postgres query fails', async () => {
    const querySpy = jest.fn().mockRejectedValue(new Error('DB down'));
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances();

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });

    // Must not throw
    await expect(orch._takeBalanceSnapshot()).resolves.toBeUndefined();
    expect(orch.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('balance snapshot failed')
    );
  });

  it('_takeBalanceSnapshot is a no-op when postgresManager is absent', async () => {
    const orch = makeOrch(); // no postgresManager
    // Must not throw
    await expect(orch._takeBalanceSnapshot()).resolves.toBeUndefined();
  });

  it('_takeBalanceSnapshot writes zero balances when getPositionSummary returns null balances', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const pgm = makePostgresManager({ queryFn: querySpy });

    const orch = makeOrch({ postgresManager: pgm });
    // default mockInventoryManager returns null baseBalance/quoteBalance → 0 balances inserted
    await expect(orch._takeBalanceSnapshot()).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(1);
    const [, params] = querySpy.mock.calls[0];
    expect(params[2]).toBe(0); // btcQty
    expect(params[3]).toBe(0); // pyusdQty
  });

  it('_snapshotTimer is null before start()', () => {
    const orch = makeOrch();
    expect(orch._snapshotTimer).toBeNull();
  });

  it('stop() clears _snapshotTimer when set', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances();

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch.isRunning = true;
    orch.startedAt = Date.now();
    // Manually plant a fake timer to verify clearInterval is called
    const fakeTimer = setInterval(() => {}, 99999);
    orch._snapshotTimer = fakeTimer;

    try {
      await orch.stop();
      expect(orch._snapshotTimer).toBeNull();
    } finally {
      clearInterval(fakeTimer);
    }
  });

  it('stop() calls _takeBalanceSnapshot for a final snapshot', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances();

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch.isRunning = true;
    orch.startedAt = Date.now();
    orch._lastMidPrice = 83000;

    await orch.stop();

    // At least one INSERT should have been fired during stop()
    expect(querySpy).toHaveBeenCalled();
  });

  it('start() sets _snapshotTimer when postgresManager is present (FR-2.2)', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances();

    // quoteEngine needs drainQueue for start() to work
    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch.quoteEngine.drainQueue = jest.fn();

    await orch.start();

    try {
      expect(orch._snapshotTimer).not.toBeNull();
    } finally {
      // Clean up all timers started by start()
      clearInterval(orch._snapshotTimer);
      clearInterval(orch._watchdogTimer);
      clearInterval(orch.drainQueueTimer);
      orch._snapshotTimer = null;
      orch._watchdogTimer = null;
      orch.drainQueueTimer = null;
      orch.isRunning = false;
    }
  });

  it('start() fires an immediate balance snapshot (FR-2.1)', async () => {
    const querySpy = jest.fn().mockResolvedValue({ rows: [] });
    const pgm = makePostgresManager({ queryFn: querySpy });
    const inv = makeInventoryWithBalances(0.044, 100);

    const orch = makeOrch({ postgresManager: pgm, inventoryManager: inv });
    orch.quoteEngine.drainQueue = jest.fn();
    orch._lastMidPrice = 83000;

    await orch.start();

    try {
      // The startup snapshot must have fired at least once with balance_snapshots SQL
      expect(querySpy).toHaveBeenCalled();
      const sqlCalls = querySpy.mock.calls.map(([sql]) => sql);
      expect(sqlCalls.some(sql => sql.includes('balance_snapshots'))).toBe(true);
    } finally {
      clearInterval(orch._snapshotTimer);
      clearInterval(orch._watchdogTimer);
      clearInterval(orch.drainQueueTimer);
      orch._snapshotTimer = null;
      orch._watchdogTimer = null;
      orch.drainQueueTimer = null;
      orch.isRunning = false;
    }
  });
});

// -----------------------------------------------------------------------
// OE disconnect — inflight order flush
// -----------------------------------------------------------------------
describe('OE disconnect flushes inflight orders', () => {
  it('does not raise a critical FIX loss when owned stop races peer TCP close during Logout', async () => {
    const fix = new FIXConnection({
      host: 'test.host', port: 1234, senderCompID: 'S', targetCompID: 'T',
      apiKey: 'key', apiSecret: 'secret',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = jest.fn(() => { socket.destroyed = true; });
    fix.socket = socket;
    fix._connectionGeneration = 1;
    fix.isConnected = true;
    fix.isLoggedOn = true;
    fix.attemptReconnect = jest.fn();
    let settleLogout;
    fix.sendMessage = jest.fn(() => new Promise((resolve) => { settleLogout = resolve; }));

    const orch = makeOrch({ fixConnection: fix });
    orch._fixConnectionOwned = true;
    orch.isRunning = true;
    orch.startedAt = Date.now();
    orch._wireEvents();
    const critical = jest.fn();
    orch.on('fix_disconnected', critical);

    const stopping = orch.stop();
    while (!settleLogout) await Promise.resolve();
    fix.handleDisconnect(socket, 1);

    expect(critical).not.toHaveBeenCalled();
    expect(fix.attemptReconnect).not.toHaveBeenCalled();
    settleLogout(true);
    await stopping;
  });

  it('does not raise a critical FIX loss when owned stop receives the peer Logout ack', async () => {
    const fix = new FIXConnection({
      host: 'test.host', port: 1234, senderCompID: 'S', targetCompID: 'T',
      apiKey: 'key', apiSecret: 'secret',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = jest.fn(() => { socket.destroyed = true; });
    fix.socket = socket;
    fix._connectionGeneration = 1;
    fix.isConnected = true;
    fix.isLoggedOn = true;
    fix.attemptReconnect = jest.fn();
    let settleLogout;
    fix.sendMessage = jest.fn(() => new Promise((resolve) => { settleLogout = resolve; }));

    const orch = makeOrch({ fixConnection: fix });
    orch._fixConnectionOwned = true;
    orch.isRunning = true;
    orch.startedAt = Date.now();
    orch._wireEvents();
    const critical = jest.fn();
    orch.on('fix_disconnected', critical);

    const stopping = orch.stop();
    while (!settleLogout) await Promise.resolve();
    fix.handleLogout({ fields: { '35': '5', '58': 'ack' } }, socket, 1);

    expect(critical).not.toHaveBeenCalled();
    expect(fix.attemptReconnect).not.toHaveBeenCalled();
    settleLogout(true);
    await stopping;
  });

  it('alerts and reconnects for a genuine unsolicited peer Logout', () => {
    const fix = new FIXConnection({
      host: 'test.host', port: 1234, senderCompID: 'S', targetCompID: 'T',
      apiKey: 'key', apiSecret: 'secret',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = jest.fn(() => { socket.destroyed = true; });
    fix.socket = socket;
    fix._connectionGeneration = 2;
    fix.isConnected = true;
    fix.isLoggedOn = true;
    fix.sendMessage = jest.fn(() => true);
    fix.attemptReconnect = jest.fn();
    const orch = makeOrch({ fixConnection: fix });
    orch.isRunning = true;
    orch._wireEvents();
    const critical = jest.fn();
    orch.on('fix_disconnected', critical);

    fix.handleLogout({ fields: { '35': '5', '58': 'peer shutdown' } }, socket, 2);

    expect(critical).toHaveBeenCalledTimes(1);
    expect(critical).toHaveBeenCalledWith(expect.objectContaining({
      source: 'logout', reason: 'peer-logout',
    }));
    expect(fix.attemptReconnect).toHaveBeenCalledTimes(1);
  });

  it('still forwards a genuine peer transport loss while stop classification is active', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._intentionalStop = true;
    orch._wireEvents();
    const critical = jest.fn();
    orch.on('fix_disconnected', critical);

    orch.fixOE.emit('disconnect', { reason: 'transport-disconnect', generation: 3 });

    expect(critical).toHaveBeenCalledTimes(1);
    expect(critical).toHaveBeenCalledWith(expect.objectContaining({
      source: 'disconnect', reason: 'transport-disconnect',
    }));
  });

  it('ownership-safely forwards liveness and emits one session-loss event for logout plus disconnect', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    const liveness = jest.fn();
    const disconnected = jest.fn();
    orch.on('fix_liveness', liveness);
    orch.on('fix_disconnected', disconnected);

    expect(orch._wireEvents()).toBe(true);
    expect(orch._wireEvents()).toBe(false);
    orch.fixOE.emit('liveness', { state: 'probe-pending', reason: 'inbound-idle' });
    orch.fixOE.emit('logout', { text: 'server logout' });
    // A frame already buffered on the failed socket is not proof of a new,
    // healthy session and must not re-arm the session-loss notification.
    orch.fixOE.emit('message', { fields: { '35': '0', '34': '99' } });
    orch.fixOE.emit('disconnect');

    expect(liveness).toHaveBeenCalledTimes(1);
    expect(liveness).toHaveBeenCalledWith(expect.objectContaining({
      state: 'probe-pending', reason: 'inbound-idle', channel: 'oe',
    }));
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ source: 'logout' }));

    // A normal reconnect emits healthy/logon without requiring a TestRequest.
    // The next independent generation loss must be forwarded again.
    orch.fixOE.emit('liveness', { state: 'healthy', reason: 'logon', generation: 2 });
    orch.fixOE.emit('disconnect', { reason: 'transport-disconnect', generation: 2 });
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(disconnected).toHaveBeenLastCalledWith(expect.objectContaining({
      source: 'disconnect', reason: 'transport-disconnect',
    }));

    expect(orch._unwireEvents()).toBe(true);
    orch.fixOE.emit('liveness', { state: 'failed', reason: 'response-timeout' });
    expect(liveness).toHaveBeenCalledTimes(2);
  });

  it('restores cancelling and pending orders to active on OE disconnect', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._wireEvents();

    orch.quoteEngine.activeOrders.set('ord1', { status: 'cancelling', side: 'buy', level: 1 });
    orch.quoteEngine.activeOrders.set('ord2', { status: 'pending',    side: 'sell', level: 1 });
    orch.quoteEngine.activeOrders.set('ord3', { status: 'active',     side: 'buy', level: 2 });

    orch.fixOE.emit('disconnect');

    expect(orch.quoteEngine.suspendQuoting).toHaveBeenCalled();
    expect(orch.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
    expect(orch.quoteEngine.clearPendingReplacement).toHaveBeenCalledWith('ord1');
    expect(orch.quoteEngine.clearPendingReplacement).toHaveBeenCalledWith('ord2');
    expect(orch.quoteEngine.activeOrders.get('ord1').status).toBe('active');
    expect(orch.quoteEngine.activeOrders.get('ord2').status).toBe('active');
    expect(orch.quoteEngine.activeOrders.has('ord3')).toBe(true);
  });

  it('restores cancelling orders to active on OE logout', () => {
    const orch = makeOrch();
    orch.isRunning = true;
    orch._wireEvents();

    orch.quoteEngine.activeOrders.set('ord1', { status: 'cancelling', side: 'sell', level: 1 });
    orch.quoteEngine.activeOrders.set('ord2', { status: 'active',     side: 'buy',  level: 1 });

    orch.fixOE.emit('logout', { text: 'server logout' });

    expect(orch.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
    expect(orch.quoteEngine.activeOrders.get('ord1').status).toBe('active');
    expect(orch.quoteEngine.activeOrders.has('ord2')).toBe(true);
  });

  it('does nothing when not running', () => {
    const orch = makeOrch();
    orch.isRunning = false;
    orch._wireEvents();

    orch.quoteEngine.activeOrders.set('ord1', { status: 'cancelling', side: 'buy', level: 1 });

    orch.fixOE.emit('disconnect');

    expect(orch.quoteEngine.activeOrders.has('ord1')).toBe(true);
  });
});
