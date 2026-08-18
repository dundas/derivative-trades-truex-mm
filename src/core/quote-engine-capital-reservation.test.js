import { describe, expect, mock, test } from 'bun:test';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { QuoteEngine } from './quote-engine.js';

function setup(baseAvailable = 0.01686, engineOptions = {}) {
  const capital = new CapitalReservationManager();
  capital.reconcile({
    baseBalance: { available: baseAvailable, held: 0, total: baseAvailable },
    quoteBalance: { available: 2000, held: 0, total: 2000 },
    liveOrders: [],
  });
  const fixConnection = { sendMessage: mock(() => {}) };
  const engine = new QuoteEngine({
    capitalReservationManager: capital, fixConnection,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...engineOptions,
  });
  return { capital, engine, fixConnection };
}

describe('QuoteEngine capital reservation binding', () => {
  test('reserves synchronously before FIX and suppresses an unfunded send', () => {
    const { capital, engine, fixConnection } = setup();
    const first = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    const second = engine._sendNewOrder({ side: 'sell', price: 99999, size: 0.01, level: 2 });

    expect(first).toBeString();
    expect(second).toBeNull();
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
    expect(capital.getReservation(first).state).toBe('pending-new');
    expect(engine.suppressedLevels.get('sell:2').reason).toBe('locally-unfunded');
  });

  test('delegates level-aware caps to the manager without reading reservation internals', () => {
    const getQuoteCapacityForLevel = mock(() => 1000);
    const manager = { getQuoteCapacityForLevel };
    Object.defineProperty(manager, 'l1Reserve', {
      get() { throw new Error('private reserve internals must not be read'); },
    });
    const engine = new QuoteEngine({
      capitalReservationManager: manager,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(engine._capSizeToBalance('buy', 0.02, 100000, 500, 2)).toBe(0.005);
    expect(getQuoteCapacityForLevel).toHaveBeenCalledWith('buy', 2, 500);
  });

  test('converts pending reservation to acknowledged-live and preserves it during cancel', () => {
    const { capital, engine, fixConnection } = setup();
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine._sendCancel(orderId, engine.activeOrders.get(orderId));

    expect(capital.getReservation(orderId)).toMatchObject({ state: 'cancel-in-flight', acknowledgedLive: true });
    expect(capital.getPresence().sell).toBe(1);
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('synchronous cancel send failure rolls back manager and local lifecycle exactly and permits retry', () => {
    const { capital, engine, fixConnection } = setup();
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    const cancelLifecycle = [];
    engine.on('quote-lifecycle', (event) => {
      if (event.eventType === 'cancel') cancelLifecycle.push(event);
    });
    const priorLastAction = engine.lastActionByClOrdID.get(orderId);
    const pendingReplacement = { quote: { side: 'sell', price: 100001, size: 0.01, level: 1 } };
    engine.pendingReplacements.set(orderId, pendingReplacement);
    fixConnection.sendMessage.mockImplementationOnce(() => { throw new Error('socket write failed'); });

    expect(() => engine._sendCancel(orderId, engine.activeOrders.get(orderId)))
      .toThrow('socket write failed');
    expect(engine.activeOrders.get(orderId)).toMatchObject({
      status: 'active', acknowledgedLive: true,
    });
    expect(engine.activeOrders.get(orderId)).not.toHaveProperty('cancellingAt');
    expect(capital.getReservation(orderId)).toMatchObject({ state: 'active', acknowledgedLive: true });
    expect(engine.cancelToOrigMap.size).toBe(0);
    expect(engine.pendingReplacements.get(orderId)).toBe(pendingReplacement);
    expect(engine.lastActionByClOrdID.get(orderId)).toBe(priorLastAction);
    expect(cancelLifecycle).toEqual([]);

    engine._sendCancel(orderId, engine.activeOrders.get(orderId));
    expect(engine.activeOrders.get(orderId).status).toBe('cancelling');
    expect(capital.getReservation(orderId).state).toBe('cancel-in-flight');
    expect(engine.cancelToOrigMap.size).toBe(1);
    expect(cancelLifecycle).toHaveLength(1);
  });

  test('synchronous cancel send failure rolls back legacy local state without false suppression', () => {
    const fixConnection = { sendMessage: mock(() => { throw new Error('socket write failed'); }) };
    const engine = new QuoteEngine({
      fixConnection,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const orderId = 'legacy-active';
    const order = {
      side: 'buy', price: 99999, size: 0.01, level: 1,
      status: 'active', acknowledgedLive: true,
    };
    engine.activeOrders.set(orderId, order);

    expect(() => engine._sendCancel(orderId, order)).toThrow('socket write failed');
    expect(engine.activeOrders.get(orderId)).toEqual(order);
    expect(order).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(order).not.toHaveProperty('cancellingAt');
    expect(engine.cancelToOrigMap.size).toBe(0);

    fixConnection.sendMessage.mockImplementation(() => {});
    engine._sendCancel(orderId, order);
    expect(order.status).toBe('cancelling');
    expect(engine.cancelToOrigMap.size).toBe(1);
  });

  test('blocks the rejected side and requests reconciliation after insufficient funds', () => {
    const { capital, engine } = setup();
    const resyncs = [];
    engine.on('capital-resync-required', (event) => resyncs.push(event));
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '8', '54': '2', '58': 'Insufficient balance' });

    expect(capital.getStatus().blockedSides).toEqual(['sell']);
    expect(resyncs).toEqual([{ side: 'sell', reason: 'Insufficient balance' }]);
    expect(engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.001, level: 1 })).toBeNull();
  });

  test('applies duplicate partial fills once and releases on terminal reports', () => {
    const { capital, engine } = setup();
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    const partial = { '11': orderId, '39': '1', '54': '2', '17': 'exec-1', '31': '100000', '32': '0.004', '151': '0.006' };
    engine.onExecutionReport(partial);
    engine.onExecutionReport(partial);
    expect(capital.getReservation(orderId).remainingSize).toBe(0.006);
    engine.onExecutionReport({ '11': orderId, '39': '2', '54': '2', '17': 'exec-2', '31': '100000', '32': '0.006', '151': '0' });
    expect(capital.getReservation(orderId)).toMatchObject({ state: 'filled', acknowledgedLive: false });
  });

  test('terminal status without quantity proof clears presence and retains capital pending resync', () => {
    const { capital, engine } = setup();
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine.onExecutionReport({ '11': orderId, '39': '2', '54': '2', '17': 'unproven' });
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'terminal-evidence-gap', acknowledgedLive: false, remainingSize: 0,
    });
    expect(capital.getStatus()).toMatchObject({
      reason: 'unproven-terminal-fill', blockedSides: ['sell'],
    });
    expect(engine.activeOrders.has(orderId)).toBe(false);
  });

  test('releases an expired order exactly once', () => {
    const { capital, engine } = setup();
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine.onExecutionReport({ '11': orderId, '39': 'C', '54': '2', '17': 'expired-1' });
    engine.onExecutionReport({ '11': orderId, '39': 'C', '54': '2', '17': 'expired-1' });
    expect(capital.getReservation(orderId)).toMatchObject({ state: 'expired', acknowledgedLive: false });
    expect(engine.activeOrders.has(orderId)).toBe(false);
  });

  test('REST absence surfaces unknown outcome without fill/PnL emission and late terminal is inert', () => {
    const { capital, engine } = setup(0.01);
    const fills = [];
    const absences = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.on('rest-order-absence', (event) => absences.push(event));
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });

    expect(engine.removeStaleOrder(orderId)).toBe(true);
    expect(absences).toEqual([expect.objectContaining({
      orderId, side: 'sell', outcome: 'unknown',
      reason: 'rest-order-absence-unknown-outcome', remainingCommitment: 0.01,
    })]);
    expect(fills).toEqual([]);
    expect(capital.getStatus()).toMatchObject({ blockedSides: ['sell'] });

    engine.onExecutionReport({
      '11': orderId, '39': '2', '54': '2', '17': 'late-terminal',
      '31': '100000', '32': '0.01', '151': '0',
    });
    expect(fills).toEqual([]);
    expect(capital.consumedEvents).toHaveLength(1);
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 0 });
  });

  test('unknown-order cancel reject conservatively blocks capacity and delayed reports are idempotent', () => {
    const { capital, engine } = setup(0.01);
    const fills = [];
    const resyncs = [];
    const unknowns = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.on('capital-resync-required', (event) => resyncs.push(event));
    engine.on('cancel-unknown-outcome', (event) => unknowns.push(event));
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine._sendCancel(orderId, engine.activeOrders.get(orderId));
    const reject = {
      '11': 'cancel-request', '41': orderId, '58': 'Unknown order', '102': '1',
    };

    engine.onOrderCancelReject(reject);
    engine.onOrderCancelReject(reject);
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'cancel-unknown-evidence-gap', acknowledgedLive: false, remainingSize: 0,
    });
    expect(capital.consumedEvents).toHaveLength(1);
    expect(capital.getStatus()).toMatchObject({ blockedSides: ['sell'] });
    expect(engine.activeOrders.has(orderId)).toBe(false);
    expect(unknowns).toHaveLength(1);
    expect(resyncs).toEqual([expect.objectContaining({
      orderId, side: 'sell', reason: 'cancel-reject-unknown-order-outcome',
    })]);
    expect(engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.001, level: 1 })).toBeNull();

    engine.onExecutionReport({
      '11': orderId, '39': '2', '54': '2', '17': 'late-terminal',
      '31': '100000', '32': '0.01', '151': '0',
    });
    expect(capital.consumedEvents).toHaveLength(1);
    expect(fills).toEqual([]);
  });

  test('unknown authoritative OrdStatus fails closed once without inventing a terminal or fill', () => {
    const { capital, engine } = setup(0.01);
    const resyncs = [];
    const fills = [];
    engine.on('capital-resync-required', (event) => resyncs.push(event));
    engine.on('fill', (event) => fills.push(event));
    const orderId = engine._sendNewOrder({
      side: 'sell', price: 100000, size: 0.01, level: 1,
    });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    const unknown = { '11': orderId, '39': 'Z', '54': '2', '17': 'u1' };
    const churn = { '11': orderId, '39': 'Y', '54': '2', '17': 'u2' };

    engine.onExecutionReport(unknown);
    engine.onExecutionReport(churn);
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'active', acknowledgedLive: true, remainingSize: 0.01,
      evidenceGapReason: 'unmapped-ord-status:Z',
    });
    expect(capital.getStatus()).toMatchObject({
      state: 'degraded', reason: 'unmapped-ord-status:Z', blockedSides: ['sell'],
    });
    expect(engine.activeOrders.has(orderId)).toBe(true);
    expect(engine.quotingSuspended).toBe(true);
    expect(engine.getContinuityState()).toMatchObject({
      executionState: 'unsafe', reasons: expect.arrayContaining(['unmapped-ord-status:Z']),
    });
    expect(resyncs).toEqual([expect.objectContaining({
      orderId, side: 'sell', reason: 'unmapped-ord-status:Z',
    })]);
    expect(fills).toEqual([]);

    capital.reconcile({
      baseBalance: { available: 0, held: 0.01, total: 0.01 },
      quoteBalance: { available: 2000, held: 0, total: 2000 },
      liveOrders: [{ orderId }], clearBlockedSides: true,
    });
    expect(engine.resolveAuthoritativeExecutionEvidenceGap()).toBe(true);
    expect(engine.executionEvidenceGap).toBeNull();
    expect(capital.getReservation(orderId)).not.toHaveProperty('evidenceGapReason');
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });

    engine.onExecutionReport(unknown);
    engine.onExecutionReport(churn);
    expect(resyncs).toHaveLength(1);
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });

    engine.onExecutionReport({ '11': orderId, '39': 'X', '54': '2', '17': 'u3' });
    expect(resyncs).toHaveLength(2);
    expect(resyncs[1]).toMatchObject({ reason: 'unmapped-ord-status:X' });
    expect(capital.getStatus()).toMatchObject({
      state: 'degraded', reason: 'unmapped-ord-status:X', blockedSides: ['sell'],
    });
  });

  test('missing-ExecID unknown status is conservative one-shot and identities clear at terminal cleanup', () => {
    const { capital, engine } = setup(0.01);
    const resyncs = [];
    engine.on('capital-resync-required', (event) => resyncs.push(event));
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine.onExecutionReport({ '11': orderId, '39': 'Z', '54': '2' });
    engine.onExecutionReport({ '11': orderId, '39': 'Y', '54': '2' });
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toMatchObject({ reason: 'unmapped-ord-status:Z' });
    expect(engine.unknownStatusDedupeByOrder.get(orderId)).toMatchObject({
      missingExecIDSeen: true,
    });

    capital.reconcile({
      baseBalance: { available: 0, held: 0.01, total: 0.01 },
      quoteBalance: { available: 2000, held: 0, total: 2000 },
      liveOrders: [{ orderId }], clearBlockedSides: true,
    });
    engine.resolveAuthoritativeExecutionEvidenceGap();
    engine.onExecutionReport({ '11': orderId, '39': 'Z', '54': '2' });
    expect(resyncs).toHaveLength(1);

    engine.onExecutionReport({ '11': orderId, '39': '4', '54': '2' });
    expect(engine.unknownStatusDedupeByOrder.has(orderId)).toBe(false);
  });

  test('late unknown statuses after every terminal path cannot recreate or poison the bounded ledger', () => {
    const terminalActions = {
      cancel: (engine, orderId) => engine.onExecutionReport({ '11': orderId, '39': '4', '54': '2' }),
      reject: (engine, orderId) => engine.onExecutionReport({
        '11': orderId, '39': '8', '54': '2', '58': 'venue reject',
      }),
      expiry: (engine, orderId) => engine.onExecutionReport({ '11': orderId, '39': 'C', '54': '2' }),
      fullFill: (engine, orderId) => engine.onExecutionReport({
        '11': orderId, '39': '2', '54': '2', '17': 'fill-terminal',
        '31': '100000', '32': '0.01', '151': '0',
      }),
      restAbsence: (engine, orderId) => engine.removeStaleOrder(orderId),
    };

    for (const [terminalPath, terminate] of Object.entries(terminalActions)) {
      const { capital, engine } = setup(0.01, {
        maxExecutionIdsPerOrder: 1, maxExecutionDedupeOrders: 1,
      });
      const resyncs = [];
      engine.on('capital-resync-required', (event) => resyncs.push(event));
      const orderId = engine._sendNewOrder({
        side: 'sell', price: 100000, size: 0.01, level: 1,
      });
      engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
      terminate(engine, orderId);
      expect(capital.isActionableReservation(orderId)).toBe(false);
      const stateBeforeLateReports = capital.getStatus();

      engine.onExecutionReport({ '11': orderId, '39': 'Z', '54': '2', '17': 'late-u1' });
      engine.onExecutionReport({ '11': orderId, '39': 'Y', '54': '2', '17': 'late-u2' });
      expect(engine.unknownStatusDedupeByOrder.has(orderId)).toBe(false);
      expect(engine.executionEvidenceGap).toBeNull();
      expect(engine.quotingSuspended).toBe(false);
      expect(resyncs).toEqual([]);
      expect(capital.getStatus()).toMatchObject({
        state: stateBeforeLateReports.state,
        reason: stateBeforeLateReports.reason,
        blockedSides: stateBeforeLateReports.blockedSides,
      });
      expect(terminalPath).toBeString();
    }
  });

  test('active unknown identity capacity still fails closed instead of evicting replay protection', () => {
    const { capital, engine } = setup(0.01, { maxExecutionIdsPerOrder: 1 });
    const resyncs = [];
    engine.on('capital-resync-required', (event) => resyncs.push(event));
    const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
    engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
    engine.onExecutionReport({ '11': orderId, '39': 'Z', '54': '2', '17': 'u1' });
    capital.reconcile({
      baseBalance: { available: 0, held: 0.01, total: 0.01 },
      quoteBalance: { available: 2000, held: 0, total: 2000 },
      liveOrders: [{ orderId }], clearBlockedSides: true,
    });
    engine.resolveAuthoritativeExecutionEvidenceGap();

    engine.onExecutionReport({ '11': orderId, '39': 'Y', '54': '2', '17': 'u2' });
    expect(engine.executionEvidenceGap).toMatchObject({
      reason: 'unknown-status-dedupe-capacity-exceeded', authoritative: false,
    });
    expect(capital.getStatus()).toMatchObject({
      state: 'degraded', reason: 'unknown-status-dedupe-capacity-exceeded', blockedSides: ['sell'],
    });
    expect(engine.unknownStatusDedupeByOrder.get(orderId).execIDs).toEqual(new Set(['u1']));
    expect(resyncs).toHaveLength(2);
  });

  test('unknown OrdStatus remains observational for untracked and legacy orders', () => {
    const managed = setup();
    const managedResyncs = [];
    managed.engine.on('capital-resync-required', (event) => managedResyncs.push(event));
    managed.engine.onExecutionReport({ '11': 'untracked', '39': 'Z', '54': '2' });
    expect(managed.engine.quotingSuspended).toBe(false);
    expect(managedResyncs).toEqual([]);

    const legacy = new QuoteEngine({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    legacy.activeOrders.set('legacy', {
      side: 'sell', price: 100000, size: 0.01, level: 1,
      status: 'active', acknowledgedLive: true,
    });
    legacy.onExecutionReport({ '11': 'legacy', '39': 'Z', '54': '2' });
    expect(legacy.activeOrders.has('legacy')).toBe(true);
    expect(legacy.quotingSuspended).toBe(false);
  });

  test('authoritative terminal rejects supplied malformed or nonzero LeavesQty as evidence gaps', () => {
    for (const leaves of ['bad', '0.001', '']) {
      const { capital, engine } = setup(0.01);
      const fills = [];
      const resyncs = [];
      engine.on('fill', (fill) => fills.push(fill));
      engine.on('capital-resync-required', (event) => resyncs.push(event));
      const orderId = engine._sendNewOrder({ side: 'sell', price: 100000, size: 0.01, level: 1 });
      engine.onExecutionReport({ '11': orderId, '39': '0', '54': '2' });
      const terminal = {
        '11': orderId, '39': '2', '54': '2', '17': `terminal-${leaves}`,
        '31': '100000', '32': '0.01', '151': leaves,
      };

      engine.onExecutionReport(terminal);
      engine.onExecutionReport(terminal);
      expect(capital.getReservation(orderId)).toMatchObject({
        state: 'terminal-evidence-gap', acknowledgedLive: false,
      });
      expect(capital.getStatus()).toMatchObject({
        reason: 'invalid-terminal-leaves-quantity', blockedSides: ['sell'],
      });
      expect(resyncs).toEqual([expect.objectContaining({
        orderId, side: 'sell', reason: 'invalid-terminal-leaves-quantity',
      })]);
      expect(fills).toEqual([expect.objectContaining({
        size: 0.01, estimated: true, evidenceGap: true,
      })]);
    }
  });
});
