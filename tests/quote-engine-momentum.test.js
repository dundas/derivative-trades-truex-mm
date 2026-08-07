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
      inventoryManager: null,
      fixConnection,
      logger,
      levels: 2,
      baseSizeBTC: 0.001,
      tickSize: 0.5,
      minNotional: 1.0,
      symbol: 'BTC-PYUSD',
      maxOrdersPerSecond: 20,
      dupGuardMs: 0, // tests fire cycles back-to-back; prod cadence is >= 1s
      minRepriceIntervalMs: overrides.minRepriceIntervalMs ?? 60000,
      momentumRepriceBps: overrides.momentumRepriceBps ?? 10,
      ...overrides,
    }),
    fixConnection,
    logger,
  };
}

const price = (mid) => ({ confidence: 1.0, weightedMidpoint: mid, sources: [] });

describe('momentum reprice — debounce bypass (task 0010)', () => {
  it('AC1: bypasses the debounce when the mid moved >= threshold since last dispatched reprice', () => {
    const { engine, fixConnection } = createEngine();
    engine.lastRepriceAt = 1; // aged out — first cycle dispatches

    engine.onPriceUpdate(price(100000)); // dispatches the ladder
    expect(fixConnection.sendMessage).toHaveBeenCalled();
    expect(engine.lastRepricedMid).toBe(100000); // AC4: reference stamped
    // Simulate FIX acks (prod: orders go active within milliseconds)
    for (const [, o] of engine.activeOrders) o.status = 'active';
    engine.lastActionByClOrdID.clear(); // simulate > dupGuardMs elapsed since placement

    const sendsAfterFirst = fixConnection.sendMessage.mock.calls.length;

    // 11bps move within the debounce window → momentum bypass → reprices
    engine.onPriceUpdate(price(100110));
    expect(fixConnection.sendMessage.mock.calls.length).toBeGreaterThan(sendsAfterFirst);
    expect(engine.momentumReprices).toBe(1);
    expect(engine.lastRepricedMid).toBe(100110); // re-baselined
  });

  it('AC2: stays debounced when the move is below threshold', () => {
    const { engine, fixConnection } = createEngine();
    engine.lastRepriceAt = 1;

    engine.onPriceUpdate(price(100000));
    const sendsAfterFirst = fixConnection.sendMessage.mock.calls.length;

    // 5bps move — under the 10bps threshold → debounced, no sends
    engine.onPriceUpdate(price(100050));
    expect(fixConnection.sendMessage.mock.calls.length).toBe(sendsAfterFirst);
    expect(engine.momentumReprices).toBe(0);
  });

  it('AC3: momentumRepriceBps <= 0 disables the bypass', () => {
    const { engine, fixConnection } = createEngine({ momentumRepriceBps: 0 });
    engine.lastRepriceAt = 1;

    engine.onPriceUpdate(price(100000));
    const sendsAfterFirst = fixConnection.sendMessage.mock.calls.length;

    engine.onPriceUpdate(price(100500)); // 50bps — but feature disabled
    expect(fixConnection.sendMessage.mock.calls.length).toBe(sendsAfterFirst);
    expect(engine.momentumReprices).toBe(0);
  });

  it('AC4: never-dispatched engine (no reference mid) does not momentum-bypass', () => {
    const { engine, fixConnection } = createEngine();
    // Fresh debounce stamp but no dispatched reprice yet (lastRepricedMid = 0)
    engine.lastRepriceAt = Date.now();
    engine.lastMid = 100000;

    engine.onPriceUpdate(price(100500)); // 50bps vs lastMid, but no reference
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.momentumReprices).toBe(0);
  });

  it('a non-dispatching bypass does not re-baseline the reference', () => {
    const { engine } = createEngine();
    engine.lastRepriceAt = 1;
    engine.onPriceUpdate(price(100000));
    expect(engine.lastRepricedMid).toBe(100000);

    // Suspend quoting: cycle runs through to executeActions? No — suspension
    // returns before reconcile; simulate a non-dispatch by suspending AFTER
    // the reference is set and checking the stamp survives.
    engine.quotingSuspended = true;
    engine.onPriceUpdate(price(100300));
    expect(engine.lastRepricedMid).toBe(100000);
  });
});

describe('momentum reference sync (roborev round 1)', () => {
  it('deferred reprice stamps lastRepricedMid alongside lastRepriceAt', () => {
    const { engine } = createEngine();
    engine.lastMid = 100000;
    engine.lastRepriceAt = 1;
    // No active orders → deferred reprice places a fresh ladder (dispatches)
    const ran = engine._runDeferredReprice();
    expect(ran).toBe(true);
    expect(engine.lastRepricedMid).toBe(100000);
    expect(engine.lastRepriceAt).toBeGreaterThan(1);
  });
});

describe('debounce scoping (roborev round 2)', () => {
  it('heldPlacementsPending does NOT bypass the ordinary onPriceUpdate debounce', () => {
    const { engine, fixConnection } = createEngine();
    engine.lastRepriceAt = 1;
    engine.onPriceUpdate(price(100000));
    for (const [, o] of engine.activeOrders) o.status = 'active';
    engine.lastActionByClOrdID.clear();

    // Arm a hold and stamp the debounce fresh
    engine.heldPlacementsPending = true;
    engine.lastRepriceAt = Date.now();
    engine.lastRepricedMid = 100000;

    const sendsBefore = fixConnection.sendMessage.mock.calls.length;
    // Small move (below momentum threshold) while a hold is pending:
    // ordinary path must stay debounced (completion retries go through
    // drainQueue → _runDeferredReprice, which carries the hold exemption).
    engine.onPriceUpdate(price(100030));
    expect(fixConnection.sendMessage.mock.calls.length).toBe(sendsBefore);
  });
});
