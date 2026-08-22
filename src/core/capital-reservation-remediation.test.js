import { describe, expect, mock, test } from 'bun:test';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { MakerPresenceController } from './maker-presence-controller.js';
import { QuoteEngine } from './quote-engine.js';

const continuity = {
  minActiveLevelsPerSide: 1,
  minimumFundedQuoteSize: 0.0001,
  l1ReserveBase: 0.01,
  l1ReserveQuote: 1000,
  maxSideGapMs: 1000,
  alertThresholdMs: 500,
  alertRateLimitMs: 2000,
  degradedMaxLevels: 2,
  degradedSizeFactor: 0.5,
  defensiveSpreadFloorBps: 80,
};
const balances = {
  baseBalance: { available: 0.0168, held: 0, total: 0.0168 },
  quoteBalance: { available: 1680, held: 0, total: 1680 },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function capitalWithLadder() {
  const capital = new CapitalReservationManager(continuity);
  capital.reconcile({ ...balances, liveOrders: [] });
  for (const [id, side, size, level, price] of [
    ['bid-l1', 'buy', 0.01, 1, 99999], ['bid-l2', 'buy', 0.0068, 2, 99998],
    ['ask-l1', 'sell', 0.01, 1, 100001], ['ask-l2', 'sell', 0.0068, 2, 100002],
  ]) {
    expect(capital.reserve({ orderId: id, side, size, level, price }).accepted).toBe(true);
    capital.accept(id);
  }
  return capital;
}

describe('capital reservation remediation', () => {
  test('legacy fill without ExecID fails closed before mutation and blocks later replay', () => {
    const engine = new QuoteEngine({ logger });
    const fills = [];
    const gaps = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.on('execution-evidence-gap', (gap) => gaps.push(gap));
    engine.activeOrders.set('missing-id', { side: 'buy', size: 0.01, price: 100000, level: 1, status: 'active' });
    engine.onExecutionReport({ '11': 'missing-id', '39': '1', '31': '100000', '32': '0.001', '151': '0.009', '54': '1' });
    engine.onExecutionReport({ '11': 'missing-id', '17': 'late-id', '39': '1', '31': '100000', '32': '0.001', '151': '0.009', '54': '1' });
    expect(fills).toHaveLength(0);
    expect(engine.activeOrders.get('missing-id').size).toBe(0.01);
    expect(gaps).toEqual([expect.objectContaining({ orderId: 'missing-id', reason: 'execution-id-required' })]);
    expect(engine.quotingSuspended).toBe(true);
  });

  test('legacy ExecID cap is exact: replay is ignored and unseen identity at capacity fails closed', () => {
    const engine = new QuoteEngine({ maxExecutionIdsPerOrder: 2, logger });
    const fills = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.activeOrders.set('cap', { side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active' });
    const a = { '11': 'cap', '17': 'a', '39': '1', '31': '100000', '32': '0.001', '151': '0.009', '54': '2' };
    const b = { ...a, '17': 'b', '151': '0.008' };
    engine.onExecutionReport(a);
    engine.onExecutionReport(b);
    engine.onExecutionReport(a);
    engine.onExecutionReport({ ...a, '17': 'c', '151': '0.007' });
    expect(fills.map((fill) => fill.execID)).toEqual(['a', 'b']);
    expect(engine.activeOrders.get('cap').size).toBeCloseTo(0.008, 8);
    expect(engine.executionEvidenceGap).toMatchObject({ orderId: 'cap', reason: 'execution-id-capacity-exceeded' });
    expect([...engine.executionDedupeByOrder.get('cap').execIDs]).toEqual(['a', 'b']);
  });

  test('legacy partial validates remaining quantity and only missing LeavesQty uses exact fallback', () => {
    const good = new QuoteEngine({ logger });
    good.activeOrders.set('fallback', { side: 'buy', size: 0.01, price: 100000, level: 1, status: 'active' });
    good.onExecutionReport({ '11': 'fallback', '17': 'fallback-id', '39': '1', '31': '100000', '32': '0.003', '54': '1' });
    expect(good.activeOrders.get('fallback').size).toBeCloseTo(0.007, 8);

    const stale = new QuoteEngine({ logger });
    stale.activeOrders.set('stale', { side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active' });
    stale.onExecutionReport({ '11': 'stale', '17': 'stale-id', '39': '1', '31': '100000', '32': '0.003', '151': '0.008', '54': '2' });
    expect(stale.activeOrders.get('stale').size).toBe(0.01);
    expect(stale.executionEvidenceGap).toMatchObject({ reason: 'inconsistent-partial-quantity' });
  });

  test('legacy fill accounting dedupes ExecIDs, falls back to valid limit price, and bounds terminal tombstones', () => {
    const engine = new QuoteEngine({ maxExecutionDedupeOrders: 2, logger });
    const fills = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.activeOrders.set('legacy', { side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active' });
    const partial = { '11': 'legacy', '17': 'legacy-partial', '39': '1', '31': 'bad', '32': '0.004', '151': '0.006', '54': '2' };
    engine.onExecutionReport(partial);
    engine.onExecutionReport(partial);
    const terminal = { '11': 'legacy', '17': 'legacy-terminal', '39': '2', '31': 'bad', '32': '0.006', '151': '0', '54': '2' };
    engine.onExecutionReport(terminal);
    engine.onExecutionReport(terminal);
    engine.onExecutionReport({ ...terminal, '17': 'late-terminal' });
    expect(fills).toHaveLength(2);
    expect(fills).toEqual([
      expect.objectContaining({ execID: 'legacy-partial', price: 100000, estimated: true, evidenceGap: true }),
      expect.objectContaining({ execID: 'legacy-terminal', price: 100000, estimated: true, evidenceGap: true }),
    ]);
    expect(engine.executionDedupeByOrder.has('legacy')).toBe(false);
    expect(engine.terminalExecutionOrders.has('legacy')).toBe(true);

    for (const id of ['legacy-2', 'legacy-3']) {
      engine.activeOrders.set(id, { side: 'buy', size: 0.001, price: 99999, level: 1, status: 'active' });
      engine.onExecutionReport({ '11': id, '17': `exec-${id}`, '39': '2', '31': '99999', '32': '0.001', '54': '1' });
    }
    expect(engine.executionDedupeByOrder.size).toBeLessThanOrEqual(2);
  });

  test('legacy terminal requires proof before consuming the preterminal remainder', () => {
    const unproven = new QuoteEngine({ logger });
    const unprovenFills = [];
    unproven.on('fill', (fill) => unprovenFills.push(fill));
    unproven.activeOrders.set('unproven', {
      side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active',
    });
    unproven.onExecutionReport({
      '11': 'unproven', '17': 'partial', '39': '1', '31': '100010',
      '32': '0.004', '151': '0.006', '54': '2',
    });
    unproven.onExecutionReport({
      '11': 'unproven', '17': 'terminal', '39': '2', '31': '100020',
      '32': '0.001', '54': '2',
    });
    expect(unprovenFills.map((fill) => fill.size)).toEqual([0.004]);
    expect(unproven.activeOrders.get('unproven').size).toBeCloseTo(0.006, 8);
    expect(unproven.executionEvidenceGap).toMatchObject({
      orderId: 'unproven', reason: 'unproven-terminal-fill', executionState: 'unsafe',
    });
    expect(unproven.quotingSuspended).toBe(true);

    const proven = new QuoteEngine({ logger });
    const provenFills = [];
    proven.on('fill', (fill) => provenFills.push(fill));
    proven.activeOrders.set('proven', {
      side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active',
    });
    proven.onExecutionReport({
      '11': 'proven', '17': 'partial', '39': '1', '31': '100010',
      '32': '0.004', '151': '0.006', '54': '2',
    });
    const terminal = {
      '11': 'proven', '17': 'terminal', '39': '2', '31': '100020',
      '32': '0.001', '151': '0', '54': '2',
    };
    proven.onExecutionReport(terminal);
    proven.onExecutionReport(terminal);
    expect(provenFills).toEqual([
      expect.objectContaining({ execID: 'partial', size: 0.004 }),
      expect.objectContaining({
        execID: 'terminal', size: 0.006, estimated: true, evidenceGap: true,
      }),
    ]);
    expect(provenFills.reduce((total, fill) => total + fill.size, 0)).toBeCloseTo(0.01, 8);
    expect(proven.activeOrders.has('proven')).toBe(false);
    expect(proven.terminalExecutionOrders.has('proven')).toBe(true);
  });

  test('legacy terminal rejects malformed or nonzero LeavesQty before mutation', () => {
    for (const leaves of ['bad', '0.001', '']) {
      const engine = new QuoteEngine({ logger });
      const fills = [];
      engine.on('fill', (fill) => fills.push(fill));
      engine.activeOrders.set(`leaves-${leaves}`, {
        side: 'buy', size: 0.006, price: 100000, level: 1, status: 'active',
      });
      engine.onExecutionReport({
        '11': `leaves-${leaves}`, '17': `exec-${leaves}`, '39': '2', '31': '100000',
        '32': '0.006', '151': leaves, '54': '1',
      });
      expect(fills).toHaveLength(0);
      expect(engine.activeOrders.get(`leaves-${leaves}`).size).toBe(0.006);
      expect(engine.executionEvidenceGap).toMatchObject({ reason: 'invalid-terminal-leaves-quantity' });
    }
  });

  test('legacy fill without any valid execution or limit price fails closed', () => {
    const engine = new QuoteEngine({ logger });
    const fills = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.activeOrders.set('no-price', { side: 'buy', size: 0.01, price: 0, level: 1, status: 'active' });
    engine.onExecutionReport({ '11': 'no-price', '17': 'no-price-exec', '39': '1', '31': 'bad', '32': '0.004', '151': '0.006', '54': '1' });
    expect(fills).toHaveLength(0);
    expect(engine.activeOrders.get('no-price').size).toBe(0.01);
  });

  test('missing LastQty derives a partial from valid LeavesQty and terminal gap emits one estimated fill', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({ capitalReservationManager: capital, logger });
    capital.reserve({ orderId: 'derived', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('derived');
    engine.activeOrders.set('derived', { side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active' });
    const fills = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.onExecutionReport({ '11': 'derived', '17': 'partial-derived', '39': '1', '151': '0.006', '54': '2' });
    expect(capital.getReservation('derived').remainingSize).toBeCloseTo(0.006, 8);
    expect(fills[0]).toMatchObject({
      size: 0.004, price: 100000, execID: 'partial-derived', estimated: true, evidenceGap: true,
    });
    engine.onExecutionReport({ '11': 'derived', '39': '2', '54': '2' });
    engine.onExecutionReport({ '11': 'derived', '39': '2', '54': '2' });
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({ size: 0.006, price: 100000, estimated: true, evidenceGap: true });
  });

  test('terminal accounting emits the full remaining amount once with original ExecID and fallback price', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({ capitalReservationManager: capital, logger });
    capital.reserve({ orderId: 'terminal-original', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('terminal-original');
    engine.activeOrders.set('terminal-original', {
      side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active',
    });
    const fills = [];
    engine.on('fill', (fill) => fills.push(fill));
    engine.onExecutionReport({
      '11': 'terminal-original', '17': 'partial-first', '39': '1', '31': '100010',
      '32': '0.004', '151': '0.006', '54': '2',
    });
    engine.onExecutionReport({
      '11': 'terminal-original', '17': 'terminal-original-exec', '39': '2', '31': 'bad',
      '32': '0.001', '151': '0', '54': '2',
    });
    engine.onExecutionReport({
      '11': 'terminal-original', '17': 'terminal-original-exec', '39': '2', '151': '0', '54': '2',
    });
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({
      size: 0.006, price: 100000, execID: 'terminal-original-exec', estimated: true, evidenceGap: true,
    });
  });

  test('partial fill without valid LastQty blocks for resync while retaining live capital through cancel', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({ capitalReservationManager: capital, logger });
    capital.reserve({ orderId: 'partial-gap', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('partial-gap');
    engine.activeOrders.set('partial-gap', {
      side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active', acknowledgedLive: true,
    });

    engine.onExecutionReport({ '11': 'partial-gap', '17': 'exec-gap', '39': '1', '32': 'bad', '151': 'bad', '54': '2' });
    expect(capital.getReservation('partial-gap')).toMatchObject({
      remainingSize: 0.01, acknowledgedLive: true, state: 'active',
    });
    expect(capital.getStatus()).toMatchObject({
      state: 'degraded', reason: 'partial-fill-evidence-gap', blockedSides: ['sell'],
    });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);

    engine.onExecutionReport({ '11': 'partial-gap', '39': '4', '54': '2' });
    expect(capital.getReservation('partial-gap')).toMatchObject({ state: 'cancelled', acknowledgedLive: false });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0168, 8);
  });

  test('terminal fill without ExecID clears presence, charges remaining capital, and blocks for resync', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    const engine = new QuoteEngine({ capitalReservationManager: capital, logger });
    capital.reserve({ orderId: 'terminal-gap', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('terminal-gap');
    engine.activeOrders.set('terminal-gap', {
      side: 'sell', size: 0.01, price: 100000, level: 1, status: 'active', acknowledgedLive: true,
    });

    engine.onExecutionReport({ '11': 'terminal-gap', '39': '2', '151': '0', '54': '2' });
    expect(capital.getReservation('terminal-gap')).toMatchObject({
      state: 'terminal-evidence-gap', remainingSize: 0, acknowledgedLive: false,
    });
    expect(capital.getPresence().sell).toBe(0);
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);
    expect(capital.getStatus()).toMatchObject({
      state: 'degraded', reason: 'terminal-fill-execution-id-required', blockedSides: ['sell'],
    });
    expect(engine.activeOrders.has('terminal-gap')).toBe(false);
  });

  test('desired ladder accounts for existing reservations instead of cancelling funded depth', () => {
    const capital = capitalWithLadder();
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      inventoryManager: { canQuote: () => true, getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }) },
      levels: 2, baseSizeBTC: 0.01, sizeDecayFactor: 0.68, minimumFundedQuoteSize: 0.0001,
      logger,
    });
    const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
    expect(desired.filter((q) => q.side === 'buy').map((q) => q.level)).toEqual([1, 2]);
    expect(desired.filter((q) => q.side === 'sell').map((q) => q.level)).toEqual([1, 2]);
  });

  test('full-fill terminal evidence consumes the entire remaining reservation and flags quantity gaps', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId: 'ask', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('ask');
    const result = capital.fullFill('ask', 'exec-1', { lastQuantity: 0.004, leavesQuantity: 0 });
    expect(result).toBe(true);
    expect(capital.getStatus()).toMatchObject({ state: 'degraded', reason: 'terminal-fill-quantity-gap' });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);
  });

  test('missing ExecID fails closed without charging twice', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId: 'ask', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('ask');
    expect(capital.fill({ orderId: 'ask', quantity: 0.004, leavesQuantity: 0.006 })).toBe(false);
    expect(capital.getStatus().reason).toBe('execution-id-required');
    expect(capital.getReservation('ask').remainingSize).toBe(0.01);
  });

  test('a fill after REST request start survives the older snapshot response', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId: 'ask', side: 'sell', size: 0.01, price: 100000, level: 1 });
    capital.accept('ask');
    const generation = capital.beginReconciliation();
    capital.fill({ orderId: 'ask', executionId: 'exec-1', quantity: 0.004, leavesQuantity: 0.006 });
    capital.reconcile({
      baseBalance: { available: 0.0068, held: 0.01, total: 0.0168 },
      quoteBalance: balances.quoteBalance,
      liveOrders: [{ orderId: 'ask' }],
      generation,
    });
    expect(capital.getReservation('ask').remainingSize).toBe(0.006);
    expect(capital.getAvailable('sell')).toBeCloseTo(0.0068, 8);
  });

  test('a second-side reject during resync remains blocked after the older generation completes', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.insufficientFunds('sell');
    const generation = capital.beginReconciliation();
    capital.insufficientFunds('buy');
    capital.reconcile({ ...balances, liveOrders: [], generation, clearBlockedSides: true });
    expect(capital.getStatus().blockedSides).toEqual(['buy']);
  });

  test('ignores an out-of-order older snapshot and bounds terminal identity retention', () => {
    const capital = new CapitalReservationManager({ maxTerminalReservations: 2 });
    capital.reconcile({ ...balances, liveOrders: [] });
    const older = capital.beginReconciliation();
    const newer = capital.beginReconciliation();
    capital.reconcile({ ...balances, liveOrders: [], generation: newer });
    capital.reconcile({
      baseBalance: { available: 0, held: 0, total: 0 },
      quoteBalance: { available: 0, held: 0, total: 0 },
      liveOrders: [], generation: older,
    });
    expect(capital.getStatus().balances.base.available).toBe(0.0168);

    for (const id of ['one', 'two', 'three']) {
      expect(capital.reserve({ orderId: id, side: 'sell', size: 0.001, price: 100000, level: 1 }).accepted).toBe(true);
      capital.rejected(id);
    }
    expect(capital.getReservation('one')).toBeNull();
    expect(capital.getReservation('two').state).toBe('rejected');
    expect(capital.getReservation('three').state).toBe('rejected');
  });
});

