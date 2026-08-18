import { describe, expect, mock, test } from 'bun:test';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { QuoteEngine } from './quote-engine.js';

function setup(baseAvailable = 0.01686) {
  const capital = new CapitalReservationManager();
  capital.reconcile({
    baseBalance: { available: baseAvailable, held: 0, total: baseAvailable },
    quoteBalance: { available: 2000, held: 0, total: 2000 },
    liveOrders: [],
  });
  const fixConnection = { sendMessage: mock(() => {}) };
  const engine = new QuoteEngine({ capitalReservationManager: capital, fixConnection, logger: { info() {}, warn() {}, error() {}, debug() {} } });
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
