import { describe, expect, test } from 'bun:test';
import { CapitalReservationManager } from './capital-reservation-manager.js';

const snapshot = (available = 0.01686, held = 0) => ({
  baseBalance: { available, held, total: available + held },
  quoteBalance: { available: 2000, held: 0, total: 2000 },
});

describe('CapitalReservationManager', () => {
  test('reserves before send and does not double-subtract a REST-reflected hold', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    expect(capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01 }).accepted).toBe(true);
    capital.accept('ask-1');
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);

    capital.reconcile({ ...snapshot(0.00686, 0.01), liveOrders: [{ orderId: 'ask-1' }] });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);
  });

  test('keeps acknowledged-live and capital reserved while cancel is in flight', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01, level: 1 });
    capital.accept('ask-1');
    capital.cancelRequested('ask-1');
    expect(capital.getReservation('ask-1')).toMatchObject({ state: 'cancel-in-flight', acknowledgedLive: true });
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 1 });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);
  });

  test('deduplicates fills and keeps consumed funds unavailable until a newer snapshot absorbs them', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01 });
    capital.accept('ask-1');
    expect(capital.fill({ orderId: 'ask-1', executionId: 'e1', quantity: 0.004, leavesQuantity: 0.006 })).toBe(true);
    expect(capital.fill({ orderId: 'ask-1', executionId: 'e1', quantity: 0.004, leavesQuantity: 0.006 })).toBe(false);
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);
    capital.fill({ orderId: 'ask-1', executionId: 'e2', quantity: 0.006, leavesQuantity: 0 });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 0 });

    capital.reconcile({ ...snapshot(0.00686), liveOrders: [] });
    expect(capital.getAvailable('sell')).toBeCloseTo(0.00686, 8);
  });

  test('cancel reject restores active idempotently and cancel ack releases once', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01 });
    capital.accept('ask-1');
    capital.cancelRequested('ask-1');
    expect(capital.cancelRejected('ask-1')).toBe(true);
    expect(capital.cancelRejected('ask-1')).toBe(false);
    expect(capital.getReservation('ask-1').state).toBe('active');
    expect(capital.cancelled('ask-1')).toBe(true);
    expect(capital.cancelled('ask-1')).toBe(false);
    expect(capital.getAvailable('sell')).toBeCloseTo(0.01686, 8);
  });

  test('blocks only the insufficient side until explicit balance and live-order reconciliation', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    capital.insufficientFunds('sell');
    expect(capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01 })).toMatchObject({ accepted: false, reason: 'insufficient-funds-resync-required' });
    expect(capital.reserve({ orderId: 'bid-1', side: 'buy', price: 100000, size: 0.01 }).accepted).toBe(true);
    capital.reconcile({ ...snapshot(0.02), liveOrders: [], clearBlockedSides: true });
    expect(capital.reserve({ orderId: 'ask-2', side: 'sell', price: 100000, size: 0.01 }).accepted).toBe(true);
  });

  test('fresh REST absence clears acknowledged-live and delayed terminal events cannot resurrect it', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    capital.reserve({ orderId: 'ask-1', side: 'sell', price: 100000, size: 0.01 });
    capital.accept('ask-1');
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    expect(capital.getReservation('ask-1')).toMatchObject({ state: 'cancelled', acknowledgedLive: false });
    expect(capital.accept('ask-1')).toBe(false);
    expect(capital.cancelRejected('ask-1')).toBe(false);
    expect(capital.getPresence().sell).toBe(0);
  });

  test('protects the configured L1 reserve from deeper levels under constrained capital', () => {
    const capital = new CapitalReservationManager({ l1ReserveBase: 0.01, l1ReserveQuote: 1000 });
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    expect(capital.reserve({ orderId: 'ask-l2-too-large', side: 'sell', price: 100000, size: 0.01, level: 2 })).toMatchObject({ accepted: false, reason: 'locally-unfunded' });
    expect(capital.reserve({ orderId: 'ask-l2', side: 'sell', price: 100000, size: 0.0068, level: 2 }).accepted).toBe(true);
    expect(capital.reserve({ orderId: 'ask-l1', side: 'sell', price: 100000, size: 0.01, level: 1 }).accepted).toBe(true);
  });
});
