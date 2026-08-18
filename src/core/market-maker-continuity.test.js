import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { MarketMakerOrchestrator } from './market-maker-orchestrator.js';
import { MakerPresenceController } from './maker-presence-controller.js';
import { QuoteEngine } from './quote-engine.js';

const continuity = {
  minActiveLevelsPerSide: 1, minimumFundedQuoteSize: 0.0001,
  l1ReserveBase: 0.01, l1ReserveQuote: 10, maxSideGapMs: 1000,
  alertThresholdMs: 500, alertRateLimitMs: 2000,
  degradedMaxLevels: 1, degradedSizeFactor: 0.5, defensiveSpreadFloorBps: 80,
};

const balances = {
  baseBalance: { available: 0.0168, held: 0, total: 0.0168 },
  quoteBalance: { available: 1000, held: 0, total: 1000 },
};

function makeStartupOrchestrator(extraOptions = {}) {
  const fixOE = Object.assign(new EventEmitter(), {
    isConnected: false,
    isLoggedOn: false,
    connect: mock(async function connect() { this.isConnected = true; this.isLoggedOn = true; }),
    disconnect: mock(async function disconnect() { this.isConnected = false; this.isLoggedOn = false; }),
    sendMessage: mock(() => {}),
  });
  const quoteEngine = Object.assign(new EventEmitter(), {
    activeOrders: new Map(),
    drainQueue: mock(() => {}),
    cancelAllQuotes: mock(() => {}),
    suspendQuoting: mock(() => {}),
    resumeQuoting: mock(() => {}),
    invalidateQueuedWork: mock(() => {}),
    clearPendingReplacement: mock(() => {}),
    getQuoteStatus: mock(() => ({})),
  });
  const inventoryManager = Object.assign(new EventEmitter(), {
    balancesInitialized: false,
    canQuote: mock(() => true),
    getPositionSummary: mock(() => ({ netPosition: 0, balancesInitialized: false })),
    shouldHedge: mock(() => ({ shouldHedge: false })),
  });
  const pnlTracker = Object.assign(new EventEmitter(), {
    startPeriodicLogging: mock(() => {}), stopPeriodicLogging: mock(() => {}),
    getSummary: mock(() => ({})), getSessionReport: mock(() => ''), getLastFill: mock(() => null),
  });
  const hedgeExecutor = Object.assign(new EventEmitter(), {
    config: { minHedgeSizeBTC: 0.001 }, getHedgeStats: mock(() => ({})),
  });
  return new MarketMakerOrchestrator({
    fixConnection: fixOE, quoteEngine, inventoryManager, pnlTracker, hedgeExecutor,
    marketDataFeed: null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...extraOptions,
  });
}

describe('MarketMakerOrchestrator continuity binding', () => {
  test('feeds the current controller state into QuoteEngine before each reprice', () => {
    const order = [];
    const status = { executionState: 'degraded', reasons: ['missing-acknowledged-sell'] };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      fixOE: { isLoggedOn: true }, marketDataFeed: null,
      pnlTracker: { markToMarket() {} }, _quotingGateEnabled: true,
      _getContinuityStatus: () => status,
      quoteEngine: {
        resumeQuoting() {},
        setContinuityState(value) { expect(value).toBe(status); order.push('state'); },
        onPriceUpdate() { order.push('reprice'); },
      },
    });
    orchestrator._onPriceUpdate({ weightedMidpoint: 100000 });
    expect(order).toEqual(['state', 'reprice']);
  });

  test('persists emergency unsafe state and counts acknowledged reserved capacity as funded', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({
      baseBalance: { available: 0.01, held: 0, total: 0.01 },
      quoteBalance: { available: 0, held: 0, total: 0 }, liveOrders: [],
    });
    capital.reserve({ orderId: 'safe-ask', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('safe-ask');
    capital.reconciliationFailed();
    const controller = new MakerPresenceController(continuity, { now: () => 1000 });
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      capitalReservationManager: capital, presenceController: controller,
      fixOE: { isLoggedOn: true }, _lastMdUpdateTime: 1000, _mdStaleThresholdMs: Number.MAX_SAFE_INTEGER,
      _lastMidPrice: 100000, quoteEngine: { lastMid: 100000, cancelAllQuotes: mock(() => {}) },
      _emergencyUnsafe: false, alertManager: { sendAlert: async () => {} },
      logger: { error() {} }, emit() {},
    });
    expect(orchestrator._getContinuityStatus().reasons).not.toContain('reconciliation-failed-no-safe-l1');
    orchestrator._onEmergency({ netPosition: 0.1, reason: 'limit' });
    expect(orchestrator._getContinuityStatus()).toMatchObject({
      executionState: 'unsafe', reasons: expect.arrayContaining(['emergency-kill-switch']),
    });
  });

  test('unblocks an insufficient side only after balance and live-order resync succeeds', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.insufficientFunds('sell');
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      inventoryManager: { refreshBalances: mock(() => {}) },
      _fetchBalances: mock(async () => balances),
      _fetchCapitalLiveOrders: mock(async () => []),
      logger: { warn() {} },
    });

    await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
    expect(capital.getStatus().blockedSides).toEqual([]);
    expect(orchestrator.inventoryManager.refreshBalances).toHaveBeenCalledTimes(1);
  });

  test('keeps the side blocked and marks reconciliation failed when live-order resync fails', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.insufficientFunds('sell');
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      inventoryManager: { refreshBalances() {} },
      _fetchBalances: async () => balances,
      _fetchCapitalLiveOrders: async () => { throw new Error('REST unavailable'); },
      logger: { warn() {} },
    });

    await expect(orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true })).rejects.toThrow('REST unavailable');
    expect(capital.getStatus()).toMatchObject({ state: 'failed', blockedSides: ['sell'] });
  });

  test('does not route missing-side degradation into the generic cancel-all watchdog', () => {
    const cancelAll = mock(async () => {});
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      _intentionalStop: false,
      _getContinuityStatus: mock(() => ({ executionState: 'degraded', reasons: ['missing-acknowledged-sell'] })),
      fixOE: { isLoggedOn: true },
      marketDataFeed: null,
      _checkMdStaleness: () => false,
      _lastRepriceTime: Date.now(),
      _quotingIdleThresholdMs: 30000,
      _activeWatchdogIssues: new Set(),
      inventoryManager: { getPositionSummary: () => ({}) },
      alertManager: { sendRecovery: async () => {}, sendAlert: async () => {} },
      restClient: { cancelAllOrders: cancelAll },
      logger: { debug() {}, error() {}, info() {} },
      emit() {},
    });

    orchestrator._runWatchdog();
    expect(cancelAll).not.toHaveBeenCalled();
  });
});

