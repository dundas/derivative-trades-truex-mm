import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { MarketMakerOrchestrator } from './market-maker-orchestrator.js';
import { MakerPresenceController } from './maker-presence-controller.js';

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

function makeStartupOrchestrator() {
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

  test('ordinary reconciliation remains a pre-start no-op', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = { getActiveOrders: mock(async () => []) };
    expect(await orchestrator._restReconcile()).toBeUndefined();
    expect(orchestrator.restClient.getActiveOrders).not.toHaveBeenCalled();
  });
});