describe('presence and dispatch remediation', () => {
  test('unsafe is a direct and deferred no-place gate that cannot reopen after a price tick', () => {
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({
      fixConnection, inventoryManager: { canQuote: () => true, getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }) },
      continuityStateProvider: () => ({ executionState: 'unsafe', reasons: ['emergency-kill-switch'] }),
      logger,
    });
    engine.executeActions({ toCancel: [], toReplace: [], toPlace: [{ side: 'buy', level: 1, size: 0.01, price: 99900 }] });
    engine.lastMid = 100000;
    engine.deferredRepriceNeeded = true;
    engine.drainQueue();
    engine.onPriceUpdate({ weightedMidpoint: 100000, confidence: 1, sources: [] });
    expect(fixConnection.sendMessage.mock.calls.some(([fields]) => fields['35'] === 'D')).toBe(false);
    expect(engine.getContinuityState().executionState).toBe('unsafe');
  });

  test('unsafe allows all required pure cancels even below the presence floor', () => {
    const config = { ...continuity, minActiveLevelsPerSide: 2 };
    const capital = new CapitalReservationManager(config);
    capital.reconcile({ ...balances, liveOrders: [] });
    for (const [id, side] of [['b1', 'buy'], ['s1', 'sell']]) {
      capital.reserve({ orderId: id, side, level: 1, size: 0.001, price: 100000 });
      capital.accept(id);
    }
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({
      capitalReservationManager: capital, fixConnection, minActiveLevelsPerSide: 2,
      continuityStateProvider: () => ({ executionState: 'unsafe', reasons: ['emergency-kill-switch'] }), logger,
    });
    for (const order of capital.getReservations()) engine.activeOrders.set(order.orderId, {
      ...order, size: order.remainingSize, status: 'active',
    });
    engine.executeActions({
      toCancel: capital.getReservations().map((order) => ({ clOrdID: order.orderId, order })),
      toReplace: [], toPlace: [],
    });
    expect(fixConnection.sendMessage.mock.calls.filter(([fields]) => fields['35'] === 'F')).toHaveLength(2);
  });

  test('authoritative cancel intents are never queued with stale presence assumptions', () => {
    const capital = capitalWithLadder();
    const engine = new QuoteEngine({
      capitalReservationManager: capital, fixConnection: { sendMessage: mock(() => {}) },
      minActiveLevelsPerSide: 1, maxOrdersPerSecond: 1, logger,
    });
    engine.actionsThisSecond = 1;
    const order = capital.getReservation('bid-l2');
    engine.executeActions({ toCancel: [{ clOrdID: order.orderId, order }], toReplace: [], toPlace: [] });
    expect(engine.actionQueue).toHaveLength(0);
    expect(engine.deferredRepriceNeeded).toBe(true);

    engine.actionQueue.push({ type: 'cancel', clOrdID: order.orderId, order });
    capital.cancelled('bid-l1');
    engine.actionsThisSecond = 0;
    engine.drainQueue();
    expect(engine.fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.suppressedLevels.get('buy:2')).toMatchObject({
      reason: 'queued-cancel-rederive-required', executionState: 'normal',
    });
  });

  test('normal continuity never cancels both last unique L1 levels in one batch', () => {
    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    for (const [id, side] of [['b1', 'buy'], ['s1', 'sell']]) {
      capital.reserve({ orderId: id, side, level: 1, size: 0.001, price: 100000 });
      capital.accept(id);
    }
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({ capitalReservationManager: capital, fixConnection, minActiveLevelsPerSide: 1, logger });
    for (const reservation of capital.getReservations()) engine.activeOrders.set(reservation.orderId, {
      side: reservation.side, level: 1, size: reservation.remainingSize, price: reservation.price, status: 'active',
    });
    engine.executeActions({
      toCancel: capital.getReservations().map((order) => ({ clOrdID: order.orderId, order })),
      toReplace: [], toPlace: [],
    });
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
  });

  test('presence below a multi-level obligation is degraded and preserves the funded side floor', () => {
    const config = { ...continuity, minActiveLevelsPerSide: 2 };
    const capital = new CapitalReservationManager(config);
    capital.reconcile({ ...balances, liveOrders: [] });
    for (const [id, side, level] of [['b1', 'buy', 1], ['b2', 'buy', 2], ['b3', 'buy', 3], ['s1', 'sell', 1]]) {
      capital.reserve({ orderId: id, side, level, size: 0.001, price: 100000 });
      capital.accept(id);
    }
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({
      capitalReservationManager: capital, fixConnection, minActiveLevelsPerSide: 2,
      degradedMaxLevels: 2, degradedSizeFactor: 0.5, defensiveSpreadFloorBps: 80, logger,
    });
    engine.setContinuityState({ executionState: 'degraded', reasons: ['missing-acknowledged-sell'] });
    for (const reservation of capital.getReservations()) {
      engine.activeOrders.set(reservation.orderId, {
        side: reservation.side, level: reservation.level, size: reservation.remainingSize,
        price: reservation.price, status: 'active', acknowledgedLive: true,
      });
    }
    engine.executeActions({
      toCancel: [
        { clOrdID: 'b1', order: engine.activeOrders.get('b1') },
        { clOrdID: 'b2', order: engine.activeOrders.get('b2') },
      ],
      toReplace: [], toPlace: [],
    });
    const cancels = fixConnection.sendMessage.mock.calls
      .map(([fields]) => fields)
      .filter((fields) => fields['35'] === 'F');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]['41']).toBe('b2');

    fixConnection.sendMessage.mockClear();
    engine.executeActions({
      toCancel: [],
      toReplace: [{
        cancel: 'b1', cancelOrder: engine.activeOrders.get('b1'),
        place: { side: 'buy', level: 1, size: 0.001, price: 99999 },
      }],
      toPlace: [],
    });
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.suppressedLevels.get('buy:1')).toMatchObject({ reason: 'degraded-preserve-funded-l1' });
    expect(engine.suppressedLevels.get('buy:1')).toMatchObject({
      cause: 'degraded-preserve-funded-l1', executionState: 'degraded',
      transition: expect.any(String),
    });
  });

  test('configured degraded control floors spread and reduces depth and size', () => {
    const engine = new QuoteEngine({
      inventoryManager: { canQuote: () => true }, levels: 4, baseSpreadBps: 20,
      baseSizeBTC: 0.01, minNotional: 1, minimumFundedQuoteSize: 0.0001,
      degradedMaxLevels: 2, degradedSizeFactor: 0.5, defensiveSpreadFloorBps: 80, logger,
    });
    engine.setContinuityState({ executionState: 'degraded', reasons: ['missing-acknowledged-sell'] });
    const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
    expect(desired.filter((quote) => quote.side === 'buy')).toHaveLength(2);
    expect(desired.filter((quote) => quote.side === 'sell')).toHaveLength(2);
    expect(desired[0].size).toBeCloseTo(0.005, 8);
    expect(100000 - desired.find((quote) => quote.side === 'buy' && quote.level === 1).price).toBeGreaterThanOrEqual(400);
    expect(engine.getContinuityState()).toMatchObject({ executionState: 'degraded' });
    expect(engine.getQuoteStatus().continuity).toMatchObject({ executionState: 'degraded' });

    const mirror = new QuoteEngine({
      inventoryManager: { canQuote: () => true }, levels: 2, baseSpreadBps: 20,
      quoteAnchorMode: 'coinbase-mirror', baseSizeBTC: 0.01, minNotional: 1,
      degradedMaxLevels: 2, degradedSizeFactor: 0.5, defensiveSpreadFloorBps: 80, logger,
    });
    mirror.setContinuityState({ executionState: 'degraded', reasons: ['missing-acknowledged-buy'] });
    const mirrored = mirror.computeDesiredQuotes(
      100000, { bidSkewTicks: 0, askSkewTicks: 0 }, { bestBid: 99999.5, bestAsk: 100000.5 },
    );
    const mirroredL1 = mirrored.filter((quote) => quote.level === 1);
    expect(mirroredL1.find((quote) => quote.side === 'sell').price -
      mirroredL1.find((quote) => quote.side === 'buy').price).toBeGreaterThanOrEqual(800);

    expect(() => new QuoteEngine({ degradedMaxLevels: 1.5, logger })).toThrow('degradedMaxLevels');
    expect(() => new QuoteEngine({ degradedSizeFactor: 0, logger })).toThrow('degradedSizeFactor');
    expect(() => new QuoteEngine({ defensiveSpreadFloorBps: -1, logger })).toThrow('defensiveSpreadFloorBps');

    const omissionEngine = new QuoteEngine({
      inventoryManager: { canQuote: (side) => side === 'sell' },
      levels: 3, baseSizeBTC: 0.01, minNotional: 1,
      degradedMaxLevels: 2, degradedSizeFactor: 0.5, defensiveSpreadFloorBps: 80, logger,
    });
    omissionEngine.setContinuityState({ executionState: 'degraded', reasons: ['capital-reconciliation-degraded'] });
    omissionEngine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
    expect(omissionEngine.suppressedLevels.get('buy:1')).toMatchObject({
      reason: 'degraded-can-quote-disabled', executionState: 'degraded',
      quote: { cause: 'can-quote-disabled', transition: 'degraded-quote-omitted' },
    });
    expect(omissionEngine.suppressedLevels.get('sell:3')).toMatchObject({
      reason: 'degraded-max-levels', executionState: 'degraded',
      quote: { cause: 'maximum-depth', transition: 'degraded-quote-omitted' },
    });
  });

  test('hard-caps the full displayed spread for normal, mirrored, fallback, and degraded quote paths', () => {
    const contractMaxQuoteSpreadBps = 10;
    const mid = 100000;
    const assertCap = (desired) => {
      for (const level of [1, 2]) {
        const bid = desired.find((quote) => quote.side === 'buy' && quote.level === level);
        const ask = desired.find((quote) => quote.side === 'sell' && quote.level === level);
        expect(ask).toBeDefined();
        expect(bid).toBeDefined();
        expect(ask.price - bid.price).toBeLessThanOrEqual(mid * contractMaxQuoteSpreadBps / 10000);
      }
    };
    const baseOptions = {
      inventoryManager: { canQuote: () => true }, levels: 2, baseSpreadBps: 30,
      baseSizeBTC: 0.01, minNotional: 1, contractMaxQuoteSpreadBps, logger,
    };

    // Missing anchor deliberately takes the mid-based fallback path.
    assertCap(new QuoteEngine({ ...baseOptions, quoteAnchorMode: 'coinbase-mirror' })
      .computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 }));
    // An external touch that is much wider than contract is bounded before it
    // reaches the generated quote set.
    assertCap(new QuoteEngine({ ...baseOptions, quoteAnchorMode: 'coinbase-mirror' })
      .computeDesiredQuotes(mid, { bidSkewTicks: -8, askSkewTicks: 8 }, {
        bestBid: 99000, bestAsk: 101000,
      }));

    const degraded = new QuoteEngine({
      ...baseOptions, degradedMaxLevels: 2, degradedSizeFactor: 0.5,
      defensiveSpreadFloorBps: 80,
    });
    degraded.setContinuityState({ executionState: 'degraded', reasons: ['test'] });
    assertCap(degraded.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 }, {
      bestBid: 99000, bestAsk: 101000,
    }));

    expect(() => new QuoteEngine({ contractMaxQuoteSpreadBps: 0, logger }))
      .toThrow('contractMaxQuoteSpreadBps');
  });

  test('counts unique valid levels and rejects a backward clock', () => {
    let now = 1000;
    const controller = new MakerPresenceController({ ...continuity, minActiveLevelsPerSide: 2 }, { now: () => now });
    const duplicateL1 = [
      { side: 'buy', level: 1, acknowledgedLive: true, remainingSize: 0.01 },
      { side: 'buy', level: 1, acknowledgedLive: true, remainingSize: 0.01 },
      { side: 'sell', level: 1, acknowledgedLive: true, remainingSize: 0.01 },
      { side: 'sell', level: 2, acknowledgedLive: true, remainingSize: 0.01 },
    ];
    expect(controller.observe({ orders: duplicateL1 }).activeLevels).toEqual({ buy: 1, sell: 2 });
    now = 999;
    expect(() => controller.observe({ orders: duplicateL1 })).toThrow('monotonic');
  });

  test('classifies the exact configured side-gap boundary', () => {
    let now = 0;
    const controller = new MakerPresenceController(continuity, { now: () => now });
    controller.observe({ orders: [] });
    now = continuity.maxSideGapMs;
    expect(controller.observe({ orders: [] }).reasons).toContain('buy-side-gap-exceeded');
    expect(controller.observe({ orders: [] }).reasons).toContain('sell-side-gap-exceeded');
  });

  test('late New preserves cancel-in-flight and acknowledged presence', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...balances, liveOrders: [] });
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({ capitalReservationManager: capital, fixConnection, logger });
    const id = engine._sendNewOrder({ side: 'sell', size: 0.01, price: 100000, level: 1 });
    engine._sendCancel(id, engine.activeOrders.get(id));
    engine.onExecutionReport({ '11': id, '39': '0', '54': '2' });
    expect(engine.activeOrders.get(id).status).toBe('cancelling');
    expect(capital.getReservation(id)).toMatchObject({ state: 'cancel-in-flight', acknowledgedLive: true });
  });

  test('engine instances generate collision-resistant IDs and missing-side degradation sends only absent L1', () => {
    const first = new QuoteEngine({ logger });
    const second = new QuoteEngine({ logger });
    expect(first.generateClOrdID()).not.toBe(second.generateClOrdID());

    const capital = new CapitalReservationManager(continuity);
    capital.reconcile({ ...balances, liveOrders: [] });
    capital.reserve({ orderId: 'bid-live', side: 'buy', size: 0.01, price: 99999, level: 1 });
    capital.accept('bid-live');
    const fixConnection = { sendMessage: mock(() => {}) };
    const engine = new QuoteEngine({
      capitalReservationManager: capital,
      fixConnection,
      minActiveLevelsPerSide: 1,
      minimumFundedQuoteSize: 0.0001,
      logger,
    });
    engine.setContinuityState({ executionState: 'degraded', reasons: ['missing-acknowledged-sell'] });
    engine.activeOrders.set('bid-live', {
      side: 'buy', level: 1, size: 0.01, price: 99999,
      status: 'active', acknowledgedLive: true, placedAt: Date.now(),
    });
    engine.executeActions({ toCancel: [], toReplace: [], toPlace: [
      { side: 'sell', level: 2, size: 0.0068, price: 100002 },
      { side: 'sell', level: 1, size: 0.01, price: 100001 },
      { side: 'buy', level: 2, size: 0.0068, price: 99998 },
    ] });
    const sentNew = fixConnection.sendMessage.mock.calls.map(([fields]) => fields).filter((fields) => fields['35'] === 'D');
    expect(sentNew.map((fields) => fields['54'])).toEqual(['2', '1']);
    expect(sentNew[0]['38']).toBe('0.01');

    fixConnection.sendMessage.mockClear();
    engine.executeActions({
      toCancel: [{ clOrdID: 'bid-live', order: engine.activeOrders.get('bid-live') }],
      toReplace: [],
      toPlace: [{ side: 'sell', level: 1, size: 0.01, price: 100001 }],
    });
    expect(fixConnection.sendMessage.mock.calls.some(([fields]) => fields['35'] === 'F')).toBe(false);
  });

  test('stable namespace IDs use boot entropy, remain bounded, and never wrap into reuse', () => {
    const originalNow = Date.now;
    Date.now = () => 123456789;
    try {
      const first = new QuoteEngine({
        orderIdNamespace: 'MM001', orderIdBootId: 'bootA', logger,
      });
      const second = new QuoteEngine({
        orderIdNamespace: 'MM001', orderIdBootId: 'bootB', logger,
      });
      const firstId = first.generateClOrdID();
      const secondId = second.generateClOrdID();
      expect(firstId).toBe('QMM001bootA000001');
      expect(secondId).toBe('QMM001bootB000001');
      expect(firstId).not.toBe(secondId);
      expect(firstId.length).toBeLessThanOrEqual(18);

      first.orderSequence = 36 ** 6 - 2;
      expect(first.generateClOrdID()).toBe('QMM001bootAzzzzzz');
      expect(() => first.generateClOrdID()).toThrow('sequence exhausted');
    } finally {
      Date.now = originalNow;
    }
  });
});
