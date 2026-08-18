#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { CapitalReservationManager } from '../src/core/capital-reservation-manager.js';
import { MakerPresenceController } from '../src/core/maker-presence-controller.js';
import { QuoteEngine } from '../src/core/quote-engine.js';

const continuityConfig = {
  minActiveLevelsPerSide: 1,
  minimumFundedQuoteSize: 0.0001,
  l1ReserveBase: 0.01,
  l1ReserveQuote: 1000,
  maxSideGapMs: 1000,
  alertThresholdMs: 500,
  alertRateLimitMs: 5000,
  degradedMaxLevels: 2,
  degradedSizeFactor: 0.5,
  defensiveSpreadFloorBps: 80,
};
const capital = new CapitalReservationManager(continuityConfig);
capital.reconcile({
  baseBalance: { available: 0.0168, held: 0, total: 0.0168 },
  quoteBalance: { available: 1680, held: 0, total: 1680 },
  liveOrders: [],
});

const sent = [];
const fixConnection = { sendMessage: (fields) => sent.push({ ...fields }) };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = new QuoteEngine({
  capitalReservationManager: capital,
  fixConnection,
  minActiveLevelsPerSide: continuityConfig.minActiveLevelsPerSide,
  minimumFundedQuoteSize: continuityConfig.minimumFundedQuoteSize,
  degradedMaxLevels: continuityConfig.degradedMaxLevels,
  degradedSizeFactor: continuityConfig.degradedSizeFactor,
  defensiveSpreadFloorBps: continuityConfig.defensiveSpreadFloorBps,
  levels: 3,
  baseSizeBTC: 0.01,
  sizeDecayFactor: 0.68,
  maxOrdersPerSecond: 1000000,
  logger,
});

let now = 0;
const presence = new MakerPresenceController(continuityConfig, { now: () => now });
const observe = () => {
  const status = presence.observe({ orders: capital.getReservations() });
  assert.equal(status.present.twoSided, true, `acknowledged two-sided L1 lost at t=${now}`);
  assert.equal(status.executionState, 'normal');
};
const placeAndAck = (side, size, level, price) => {
  const id = engine._sendNewOrder({ side, size, level, price });
  assert.ok(id, `${side} L${level} must reserve before FIX send`);
  engine.onExecutionReport({ '11': id, '39': '0', '54': side === 'buy' ? '1' : '2' });
  return id;
};

const synchronizedDesired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
for (const quote of synchronizedDesired) placeAndAck(quote.side, quote.size, quote.level, quote.price);
let buyL2 = [...engine.activeOrders].find(([, order]) => order.side === 'buy' && order.level === 2)[0];
let sellL2 = [...engine.activeOrders].find(([, order]) => order.side === 'sell' && order.level === 2)[0];
const synchronizedActions = engine.reconcileOrders(
  engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }),
  engine.activeOrders,
);
assert.deepEqual(synchronizedActions, { toPlace: [], toCancel: [], toReplace: [] },
  'synchronized capital and desired ladder must not churn or cancel');
observe();

for (let cycle = 1; cycle <= 1000; cycle++) {
  for (const side of ['buy', 'sell']) {
    const previous = side === 'buy' ? buyL2 : sellL2;
    const desired = [...engine.activeOrders.entries()].map(([clOrdID, order]) => ({
      side: order.side,
      level: order.level,
      size: order.size,
      price: clOrdID === previous
        ? order.price + (side === 'buy' ? -engine.config.tickSize : engine.config.tickSize)
        : order.price,
    }));
    const actions = engine.reconcileOrders(desired, engine.activeOrders);
    assert.equal(actions.toReplace.length, 1);
    // The soak advances logical market time without sleeping wall-clock time.
    engine.lastActionByClOrdID.delete(previous);
    engine.executeActions(actions);
    const cancel = sent.at(-1);
    assert.equal(cancel['35'], 'F');
    now++;
    observe(); // cancel-in-flight remains acknowledged live

    engine.onExecutionReport({ '11': cancel['11'], '39': '4', '54': side === 'buy' ? '1' : '2' });
    const replacement = sent.at(-1);
    assert.equal(replacement['35'], 'D');
    now++;
    observe(); // funded L1 remains acknowledged while replacement is pending-new

    engine.onExecutionReport({ '11': replacement['11'], '39': '0', '54': side === 'buy' ? '1' : '2' });
    if (side === 'buy') buyL2 = replacement['11'];
    else sellL2 = replacement['11'];
    now++;
    observe();
  }
}

assert.equal([...engine.recentRejectsByReason.values()].reduce((sum, count) => sum + count, 0), 0);
assert.equal(presence.observe({ orders: capital.getReservations() }).twoSidedUptimePct, 100);

let controlState = { executionState: 'unsafe', reasons: ['smoke-emergency'] };
engine.setContinuityStateProvider(() => controlState);
const beforeUnsafe = sent.length;
engine.executeActions({
  toCancel: [], toReplace: [],
  toPlace: [{ side: 'buy', size: 0.001, level: 3, price: 99000 }],
});
assert.equal(sent.length, beforeUnsafe, 'unsafe state must dispatch no new order');

const applyControlledReprice = (executionState) => {
  controlState = {
    executionState,
    reasons: executionState === 'degraded' ? ['missing-acknowledged-depth'] : [],
  };
  engine.setContinuityState(controlState);
  const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
  for (const side of ['buy', 'sell']) {
    assert.ok(desired.filter((quote) => quote.side === side).length >= continuityConfig.minActiveLevelsPerSide);
  }
  const start = sent.length;
  engine.executeActions(engine.reconcileOrders(desired, engine.activeOrders));
  const cancels = sent.slice(start).filter((fields) => fields['35'] === 'F');
  for (const cancel of cancels) {
    engine.onExecutionReport({ '11': cancel['11'], '39': '4', '54': cancel['54'] });
    observe();
    const replacement = sent.at(-1);
    if (replacement?.['35'] === 'D') {
      engine.onExecutionReport({ '11': replacement['11'], '39': '0', '54': replacement['54'] });
      observe();
    }
  }
  observe();
};

applyControlledReprice('degraded');
applyControlledReprice('normal');
assert.equal(presence.observe({ orders: capital.getReservations() }).twoSidedUptimePct, 100);
console.log('PASS: QuoteEngine/FIX simulated 1,000 constrained-capital reprices, unsafe no-send, and degraded recovery with continuous acknowledged L1 and zero funding rejects');
