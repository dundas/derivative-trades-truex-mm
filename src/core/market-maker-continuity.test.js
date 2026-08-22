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

  test('reconciles authoritative capital and rearms without cancelling the surviving side', async () => {
    const recovery = {
      observe: mock(() => ({ shouldRecover: true })),
      reconciled: mock(() => {}), failed: mock(() => {}), snapshot: () => ({ state: 'rearming' }),
    };
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      presenceRecoveryController: recovery,
      restClient: {},
      capitalReservationManager: { getStatus: () => ({ state: 'normal', blockedSides: [] }) },
      _onCapitalResyncRequired: mock(async () => {}),
      quoteEngine: { deferredRepriceNeeded: false, drainQueue: mock(() => {}), cancelAllQuotes: mock(() => {}) },
      logger: { error() {} }, emit() {},
    });
    orchestrator._maybeRecoverMakerPresence({ executionState: 'degraded' });
    await Promise.resolve();
    await Promise.resolve();
    expect(orchestrator._onCapitalResyncRequired).toHaveBeenCalledWith({
      side: 'multiple', reason: 'maker-presence-gap', strict: true,
    });
    expect(orchestrator.quoteEngine.cancelAllQuotes).not.toHaveBeenCalled();
    expect(recovery.reconciled).toHaveBeenCalledTimes(1);
  });

  test('reports the quote loop separately from actual two-sided maker presence', () => {
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true, startedAt: Date.now() - 1000, sessionId: 'health-test',
      _lastRepriceTime: Date.now(), _lastMdUpdateTime: Date.now(), _quotingIdleThresholdMs: 1000,
      fixOE: { isLoggedOn: true }, marketDataFeed: null,
      _getContinuityStatus: () => ({
        executionState: 'degraded', reasons: ['missing-acknowledged-sell'],
        present: { buy: true, sell: false, twoSided: false },
        activeLevels: { buy: 1, sell: 0 }, gaps: { buy: {}, sell: {} },
      }),
      inventoryManager: { getPositionSummary: () => ({ balancesInitialized: false }) },
      quoteEngine: { activeOrders: new Map([['stale', {}]]) },
      capitalReservationManager: { getReservations: () => [], getStatus: () => ({ state: 'normal' }) },
      pnlTracker: { getSummary: () => ({}), getLastFill: () => null },
      presenceRecoveryController: null, inventoryRebalanceShadow: null,
    });
    expect(orchestrator.getHealthStatus()).toMatchObject({
      status: 'degraded', quoting: false, quoteLoopActive: true, activeOrders: 1,
      makerActiveOrders: 0, makerPresence: { twoSided: false },
    });
  });

  test('publishes bell-curve inventory guidance as an unreachable observe-only order path', () => {
    const events = [];
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      inventoryRebalanceShadowConfig: {
        enabled: true, sampleIntervalMs: 5000, targetInventoryBTC: 0.014, inventorySigmaBTC: 0.004,
        centerBandSigma: 0.5, softHedgeBandSigma: 2, hardHedgeBandSigma: 3,
        minimumMakerParticipation: 0.25, maxSizeAsymmetry: 0.75, maxQuoteSkewBps: 10,
      },
      inventoryManager: { getPositionSummary: () => ({ baseBalance: { total: 0.002 }, netPosition: 99 }) },
      _inventoryRebalanceShadowLastAt: 0,
      emit: (name, payload) => events.push({ name, payload }),
    });
    const shadow = orchestrator._updateInventoryRebalanceShadow();
    expect(shadow).toMatchObject({
      mode: 'observe-only', orderPathEnabled: false, inventoryBTC: 0.002,
      regime: { status: 'unavailable', adjustmentApplied: false },
      hedge: { side: 'buy' },
    });
    expect(events[0].name).toBe('inventory-rebalance-shadow');
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

  test('scopes strict reconciliation to the configured instrument and maker namespace', async () => {
    const own = rawOrder('venue-own', 'QMM001abcde000001', 'ACTIVE');
    const otherInstrument = rawOrder('venue-other-product', 'FOREIGN_PRODUCT_1', 'ACTIVE');
    otherInstrument.order_info.instrument_id = 'eth-pyusd';
    const otherStrategy = rawOrder('venue-other-strategy', 'FOREIGN_STRATEGY_1', 'ACTIVE');
    const foreignPending = rawOrder('venue-foreign-pending', 'FOREIGN_STRATEGY_2', 'MODIFY_PENDING');
    const cancelOrder = mock(async () => {});
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
      startupCancelVerifyTimeoutMs: 20, startupCancelVerifyIntervalMs: 10,
      now: () => 0, sleep: async () => {},
    });
    orchestrator.restClient = {
      getActiveOrders: mock()
        .mockResolvedValueOnce([otherInstrument, otherStrategy, foreignPending, own])
        .mockResolvedValueOnce([rawOrder('venue-own', 'QMM001abcde000001', 'CANCELED')]),
      cancelOrder,
    };

    const stats = await orchestrator._restReconcile({ allowPreStart: true, strict: true });
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('venue-own');
    expect(stats).toMatchObject({ exchange: 1, orphansCancelled: 1 });
  });

  test('fails closed on malformed scope evidence that could identify our order', async () => {
    const missingInstrument = rawOrder('venue-own', 'QMM001abcde000001', 'ACTIVE');
    delete missingInstrument.order_info.instrument_id;
    const malformedExternalId = rawOrder('venue-ambiguous', '', 'ACTIVE');
    const cancelOrder = mock(async () => {});
    for (const candidate of [missingInstrument, malformedExternalId]) {
      const orchestrator = makeStartupOrchestrator({
        truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
      });
      orchestrator.restClient = { getActiveOrders: mock(async () => [candidate]), cancelOrder };
      await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
        .rejects.toThrow('ambiguous order ownership scope');
    }
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  test('conflicting foreign-instrument evidence for our identity fails closed in every manager path', async () => {
    const orderId = 'QMM001abcde000001';
    const contradictory = rawOrder('venue-conflict', orderId, 'ACTIVE');
    contradictory.order_info.instrument_id = 'eth-pyusd';
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId, side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept(orderId);
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
      capitalReservationManager: capital,
    });
    orchestrator.quoteEngine.activeOrders.set(orderId, {
      clOrdID: orderId, side: 'sell', size: 0.01, price: 100000, level: 1,
      status: 'active', acknowledgedLive: true,
    });
    orchestrator.quoteEngine.removeStaleOrder = mock(() => true);
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [contradictory]), cancelOrder: mock(async () => {}),
    };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('ambiguous order ownership scope');
    orchestrator.isRunning = true;
    expect(await orchestrator._restReconcile()).toBeUndefined();
    await expect(orchestrator._fetchCapitalLiveOrders())
      .rejects.toThrow('ambiguous order ownership scope');
    expect(orchestrator.quoteEngine.activeOrders.has(orderId)).toBe(true);
    expect(orchestrator.quoteEngine.removeStaleOrder).not.toHaveBeenCalled();
    expect(orchestrator.restClient.cancelOrder).not.toHaveBeenCalled();
    expect(capital.getReservation(orderId)).toMatchObject({ acknowledgedLive: true });
    expect(capital.getStatus().state).toBe('failed');
  });

  test('restart scope accepts any exact boot segment under the stable namespace', () => {
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
    });
    expect(orchestrator._restOrderScope(rawOrder(
      'old-venue', 'QMM001old_B000001', 'ACTIVE'
    ))).toBe('owned');
    expect(orchestrator._restOrderScope(rawOrder(
      'foreign-venue', 'QOTHERold_B000001', 'ACTIVE'
    ))).toBe('foreign');
    expect(orchestrator._restOrderScope(rawOrder(
      'malformed-venue', 'QMM001short', 'ACTIVE'
    ))).toBe('ambiguous');
  });

  test('full-layout parsing keeps overlapping 4, 5, and 6 character namespaces foreign in every path', async () => {
    const namespace5 = rawOrder('venue-five', 'QMM001abcde000001', 'ACTIVE');
    const namespace6 = rawOrder('venue-six', 'QMM001Xabcde000001', 'ACTIVE');
    for (const raw of [namespace5, namespace6]) raw.order_info.instrument_id = '12345';
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: '12345', orderIdNamespace: 'MM00',
      capitalReservationManager: capital,
    });
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [namespace5, namespace6]),
      cancelAllOrders: mock(async () => {}), cancelOrder: mock(async () => {}),
    };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .resolves.toMatchObject({ exchange: 0, orphansCancelled: 0 });
    orchestrator.isRunning = true;
    await expect(orchestrator._restReconcile()).resolves.toMatchObject({ exchange: 0 });
    expect(await orchestrator._fetchCapitalLiveOrders()).toEqual([]);
    await orchestrator._cancelAllOrdersViaRest('overlap-test');
    expect(orchestrator.restClient.cancelAllOrders).not.toHaveBeenCalled();
    expect(orchestrator.restClient.cancelOrder).not.toHaveBeenCalled();
    expect(capital.getStatus().state).toBe('normal');
  });

  test('malformed exact namespace remains ambiguous across strict, runtime, capital, and watchdog paths', async () => {
    const malformed = rawOrder('venue-malformed', 'QMM00short', 'ACTIVE');
    malformed.order_info.instrument_id = '12345';
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: '12345', orderIdNamespace: 'MM00',
      capitalReservationManager: capital,
    });
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [malformed]),
      cancelAllOrders: mock(async () => {}), cancelOrder: mock(async () => {}),
    };

    await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('ambiguous order ownership scope');
    orchestrator.isRunning = true;
    expect(await orchestrator._restReconcile()).toBeUndefined();
    await expect(orchestrator._fetchCapitalLiveOrders())
      .rejects.toThrow('ambiguous order ownership scope');
    await expect(orchestrator._cancelAllOrdersViaRest('malformed-test'))
      .rejects.toThrow('ambiguous order ownership scope');
    expect(orchestrator.restClient.cancelAllOrders).not.toHaveBeenCalled();
    expect(orchestrator.restClient.cancelOrder).not.toHaveBeenCalled();
    expect(capital.getStatus().state).toBe('failed');
  });

  test('recognizes a configured namespace across restart and exact local legacy identities', async () => {
    const priorSession = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
    });
    expect(priorSession.orderIdNamespace).toBe('MM001');

    const local = {
      clOrdID: 'legacy-local-id', side: 'sell', price: 100000, size: 0.01,
      status: 'active', acknowledgedLive: true,
    };
    const restarted = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
    });
    restarted.quoteEngine.activeOrders.set(local.clOrdID, local);
    restarted.quoteEngine.removeStaleOrder = mock(() => true);
    restarted.restClient = {
      getActiveOrders: mock(async () => [rawOrder('venue-legacy', local.clOrdID, 'ACTIVE')]),
      cancelOrder: mock(async () => {}),
    };

    const stats = await restarted._restReconcile({ allowPreStart: true, strict: true });
    expect(stats).toMatchObject({ matched: 1, ghostsRemoved: 0, orphansCancelled: 0 });
    expect(restarted.restClient.cancelOrder).not.toHaveBeenCalled();
  });

  test('capital live-order evidence excludes foreign products and strategies', async () => {
    const own = rawOrder('venue-own', 'QMM001abcde000001', 'ACTIVE');
    const foreignProduct = rawOrder('venue-product', 'FOREIGN_PRODUCT_1', 'ACTIVE');
    foreignProduct.order_info.instrument_id = 'eth-pyusd';
    const foreignStrategy = rawOrder('venue-strategy', 'OTHER_STRATEGY', 'ACTIVE');
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
    });
    orchestrator.restClient = { getActiveOrders: mock(async () => [own, foreignProduct, foreignStrategy]) };

    expect(await orchestrator._fetchCapitalLiveOrders()).toEqual([expect.objectContaining({
      orderId: own.external_id, promotionEvidenceValid: true,
    })]);
  });

  test('scoped watchdog cancellation never calls venue-wide cancel or touches foreign orders', async () => {
    const own = rawOrder('venue-own', 'QMM001abcde000001', 'ACTIVE');
    const foreignProduct = rawOrder('venue-product', 'FOREIGN_PRODUCT_1', 'ACTIVE');
    foreignProduct.order_info.instrument_id = 'eth-pyusd';
    const foreignStrategy = rawOrder('venue-strategy', 'OTHER_STRATEGY', 'ACTIVE');
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: 'btc-pyusd', orderIdNamespace: 'MM001',
    });
    orchestrator.restClient = {
      getActiveOrders: mock(async () => [own, foreignProduct, foreignStrategy]),
      cancelAllOrders: mock(async () => {}), cancelOrder: mock(async () => {}),
    };

    await orchestrator._cancelAllOrdersViaRest('test');
    expect(orchestrator.restClient.cancelAllOrders).not.toHaveBeenCalled();
    expect(orchestrator.restClient.cancelOrder).toHaveBeenCalledTimes(1);
    expect(orchestrator.restClient.cancelOrder).toHaveBeenCalledWith('venue-own');
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
    orchestrator._refreshBalances = mock(async () => {});
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
    expect(orchestrator._refreshBalances).toHaveBeenCalledWith({
      requireLiveOrders: true, clearBlockedSides: true, allowPreStart: true, strict: true,
    });
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(1);
    expect(orchestrator.isRunning).toBe(true);

    orchestrator.restClient = null;
    await orchestrator.stop();
  });

  test('refreshes released orphan holds coherently before FIX and permits only newly funded size', async () => {
    const orderId = 'QMM001abcde000001';
    const capital = new CapitalReservationManager();
    const orchestrator = makeStartupOrchestrator({
      truexInstrumentId: '12345', orderIdNamespace: 'MM001',
      capitalReservationManager: capital,
      startupCancelVerifyTimeoutMs: 20, startupCancelVerifyIntervalMs: 10,
      now: () => 0, sleep: async () => {},
    });
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator.inventoryManager.refreshBalances = mock(() => {});
    orchestrator._initializeBalances = mock(async () => {
      capital.reconcile({
        baseBalance: { available: 1, held: 0, total: 1 },
        quoteBalance: { available: 0, held: 100, total: 100 },
        liveOrders: [],
      });
    });
    orchestrator._fetchBalances = mock(async () => {
      expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
      return {
        baseBalance: { available: 1, held: 0, total: 1 },
        quoteBalance: { available: 100, held: 0, total: 100 },
      };
    });
    const own = rawOrder('venue-own', orderId, 'ACTIVE');
    own.order_info.instrument_id = '12345';
    const terminal = rawOrder('venue-own', orderId, 'CANCELED');
    terminal.order_info.instrument_id = '12345';
    orchestrator.restClient = {
      getActiveOrders: mock()
        .mockResolvedValueOnce([own])
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([]),
      cancelOrder: mock(async () => {}),
    };

    await orchestrator.start();
    expect(orchestrator._fetchBalances).toHaveBeenCalledTimes(1);
    expect(orchestrator.restClient.getActiveOrders).toHaveBeenCalledTimes(3);
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });
    expect(capital.reserve({
      orderId: 'new-funded-bid', side: 'buy', size: 0.001, price: 100000, level: 1,
    })).toMatchObject({ accepted: true });
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(1);

    orchestrator.restClient = null;
    await orchestrator.stop();
  });

  test('aborts startup when the post-cleanup coherent capital refresh fails', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = {};
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator._initializeBalances = mock(async () => {});
    orchestrator._restReconcile = mock(async () => ({ orphansCancelled: 1 }));
    orchestrator._refreshBalances = mock(async () => { throw new Error('fresh capital unavailable'); });

    await expect(orchestrator.start()).rejects.toThrow('fresh capital unavailable');
    expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
    expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();
    expect(orchestrator.isRunning).toBe(false);
  });

  test('uses one optional FIX logon contract across continuity and queue eligibility', () => {
    const orchestrator = makeStartupOrchestrator({ continuityConfig: continuity, now: () => 1000 });
    delete orchestrator.fixOE.isLoggedOn;
    orchestrator.isRunning = true;
    orchestrator._lastMdUpdateTime = 1000;
    orchestrator._mdStaleThresholdMs = 1000;
    orchestrator.capitalReservationManager.reconcile({ ...balances, liveOrders: [] });
    for (const [orderId, side] of [['bid', 'buy'], ['ask', 'sell']]) {
      orchestrator.capitalReservationManager.reserve({
        orderId, side, level: 1, size: 0.001, price: 100000,
      });
      orchestrator.capitalReservationManager.accept(orderId);
    }
    expect(orchestrator._isFixExecutionHealthy()).toBe(true);
    expect(orchestrator._isQueueDrainExecutionEligible()).toBe(true);
    expect(orchestrator._getContinuityStatus().reasons).not.toContain('order-entry-unhealthy');

    orchestrator.fixOE.isLoggedOn = false;
    expect(orchestrator._isFixExecutionHealthy()).toBe(false);
    expect(orchestrator._isQueueDrainExecutionEligible()).toBe(false);
    expect(orchestrator._getContinuityStatus().reasons).toContain('order-entry-unhealthy');
  });

  test('rejects an attempt-owned FIX transport that connects without logon and fully rolls it back', async () => {
    const fixOE = Object.assign(new EventEmitter(), {
      isConnected: false,
      isLoggedOn: false,
      connect: mock(async function connect() { this.isConnected = true; }),
      disconnect: mock(async function disconnect() {
        this.isConnected = false;
        this.isLoggedOn = false;
      }),
      sendMessage: mock(() => {}),
    });
    const orchestrator = makeStartupOrchestrator({ fixConnection: fixOE });

    await expect(orchestrator.start()).rejects.toThrow('not logged on');
    expect(fixOE.connect).toHaveBeenCalledTimes(1);
    expect(fixOE.disconnect).toHaveBeenCalledTimes(1);
    expect(fixOE.isConnected).toBe(false);
    expect(orchestrator.isRunning).toBe(false);
    expect(orchestrator.drainQueueTimer).toBeNull();
    expect(orchestrator._watchdogTimer).toBeNull();
    expect(fixOE.listenerCount('message')).toBe(0);
    expect(orchestrator.quoteEngine.listenerCount('fill')).toBe(0);
  });

  test('keeps an initially inactive FIX adapter without a logon property compatible after connect', async () => {
    const fixOE = Object.assign(new EventEmitter(), {
      isConnected: false,
      connect: mock(async function connect() { this.isConnected = true; }),
      disconnect: mock(async function disconnect() { this.isConnected = false; }),
      sendMessage: mock(() => {}),
    });
    const orchestrator = makeStartupOrchestrator({ fixConnection: fixOE });

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(fixOE.connect).toHaveBeenCalledTimes(1);
    expect(orchestrator.isRunning).toBe(true);
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

  test('failed strict startup unwires its attempt and retry installs exactly one handler', async () => {
    const orchestrator = makeStartupOrchestrator();
    orchestrator.restClient = {};
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator._initializeBalances = mock(async () => {});
    orchestrator._refreshBalances = mock(async () => {});
    orchestrator._restReconcile = mock()
      .mockRejectedValueOnce(new Error('strict startup failed'))
      .mockResolvedValueOnce({ exchange: 0, local: 0, matched: 0, orphansCancelled: 0, ghostsRemoved: 0 });
    orchestrator._onQuoteFill = mock(() => {});
    orchestrator._onQuoteLifecycle = mock(() => {});
    orchestrator._onCapitalResyncRequired = mock(() => {});

    await expect(orchestrator.start()).rejects.toThrow('strict startup failed');
    expect(orchestrator.isRunning).toBe(false);
    expect(orchestrator.fixOE.listenerCount('message')).toBe(0);
    expect(orchestrator.fixOE.listenerCount('logon-reset-fallback')).toBe(0);
    expect(orchestrator.quoteEngine.listenerCount('fill')).toBe(0);

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(orchestrator.fixOE.listenerCount('message')).toBe(1);
    expect(orchestrator.fixOE.listenerCount('logon-reset-fallback')).toBe(1);
    expect(orchestrator.quoteEngine.listenerCount('fill')).toBe(1);
    expect(orchestrator.quoteEngine.listenerCount('quote-lifecycle')).toBe(1);
    expect(orchestrator.quoteEngine.listenerCount('capital-resync-required')).toBe(1);

    orchestrator.quoteEngine.emit('fill', { execID: 'one' });
    orchestrator.quoteEngine.emit('quote-lifecycle', { quoteId: 'one' });
    orchestrator.quoteEngine.emit('capital-resync-required', { side: 'sell' });
    expect(orchestrator._onQuoteFill).toHaveBeenCalledTimes(1);
    expect(orchestrator._onQuoteLifecycle).toHaveBeenCalledTimes(1);
    expect(orchestrator._onCapitalResyncRequired).toHaveBeenCalledTimes(1);

    orchestrator.restClient = null;
    await orchestrator.stop();
  });

  test('capital-resync EventEmitter listener contains async REST failure while direct strict caller receives it', async () => {
    const orchestrator = makeStartupOrchestrator();
    const failure = new Error('REST snapshot failed');
    orchestrator.logger.error = mock(() => {});
    orchestrator._onCapitalResyncRequired = mock(() => Promise.reject(failure));
    orchestrator._wireEvents();

    orchestrator.quoteEngine.emit('capital-resync-required', { side: 'buy', strict: true });
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    expect(orchestrator.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Capital resync event failed: REST snapshot failed'),
    );
    await expect(orchestrator._onCapitalResyncRequired({ side: 'buy', strict: true })).rejects.toThrow('REST snapshot failed');
    orchestrator._unwireEvents();
  });

  test('later startup failure clears attempt-owned timers and connections before retry', async () => {
    const orchestrator = makeStartupOrchestrator({ postgresManager: {} });
    orchestrator._takeBalanceSnapshot = mock()
      .mockRejectedValueOnce(new Error('snapshot failed'))
      .mockResolvedValue(undefined);

    await expect(orchestrator.start()).rejects.toThrow('snapshot failed');
    expect(orchestrator.isRunning).toBe(false);
    expect(orchestrator.startedAt).toBeNull();
    expect(orchestrator.fixOE.disconnect).toHaveBeenCalledTimes(1);
    expect(orchestrator.pnlTracker.stopPeriodicLogging).toHaveBeenCalledTimes(1);
    expect(orchestrator.drainQueueTimer).toBeNull();
    expect(orchestrator._watchdogTimer).toBeNull();
    expect(orchestrator._snapshotTimer).toBeNull();
    expect(orchestrator.fixOE.listenerCount('message')).toBe(0);

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(2);
    expect(orchestrator.fixOE.listenerCount('message')).toBe(1);
    expect(orchestrator.drainQueueTimer).not.toBeNull();
    expect(orchestrator._watchdogTimer).not.toBeNull();
    expect(orchestrator._snapshotTimer).not.toBeNull();

    await orchestrator.stop();
  });

  test('slow startup snapshot cannot run the drain timer before execution eligibility', async () => {
    let releaseSnapshot;
    let snapshotCalls = 0;
    const orchestrator = makeStartupOrchestrator({
      postgresManager: {}, drainQueueIntervalMs: 5,
    });
    orchestrator.quoteEngine.deferredRepriceNeeded = true;
    orchestrator._takeBalanceSnapshot = mock(() => {
      snapshotCalls += 1;
      if (snapshotCalls > 1) return Promise.resolve();
      return new Promise(resolve => { releaseSnapshot = resolve; });
    });

    const starting = orchestrator.start();
    while (!releaseSnapshot) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(orchestrator.isRunning).toBe(false);
    expect(orchestrator.drainQueueTimer).toBeNull();
    expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();

    releaseSnapshot();
    await starting;
    expect(orchestrator.isRunning).toBe(true);
    expect(orchestrator.quoteEngine.drainQueue).toHaveBeenCalledTimes(1);
    for (let turn = 0; turn < 50 && orchestrator.quoteEngine.drainQueue.mock.calls.length === 1; turn++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(orchestrator.quoteEngine.drainQueue.mock.calls.length).toBeGreaterThan(1);
    await orchestrator.stop();
  });

  test('partial FIX and PnL activation throws are owned and unwound', async () => {
    const fixFailure = makeStartupOrchestrator();
    fixFailure.fixOE.connect = mock(async function connect() {
      this.isConnected = true;
      this.isLoggedOn = true;
      throw new Error('FIX partial start');
    });
    await expect(fixFailure.start()).rejects.toThrow('FIX partial start');
    expect(fixFailure.fixOE.disconnect).toHaveBeenCalledTimes(1);
    expect(fixFailure.fixOE.isConnected).toBe(false);
    expect(fixFailure.fixOE.listenerCount('message')).toBe(0);

    const pnlFailure = makeStartupOrchestrator();
    pnlFailure.pnlTracker._logTimer = null;
    pnlFailure.pnlTracker.startPeriodicLogging = mock(function startPeriodicLogging() {
      this._logTimer = setInterval(() => {}, 60000);
      throw new Error('PnL partial start');
    });
    pnlFailure.pnlTracker.stopPeriodicLogging = mock(function stopPeriodicLogging() {
      if (this._logTimer) clearInterval(this._logTimer);
      this._logTimer = null;
    });
    try {
      await expect(pnlFailure.start()).rejects.toThrow('PnL partial start');
      expect(pnlFailure.pnlTracker.stopPeriodicLogging).toHaveBeenCalledTimes(1);
      expect(pnlFailure.pnlTracker._logTimer).toBeNull();
      expect(pnlFailure.fixOE.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      if (pnlFailure.pnlTracker._logTimer) clearInterval(pnlFailure.pnlTracker._logTimer);
    }
  });

  test('failed FIX cleanup remains attempt-owned across retries until proven inactive', async () => {
    const orchestrator = makeStartupOrchestrator();
    let connectAttempts = 0;
    orchestrator.fixOE.connect = mock(async function connect() {
      connectAttempts += 1;
      this.isConnected = true;
      this.isLoggedOn = true;
      this.socket = { destroyed: false, attempt: connectAttempts };
      if (connectAttempts === 1) throw new Error('FIX primary failure');
    });
    let disconnectAttempts = 0;
    orchestrator.fixOE.disconnect = mock(async function disconnect() {
      disconnectAttempts += 1;
      if (disconnectAttempts <= 2) throw new Error('FIX cleanup failure');
      if (this.socket) this.socket.destroyed = true;
      this.socket = null;
      this.isConnected = false;
      this.isLoggedOn = false;
    });

    await expect(orchestrator.start()).rejects.toThrow('FIX primary failure');
    expect(orchestrator._dirtyStartupResources.fix).not.toBeNull();
    expect(orchestrator.fixOE.isConnected).toBe(true);

    await expect(orchestrator.start()).rejects.toThrow('dirty startup resource cleanup incomplete: FIX');
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(1);
    expect(orchestrator.fixOE.listenerCount('message')).toBe(0);
    expect(orchestrator._dirtyStartupResources.fix).not.toBeNull();

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(orchestrator._dirtyStartupResources.fix).toBeNull();
    expect(orchestrator.fixOE.connect).toHaveBeenCalledTimes(2);
    expect(orchestrator.fixOE.socket.attempt).toBe(2);
    await orchestrator.stop();
    expect(orchestrator.fixOE.disconnect).toHaveBeenCalledTimes(4);
    expect(orchestrator.fixOE.isConnected).toBe(false);
  });

  test('nonfatal partial market-data and pipeline starts are cleaned immediately', async () => {
    const marketDataFeed = Object.assign(new EventEmitter(), {
      isLoggedOn: false,
      connect: mock(async function connect() {
        this.isLoggedOn = true;
        throw new Error('MD partial start');
      }),
      subscribe: mock(async () => {}),
      disconnect: mock(async function disconnect() { this.isLoggedOn = false; }),
    });
    const dataPipeline = {
      isRunning: false,
      start: mock(async function start() {
        this.isRunning = true;
        this._cleanupTimer = setInterval(() => {}, 60000);
        throw new Error('pipeline partial start');
      }),
      stop: mock(async function stop() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = null;
        this.isRunning = false;
      }),
    };
    const orchestrator = makeStartupOrchestrator({ marketDataFeed, dataPipeline });
    try {
      await expect(orchestrator.start()).resolves.toBe(true);
      expect(marketDataFeed.disconnect).toHaveBeenCalledTimes(1);
      expect(marketDataFeed.isLoggedOn).toBe(false);
      expect(dataPipeline.stop).toHaveBeenCalledTimes(1);
      expect(dataPipeline.isRunning).toBe(false);
      expect(dataPipeline._cleanupTimer).toBeNull();
    } finally {
      await orchestrator.stop();
      if (dataPipeline._cleanupTimer) clearInterval(dataPipeline._cleanupTimer);
    }
  });

  test('partial reference collector activation is stopped and its timer is removed', async () => {
    const referenceMarkoutCollector = {
      writer: {},
      _timer: null,
      start: mock(function start() {
        this._timer = setInterval(() => {}, 60000);
        throw new Error('collector partial start');
      }),
      stop: mock(function stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
      }),
    };
    const orchestrator = makeStartupOrchestrator({ referenceMarkoutCollector });
    try {
      await expect(orchestrator.start()).rejects.toThrow('collector partial start');
      expect(referenceMarkoutCollector.stop).toHaveBeenCalledTimes(1);
      expect(referenceMarkoutCollector._timer).toBeNull();
      expect(orchestrator.fixOE.disconnect).toHaveBeenCalledTimes(1);
      expect(orchestrator.fixOE.listenerCount('message')).toBe(0);
    } finally {
      if (referenceMarkoutCollector._timer) clearInterval(referenceMarkoutCollector._timer);
    }
  });

  test('failed startup preserves every preexisting resource and timer handle', async () => {
    const marketDataFeed = Object.assign(new EventEmitter(), {
      isLoggedOn: true,
      ingest: { connected: true },
      connect: mock(async () => {}), subscribe: mock(async () => {}), disconnect: mock(async () => {}),
    });
    const dataPipeline = {
      isRunning: true, start: mock(async () => {}), stop: mock(async () => {}),
      _cleanupTimer: setInterval(() => {}, 60000),
    };
    const referenceMarkoutCollector = {
      writer: {}, _timer: setInterval(() => {}, 60000),
      start: mock(() => {}), stop: mock(() => {}),
    };
    const orchestrator = makeStartupOrchestrator({
      marketDataFeed, dataPipeline, referenceMarkoutCollector, postgresManager: {},
    });
    const preexistingTimers = {
      drainQueueTimer: setInterval(() => {}, 60000),
      _reconcileTimer: setInterval(() => {}, 60000),
      _balanceRefreshTimer: setInterval(() => {}, 60000),
      _watchdogTimer: setInterval(() => {}, 60000),
      _snapshotTimer: setInterval(() => {}, 60000),
      _truexEbboPollTimer: setTimeout(() => {}, 60000),
      _pyusdUsdPollTimer: setTimeout(() => {}, 60000),
    };
    const pnlTimer = setInterval(() => {}, 60000);
    Object.assign(orchestrator, preexistingTimers);
    orchestrator.pnlTracker._logTimer = pnlTimer;
    orchestrator.fixOE.isConnected = true;
    orchestrator.fixOE.isLoggedOn = true;
    const fixSocket = { destroyed: false };
    orchestrator.fixOE.socket = fixSocket;
    orchestrator._takeBalanceSnapshot = mock(async () => { throw new Error('late startup failure'); });

    try {
      await expect(orchestrator.start()).rejects.toThrow('late startup failure');
      for (const [property, handle] of Object.entries(preexistingTimers)) {
        expect(orchestrator[property]).toBe(handle);
      }
      expect(orchestrator.pnlTracker._logTimer).toBe(pnlTimer);
      expect(dataPipeline._cleanupTimer).not.toBeNull();
      expect(referenceMarkoutCollector._timer).not.toBeNull();
      expect(orchestrator.fixOE.socket).toBe(fixSocket);
      expect(orchestrator.fixOE.isConnected).toBe(true);
      expect(orchestrator.fixOE.isLoggedOn).toBe(true);
      expect(marketDataFeed.ingest.connected).toBe(true);
      expect(orchestrator.fixOE.disconnect).not.toHaveBeenCalled();
      expect(marketDataFeed.disconnect).not.toHaveBeenCalled();
      expect(dataPipeline.stop).not.toHaveBeenCalled();
      expect(orchestrator.pnlTracker.stopPeriodicLogging).not.toHaveBeenCalled();
      expect(referenceMarkoutCollector.stop).not.toHaveBeenCalled();
      expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
      expect(marketDataFeed.connect).not.toHaveBeenCalled();
      expect(marketDataFeed.subscribe).not.toHaveBeenCalled();
      expect(dataPipeline.start).not.toHaveBeenCalled();
      expect(orchestrator.pnlTracker.startPeriodicLogging).not.toHaveBeenCalled();
      expect(referenceMarkoutCollector.start).not.toHaveBeenCalled();
    } finally {
      for (const handle of Object.values(preexistingTimers)) clearTimeout(handle);
      clearInterval(pnlTimer);
      clearInterval(dataPipeline._cleanupTimer);
      clearInterval(referenceMarkoutCollector._timer);
      for (const property of Object.keys(preexistingTimers)) orchestrator[property] = null;
      orchestrator.pnlTracker._logTimer = null;
      dataPipeline._cleanupTimer = null;
      referenceMarkoutCollector._timer = null;
    }
  });

  test('subscription without a live market-data transport is not treated as preexisting active', async () => {
    const marketDataFeed = Object.assign(new EventEmitter(), {
      isSubscribed: true,
      isLoggedOn: false,
      isConnected: false,
      connect: mock(async function connect() { this.isConnected = true; }),
      subscribe: mock(async () => {}),
      disconnect: mock(async function disconnect() { this.isConnected = false; }),
    });
    const orchestrator = makeStartupOrchestrator({ marketDataFeed });
    await orchestrator.start();
    expect(marketDataFeed.connect).toHaveBeenCalledTimes(1);
    expect(marketDataFeed.subscribe).toHaveBeenCalledTimes(1);
    await orchestrator.stop();
  });

  test('failed cleanup of partial nonfatal resources aborts startup with the primary error', async () => {
    const marketDataFeed = Object.assign(new EventEmitter(), {
      isLoggedOn: false,
      connect: mock(async function connect() {
        this.isLoggedOn = true;
        throw new Error('MD primary failure');
      }),
      subscribe: mock(async () => {}),
      disconnect: mock(async () => { throw new Error('MD cleanup failure'); }),
    });
    const mdOrchestrator = makeStartupOrchestrator({ marketDataFeed });
    await expect(mdOrchestrator.start()).rejects.toThrow('MD primary failure');
    expect(mdOrchestrator.isRunning).toBe(false);
    expect(marketDataFeed.disconnect).toHaveBeenCalledTimes(2);
    expect(mdOrchestrator.fixOE.disconnect).toHaveBeenCalledTimes(1);

    const dataPipeline = {
      isRunning: false,
      start: mock(async function start() {
        this.isRunning = true;
        throw new Error('pipeline primary failure');
      }),
      stop: mock(async () => { throw new Error('pipeline cleanup failure'); }),
    };
    const pipelineOrchestrator = makeStartupOrchestrator({ dataPipeline });
    await expect(pipelineOrchestrator.start()).rejects.toThrow('pipeline primary failure');
    expect(pipelineOrchestrator.isRunning).toBe(false);
    expect(dataPipeline.stop).toHaveBeenCalledTimes(2);
    expect(pipelineOrchestrator.fixOE.disconnect).toHaveBeenCalledTimes(1);
  });

  test('pipeline cleanup must restore nested transport state before startup may continue', async () => {
    const dataPipeline = {
      isRunning: false,
      ingest: { connected: false },
      start: mock(async function start() {
        this.ingest.connected = true;
        throw new Error('pipeline ingest primary failure');
      }),
      stop: mock(async function stop() {
        if (!this.isRunning) return;
        this.ingest.connected = false;
        this.isRunning = false;
      }),
    };
    const orchestrator = makeStartupOrchestrator({ dataPipeline });
    await expect(orchestrator.start()).rejects.toThrow('pipeline ingest primary failure');
    expect(orchestrator.isRunning).toBe(false);
    expect(dataPipeline.stop).toHaveBeenCalledTimes(2);
    expect(dataPipeline.ingest.connected).toBe(true);
    expect(orchestrator.fixOE.disconnect).toHaveBeenCalledTimes(1);
  });

  test('dirty pipeline ownership survives retry until nested state is restored', async () => {
    let startAttempts = 0;
    let stopAttempts = 0;
    const dataPipeline = {
      isRunning: false,
      ingest: { connected: false },
      start: mock(async function start() {
        startAttempts += 1;
        if (startAttempts === 1) {
          this.ingest.connected = true;
          throw new Error('pipeline primary failure');
        }
        this.isRunning = true;
      }),
      stop: mock(async function stop() {
        stopAttempts += 1;
        if (stopAttempts <= 3) throw new Error('pipeline cleanup failure');
        this.ingest.connected = false;
        this.isRunning = false;
      }),
    };
    const orchestrator = makeStartupOrchestrator({ dataPipeline });

    await expect(orchestrator.start()).rejects.toThrow('pipeline primary failure');
    expect(orchestrator._dirtyStartupResources.pipeline).not.toBeNull();
    await expect(orchestrator.start()).rejects.toThrow('dirty startup resource cleanup incomplete: pipeline');
    expect(dataPipeline.start).toHaveBeenCalledTimes(1);
    expect(orchestrator._dirtyStartupResources.pipeline).not.toBeNull();

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(orchestrator._dirtyStartupResources.pipeline).toBeNull();
    expect(dataPipeline.start).toHaveBeenCalledTimes(2);
    await orchestrator.stop();
    expect(dataPipeline.stop).toHaveBeenCalledTimes(5);
  });

  test('preexisting pipeline active contract or ingest transport is a no-touch resource', async () => {
    for (const pipeline of [
      { isRunning: false, isActive: true },
      { isRunning: false, ingest: { connected: true } },
    ]) {
      pipeline.start = mock(async () => {});
      pipeline.stop = mock(async () => {});
      const orchestrator = makeStartupOrchestrator({ dataPipeline: pipeline, postgresManager: {} });
      orchestrator._takeBalanceSnapshot = mock(async () => { throw new Error('late failure'); });
      await expect(orchestrator.start()).rejects.toThrow('late failure');
      expect(pipeline.start).not.toHaveBeenCalled();
      expect(pipeline.stop).not.toHaveBeenCalled();
      if (pipeline.ingest) expect(pipeline.ingest.connected).toBe(true);
      if ('isActive' in pipeline) expect(pipeline.isActive).toBe(true);
    }
  });

  test('preexisting live transport is external even before FIX or MD logon completes', async () => {
    for (const resourceKind of ['fix-connected', 'fix-socket', 'md-connected', 'md-ingest']) {
      const marketDataFeed = Object.assign(new EventEmitter(), {
        isConnected: resourceKind === 'md-connected',
        isLoggedOn: false,
        ingest: { connected: resourceKind === 'md-ingest' },
        connect: mock(async () => {}), subscribe: mock(async () => {}), disconnect: mock(async () => {}),
      });
      const orchestrator = makeStartupOrchestrator({ marketDataFeed, postgresManager: {} });
      const oldFixSocket = { destroyed: false };
      orchestrator.fixOE.isConnected = resourceKind === 'fix-connected';
      orchestrator.fixOE.isLoggedOn = false;
      orchestrator.fixOE.socket = resourceKind === 'fix-socket' ? oldFixSocket : null;
      orchestrator._takeBalanceSnapshot = mock(async () => { throw new Error('late failure'); });

      await expect(orchestrator.start()).rejects.toThrow(
        resourceKind.startsWith('fix-') ? 'preexisting FIX transport is not logged on' : 'late failure'
      );
      if (resourceKind.startsWith('fix-')) {
        expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
        expect(orchestrator.fixOE.disconnect).not.toHaveBeenCalled();
        expect(orchestrator.fixOE.socket).toBe(resourceKind === 'fix-socket' ? oldFixSocket : null);
        expect(orchestrator.fixOE.isConnected).toBe(resourceKind === 'fix-connected');
        expect(orchestrator.pnlTracker.startPeriodicLogging).not.toHaveBeenCalled();
        expect(orchestrator.drainQueueTimer).toBeNull();
        expect(orchestrator.isRunning).toBe(false);
      }
      if (resourceKind.startsWith('md-')) {
        expect(marketDataFeed.connect).not.toHaveBeenCalled();
        expect(marketDataFeed.subscribe).not.toHaveBeenCalled();
        expect(marketDataFeed.disconnect).not.toHaveBeenCalled();
      }
    }
  });

  test('fully logged-on preexisting FIX succeeds without taking connection ownership', async () => {
    const orchestrator = makeStartupOrchestrator();
    const oldSocket = { destroyed: false };
    orchestrator.fixOE.isConnected = true;
    orchestrator.fixOE.isLoggedOn = true;
    orchestrator.fixOE.socket = oldSocket;

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(orchestrator.fixOE.connect).not.toHaveBeenCalled();
    expect(orchestrator.fixOE.socket).toBe(oldSocket);
    expect(orchestrator.fixOE.isLoggedOn).toBe(true);
    await orchestrator.stop();
    expect(orchestrator.fixOE.disconnect).not.toHaveBeenCalled();
    expect(orchestrator.fixOE.socket).toBe(oldSocket);
  });

  test('preconnected FIX adapter without a logon contract remains eligible and no-touch', async () => {
    const orchestrator = makeStartupOrchestrator();
    const adapter = Object.assign(new EventEmitter(), {
      isConnected: true,
      connect: mock(async () => {}),
      disconnect: mock(async () => {}),
      sendMessage: mock(() => {}),
    });
    orchestrator.fixOE = adapter;

    await expect(orchestrator.start()).resolves.toBe(true);
    expect(adapter.connect).not.toHaveBeenCalled();
    await orchestrator.stop();
    expect(adapter.disconnect).not.toHaveBeenCalled();
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

  test('strict startup waits for modify-pending settlement before orphan handling', async () => {
    let now = 0;
    const terminalRows = mock()
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'MODIFY_PENDING')])
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'CANCELED')]);
    const terminal = makeStartupOrchestrator({ now: () => now, sleep: async (ms) => { now += ms; } });
    terminal.restClient = { getActiveOrders: terminalRows, cancelOrder: mock(async () => {}) };
    await expect(terminal._restReconcile({ allowPreStart: true, strict: true })).resolves.toMatchObject({
      orphansCancelled: 0,
    });
    expect(terminal.restClient.cancelOrder).not.toHaveBeenCalled();

    const activeRows = mock()
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'MODIFY_PENDING')])
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'ACTIVE')])
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'CANCEL_PENDING')])
      .mockResolvedValueOnce([rawOrder('venue-modify', 'prior-modify', 'CANCELED')]);
    const active = makeStartupOrchestrator({ now: () => now, sleep: async (ms) => { now += ms; } });
    active.restClient = { getActiveOrders: activeRows, cancelOrder: mock(async () => {}) };
    await expect(active._restReconcile({ allowPreStart: true, strict: true })).resolves.toMatchObject({
      orphansCancelled: 1,
    });
    expect(active.restClient.cancelOrder).toHaveBeenCalledWith('venue-modify');
  });

  test('strict startup rejects timed-out or malformed modify-pending evidence', async () => {
    let now = 0;
    const timeout = makeStartupOrchestrator({
      startupCancelVerifyTimeoutMs: 20, startupCancelVerifyIntervalMs: 10,
      now: () => now, sleep: async (ms) => { now += ms; },
    });
    timeout.restClient = {
      getActiveOrders: mock(async () => [rawOrder('venue-modify', 'prior-modify', 'MODIFY_PENDING')]),
      cancelOrder: mock(async () => {}),
    };
    await expect(timeout._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('transitional-order verification timed out');
    expect(timeout.restClient.cancelOrder).not.toHaveBeenCalled();

    const malformed = makeStartupOrchestrator();
    const malformedRow = rawOrder('venue-modify', '', 'MODIFY_PENDING');
    malformed.restClient = { getActiveOrders: mock(async () => [malformedRow]) };
    await expect(malformed._restReconcile({ allowPreStart: true, strict: true }))
      .rejects.toThrow('invalid transitional-order identity');
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

  test('strict startup ghost recovery propagates refresh errors and failed manager state', async () => {
    for (const refreshThrows of [true, false]) {
      const capital = new CapitalReservationManager();
      capital.reconcile({ ...balances, liveOrders: [] });
      capital.reserve({ orderId: 'ghost', side: 'sell', size: 0.01, price: 100000, level: 1 });
      capital.accept('ghost');
      const orchestrator = makeStartupOrchestrator({ capitalReservationManager: capital });
      orchestrator.restClient = { getActiveOrders: mock(async () => []) };
      orchestrator.quoteEngine.activeOrders.set('ghost', { side: 'sell', status: 'active' });
      orchestrator.quoteEngine.removeStaleOrder = mock((orderId) => {
        orchestrator.quoteEngine.activeOrders.delete(orderId);
        capital.restOrderAbsent(orderId);
        return true;
      });
      orchestrator._refreshBalances = mock(async (options) => {
        expect(options).toEqual({
          requireLiveOrders: true, clearBlockedSides: true, allowPreStart: true,
        });
        capital.reconciliationFailed();
        if (refreshThrows) throw new Error('strict fresh snapshot unavailable');
      });

      await expect(orchestrator._restReconcile({ allowPreStart: true, strict: true }))
        .rejects.toThrow(refreshThrows ? 'strict fresh snapshot unavailable' : 'capital reconciliation remained failed');
      expect(orchestrator._capitalResyncInFlight).toBeNull();
      expect(capital.getStatus().state).toBe('failed');
      expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();
      expect(orchestrator.quoteEngine.deferredRepriceNeeded).toBeFalsy();
      expect(orchestrator.drainQueueTimer).toBeNull();
    }
  });

  test('successful strict recovery defers queue work until startup is execution-eligible', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const orchestrator = makeStartupOrchestrator({ capitalReservationManager: capital });
    orchestrator.restClient = {};
    orchestrator._refreshBalances = mock(async () => {
      capital.reconcile({ ...balances, liveOrders: [], clearBlockedSides: true });
    });

    await orchestrator._onCapitalResyncRequired({
      side: 'sell', reason: 'strict-startup-ghost', strict: true,
    });
    expect(orchestrator.quoteEngine.deferredRepriceNeeded).toBe(true);
    expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();
    expect(orchestrator._drainDeferredAfterStartup()).toBe(false);
    expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();

    orchestrator.isRunning = true;
    orchestrator.fixOE.isLoggedOn = true;
    expect(orchestrator._drainDeferredAfterStartup()).toBe(true);
    expect(orchestrator.quoteEngine.drainQueue).toHaveBeenCalledTimes(1);
    orchestrator.isRunning = false;
  });

  test('start drains strict recovery work only after FIX eligibility is established', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const orchestrator = makeStartupOrchestrator({ capitalReservationManager: capital });
    orchestrator.restClient = {};
    orchestrator.inventoryManager.balancesInitialized = true;
    orchestrator._initializeBalances = mock(async () => {});
    orchestrator._refreshBalances = mock(async () => {
      capital.reconcile({ ...balances, liveOrders: [], clearBlockedSides: true });
    });
    orchestrator._restReconcile = mock(async () => {
      await orchestrator._onCapitalResyncRequired({
        side: 'sell', reason: 'strict-startup-ghost', strict: true,
      });
      expect(orchestrator.isRunning).toBe(false);
      expect(orchestrator.fixOE.isLoggedOn).toBe(false);
      expect(orchestrator.quoteEngine.drainQueue).not.toHaveBeenCalled();
    });

    await orchestrator.start();
    expect(orchestrator.fixOE.isLoggedOn).toBe(true);
    expect(orchestrator.quoteEngine.drainQueue).toHaveBeenCalledTimes(1);
    orchestrator.restClient = null;
    await orchestrator.stop();
  });

  test('strict capital recovery joining a runtime single-flight still observes its error', async () => {
    let rejectRefresh;
    const orchestrator = makeStartupOrchestrator();
    orchestrator._capitalResyncInFlight = null;
    orchestrator._capitalResyncPending = false;
    orchestrator._capitalResyncStrictPending = false;
    orchestrator._refreshBalances = mock(() => new Promise((_, reject) => { rejectRefresh = reject; }));

    const runtime = orchestrator._onCapitalResyncRequired({
      side: 'sell', reason: 'runtime-insufficient-funds',
    });
    const strict = orchestrator._onCapitalResyncRequired({
      side: 'sell', reason: 'strict-startup-ghost', strict: true,
    });
    const runtimeObserved = runtime.then(value => ({ value }), error => ({ error }));
    const strictObserved = strict.then(value => ({ value }), error => ({ error }));
    rejectRefresh(new Error('shared fresh snapshot failed'));

    expect(await runtimeObserved).toEqual({ value: undefined });
    expect((await strictObserved).error?.message).toContain('shared fresh snapshot failed');
    expect(orchestrator._refreshBalances).toHaveBeenCalledTimes(1);
    expect(orchestrator._capitalResyncInFlight).toBeNull();
  });

  test('contract-order snapshot storm schedules at most one strict follow-up and never dispatches D', async () => {
    let releaseFirst;
    let releaseSecond;
    let refreshCalls = 0;
    const fixConnection = { sendMessage: mock(() => true) };
    const orchestrator = makeStartupOrchestrator();
    orchestrator._capitalResyncInFlight = null;
    orchestrator._capitalResyncPending = false;
    orchestrator._capitalResyncStrictPending = false;
    orchestrator._capitalResyncStrictDrainSuppressed = false;
    orchestrator.quoteEngine.fixConnection = fixConnection;
    orchestrator._refreshBalances = mock(() => {
      refreshCalls += 1;
      if (refreshCalls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      if (refreshCalls === 2) return new Promise((resolve) => { releaseSecond = resolve; });
      return Promise.resolve();
    });

    const first = orchestrator._onCapitalResyncRequired({
      side: 'buy', reason: 'contract-order-state-stale', strict: true,
    });
    for (let index = 0; index < 20; index += 1) {
      void orchestrator._onCapitalResyncRequired({
        side: 'buy', reason: 'contract-order-state-stale', strict: true,
      });
      void orchestrator._onCapitalResyncRequired({
        side: 'multiple', reason: 'contract-order-state-refresh', strict: false,
      });
    }
    for (let turn = 0; turn < 5 && !releaseFirst; turn += 1) await Promise.resolve();
    expect(typeof releaseFirst).toBe('function');
    expect(orchestrator._refreshBalances).toHaveBeenCalledTimes(1);
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();

    releaseFirst();
    for (let turn = 0; turn < 5 && !releaseSecond; turn += 1) await Promise.resolve();
    expect(orchestrator._refreshBalances).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 20; index += 1) {
      void orchestrator._onCapitalResyncRequired({
        side: 'buy', reason: 'contract-order-state-stale', strict: true,
      });
    }
    expect(orchestrator._refreshBalances).toHaveBeenCalledTimes(2);
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    releaseSecond();
    await first;
    expect(orchestrator._refreshBalances).toHaveBeenCalledTimes(2);
    expect(orchestrator._capitalResyncInFlight).toBeNull();
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

  test('unknown new dispatch absent from REST is removed and absorbed only by a second fresh generation', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId: 'unknown-new', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.dispatchOutcomeUnknown('unknown-new', 'async-new-dispatch-outcome-unknown');
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    engine.activeOrders.set('unknown-new', {
      side: 'sell', size: 0.01, price: 100000, level: 1,
      status: 'pending', acknowledgedLive: false,
    });
    const fetchLive = mock(async () => []);
    const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
      isRunning: true,
      restClient: {},
      capitalReservationManager: capital,
      quoteEngine: engine,
      inventoryManager: { refreshBalances: mock(() => {}) },
      _capitalResyncInFlight: null,
      _capitalResyncPending: false,
      _capitalResyncStrictPending: false,
      _capitalResyncStrictDrainSuppressed: false,
      _fetchBalances: mock(async () => balances),
      _fetchCapitalLiveOrders: fetchLive,
      logger: { info() {}, warn() {}, error() {} },
    });

    await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
    expect(fetchLive).toHaveBeenCalledTimes(2);
    expect(engine.activeOrders.has('unknown-new')).toBe(false);
    expect(capital.getReservation('unknown-new')).toMatchObject({
      state: 'rest-absence-evidence-gap', remainingSize: 0, acknowledgedLive: false,
    });
    expect(capital.consumedEvents).toEqual([]);
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });
  });

  test.each(['ACTIVE', 'CANCEL_PENDING', 'ACTIVE_DUPLICATE'])(
    'fresh coherent %s REST evidence resolves only the appropriate unknown cancel state',
    async (status) => {
      const capital = new CapitalReservationManager();
      const coherentBalances = {
        baseBalance: balances.baseBalance,
        quoteBalance: { available: 999.02, held: 0.98, total: 1000 },
      };
      capital.reconcile({ ...coherentBalances, liveOrders: [] });
      capital.reserve({ orderId: 'old', side: 'buy', size: 0.01, price: 98, level: 1 });
      capital.accept('old');
      capital.cancelRequested('old');
      capital.failClosedForEvidenceGap('old', 'async-cancel-dispatch-outcome-unknown');
      const fixConnection = { sendMessage: mock(() => true) };
      const engine = new QuoteEngine({
        capitalReservationManager: capital, fixConnection,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      engine.activeOrders.set('old', {
        side: 'buy', size: 0.01, price: 98, level: 1, status: 'cancelling',
        acknowledgedLive: true, cancellingAt: 1, dispatchOutcomeUnknown: true,
      });
      engine.pendingReplacements.set('old', {
        quote: { side: 'buy', size: 0.01, price: 97, level: 1 }, createdAt: 1,
      });
      engine.cancelToOrigMap.set('cancel-old', 'old');
      engine._failClosedExecutionEvidence('old', 'async-cancel-dispatch-outcome-unknown', { authoritative: true });
      const orchestrator = Object.assign(Object.create(MarketMakerOrchestrator.prototype), {
        isRunning: true,
        restClient: {}, capitalReservationManager: capital, quoteEngine: engine,
        inventoryManager: { refreshBalances: mock(() => {}) },
        _capitalResyncInFlight: null,
        _fetchBalances: mock(async () => coherentBalances),
        _fetchCapitalLiveOrders: mock(async () => {
          const candidate = {
            orderId: 'old', status: status === 'ACTIVE_DUPLICATE' ? 'ACTIVE' : status,
            side: 'buy', price: 98, size: 0.01, promotionEvidenceValid: true,
          };
          return status === 'ACTIVE_DUPLICATE' ? [candidate, { ...candidate }] : [candidate];
        }),
        logger: { info() {}, warn() {}, error() {} },
      });

      await orchestrator._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
      if (status === 'ACTIVE') {
        expect(engine.activeOrders.get('old')).toMatchObject({ status: 'active', acknowledgedLive: true });
        expect(engine.activeOrders.get('old')).not.toHaveProperty('dispatchOutcomeUnknown');
        expect(engine.activeOrders.get('old')).not.toHaveProperty('cancellingAt');
        expect(engine.cancelToOrigMap.size).toBe(0);
        expect(engine.pendingReplacements.has('old')).toBe(true);
        expect(capital.getReservation('old')).toMatchObject({ state: 'active' });
        expect(engine._sendCancel('old', engine.activeOrders.get('old'))).toBe(true);
        expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
      } else {
        expect(engine.activeOrders.get('old')).toMatchObject({
          status: 'cancelling', dispatchOutcomeUnknown: true,
        });
        expect(capital.getReservation('old')).toMatchObject({ state: 'cancel-in-flight' });
        expect(engine.executionEvidenceGap).toMatchObject({
          orderId: 'old', reason: 'async-cancel-dispatch-outcome-unknown',
        });
        expect(engine.cancelToOrigMap.size).toBe(1);
        expect(engine._sendCancel('old', engine.activeOrders.get('old'))).toBe(false);
        expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      }
    },
  );

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
