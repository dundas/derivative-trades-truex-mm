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
});
