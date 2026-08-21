import { describe, expect, test, mock } from 'bun:test';
import { QuoteEngine } from './quote-engine.js';
import { CapitalReservationManager } from './capital-reservation-manager.js';

function makeEngine(overrides = {}) {
  const fixConnection = { sendMessage: mock(() => true) };
  const engine = new QuoteEngine({
    fixConnection,
    inventoryManager: {
      balancesInitialized: true,
      canQuote: () => true,
      getAvailableForSide: () => 1_000_000,
      getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }),
    },
    strictTruexMakerSafety: true,
    truexMakerEbboMaxAgeMs: 2_000,
    truexAloRetryCooldownMs: 60_000,
    truexAloRetryMaxEntries: 8,
    marketablePostOnlyAction: 'skip',
    tickSize: 0.5,
    ...overrides,
  });
  return { engine, fixConnection };
}

function quote(side, price, level = 1) {
  return { side, price, size: 0.01, level };
}

function freshEbbo(bestBid = 99, bestAsk = 101) {
  return { bestBid, bestAsk, timestamp: Date.now() };
}

describe('strict TrueX EBBO maker safety', () => {
  test('observe dispatch mode permits protective cancels but suppresses all placement paths', () => {
    const { engine, fixConnection } = makeEngine({ quoteDispatchMode: 'observe' });
    engine.updateTruexEbbo(freshEbbo(99, 101));
    engine.activeOrders.set('existing', { ...quote('buy', 98), status: 'active' });

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.activeOrders.size).toBe(1);
    expect(engine._dispatchAction({ type: 'place', quote: quote('buy', 100) })).toBe(false);
    expect(engine._dispatchAction({
      type: 'replacement-cancel', clOrdID: 'existing',
      order: engine.activeOrders.get('existing'), quote: quote('buy', 100),
    })).toBe(false);
    expect(engine._dispatchAction({
      type: 'cancel', clOrdID: 'existing', order: engine.activeOrders.get('existing'),
    })).toBe(true);

    const messageTypes = fixConnection.sendMessage.mock.calls.map(([fields]) => fields['35']);
    expect(messageTypes).toEqual(['F']);
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('quote-dispatch-observe-mode');
  });

  test('missing, stale, and invalid EBBO suppress new D sends while pure cancels remain allowed', () => {
    let now = 10_000;
    const { engine, fixConnection } = makeEngine({ now: () => now });
    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('truex-ebbo-missing');

    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 101, timestamp: 1_000 });
    now += 2_001;
    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('truex-ebbo-stale');

    engine.updateTruexEbbo({ bestBid: 102, bestAsk: 101, timestamp: now });
    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('truex-ebbo-invalid');

    engine.activeOrders.set('existing', { ...quote('buy', 98), status: 'active' });
    engine._sendCancel('existing', engine.activeOrders.get('existing'));
    expect(fixConnection.sendMessage.mock.calls.some(([fields]) => fields['35'] === 'F')).toBe(true);
    expect(fixConnection.sendMessage.mock.calls.some(([fields]) => fields['35'] === 'D')).toBe(false);
  });

  test('missing EBBO retains an acknowledged quote instead of starting its replacement cancel', () => {
    const { engine, fixConnection } = makeEngine();
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('existing', existing);
    engine.executeActions({
      toPlace: [],
      toCancel: [],
      toReplace: [{ cancel: 'existing', cancelOrder: existing, place: quote('buy', 99) }],
    });
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.activeOrders.get('existing')).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('truex-ebbo-missing');
  });

  test('fresh EBBO is the sole marketability authority and skip blocks crossing prices', () => {
    const { engine, fixConnection } = makeEngine({
      marketDataProvider: () => ({ bestBid: 1, bestAsk: 1_000_000, timestamp: Date.now() }),
    });
    engine.updateTruexEbbo(freshEbbo(99, 101));

    expect(engine._sendNewOrder(quote('buy', 101))).toBeNull();
    expect(engine._sendNewOrder(quote('sell', 99))).toBeNull();
    expect(engine._sendNewOrder(quote('buy', 100))).not.toBeNull();
    const sends = fixConnection.sendMessage.mock.calls.map(([fields]) => fields);
    expect(sends).toHaveLength(1);
    expect(Number(sends[0]['44'])).toBe(100);
  });

  test('first fresh EBBO and relevant touch changes re-arm a deferred reprice generation', () => {
    const { engine } = makeEngine();
    engine.deferredRepriceNeeded = false;
    engine.updateTruexEbbo(freshEbbo(99, 101));
    expect(engine.deferredRepriceNeeded).toBe(true);
    expect(engine.truexEbboGeneration).toEqual({ buy: 1, sell: 1 });

    engine.deferredRepriceNeeded = false;
    engine.updateTruexEbbo(freshEbbo(99, 101));
    expect(engine.deferredRepriceNeeded).toBe(false);
    engine.updateTruexEbbo(freshEbbo(99, 101.5));
    expect(engine.deferredRepriceNeeded).toBe(true);
    expect(engine.truexEbboGeneration).toEqual({ buy: 2, sell: 1 });
  });

  test('freshness uses engine-stamped receipt while retaining and validating source provenance', () => {
    let now = 10_000;
    const { engine } = makeEngine({ now: () => now, truexMakerEbboMaxAgeMs: 1000 });
    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 101, timestamp: 1_000, receivedAt: 99_999 });
    expect(engine._strictEbboState()).toMatchObject({ usable: true });
    expect(engine.truexEbbo).toMatchObject({ timestamp: 1_000, receivedAt: 10_000 });

    now = 11_001;
    expect(engine._strictEbboState()).toMatchObject({ usable: false, reason: 'truex-ebbo-stale' });
    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 101, timestamp: 1_000, receivedAt: 99_999 });
    expect(engine._strictEbboState()).toMatchObject({ usable: true });

    now = 12_000;
    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 102, timestamp: 12_001 });
    expect(engine._strictEbboState()).toMatchObject({ usable: false, reason: 'truex-ebbo-invalid' });
  });

  test.each([null, undefined, '', '   '])('blank source timestamp %p is invalid', (timestamp) => {
    const { engine } = makeEngine();
    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 101, timestamp });
    expect(engine._strictEbboState()).toMatchObject({ usable: false, reason: 'truex-ebbo-invalid' });
    expect(engine.truexEbboGeneration).toEqual({ buy: 0, sell: 0 });
  });

  test.each([0, '0', false, '10000', 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'non-positive or non-integer numeric source timestamp %p is invalid',
    (timestamp) => {
      const { engine } = makeEngine({ now: () => 10_000 });
      engine.updateTruexEbbo({ bestBid: 99, bestAsk: 101, timestamp });
      expect(engine._strictEbboState()).toMatchObject({ usable: false, reason: 'truex-ebbo-invalid' });
      expect(engine.truexEbboGeneration).toEqual({ buy: 0, sell: 0 });
    },
  );

  test('invalid observations never advance generations or clear an ALO inhibition', () => {
    const { engine } = makeEngine();
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const id = engine._sendNewOrder(quote('buy', 100));
    engine.onExecutionReport({ '11': id, '39': '4', '58': 'ALO would trade' });
    expect(engine.truexEbboGeneration).toEqual({ buy: 1, sell: 1 });

    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 0, timestamp: Date.now() });
    expect(engine.truexEbboGeneration).toEqual({ buy: 1, sell: 1 });
    engine.updateTruexEbbo({ bestBid: 106, bestAsk: 105, timestamp: Date.now() });
    expect(engine.truexEbboGeneration).toEqual({ buy: 1, sell: 1 });
    engine.updateTruexEbbo({ bestBid: 99, bestAsk: 106, timestamp: Date.now() + 10_000 });
    expect(engine.truexEbboGeneration).toEqual({ buy: 1, sell: 1 });
  });

  test('slide moves one tick passive and reruns tracked self-cross guard', () => {
    const { engine, fixConnection } = makeEngine({ marketablePostOnlyAction: 'slide' });
    engine.updateTruexEbbo(freshEbbo(99, 101));
    engine._sendNewOrder(quote('buy', 103));
    expect(Number(fixConnection.sendMessage.mock.calls[0][0]['44'])).toBe(100.5);

    engine.activeOrders.set('ask', { ...quote('sell', 100.5), status: 'active' });
    expect(engine._sendNewOrder(quote('buy', 103, 2))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('self-cross-tracked-order');
  });

  test('slide reserves capital against the final passive price', () => {
    const reserve = mock(() => ({ accepted: true }));
    const { engine, fixConnection } = makeEngine({
      marketablePostOnlyAction: 'slide',
      capitalReservationManager: {
        reserve,
        getPresence: () => ({ buy: 0, sell: 0 }),
        getReservations: () => [],
      },
    });
    engine.updateTruexEbbo(freshEbbo(99, 101));
    engine._sendNewOrder(quote('buy', 103));
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', price: 100.5 }));
    expect(Number(fixConnection.sendMessage.mock.calls[0][0]['44'])).toBe(100.5);
  });

  test('queued and pending-replacement placements recheck current EBBO at final send', () => {
    const { engine, fixConnection } = makeEngine({ maxOrdersPerSecond: 1 });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    engine.actionQueue.push({ type: 'place', quote: quote('buy', 104) });
    engine.updateTruexEbbo(freshEbbo(99, 103));
    engine.drainQueue();
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();

    engine.pendingReplacements.set('old', { quote: quote('buy', 104), createdAt: Date.now() });
    engine._releasePendingReplacement('old');
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
  });

  test('replacement cancel preflight retains the live quote for skip, inhibition, and self-cross', () => {
    const scenarios = [
      { existing: quote('buy', 98), replacement: quote('buy', 105), ebbo: freshEbbo(99, 101) },
      { existing: quote('buy', 98), replacement: quote('buy', 100), ebbo: freshEbbo(99, 105), inhibit: true },
      { existing: quote('buy', 98), replacement: quote('buy', 100), ebbo: freshEbbo(99, 105), opposite: quote('sell', 100) },
    ];
    for (const scenario of scenarios) {
      const { engine, fixConnection } = makeEngine();
      engine.updateTruexEbbo(scenario.ebbo);
      const existing = { ...scenario.existing, status: 'active', acknowledgedLive: true };
      engine.activeOrders.set('old', existing);
      if (scenario.opposite) engine.activeOrders.set('opposite', { ...scenario.opposite, status: 'active' });
      if (scenario.inhibit) engine._recordAloRetryInhibition(scenario.replacement);
      engine._dispatchAction({ type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: scenario.replacement });
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(engine.activeOrders.get('old').status).toBe('active');
    }
  });

  test('slide replacement cancellation starts only when the captured slide is viable', () => {
    const { engine, fixConnection } = makeEngine({ marketablePostOnlyAction: 'slide' });
    engine.updateTruexEbbo(freshEbbo(99, 101));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    engine.activeOrders.set('ask', { ...quote('sell', 100.5), status: 'active' });
    engine._dispatchAction({ type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 103) });
    expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(engine.activeOrders.get('old').status).toBe('active');
  });

  test('queued replacement cancel rechecks viability while a viable replacement may cancel', () => {
    const blocked = makeEngine();
    blocked.engine.updateTruexEbbo(freshEbbo(99, 101));
    const blockedOrder = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    blocked.engine.activeOrders.set('old', blockedOrder);
    blocked.engine.actionQueue.push({
      type: 'replacement-cancel', clOrdID: 'old', order: blockedOrder, quote: quote('buy', 101),
    });
    blocked.engine.drainQueue();
    expect(blocked.fixConnection.sendMessage).not.toHaveBeenCalled();
    expect(blocked.engine.activeOrders.get('old').status).toBe('active');

    const viable = makeEngine();
    viable.engine.updateTruexEbbo(freshEbbo(99, 105));
    const viableOrder = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    viable.engine.activeOrders.set('old', viableOrder);
    expect(viable.engine._dispatchAction({
      type: 'replacement-cancel', clOrdID: 'old', order: viableOrder, quote: quote('buy', 100),
    })).toBe(true);
    expect(viable.fixConnection.sendMessage.mock.calls[0][0]['35']).toBe('F');
  });

  test('ALO retry inhibition is side/price scoped, bounded, and clears only on price generation or cooldown', () => {
    const { engine, fixConnection } = makeEngine({ truexAloRetryMaxEntries: 2 });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const id = engine._sendNewOrder(quote('buy', 100));
    engine.onExecutionReport({ '11': id, '39': '4', '58': 'ALO would trade' });

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('alo-retry-inhibited');
    expect(engine._sendNewOrder(quote('sell', 104))).not.toBeNull();

    // An identical poll does not create a new price generation or re-arm the storm.
    engine.updateTruexEbbo(freshEbbo(99, 105));
    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();

    engine.updateTruexEbbo(freshEbbo(99.5, 105.5));
    expect(engine._sendNewOrder(quote('buy', 100))).not.toBeNull();
    expect(engine.getQuoteStatus().aloRetryInhibitions.length).toBeLessThanOrEqual(2);
    expect(fixConnection.sendMessage.mock.calls.filter(([fields]) => fields['35'] === 'D').length).toBe(3);
  });

  test('changed venue wording still inhibits an unsolicited maker cancellation at side and price', () => {
    const { engine, fixConnection } = makeEngine();
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const id = engine._sendNewOrder(quote('buy', 100));

    engine.onExecutionReport({ '11': id, '39': '4', '58': 'maker protection cancelled the order' });

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1)).toMatchObject({
      reason: 'alo-retry-inhibited',
      quote: { side: 'buy', price: 100 },
    });
    expect(engine.recentRejectsByReason.get('venue-cancel:maker protection cancelled the order')).toBe(1);
    expect(fixConnection.sendMessage.mock.calls.filter(([fields]) => fields['35'] === 'D')).toHaveLength(1);
  });

  test('unsolicited cancellation wording does not inhibit an intentional taker order', () => {
    const { engine } = makeEngine();
    engine.updateTruexEbbo(freshEbbo(99, 105));
    engine.activeOrders.set('taker', {
      ...quote('buy', 100),
      status: 'active',
      postOnly: false,
      liquidityRoleExpected: 'taker',
    });

    engine.onExecutionReport({ '11': 'taker', '39': '4', '58': 'maker protection cancelled the order' });

    expect(engine.getQuoteStatus().aloRetryInhibitions).toHaveLength(0);
  });

  test('ALO inhibition never couples an intentional taker attempt', () => {
    const { engine } = makeEngine();
    engine.updateTruexEbbo(freshEbbo(99, 105));
    engine._recordAloRetryInhibition(quote('buy', 100));
    expect(engine._isAloRetryInhibited({ ...quote('buy', 100), postOnly: false })).toBe(false);
    expect(engine._prepareQuoteForSend({ ...quote('buy', 100), postOnly: false })).toBeNull();
    expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('taker-disabled');
  });

  test.each(['ebbo-cross', 'alo-inhibition', 'self-cross'])(
    'last send-boundary check rolls back a synchronous %s mutation with no lifecycle or D',
    (mutation) => {
      let engine;
      const abort = mock(() => true);
      const manager = {
        reserve: mock(({ side, price, level }) => {
          if (mutation === 'ebbo-cross') {
            engine.updateTruexEbbo({ bestBid: 99, bestAsk: price, timestamp: Date.now() });
          } else if (mutation === 'alo-inhibition') {
            engine._recordAloRetryInhibition({ side, price, level });
          } else {
            engine.activeOrders.set('new-opposite', {
              side: 'sell', price, size: 0.01, level: 2, status: 'active', acknowledgedLive: true,
            });
          }
          return { accepted: true };
        }),
        newDispatchAborted: abort,
        getPresence: () => ({ buy: 0, sell: 0 }),
        getReservations: () => [],
      };
      const built = makeEngine({ capitalReservationManager: manager });
      engine = built.engine;
      engine.updateTruexEbbo(freshEbbo(99, 105));
      const lifecycle = [];
      engine.on('quote-lifecycle', (event) => lifecycle.push(event));

      expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
      expect(built.fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledTimes(1);
      expect([...engine.activeOrders.keys()]).toEqual(mutation === 'self-cross' ? ['new-opposite'] : []);
      expect(lifecycle).toEqual([]);
      expect(engine.lastActionByClOrdID.size).toBe(0);
    },
  );

  test('send-boundary suppression removes the real pending reservation without a capital leak', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 },
      liveOrders: [],
    });
    const reserve = capital.reserve.bind(capital);
    let engine;
    capital.reserve = (request) => {
      const result = reserve(request);
      engine.updateTruexEbbo({ bestBid: 99, bestAsk: request.price, timestamp: Date.now() });
      return result;
    };
    const built = makeEngine({ capitalReservationManager: capital });
    engine = built.engine;
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const before = capital.getStatus().available.buy;

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(capital.getReservations()).toEqual([]);
    expect(capital.getStatus().available.buy).toBe(before);
    expect(built.fixConnection.sendMessage).not.toHaveBeenCalled();
  });

  test('explicit false new-order dispatch rolls back reservation, identity, lifecycle, and last action', () => {
    const abort = mock(() => true);
    const manager = {
      reserve: mock(() => ({ accepted: true })),
      newDispatchAborted: abort,
      getPresence: () => ({ buy: 0, sell: 0 }),
      getReservations: () => [],
    };
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: manager });
    fixConnection.sendMessage.mockImplementation(() => false);
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const lifecycle = [];
    engine.on('quote-lifecycle', (event) => lifecycle.push(event));

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(engine.activeOrders.size).toBe(0);
    expect(engine.lastActionByClOrdID.size).toBe(0);
    expect(lifecycle).toEqual([]);
    expect(engine.deferredRepriceNeeded).toBe(true);
  });

  test('strict mode contains a rejected legacy Promise and never reports definitive dispatch', async () => {
    const failClosed = mock(() => true);
    const manager = {
      reserve: mock(() => ({ accepted: true })),
      failClosedForEvidenceGap: failClosed,
      getPresence: () => ({ buy: 0, sell: 0 }),
      getReservations: () => [],
    };
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: manager });
    fixConnection.sendMessage.mockImplementation(() => Promise.reject(new Error('async reject')));
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const lifecycle = [];
    engine.on('quote-lifecycle', (event) => lifecycle.push(event));

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    await Promise.resolve();
    expect(failClosed).toHaveBeenCalledWith(expect.any(String), 'async-new-dispatch-outcome-unknown');
    expect(lifecycle).toEqual([]);
    expect(engine.lastActionByClOrdID.size).toBe(0);
    expect(engine.deferredRepriceNeeded).toBe(true);
  });

  test('Promise new delivery is fail-closed and requests scoped resync without releasing capital', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 },
      liveOrders: [],
    });
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: capital });
    fixConnection.sendMessage.mockImplementation(() => Promise.resolve(true));
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const resync = [];
    engine.on('capital-resync-required', (event) => resync.push(event));

    expect(engine._sendNewOrder(quote('buy', 100))).toBeNull();
    const [orderId] = engine.activeOrders.keys();
    expect(capital.getReservation(orderId)).toMatchObject({ state: 'dispatch-outcome-unknown' });
    expect(capital.getStatus()).toMatchObject({ state: 'degraded', blockedSides: ['buy'] });
    expect(resync).toHaveLength(1);
    expect(resync[0]).toMatchObject({ side: 'buy', reason: 'async-new-dispatch-outcome-unknown' });
    expect(engine.getContinuityState().executionState).toBe('unsafe');
    await Promise.resolve();
  });

  test('Promise replacement cancel retains the unknown in-flight intent and cannot retry it', async () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 },
      liveOrders: [],
    });
    capital.reserve({ orderId: 'old', side: 'buy', price: 98, size: 0.01, level: 1 });
    capital.accept('old');
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: capital });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    fixConnection.sendMessage.mockImplementation(() => Promise.resolve(true));
    const resync = [];
    const lifecycle = [];
    engine.on('capital-resync-required', (event) => resync.push(event));
    engine.on('quote-lifecycle', (event) => lifecycle.push(event));
    const action = { type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 100) };

    expect(engine._dispatchAction(action)).toBe(true);
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'cancelling', dispatchOutcomeUnknown: true });
    expect(capital.getReservation('old')).toMatchObject({ state: 'cancel-in-flight' });
    expect(engine.pendingReplacements.has('old')).toBe(true);
    expect(engine.cancelToOrigMap.size).toBe(1);
    expect(resync).toHaveLength(1);
    expect(lifecycle).toEqual([]);
    expect(engine._dispatchAction(action)).toBe(false);
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  test('ordinary cancel reject authoritatively clears unknown delivery and permits retry', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 }, liveOrders: [],
    });
    capital.reserve({ orderId: 'old', side: 'buy', price: 98, size: 0.01, level: 1 });
    capital.accept('old');
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: capital });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    fixConnection.sendMessage.mockImplementationOnce(() => Promise.resolve(true)).mockImplementation(() => true);
    expect(engine._sendCancel('old', existing)).toBe(true);
    const cancelId = [...engine.cancelToOrigMap.keys()][0];

    const resync = [];
    engine.on('capital-resync-required', (event) => resync.push(event));
    engine.onOrderCancelReject({ '11': 'arbitrary-cancel', '41': 'old', '102': '0', '58': 'spoof' });
    expect(engine.activeOrders.get('old')).toMatchObject({
      status: 'cancelling', dispatchOutcomeUnknown: true,
    });
    expect(engine.cancelToOrigMap.get(cancelId)).toBe('old');
    expect(capital.getReservation('old')).toMatchObject({ state: 'cancel-in-flight' });
    expect(engine.getContinuityState().executionState).toBe('unsafe');
    expect(resync).toHaveLength(1);

    engine.cancelToOrigMap.set('mismatched-cancel', 'different-order');
    engine.onOrderCancelReject({ '11': 'mismatched-cancel', '41': 'old', '102': '0', '58': 'mismatch' });
    expect(engine.activeOrders.get('old')).toHaveProperty('dispatchOutcomeUnknown', true);
    expect(engine.cancelToOrigMap.get(cancelId)).toBe('old');
    expect(engine.cancelToOrigMap.get('mismatched-cancel')).toBe('different-order');

    engine.onOrderCancelReject({ '11': cancelId, '41': 'old', '102': '0', '58': 'too late' });
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(engine.activeOrders.get('old')).not.toHaveProperty('dispatchOutcomeUnknown');
    expect(engine.activeOrders.get('old')).not.toHaveProperty('cancellingAt');
    expect(engine.cancelToOrigMap.has(cancelId)).toBe(false);
    expect(engine.cancelToOrigMap.get('mismatched-cancel')).toBe('different-order');
    expect(capital.getReservation('old')).toMatchObject({ state: 'active' });
    expect(engine.getContinuityState().executionState).toBe('normal');
    expect(engine._sendCancel('old', existing)).toBe(true);
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(2);

    const rejectsBeforeDuplicate = engine.consecutiveRejects;
    const mappingCountBeforeDuplicate = engine.cancelToOrigMap.size;
    engine.onOrderCancelReject({ '11': cancelId, '41': 'old', '102': '0', '58': 'delayed duplicate' });
    expect(engine.consecutiveRejects).toBe(rejectsBeforeDuplicate);
    expect(engine.cancelToOrigMap.size).toBe(mappingCountBeforeDuplicate);
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'cancelling' });
  });

  test.each([true, false])(
    'terminal cancel ack retires identity and three delayed rejects are inert (tag41=%s)',
    (includeOrig) => {
      const capital = new CapitalReservationManager();
      capital.reconcile({
        baseBalance: { available: 1, held: 0, total: 1 },
        quoteBalance: { available: 1000, held: 0, total: 1000 }, liveOrders: [],
      });
      capital.reserve({ orderId: 'old', side: 'buy', price: 98, size: 0.01, level: 1 });
      capital.accept('old');
      const { engine } = makeEngine({ capitalReservationManager: capital });
      const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
      engine.activeOrders.set('old', existing);
      expect(engine._sendCancel('old', existing)).toBe(true);
      const cancelId = [...engine.cancelToOrigMap.keys()][0];
      const ack = { '11': cancelId, '39': '4', '54': '1' };
      if (includeOrig) ack['41'] = 'old';
      engine.onExecutionReport(ack);

      expect(engine.cancelToOrigMap.has(cancelId)).toBe(false);
      expect(engine.resolvedCancelIds.has(cancelId)).toBe(true);
      expect(engine.activeOrders.has('old')).toBe(false);
      for (let i = 0; i < 3; i++) {
        engine.onOrderCancelReject({ '11': cancelId, '41': 'old', '102': '0', '58': 'delayed' });
      }
      expect(engine.consecutiveRejects).toBe(0);
      expect(engine.rejectBackoffUntil).toBe(0);
    },
  );

  test('contradictory tag41 on a mapped cancel ack fails closed without mutation', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 }, liveOrders: [],
    });
    capital.reserve({ orderId: 'old', side: 'buy', price: 98, size: 0.01, level: 1 });
    capital.accept('old');
    const { engine } = makeEngine({ capitalReservationManager: capital });
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    engine._sendCancel('old', existing);
    const cancelId = [...engine.cancelToOrigMap.keys()][0];
    const resync = [];
    engine.on('capital-resync-required', (event) => resync.push(event));

    engine.onExecutionReport({ '11': cancelId, '41': 'different-order', '39': '4', '54': '1' });
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'cancelling', acknowledgedLive: true });
    expect(engine.cancelToOrigMap.get(cancelId)).toBe('old');
    expect(capital.getReservation('old')).toMatchObject({ state: 'cancel-in-flight' });
    expect(engine.getContinuityState().executionState).toBe('unsafe');
    expect(resync).toHaveLength(1);
  });

  test('REST stale cleanup retires every cancel identity before delayed rejects', () => {
    const { engine } = makeEngine();
    engine.activeOrders.set('old', { ...quote('sell', 104), status: 'cancelling', acknowledgedLive: true });
    engine.cancelToOrigMap.set('cancel-a', 'old');
    engine.cancelToOrigMap.set('cancel-b', 'old');
    engine.reconcileRestAbsentOrder('old');
    expect(engine.cancelToOrigMap.size).toBe(0);
    expect(engine.resolvedCancelIds.has('cancel-a')).toBe(true);
    expect(engine.resolvedCancelIds.has('cancel-b')).toBe(true);
    engine.onOrderCancelReject({ '11': 'cancel-a', '41': 'old', '102': '0' });
    engine.onOrderCancelReject({ '11': 'cancel-b', '41': 'old', '102': '0' });
    expect(engine.consecutiveRejects).toBe(0);
  });

  test('replacement timeout clears unknown delivery state and permits a fresh cancel', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 }, liveOrders: [],
    });
    capital.reserve({ orderId: 'old', side: 'buy', price: 98, size: 0.01, level: 1 });
    capital.accept('old');
    const { engine, fixConnection } = makeEngine({
      capitalReservationManager: capital, pendingReplacementTimeoutMs: 1,
    });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    fixConnection.sendMessage.mockImplementationOnce(() => Promise.resolve(true)).mockImplementation(() => true);
    expect(engine._dispatchAction({
      type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 100),
    })).toBe(true);
    engine.pendingReplacements.get('old').createdAt = 0;

    engine._expirePendingReplacements();
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(engine.activeOrders.get('old')).not.toHaveProperty('dispatchOutcomeUnknown');
    expect(engine.activeOrders.get('old')).not.toHaveProperty('cancellingAt');
    expect(engine.cancelToOrigMap.size).toBe(0);
    expect(engine.pendingReplacements.has('old')).toBe(false);
    expect(engine._sendCancel('old', existing)).toBe(true);
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('no-manager Promise cancel timeout cannot heal a non-authoritative execution gap', () => {
    const { engine, fixConnection } = makeEngine({ pendingReplacementTimeoutMs: 1 });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    fixConnection.sendMessage.mockImplementationOnce(() => Promise.resolve(true)).mockImplementation(() => true);
    expect(engine._dispatchAction({
      type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 100),
    })).toBe(true);
    expect(engine.getContinuityState().executionState).toBe('unsafe');
    expect(engine.quotingSuspended).toBe(true);
    expect(engine.executionEvidenceGap).toMatchObject({
      orderId: 'old', reason: 'async-cancel-dispatch-outcome-unknown', authoritative: false,
    });
    engine.pendingReplacements.get('old').createdAt = 0;

    engine._expirePendingReplacements();
    expect(engine.pendingReplacements.has('old')).toBe(false);
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(engine.activeOrders.get('old')).not.toHaveProperty('dispatchOutcomeUnknown');
    expect(engine.executionEvidenceGap).toMatchObject({
      orderId: 'old', reason: 'async-cancel-dispatch-outcome-unknown', authoritative: false,
    });
    expect(engine.getContinuityState().executionState).toBe('unsafe');

    engine.resumeQuoting();
    engine.onPriceUpdate({ price: 100, timestamp: Date.now(), sourceCount: 1 });
    expect(fixConnection.sendMessage).toHaveBeenCalledTimes(1);
    expect(engine.getContinuityState().executionState).toBe('unsafe');
  });

  test('strict Promise delivery without a capital manager suspends unsafe and requests resync', async () => {
    const newAttempt = makeEngine();
    newAttempt.fixConnection.sendMessage.mockImplementation(() => Promise.resolve(true));
    newAttempt.engine.updateTruexEbbo(freshEbbo(99, 105));
    const newResync = [];
    newAttempt.engine.on('capital-resync-required', (event) => newResync.push(event));
    expect(newAttempt.engine._sendNewOrder(quote('buy', 100))).toBeNull();
    expect(newAttempt.engine.getContinuityState().executionState).toBe('unsafe');
    expect(newAttempt.engine.isQuoting).toBe(false);
    expect(newResync).toHaveLength(1);

    const cancelAttempt = makeEngine();
    cancelAttempt.fixConnection.sendMessage.mockImplementation(() => Promise.resolve(true));
    cancelAttempt.engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('sell', 104), status: 'active', acknowledgedLive: true };
    cancelAttempt.engine.activeOrders.set('old', existing);
    const cancelResync = [];
    cancelAttempt.engine.on('capital-resync-required', (event) => cancelResync.push(event));
    expect(cancelAttempt.engine._sendCancel('old', existing)).toBe(true);
    expect(cancelAttempt.engine.getContinuityState().executionState).toBe('unsafe');
    expect(cancelAttempt.engine.activeOrders.get('old')).toMatchObject({
      status: 'cancelling', dispatchOutcomeUnknown: true,
    });
    expect(cancelResync).toHaveLength(1);
    await Promise.resolve();
  });

  test('throwing resync telemetry cannot misclassify Promise delivery as unsent', () => {
    const capital = new CapitalReservationManager();
    capital.reconcile({
      baseBalance: { available: 1, held: 0, total: 1 },
      quoteBalance: { available: 1000, held: 0, total: 1000 },
      liveOrders: [],
    });
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: capital });
    fixConnection.sendMessage.mockImplementation(() => Promise.resolve(true));
    engine.updateTruexEbbo(freshEbbo(99, 105));
    engine.on('capital-resync-required', () => { throw new Error('observer failed'); });

    expect(() => engine._sendNewOrder(quote('buy', 100))).not.toThrow();
    const [orderId] = engine.activeOrders.keys();
    expect(capital.getReservation(orderId)).toMatchObject({
      state: 'dispatch-outcome-unknown', remainingSize: 0.01,
    });
    expect(engine.getContinuityState().executionState).toBe('unsafe');
  });

  test.each(['false', 'throw'])('replacement cancel %s restores exact prior intent and cancel state', (failure) => {
    const cancelRequested = mock(() => true);
    const cancelDispatchFailed = mock(() => true);
    const manager = {
      cancelRequested,
      cancelDispatchFailed,
      getReservation: () => ({ state: 'active' }),
      getPresence: () => ({ buy: 1, sell: 0 }),
      getReservations: () => [],
    };
    const { engine, fixConnection } = makeEngine({ capitalReservationManager: manager });
    engine.updateTruexEbbo(freshEbbo(99, 105));
    const existing = { ...quote('buy', 98), status: 'active', acknowledgedLive: true };
    engine.activeOrders.set('old', existing);
    const priorPending = { quote: quote('buy', 97), createdAt: 1 };
    engine.pendingReplacements.set('old', priorPending);
    engine.lastReplacementSide = 'sell';
    engine.lastReplacementLevelBySide.set('buy', 7);
    const lifecycle = [];
    engine.on('quote-lifecycle', (event) => lifecycle.push(event));
    fixConnection.sendMessage.mockImplementation(() => {
      if (failure === 'throw') throw new Error('dispatch failed');
      return false;
    });

    if (failure === 'throw') {
      expect(() => engine._dispatchAction({
        type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 100),
      })).toThrow('dispatch failed');
    } else {
      expect(engine._dispatchAction({
        type: 'replacement-cancel', clOrdID: 'old', order: existing, quote: quote('buy', 100),
      })).toBe(false);
    }
    expect(engine.pendingReplacements.get('old')).toBe(priorPending);
    expect(engine.lastReplacementSide).toBe('sell');
    expect(engine.lastReplacementLevelBySide.get('buy')).toBe(7);
    expect(engine.activeOrders.get('old')).toMatchObject({ status: 'active', acknowledgedLive: true });
    expect(cancelDispatchFailed).toHaveBeenCalledTimes(1);
    expect(engine.cancelToOrigMap.size).toBe(0);
    expect(engine.lastActionByClOrdID.size).toBe(0);
    expect(lifecycle).toEqual([]);
    expect(engine.deferredRepriceNeeded).toBe(true);
  });
});
