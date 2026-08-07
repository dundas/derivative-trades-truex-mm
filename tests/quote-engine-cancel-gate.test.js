import { describe, it, expect, mock } from 'bun:test';
import { QuoteEngine } from '../src/core/quote-engine.js';

// --- Test helpers (same pattern as quote-engine.test.js) ---

function createMockFix() {
  return {
    sendMessage: mock(() => Promise.resolve({})),
    senderCompID: 'CLI_CLIENT',
    targetCompID: 'TRUEX_PROD_OE',
    msgSeqNum: 1,
    getUTCTimestamp: () => '20260807-12:00:00.000',
  };
}

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function createEngine(overrides = {}) {
  const fixConnection = overrides.fixConnection || createMockFix();
  const logger = overrides.logger || createMockLogger();
  return {
    engine: new QuoteEngine({
      inventoryManager: null, // balance gate lives in the dispatch path; not needed here
      fixConnection,
      logger,
      levels: 2,
      baseSizeBTC: 0.001,
      tickSize: 0.5,
      minNotional: 1.0,
      symbol: 'BTC-PYUSD',
      maxOrdersPerSecond: 10,
      replaceMode: overrides.replaceMode || 'passive-safe',
      ...overrides,
    }),
    fixConnection,
    logger,
  };
}

function sellQuote(level = 1, price = 65000) {
  return { side: 'sell', price, size: 0.001, level };
}

function buyQuote(level = 1, price = 64000) {
  return { side: 'buy', price, size: 0.001, level };
}

function seedCancellingOrder(engine, side, clOrdID = 'orig-1') {
  engine.activeOrders.set(clOrdID, {
    side,
    price: side === 'sell' ? 65000 : 64000,
    size: 0.001,
    level: 1,
    status: 'cancelling',
    placedAt: Date.now(),
    cancellingAt: Date.now(),
  });
}

// --- Gate decision tests (AC1-AC3, AC5) ---

describe('_shouldHoldPlacement — balance-safety gate', () => {
  it('holds a pure placement while a same-side cancel is in flight (AC1)', () => {
    const { engine } = createEngine();
    seedCancellingOrder(engine, 'sell');
    expect(engine._shouldHoldPlacement({ type: 'place', quote: sellQuote() })).toBe(true);
  });

  it('does not hold when no cancels are in flight (AC2)', () => {
    const { engine } = createEngine();
    expect(engine._shouldHoldPlacement({ type: 'place', quote: sellQuote() })).toBe(false);
  });

  it('does not hold the opposite side of an in-flight cancel', () => {
    const { engine } = createEngine();
    seedCancellingOrder(engine, 'sell');
    expect(engine._shouldHoldPlacement({ type: 'place', quote: buyQuote() })).toBe(false);
  });

  it('does not hold in place-before-cancel mode (AC3)', () => {
    const { engine } = createEngine({ replaceMode: 'place-before-cancel' });
    seedCancellingOrder(engine, 'sell');
    expect(engine._shouldHoldPlacement({ type: 'place', quote: sellQuote() })).toBe(false);
  });

  it('never holds cancels or replacement-cancels (AC5)', () => {
    const { engine } = createEngine();
    seedCancellingOrder(engine, 'sell');
    expect(engine._shouldHoldPlacement({ type: 'cancel', clOrdID: 'x', order: sellQuote() })).toBe(false);
    expect(
      engine._shouldHoldPlacement({ type: 'replacement-cancel', clOrdID: 'x', order: sellQuote(), quote: sellQuote() })
    ).toBe(false);
  });

  it('only cancelling status counts — active/pending orders do not hold placements', () => {
    const { engine } = createEngine();
    engine.activeOrders.set('a', { side: 'sell', status: 'active', size: 0.001, price: 65000 });
    engine.activeOrders.set('p', { side: 'sell', status: 'pending', size: 0.001, price: 65000 });
    expect(engine._hasInflightCancels('sell')).toBe(false);
    expect(engine._shouldHoldPlacement({ type: 'place', quote: sellQuote() })).toBe(false);
  });
});

