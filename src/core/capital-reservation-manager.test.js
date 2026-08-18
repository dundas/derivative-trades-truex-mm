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

  test('level quote capacity preserves L1 only when no live L1 and includes existing reservations', () => {
    const capital = new CapitalReservationManager({ l1ReserveBase: 0.01, l1ReserveQuote: 1000 });
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    expect(capital.getQuoteCapacityForLevel('sell', 2)).toBeCloseTo(0.00686, 8);
    expect(capital.getQuoteCapacityForLevel('buy', 2)).toBeCloseTo(1000, 8);
    // A planned desired L1 consumes the carve-out rather than being subtracted twice.
    expect(capital.getQuoteCapacityForLevel('sell', 2, 0.01)).toBeCloseTo(0.01686, 8);
    expect(capital.getQuoteCapacityForLevel('buy', 2, 1000)).toBeCloseTo(2000, 8);

    capital.reserve({ orderId: 'ask-l1-live', side: 'sell', price: 100000, size: 0.01, level: 1 });
    capital.accept('ask-l1-live');
    capital.reserve({ orderId: 'bid-l1-live', side: 'buy', price: 100000, size: 0.01, level: 1 });
    capital.accept('bid-l1-live');
    expect(capital.getQuoteCapacityForLevel('sell', 2)).toBeCloseTo(0.01686, 8);
    expect(capital.getQuoteCapacityForLevel('buy', 2)).toBeCloseTo(2000, 8);
  });

  test('failed reconciliation preserves acknowledged L1 but rejects new reservations until coherent recovery', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(), liveOrders: [] });
    expect(capital.reserve({
      orderId: 'bid-l1', side: 'buy', price: 100000, size: 0.01, level: 1,
    }).accepted).toBe(true);
    expect(capital.reserve({
      orderId: 'ask-l1', side: 'sell', price: 100000, size: 0.01, level: 1,
    }).accepted).toBe(true);
    capital.accept('bid-l1');
    capital.accept('ask-l1');

    capital.reconciliationFailed();
    expect(capital.getPresence()).toEqual({ buy: 1, sell: 1 });
    expect(capital.reserve({
      orderId: 'ask-l2', side: 'sell', price: 100001, size: 0.001, level: 2,
    })).toEqual({ accepted: false, reason: 'capital-reconciliation-failed' });
    expect(capital.getReservation('ask-l1')).toMatchObject({
      state: 'active', acknowledgedLive: true, remainingSize: 0.01,
    });

    capital.reconcile({
      baseBalance: { available: 0.00686, held: 0.01, total: 0.01686 },
      quoteBalance: { available: 1000, held: 1000, total: 2000 },
      liveOrders: [{ orderId: 'bid-l1' }, { orderId: 'ask-l1' }],
    });
    expect(capital.getStatus().state).toBe('normal');
    expect(capital.reserve({
      orderId: 'ask-l2', side: 'sell', price: 100001, size: 0.001, level: 2,
    }).accepted).toBe(true);
  });

  test('REST absence conservatively consumes stale capacity until a fresh coherent snapshot', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(0.01), liveOrders: [] });
    capital.reserve({ orderId: 'missing-ask', side: 'sell', price: 100000, size: 0.01, level: 1 });
    capital.accept('missing-ask');

    expect(capital.restOrderAbsent('missing-ask')).toMatchObject({
      orderId: 'missing-ask', side: 'sell', outcome: 'unknown', remainingCommitment: 0.01,
    });
    expect(capital.getReservation('missing-ask')).toMatchObject({
      state: 'rest-absence-evidence-gap', acknowledgedLive: false, remainingSize: 0,
    });
    expect(capital.getAvailable('sell')).toBe(0);
    expect(capital.reserve({
      orderId: 'unsafe-reuse', side: 'sell', price: 100000, size: 0.01, level: 1,
    })).toMatchObject({ accepted: false });

    capital.reconciliationFailed();
    expect(capital.getStatus()).toMatchObject({ state: 'failed', blockedSides: ['sell'] });
    expect(capital.reserve({
      orderId: 'still-blocked', side: 'sell', price: 100000, size: 0.01, level: 1,
    })).toMatchObject({ accepted: false, reason: 'capital-reconciliation-failed' });

    const generation = capital.beginReconciliation();
    capital.reconcile({ ...snapshot(0.01), liveOrders: [], clearBlockedSides: true, generation });
    expect(capital.getStatus()).toMatchObject({ state: 'normal', blockedSides: [] });
    expect(capital.reserve({
      orderId: 'safe-after-fresh-snapshot', side: 'sell', price: 100000, size: 0.01, level: 1,
    }).accepted).toBe(true);
  });

  test('delayed terminal after REST absence cannot consume twice or resurrect presence', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({ ...snapshot(0.01), liveOrders: [] });
    capital.reserve({ orderId: 'missing-ask', side: 'sell', price: 100000, size: 0.01, level: 1 });
    capital.accept('missing-ask');
    capital.restOrderAbsent('missing-ask');
    const consumedBefore = capital.consumedEvents.map((event) => ({ ...event }));

    expect(capital.fullFill('missing-ask', 'late-terminal', {
      lastQuantity: 0.01, leavesQuantity: 0,
    })).toBe(false);
    expect(capital.consumedEvents).toEqual(consumedBefore);
    expect(capital.getPresence()).toEqual({ buy: 0, sell: 0 });
    expect(capital.getReservation('missing-ask')).toMatchObject({
      state: 'rest-absence-evidence-gap', acknowledgedLive: false,
    });
  });
});