describe('MarketMakerOrchestrator strict startup reconciliation', () => {
  const rawOrder = (id, externalId, status = 'OPEN') => ({
    id,
    external_id: externalId,
    status,
    order_info: {
      side: 'SELL', type: 'LIMIT', instrument_id: 'btc-pyusd', price: '100000', qty: '0.01',
    },
    pending_qty: '0', leaves_qty: '0.01', exeuted_qty: '0', executed_vwap: '0',
  });

  test('strictly validates configurable startup cancel verification bounds', () => {
    expect(makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
    })).toMatchObject({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
    });
    for (const options of [
      { startupCancelVerifyTimeoutMs: 0 },
      { startupCancelVerifyTimeoutMs: 1.5 },
      { startupCancelVerifyIntervalMs: -1 },
      { startupCancelVerifyTimeoutMs: 10, startupCancelVerifyIntervalMs: 20 },
    ]) {
      expect(() => makeStartupOrchestrator(options)).toThrow();
    }
  });

  test('awaits strict pre-start reconciliation before FIX connection or quoting eligibility', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = {};
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator._initializeBalances = mock(async () => {});
    let releaseReconciliation;
    orchestrator._restReconcile = mock(() => new Promise((resolve) => {
      releaseReconciliation = () => resolve({ exchange: 0, local: 0, matched: 0, orphansCancelled: 0, ghostsRemoved: 0 });
    }));

    const starting = orchestrator.start();
    while (!releaseReconciliation) await Promise.resolve();
    expect(orchestrator._restReconcile).toHaveBeenCalledWith({ allowPreStart: true, strict: true });
    expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
    expect(orchestrator.isRunning).toBe(false);
    releaseReconciliation();
    await starting;
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(1);
    expect(orchestrator.isRunning).toBe(true);

    orchestrator.restClient = null;
    await orchestrator.stop();
  });

  test('orphan cancellation failure aborts startup before FIX connection', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [rawOrder('venue-1', 'old-session-order')]),
      cancelOrder: mock(async () => { throw new Error('cancel rejected'); }),
    };
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator._initializeBalances = mock(async () => {});

    await expect(orchestrator.start()).rejects.toThrow('cancel rejected');
    expect(orchestrator.restClient.cancelOrder).toHaveBeenCalledWith('venue-1');
    expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
    expect(orchestrator.isRunning).toBe(false);
  });

  test('strict startup waits for cancel-pending orders to become terminal', async () => {
    let now = 0;
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-pending', 'prior-session', 'CANCEL_PENDING')])
      .mockResolvedValueOnce([rawOrder('venue-pending', 'prior-session', 'CANCELED')]);
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = { getActiveOrders, cancelOrder: mock(async () => {}) };
    orchestrator.startupCancelVerifyTimeoutMs = 100;
    orchestrator.startupCancelVerifyIntervalMs = 10;
    orchestrator._now = () => now;
    orchestrator._sleep = mock(async (ms) => { now += ms; });

    const stats = await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(getActiveOrders).toHaveBeenCalledTimes(2);
    expect(orchestrator._sleep).toHaveBeenCalledWith(10);
    expect(orchestrator.restClient.cancelOrder).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ exchange: 0, orphansCancelled: 0, ghostsRemoved: 0 });
  });

  test('strict startup aborts after the configured cancel-pending verification bound', async () => {
    let now = 0;
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [rawOrder('venue-pending', 'prior-session', 'CANCEL_PENDING')]),
      cancelOrder: mock(async () => {}),
    };
    orchestrator.startupCancelVerifyTimeoutMs = 20;
    orchestrator.startupCancelVerifyIntervalMs = 10;
    orchestrator._now = () => now;
    orchestrator._sleep = mock(async (ms) => { now += ms; });

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('cancel-pending verification timed out');
    expect(orchestrator.restClient.getActiveOrders).toHaveBeenCalledTimes(3);
    expect(orchestrator.restClient.cancelOrder).not.toHaveBeenCalled();
  });

  test('strict startup rejects malformed or duplicate cancel-pending identities', async () => {
    const malformed = rawOrder('venue-pending', 'prior-session', 'CANCEL_PENDING');
    malformed.external_id = '';
    const duplicateA = rawOrder('venue-a', 'duplicate', 'CANCEL_PENDING');
    const duplicateB = rawOrder('venue-b', 'duplicate', 'CANCEL_PENDING');
    for (const rows of [[malformed], [duplicateA, duplicateB]]) {
      const orchestrator = makeStartupOrchestrator();
      orchestrator.restClient = { getActiveOrders: mock(async () => rows) };
      orchestrator.startupCancelVerifyTimeoutMs = 20;
      orchestrator.startupCancelVerifyIntervalMs = 10;
      await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
        .rejects.toThrow('invalid cancel-pending identity');
    }
  });

  test('strict startup verifies newly cancelled ACTIVE orphan terminal before succeeding', async () => {
    let now = 0;
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-active', 'prior-active', 'ACTIVE')])
      .mockResolvedValueOnce([rawOrder('venue-active', 'prior-active', 'CANCEL_PENDING')])
      .mockResolvedValueOnce([rawOrder('venue-active', 'prior-active', 'CANCELED')]);
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = { getActiveOrders, cancelOrder };

    const stats = await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('venue-active');
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
    expect(stats).toMatchObject({ orphansCancelled: 1, ghostsRemoved: 0 });
  });

  test('strict startup aborts when newly cancelled orphan stays ACTIVE through the shared bound', async () => {
    let now = 0;
    const active = rawOrder('venue-active', 'prior-active', 'ACTIVE');
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [active]),
      cancelOrder: mock(async () => {}),
    };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('orphan cancellation verification timed out');
    expect(orchestrator.restClient.cancelOrder).toHaveBeenCalledTimes(1);
    expect(orchestrator.restClient.getActiveOrders).toHaveBeenCalledTimes(3);
  });

  test('strict startup rejects mismatched, duplicate, or malformed targeted cancellation evidence', async () => {
    const initial = rawOrder('venue-active', 'prior-active', 'ACTIVE');
    const evidenceCases = [
      [rawOrder('venue-active', 'different-external', 'CANCEL_PENDING')],
      [
        rawOrder('venue-active', 'prior-active', 'CANCEL_PENDING'),
        rawOrder('venue-active', 'prior-active', 'CANCEL_PENDING'),
      ],
      [{ ...rawOrder('venue-active', 'prior-active', 'CANCEL_PENDING'), external_id: '' }],
    ];
    for (const evidence of evidenceCases) {
      let now = 0;
      const orchestrator = makeStartupOrchestrator({
        startupCancelVerifyTimeoutMs: 20,
        startupCancelVerifyIntervalMs: 10,
        now: () => now,
        sleep: async (ms) => { now += ms; },
      });
      orchestrator.restClient = {
        getActiveOrders: mock()
          .mockResolvedValueOnce([initial])
          .mockResolvedValueOnce(evidence),
        cancelOrder: mock(async () => {}),
      };
      await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
        .rejects.toThrow('invalid orphan cancellation identity');
      expect(orchestrator.restClient.cancelOrder).toHaveBeenCalledTimes(1);
    }
  });

  test('strict startup rejects malformed or duplicate ACTIVE orphan identities before cancellation', async () => {
    const malformed = rawOrder('venue-active', '', 'ACTIVE');
    const duplicateA = rawOrder('venue-a', 'duplicate-active', 'ACTIVE');
    const duplicateB = rawOrder('venue-b', 'duplicate-active', 'ACTIVE');
    for (const rows of [[malformed], [duplicateA, duplicateB]]) {
      const cancelOrder = mock(async () => {});
      const orchestrator = makeStartupOrchestrator();
      orchestrator.restClient = { getActiveOrders: mock(async () => rows), cancelOrder };
      await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
        .rejects.toThrow('invalid orphan cancellation identity');
      expect(cancelOrder).not.toHaveBeenCalled();
    }
  });

  test('strict startup waits for unrelated transitional rows without cancelling them', async () => {
    let now = 0;
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-active', 'prior-active', 'ACTIVE')])
      .mockResolvedValueOnce([
        rawOrder('venue-active', 'prior-active', 'CANCELED'),
        rawOrder('venue-other', 'unrelated', 'CANCEL_PENDING'),
      ])
      .mockResolvedValueOnce([rawOrder('venue-other', 'unrelated', 'CANCELED')]);
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = { getActiveOrders, cancelOrder };

    await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('venue-active');
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
  });

  test('strict startup rejects an initial REST response that completes beyond the shared deadline', async () => {
    let now = 0;
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = {
      getActiveOrders: mock(async () => { now = 21; return []; }),
      cancelOrder: mock(async () => {}),
    };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('startup verification timed out');
    expect(orchestrator.restClient.getActiveOrders).toHaveBeenCalledTimes(1);
  });

  test('strict startup applies the same deadline to a generation follow-up REST response', async () => {
    let now = 0;
    const activeOrders = new Map();
    const getActiveOrders = mock()
      .mockImplementationOnce(async () => {
        activeOrders.set('born-during-request', {
          side: 'sell', size: 0.01, price: 100000, level: 1,
          status: 'active', acknowledgedLive: true,
        });
        return [];
      })
      .mockImplementationOnce(async () => {
        now = 21;
        return [rawOrder('venue-born', 'born-during-request', 'ACTIVE')];
      });
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.quoteEngine.activeOrders = activeOrders;
    orchestrator.quoteEngine.removeStaleOrder = mock(() => false);
    orchestrator.restClient = { getActiveOrders, cancelOrder: mock(async () => {}) };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('startup verification timed out');
    expect(getActiveOrders).toHaveBeenCalledTimes(2);
    expect(activeOrders.has('born-during-request')).toBe(true);
  });

  test('strict startup carries orphan cancellation targets into a generation follow-up', async () => {
    let now = 0;
    const activeOrders = new Map();
    const reappeared = () => [
      rawOrder('venue-a', 'orphan-a', 'ACTIVE'),
      rawOrder('venue-born', 'born-during-request', 'ACTIVE'),
    ];
    const getActiveOrders = mock()
      .mockImplementationOnce(async () => {
        activeOrders.set('born-during-request', {
          side: 'sell', size: 0.01, price: 100000, level: 1,
          status: 'active', acknowledgedLive: true,
        });
        return [rawOrder('venue-a', 'orphan-a', 'ACTIVE')];
      })
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'CANCELED'),
        rawOrder('venue-born', 'born-during-request', 'ACTIVE'),
      ])
      .mockImplementation(async () => reappeared());
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 30,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.quoteEngine.activeOrders = activeOrders;
    orchestrator.quoteEngine.removeStaleOrder = mock(() => false);
    orchestrator.restClient = { getActiveOrders, cancelOrder };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('orphan cancellation verification timed out');
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('venue-a');
    expect(activeOrders.has('born-during-request')).toBe(true);
  });

  test('strict startup keeps cancelled targets sticky through unrelated transitional settlement', async () => {
    let now = 0;
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'ACTIVE')])
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'CANCELED'),
        rawOrder('venue-b', 'unrelated-b', 'CANCEL_PENDING'),
      ])
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'ACTIVE'),
        rawOrder('venue-b', 'unrelated-b', 'CANCELED'),
      ]);
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = { getActiveOrders, cancelOrder };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('orphan cancellation verification timed out');
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
  });

  test('strict startup rejects an unrelated order that becomes ACTIVE during post-cancel polling', async () => {
    let now = 0;
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'ACTIVE')])
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'CANCELED'),
        rawOrder('venue-b', 'unrelated-b', 'CANCEL_PENDING'),
      ])
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'CANCELED'),
        rawOrder('venue-b', 'unrelated-b', 'ACTIVE'),
      ]);
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    orchestrator.restClient = { getActiveOrders, cancelOrder };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('new unmatched order in post-scan snapshot');
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('venue-a');
    expect(cancelOrder).not.toHaveBeenCalledWith('venue-b');
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
  });

  test('strict startup uses the validated post-cancel snapshot for stable local ghost decisions', async () => {
    let now = 0;
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection: { sendMessage: mock(() => {}) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const localId = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    engine.onExecutionReport({ '11': localId, '39': '0', '54': '2' });
    const localRaw = rawOrder('venue-local', localId, 'ACTIVE');
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'ACTIVE')])
      .mockResolvedValueOnce([
        rawOrder('venue-a', 'orphan-a', 'CANCELED'),
        localRaw,
      ]);
    const cancelOrder = mock(async () => {});
    engine.drainQueue = mock(() => {});
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: false,
      startupCancelVerifyTimeoutMs: 20,
      startupCancelVerifyIntervalMs: 10,
      _now: () => now,
      _sleep: async (ms) => { now += ms; },
      restClient: { getActiveOrders, cancelOrder },
      quoteEngine: engine,
      capitalReservationManager: capital,
      _onCapitalResyncRequired: mock(async () => {}),
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    const stats = await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(cancelOrder).toHaveBeenCalledWith('venue-a');
    expect(stats.ghostsRemoved).toBe(0);
    expect(engine.activeOrders.has(localId)).toBe(true);
    expect(capital.getReservation(localId)).toMatchObject({
      state: 'active', acknowledgedLive: true,
    });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(orchestrator._onCapitalResyncRequired).not.toHaveBeenCalled();
  });

  test('strict startup follows a local mutation that occurs during post-cancel verification', async () => {
    let now = 0;
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection: { sendMessage: mock(() => {}) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const localId = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    engine.onExecutionReport({ '11': localId, '39': '0', '54': '2' });
    const freshLocal = () => {
      const raw = rawOrder('venue-local', localId, 'ACTIVE');
      raw.order_info.price = '100001';
      return raw;
    };
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'ACTIVE')])
      .mockImplementationOnce(async () => {
        engine.activeOrders.get(localId).price = 100001;
        return [rawOrder('venue-a', 'orphan-a', 'CANCELED'), freshLocal()];
      })
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'CANCELED'), freshLocal()]);
    const cancelOrder = mock(async () => {});
    engine.drainQueue = mock(() => {});
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: false,
      startupCancelVerifyTimeoutMs: 30,
      startupCancelVerifyIntervalMs: 10,
      _now: () => now,
      _sleep: async (ms) => { now += ms; },
      restClient: { getActiveOrders, cancelOrder },
      quoteEngine: engine,
      capitalReservationManager: capital,
      _onCapitalResyncRequired: mock(async () => {}),
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    const stats = await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
    expect(stats.generationChanged).toBe(true);
    expect(stats.followup).toMatchObject({ generationChanged: false, ghostsRemoved: 0 });
    expect(engine.activeOrders.get(localId)).toMatchObject({ price: 100001, acknowledgedLive: true });
    expect(capital.getReservation(localId)).toMatchObject({ state: 'active', acknowledgedLive: true });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(orchestrator._onCapitalResyncRequired).not.toHaveBeenCalled();
  });

  test('strict startup aborts if the single bounded generation follow-up mutates again', async () => {
    let now = 0;
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection: { sendMessage: mock(() => {}) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const localId = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    engine.onExecutionReport({ '11': localId, '39': '0', '54': '2' });
    const localRaw = (price) => {
      const raw = rawOrder('venue-local', localId, 'ACTIVE');
      raw.order_info.price = String(price);
      return raw;
    };
    const getActiveOrders = mock()
      .mockResolvedValueOnce([rawOrder('venue-a', 'orphan-a', 'ACTIVE')])
      .mockImplementationOnce(async () => {
        engine.activeOrders.get(localId).price = 100001;
        return [rawOrder('venue-a', 'orphan-a', 'CANCELED'), localRaw(100001)];
      })
      .mockImplementationOnce(async () => {
        engine.activeOrders.get(localId).price = 100002;
        return [rawOrder('venue-a', 'orphan-a', 'CANCELED'), localRaw(100002)];
      });
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: false,
      startupCancelVerifyTimeoutMs: 30,
      startupCancelVerifyIntervalMs: 10,
      _now: () => now,
      _sleep: async (ms) => { now += ms; },
      restClient: { getActiveOrders, cancelOrder: mock(async () => {}) },
      quoteEngine: engine,
      capitalReservationManager: capital,
      _onCapitalResyncRequired: mock(async () => {}),
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('startup reconciliation remained unstable');
    expect(getActiveOrders).toHaveBeenCalledTimes(3);
    expect(engine.activeOrders.get(localId)).toMatchObject({ price: 100002, acknowledgedLive: true });
    expect(capital.getReservation(localId)).toMatchObject({ state: 'active', acknowledgedLive: true });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(orchestrator._onCapitalResyncRequired).not.toHaveBeenCalled();
  });

  test('ordinary reconciliation remains a pre-start no-op', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = { getActiveOrders: mock(async () => []) };
    expect(await orchestrator._restReconcile()).toBeUndefined();
    expect(orchestrator.restClient.getActiveOrders).not.toHaveBeenCalled();
  });

  test('New acknowledgement during a REST request is excluded from the stale snapshot and checked fresh', async () => {
    let releaseFirst;
    const getActiveOrders = mock()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve([]); }))
      .mockResolvedValueOnce([rawOrder('venue-new-ack', 'new-ack')]);
    const order = {
      side: 'sell', size: 0.01, price: 100000, level: 1,
      status: 'pending', acknowledgedLive: false,
    };
    const quoteEngine = {
      activeOrders: new Map([['new-ack', order]]),
      removeStaleOrder: mock(() => { quoteEngine.activeOrders.delete('new-ack'); return true; }),
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: { getActiveOrders, cancelOrder: mock(async () => {}) },
      quoteEngine,
      capitalReservationManager: null,
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    const reconciling = orchestrator._restReconcile();
    while (!releaseFirst) await Promise.resolve();
    order.status = 'active';
    order.acknowledgedLive = true;
    releaseFirst();
    await reconciling;

    expect(getActiveOrders).toHaveBeenCalledTimes(2);
    expect(quoteEngine.removeStaleOrder).not.toHaveBeenCalled();
    expect(quoteEngine.activeOrders.has('new-ack')).toBe(true);
  });

  test('active order born during a REST request is excluded from the stale snapshot and checked fresh', async () => {
    let releaseFirst;
    const getActiveOrders = mock()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve([]); }))
      .mockResolvedValueOnce([rawOrder('venue-born', 'born-during-request')]);
    const quoteEngine = {
      activeOrders: new Map(),
      removeStaleOrder: mock((orderId) => { quoteEngine.activeOrders.delete(orderId); return true; }),
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: { getActiveOrders, cancelOrder: mock(async () => {}) },
      quoteEngine,
      capitalReservationManager: null,
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    const reconciling = orchestrator._restReconcile();
    while (!releaseFirst) await Promise.resolve();
    quoteEngine.activeOrders.set('born-during-request', {
      side: 'sell', size: 0.01, price: 100000, level: 1,
      status: 'active', acknowledgedLive: true,
    });
    releaseFirst();
    await reconciling;

    expect(getActiveOrders).toHaveBeenCalledTimes(2);
    expect(quoteEngine.removeStaleOrder).not.toHaveBeenCalled();
    expect(quoteEngine.activeOrders.has('born-during-request')).toBe(true);
  });

  test('runtime ghost removal awaits the coalesced capital resync', async () => {
    let releaseResync;
    let reconcileFinished = false;
    const quoteEngine = {
      activeOrders: new Map([['ghost', { status: 'active' }]]),
      removeStaleOrder: mock(() => {
        quoteEngine.activeOrders.delete('ghost');
        return true;
      }),
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: { getActiveOrders: mock(async () => []) },
      quoteEngine,
      capitalReservationManager: {},
      _onCapitalResyncRequired: mock(() => new Promise((resolve) => { releaseResync = resolve; })),
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    const reconciling = orchestrator._restReconcile().then(() => { reconcileFinished = true; });
    for (let turn = 0; turn < 5 && !releaseResync; turn++) await Promise.resolve();
    expect(typeof releaseResync).toBe('function');
    expect(reconcileFinished).toBe(false);
    expect(orchestrator._onCapitalResyncRequired).toHaveBeenCalledWith({
      side: 'unknown', reason: 'rest-order-absence-unknown-outcome',
    });
    releaseResync();
    await reconciling;
    expect(reconcileFinished).toBe(true);
  });

  test('failed runtime ghost resync leaves the affected side blocked and failed', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 0.01, held: 0, total: 0.01 },
      quoteBalance: { available: 1000, held: 0, total: 1000 }, liveOrders: [],
    });
    capital.reserve({ orderId: 'ghost', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('ghost');
    const quoteEngine = {
      activeOrders: new Map([['ghost', { side: 'sell', status: 'active' }]]),
      removeStaleOrder(orderId) {
        this.activeOrders.delete(orderId);
        capital.restOrderAbsent(orderId);
        return true;
      },
      drainQueue: mock(() => {}),
      deferredRepriceNeeded: false,
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: { getActiveOrders: mock(async () => []) },
      quoteEngine,
      capitalReservationManager: capital,
      _capitalResyncInFlight: null,
      _capitalResyncPending: false,
      _refreshBalances: mock(async () => {
        capital.reconciliationFailed();
        throw new Error('fresh snapshot unavailable');
      }),
      logger: { info() {}, warn() {}, error() {} },
      emit() {}, listenerCount: () => 0,
    });

    await orchestrator._restReconcile();
    expect(orchestrator._refreshBalances).toHaveBeenCalledWith({
      requireLiveOrders: true, clearBlockedSides: true,
    });
    expect(capital.getStatus()).toMatchObject({ state: 'failed', blockedSides: ['sell'] });
    expect(capital.reserve({
      orderId: 'unsafe-reuse', side: 'sell', size: 0.01, price: 100000, level: 1,
    })).toMatchObject({ accepted: false, reason: 'capital-reconciliation-failed' });
  });

  test('periodic recovery retries a failed capital resync with one fresh coherent snapshot', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.insufficientFunds('sell');
    let releaseFreshSnapshot;
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      inventoryManager: { refreshBalances: mock(() => {}) },
      quoteEngine: { deferredRepriceNeeded: false, drainQueue: mock(() => {}) },
      _capitalResyncInFlight: null,
      _capitalResyncPending: false,
      _fetchBalances: mock(async () => balances),
      _fetchCapitalLiveOrders: mock()
        .mockRejectedValueOnce(new Error('REST unavailable'))
        .mockImplementationOnce(() => new Promise((resolve) => { releaseFreshSnapshot = () => resolve([]); })),
      logger: { info() {}, warn() {}, error() {} },
    });

    await orchestrator._onCapitalResyncRequired({ side: 'sell', reason: 'insufficient-funds' });
    expect(capital.getStatus()).toMatchObject({ state: 'failed', blockedSides: ['sell'] });

    const firstTick = orchestrator._periodicBalanceRefresh();
    const overlappingTick = orchestrator._periodicBalanceRefresh();
    for (let turn = 0; turn < 5 && !releaseFreshSnapshot; turn++) await Promise.resolve();
    expect(typeof releaseFreshSnapshot).toBe('function');
    expect(orchestrator._fetchCapitalLiveOrders).toHaveBeenCalledTimes(2);
    releaseFreshSnapshot();
    await Promise.all([firstTick, overlappingTick]);

    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });
    expect(orchestrator.inventoryManager.refreshBalances).toHaveBeenCalledTimes(1);
    expect(capital.reserve({
      orderId: 'recovered-ask', side: 'sell', size: 0.001, price: 100000, level: 1,
    }).accepted).toBe(true);
  });

  test('lost cancel ack removes stale local replacement state before a second fresh snapshot unblocks', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection: { sendMessage: mock(() => {}) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const orderId = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine.pendingReplacements.set(orderId, {
      quote: { side: 'sell', size: 0.01, price: 100001, level: 1 },
      expiresAt: Date.now() - 1,
    });
    engine.cancelAllQuotes('lost-cancel-ack-test');
    const cancelId = [...engine.cancelToOrigMap.entries()]
      .find(([, originalId]) => originalId === orderId)?.[0];
    expect(cancelId).toBeString();
    expect(engine.activeOrders.has(orderId)).toBe(false);
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'cancel-in-flight', acknowledgedLive: true,
    });
    let releaseSecondSnapshot;
    const fetchLiveOrders = mock()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseSecondSnapshot = () => resolve([]);
      }));
    engine.drainQueue = mock(() => {});
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      quoteEngine: engine,
      inventoryManager: { refreshBalances: mock(() => {}) },
      _capitalResyncInFlight: null,
      _capitalResyncPending: false,
      _fetchBalances: mock(async () => balances),
      _fetchCapitalLiveOrders: fetchLiveOrders,
      logger: { info() {}, warn() {}, error() {} },
    });

    const recovering = orchestrator._onCapitalResyncRequired({
      side: 'sell', reason: 'lost-cancel-ack',
    });
    for (let turn = 0; turn < 10 && !releaseSecondSnapshot; turn++) await Promise.resolve();
    expect(typeof releaseSecondSnapshot).toBe('function');
    expect(engine.activeOrders.has(orderId)).toBe(false);
    expect(engine.pendingReplacements.has(orderId)).toBe(false);
    expect([...engine.cancelToOrigMap.values()]).not.toContain(orderId);
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'rest-absence-evidence-gap', acknowledgedLive: false,
    });
    expect(capital.getStatus()).toMatchObject({ state: 'degraded', blockedSides: ['sell'] });
    expect(capital.reserve({
      orderId: 'premature-reuse', side: 'sell', size: 0.001, price: 100000, level: 1,
    }).accepted).toBe(false);

    releaseSecondSnapshot();
    await recovering;
    expect(fetchLiveOrders).toHaveBeenCalledTimes(2);
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });
    engine._expirePendingReplacements();
    expect(engine.activeOrders.has(orderId)).toBe(false);

    engine.onExecutionReport({
      '11': orderId, '39': '2', '54': '2', '17': 'delayed-terminal',
      '31': '100000', '32': '0.01', '151': '0',
    });
    engine.onExecutionReport({ '11': cancelId, '41': orderId, '39': '4', '54': '2' });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 0 });
    expect(capital.consumedEvents).toHaveLength(0);
    expect(engine.deferredRepriceNeeded).toBe(true);
  });

  test('coherent live-order snapshot retains healthy acknowledged local order', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const activeOrders = new Map([['healthy', {
      side: 'buy', size: 0.001, price: 100000, level: 1, status: 'active', acknowledgedLive: true,
    }]]);
    capital.reserve({ orderId: 'healthy', side: 'buy', size: 0.001, price: 100000, level: 1 });
    capital.accept('healthy');
    const quoteEngine = {
      activeOrders,
      removeStaleOrder: mock(() => false),
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      quoteEngine,
      inventoryManager: { refreshBalances: mock(() => {}) },
      _capitalResyncInFlight: null,
      _fetchBalances: mock(async () => balances),
      _fetchCapitalLiveOrders: mock(async () => [{ orderId: 'healthy' }]),
      logger: { warn() {} },
    });

    await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
    expect(quoteEngine.removeStaleOrder).not.toHaveBeenCalled();
    expect(activeOrders.has('healthy')).toBe(true);
    expect(capital.getReservation('healthy')).toMatchObject({ acknowledgedLive: true, state: 'active' });
  });

  test('lost New ack after OE disconnect promotes only matching stable REST evidence without double count', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection: { sendMessage: mock(() => {}) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const orderId = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: { getActiveOrders: mock(async () => [{
        id: 'venue-order', external_id: orderId, status: 'ACTIVE',
        order_info: {
          side: 'SELL', type: 'LIMIT', instrument_id: 'btc-pyusd', price: '100000', qty: '0.01',
        },
        pending_qty: '0', leaves_qty: '0.01', exeuted_qty: '0', executed_vwap: '0',
      }]) },
      capitalReservationManager: capital,
      quoteEngine: engine,
      inventoryManager: { refreshBalances: mock(() => {}) },
      _capitalResyncInFlight: null,
      _fetchBalances: mock(async () => ({
        baseBalance: { available: 0.0068, held: 0.01, total: 0.0168 },
        quoteBalance: balances.quoteBalance,
      })),
      logger: { info() {}, warn() {}, error() {} },
    });
    orchestrator._onOEDisconnect();
    expect(engine.activeOrders.get(orderId)).toMatchObject({ status: 'active', acknowledgedLive: false });
    expect(capital.getReservation(orderId)).toMatchObject({ state: 'pending-new', acknowledgedLive: false });

    await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'active', acknowledgedLive: true, representedByHeld: true,
    });
    expect(engine.activeOrders.get(orderId)).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);

    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);
  });

  test('mismatched or ambiguous REST rows cannot promote a pending reservation', async () => {
    for (const liveRows of [
      [{ orderId: 'pending', status: 'ACTIVE', side: 'buy', price: 100000, size: 0.01 }],
      [
        { orderId: 'pending', status: 'ACTIVE', side: 'sell', price: 100000, size: 0.01 },
        { orderId: 'pending', status: 'ACTIVE', side: 'sell', price: 100000, size: 0.01 },
      ],
    ]) {
      const capital = new CapitalReservationManager();
      capital.reconcile({ ...balances, liveOrders: [] });
      capital.reserve({ orderId: 'pending', side: 'sell', size: 0.01, price: 100000, level: 1 });
      const activeOrders = new Map([['pending', {
        side: 'sell', size: 0.01, price: 100000, level: 1, status: 'pending', acknowledgedLive: false,
      }]]);
      const quoteEngine = { activeOrders, removeStaleOrder: mock(() => false) };
      const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
        isRunning: true,
        restClient: {},
        capitalReservationManager: capital,
        quoteEngine,
        inventoryManager: { refreshBalances: mock(() => {}) },
        _capitalResyncInFlight: null,
        _fetchBalances: mock(async () => balances),
        _fetchCapitalLiveOrders: mock(async () => liveRows),
        logger: { warn() {} },
      });

      await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
      expect(capital.getReservation('pending')).toMatchObject({
        state: 'pending-new', acknowledgedLive: false,
      });
      expect(activeOrders.get('pending')).toMatchObject({ status: 'pending', acknowledgedLive: false });
      expect(capital.getStatus()).toMatchObject({
        state: 'degraded', reason: 'live-order-promotion-evidence-mismatch', blockedSides: ['sell'],
      });
      expect(capital.reserve({
        orderId: `blocked-${liveRows.length}`, side: 'sell', size: 0.001, price: 100000, level: 2,
      }).accepted).toBe(false);
    }
  });

  test('raw REST promotion evidence rejects malformed, transitional, missing-local, and duplicate rows', async () => {
    const raw = ({
      price = '100000', leaves = '0.01', status = 'ACTIVE', side = 'SELL', externalId = 'pending',
    } = {}) => ({
      id: `venue-${externalId}`,
      external_id: externalId,
      status,
      order_info: {
        side, type: 'LIMIT', instrument_id: 'btc-pyusd', price, qty: '0.01',
      },
      pending_qty: '0', leaves_qty: leaves, exeuted_qty: '0', executed_vwap: '0',
    });
    const cases = [
      { name: 'empty price', rows: [raw({ price: '' })] },
      { name: 'garbage price', rows: [raw({ price: 'bad' })] },
      { name: 'partial-garbage price', rows: [raw({ price: '100000junk' })] },
      { name: 'zero leaves', rows: [raw({ leaves: '0' })] },
      { name: 'garbage leaves', rows: [raw({ leaves: 'bad' })] },
      { name: 'partial-garbage leaves', rows: [raw({ leaves: '0.01junk' })] },
      { name: 'different price', rows: [raw({ price: '100001' })] },
      { name: 'different remaining size', rows: [raw({ leaves: '0.005' })] },
      { name: 'cancel pending', rows: [raw({ status: 'CANCEL_PENDING' })] },
      { name: 'missing local order', rows: [raw()], missingLocal: true },
      { name: 'duplicate rows', rows: [raw(), raw()] },
    ];

    for (const evidence of cases) {
      const capital = new CapitalReservationManager();
      capital.reconcile({ ...balances, liveOrders: [] });
      capital.reserve({ orderId: 'pending', side: 'sell', size: 0.01, price: 100000, level: 1 });
      const activeOrders = evidence.missingLocal ? new Map() : new Map([['pending', {
        side: 'sell', size: 0.01, price: 100000, level: 1,
        status: 'pending', acknowledgedLive: false,
      }]]);
      const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
        isRunning: true,
        restClient: { getActiveOrders: mock(async () => evidence.rows) },
        capitalReservationManager: capital,
        quoteEngine: { activeOrders, removeStaleOrder: mock(() => false) },
        inventoryManager: { refreshBalances: mock(() => {}) },
        _capitalResyncInFlight: null,
        _fetchBalances: mock(async () => balances),
        logger: { warn() {} },
      });

      const adapted = await orchestrator._fetchCapitalLiveOrders();
      expect(adapted.length).toBe(evidence.rows.length);
      await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
      expect(capital.getReservation('pending'), evidence.name).toMatchObject({
        state: 'pending-new', acknowledgedLive: false,
      });
      expect(capital.getStatus(), evidence.name).toMatchObject({
        state: 'degraded', reason: 'live-order-promotion-evidence-mismatch', blockedSides: ['sell'],
      });
    }
  });
});