// --- Dispatch-path integration (AC1, AC2) ---

describe('executeActions — placement gating', () => {
  it('skips a placement with a same-side cancel in flight; nothing sent (AC1)', () => {
    const { engine, fixConnection } = createEngine();
    seedCancellingOrder(engine, 'sell');

    const dispatched = engine.executeActions({ toCancel: [], toReplace: [], toPlace: [sellQuote()] });

    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(dispatched).toBe(false);
    expect(engine.placementsDeferredForCancels).toBe(1);
    expect(engine.deferredRepriceNeeded).toBe(true);
    // Nothing was added to the order book as pending
    expect(engine.activeOrders.size).toBe(1); // only the seeded cancelling order
  });

  it('dispatches the placement when no cancels are in flight (AC2)', () => {
    const { engine, fixConnection } = createEngine();

    engine.executeActions({ toCancel: [], toReplace: [], toPlace: [sellQuote()] });

    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
    expect(engine.placementsDeferredForCancels).toBe(0);
  });

  it('defers only the side with in-flight cancels; other side flows', () => {
    const { engine, fixConnection } = createEngine();
    seedCancellingOrder(engine, 'sell');

    engine.executeActions({ toCancel: [], toReplace: [], toPlace: [sellQuote(), buyQuote()] });

    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1); // only the buy went
    expect(engine.placementsDeferredForCancels).toBe(1);
  });
});

// --- Queue drain gating (AC4) ---

describe('drainQueue — placement gating', () => {
  it('drops gated stale placements; dispatches non-gated actions (AC4)', () => {
    const { engine, fixConnection } = createEngine();
    seedCancellingOrder(engine, 'sell');
    engine.actionQueue.push({ type: 'place', quote: sellQuote() }, { type: 'place', quote: buyQuote() });

    engine.drainQueue();

    // Buy dispatched; gated sell dropped (stale — re-derived next cycle)
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
    expect(engine.actionQueue.length).toBe(0);
    expect(engine.placementsDeferredForCancels).toBe(1);
    expect(engine.deferredRepriceNeeded).toBe(true);
  });

  it('dropped placements come back fresh via deferred reprice after the cancel clears', () => {
    const { engine, fixConnection } = createEngine();
    engine.lastMid = 100000;
    seedCancellingOrder(engine, 'sell');
    engine.actionQueue.push({ type: 'place', quote: sellQuote() });

    engine.drainQueue();
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.deferredRepriceNeeded).toBe(true);

    // Cancel confirm arrives (order removed) → deferred reprice rebuilds fresh
    engine.activeOrders.delete('orig-1');
    const ran = engine._runDeferredReprice();
    expect(ran).toBe(true);
    expect(fixConnection.sendMessage).toHaveBeenCalled();
  });
});

// --- Deferred-reprice interaction (AC5) ---

describe('_runDeferredReprice — gate interaction', () => {
  it('keeps the deferred reprice armed when placements are gated, and completes after the cancel clears', () => {
    const { engine, fixConnection } = createEngine();
    engine.lastMid = 100000;
    // Resting order whose level no longer matches the desired ladder →
    // reconcile cancels it and places fresh levels on the same side.
    engine.activeOrders.set('B1', { side: 'buy', price: 90000, size: 0.001, level: 1, status: 'active', placedAt: Date.now() });

    const ran = engine._runDeferredReprice();

    // Cancel went out, but same-side placements are held → retry stays armed
    expect(ran).toBe(false);
    expect(engine.deferredRepriceNeeded).toBe(true);
    expect(engine.placementsDeferredForCancels).toBeGreaterThan(0);
    expect(engine.activeOrders.get('B1').status).toBe('cancelling');
    const sendsAfterFirst = fixConnection.sendMessage.mock.calls.length;

    // Cancel confirm arrives (order removed) → next deferred reprice completes
    engine.activeOrders.delete('B1');
    const ranAgain = engine._runDeferredReprice();
    expect(ranAgain).toBe(true);
    expect(engine.deferredRepriceNeeded).toBe(false);
    expect(fixConnection.sendMessage.mock.calls.length).toBeGreaterThan(sendsAfterFirst);
  });
});

describe('minRepriceInterval debounce — gate interaction', () => {
  it('completion retry after a gated cycle bypasses the minRepriceInterval debounce', () => {
    const { engine, fixConnection } = createEngine({ minRepriceIntervalMs: 60000 });
    engine.lastMid = 100000;
    engine.lastRepriceAt = 1; // aged out — first cycle passes the debounce
    engine.activeOrders.set('B1', { side: 'buy', price: 90000, size: 0.001, level: 1, status: 'active', placedAt: Date.now() });

    const ran = engine._runDeferredReprice();
    expect(ran).toBe(false);
    expect(engine.heldPlacementsPending).toBe(true);
    // Gated cycles stamp on dispatch (aligned with onPriceUpdate semantics);
    // the essential invariant is that the completion retry still bypasses the
    // debounce via heldPlacementsPending — asserted below.

    // Cancel confirm arrives, then a fresh debounce stamp lands (would block for 60s)
    engine.activeOrders.delete('B1');
    engine.lastRepriceAt = Date.now();

    // Completion retry must not be debounced behind it
    const ranAgain = engine._runDeferredReprice();
    expect(ranAgain).toBe(true);
    expect(engine.heldPlacementsPending).toBe(false);
    expect(fixConnection.sendMessage).toHaveBeenCalled();
  });

  it('ordinary debouncing still applies when nothing is held', () => {
    const { engine } = createEngine({ minRepriceIntervalMs: 60000 });
    engine.lastMid = 100000;
    engine.lastRepriceAt = Date.now();
    engine.deferredRepriceNeeded = false;

    expect(engine._runDeferredReprice()).toBe(false);
  });
});

describe('debounce bypass is scoped to the completion-retry path (roborev round 3)', () => {
  it('an intra-cycle hold does not silently disable the ordinary onPriceUpdate debounce (PR#58 review repro)', () => {
    // A cycle that dispatches a same-side replacement-cancel and gates a
    // same-side placement must still stamp lastRepriceAt — otherwise every
    // subsequent tick sees a stale stamp and skips the debounce entirely.
    const { engine, fixConnection } = createEngine({ minRepriceIntervalMs: 60000, levels: 2 });
    engine.lastRepriceAt = 1; // stale — first cycle passes the debounce
    // Active buy L1 far from the incoming desired price → becomes a replacement
    engine.activeOrders.set('B1', { side: 'buy', price: 90000, size: 0.001, level: 1, status: 'active', placedAt: Date.now() });

    // Cycle 1: replacement-cancel for B1 dispatched (B1 → 'cancelling'), the
    // same-side L2 placement behind it is gated.
    engine.onPriceUpdate({ confidence: 1.0, weightedMidpoint: 100000, sources: [] });
    expect(engine.heldPlacementsPending).toBe(true);
    expect(engine.placementsDeferredForCancels).toBeGreaterThan(0);
    // The cycle dispatched real work → it stamped lastRepriceAt even though a
    // placement is held (this is the fix).
    expect(engine.lastRepriceAt).toBeGreaterThan(1);

    // Cycle 2 within minRepriceIntervalMs: debounced — no new sends
    const sendsAfterFirst = fixConnection.sendMessage.mock.calls.length;
    engine.onPriceUpdate({ confidence: 1.0, weightedMidpoint: 100050, sources: [] });
    expect(fixConnection.sendMessage.mock.calls.length).toBe(sendsAfterFirst);
  });
});
