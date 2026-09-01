#!/usr/bin/env bun
import { QuoteEngine } from '../src/core/quote-engine.js';

const sent = [];
let freshestEbbo = null;
const engine = new QuoteEngine({
  fixConnection: { sendMessage: (fields) => sent.push({ fields: { ...fields }, ebbo: { ...freshestEbbo } }) },
  inventoryManager: {
    balancesInitialized: true,
    canQuote: () => true,
    getAvailableForSide: () => 1_000_000,
    getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }),
  },
  strictTruexMakerSafety: true,
  truexMakerEbboMaxAgeMs: 3000,
  truexAloRetryCooldownMs: 10000,
  truexAloRetryMaxEntries: 16,
  marketablePostOnlyAction: 'skip',
  tickSize: 0.5,
  logger: { info() {}, warn() {}, error() {} },
});

freshestEbbo = { bestBid: 100, bestAsk: 101, timestamp: Date.now() };
engine.updateTruexEbbo(freshestEbbo);
for (let i = 0; i < 20; i++) {
  engine._sendNewOrder({ side: 'buy', price: 101, size: 0.01, level: 1 });
  engine._sendNewOrder({ side: 'sell', price: 100, size: 0.01, level: 1 });
}
engine._sendNewOrder({ side: 'buy', price: 100.5, size: 0.01, level: 1 });
engine._sendNewOrder({ side: 'sell', price: 101.5, size: 0.01, level: 1 });

// Deterministic recorded-event replay: a venue ALO cancellation inhibits the identical
// side/price through timestamp-only refreshes, then a real opposite-touch change re-arms it.
freshestEbbo = { bestBid: 99, bestAsk: 105, timestamp: Date.now() };
engine.updateTruexEbbo(freshestEbbo);
const aloOrderId = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.01, level: 2 });
engine.onExecutionReport({ '11': aloOrderId, '39': '4', '58': 'ALO would trade' });
for (let i = 0; i < 20; i++) {
  freshestEbbo = { ...freshestEbbo, timestamp: Date.now() };
  engine.updateTruexEbbo(freshestEbbo);
  engine._sendNewOrder({ side: 'buy', price: 100, size: 0.01, level: 2 });
}
freshestEbbo = { bestBid: 99, bestAsk: 105.5, timestamp: Date.now() };
engine.updateTruexEbbo(freshestEbbo);
engine._sendNewOrder({ side: 'buy', price: 100, size: 0.01, level: 2 });

const newOrders = sent.filter(({ fields }) => fields['35'] === 'D');
if (newOrders.length !== 4) throw new Error(`expected 4 safe D sends, received ${newOrders.length}`);
for (const { fields, ebbo } of newOrders) {
  const price = Number(fields['44']);
  if (fields['54'] === '1' && price >= ebbo.bestAsk) throw new Error(`marketable buy dispatched at ${price}`);
  if (fields['54'] === '2' && price <= ebbo.bestBid) throw new Error(`marketable sell dispatched at ${price}`);
}

// A missing L1 must be recoverable without crossing the authoritative TrueX
// book. This is the bounded alternative to leaving a single side absent when
// its desired replacement is marketable: `slide` moves it one tick passive
// while retaining a non-crossing acknowledged quote on the opposite side.
const slideEbbo = { bestBid: 100, bestAsk: 102, timestamp: Date.now() };
const slideTickSize = 0.5;
const makeSlideEngine = () => {
  const sent = [];
  const engine = new QuoteEngine({
    fixConnection: { sendMessage: (fields) => sent.push({ fields: { ...fields }, ebbo: { ...slideEbbo } }) },
    inventoryManager: {
      balancesInitialized: true,
      canQuote: () => true,
      getAvailableForSide: () => 1_000_000,
      getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }),
    },
    strictTruexMakerSafety: true,
    truexMakerEbboMaxAgeMs: 3000,
    truexAloRetryCooldownMs: 10000,
    truexAloRetryMaxEntries: 16,
    marketablePostOnlyAction: 'slide',
    tickSize: slideTickSize,
    logger: { info() {}, warn() {}, error() {} },
  });
  engine.updateTruexEbbo(slideEbbo);
  return { engine, sent };
};

const buyRecovery = makeSlideEngine();
const existingAsk = { side: 'sell', price: 103, size: 0.01, level: 1, status: 'active' };
buyRecovery.engine.activeOrders.set('existing-ask', existingAsk);
buyRecovery.engine._sendNewOrder({ side: 'buy', price: 102, size: 0.01, level: 1 });
const sellRecovery = makeSlideEngine();
const existingBid = { side: 'buy', price: 99, size: 0.01, level: 1, status: 'active' };
sellRecovery.engine.activeOrders.set('existing-bid', existingBid);
sellRecovery.engine._sendNewOrder({ side: 'sell', price: 100, size: 0.01, level: 1 });

if (buyRecovery.engine.activeOrders.get('existing-ask') !== existingAsk) throw new Error('buy recovery mutated the retained ask');
if (sellRecovery.engine.activeOrders.get('existing-bid') !== existingBid) throw new Error('sell recovery mutated the retained bid');
if ([...buyRecovery.sent, ...sellRecovery.sent].some(({ fields }) => fields['35'] === 'F')) {
  throw new Error('slide recovery cancelled the retained opposite L1');
}

const slideOrders = [...buyRecovery.sent, ...sellRecovery.sent].filter(({ fields }) => fields['35'] === 'D');
if (slideOrders.length !== 2) throw new Error(`expected 2 passive L1 slide sends, received ${slideOrders.length}`);
for (const { fields, ebbo } of slideOrders) {
  const price = Number(fields['44']);
  if (fields['54'] === '1' && price !== ebbo.bestAsk - slideTickSize) throw new Error(`buy did not slide one tick passive: ${price}`);
  if (fields['54'] === '2' && price !== ebbo.bestBid + slideTickSize) throw new Error(`sell did not slide one tick passive: ${price}`);
  if (fields['54'] === '1' && price >= ebbo.bestAsk) throw new Error(`marketable slid buy dispatched at ${price}`);
  if (fields['54'] === '2' && price <= ebbo.bestBid) throw new Error(`marketable slid sell dispatched at ${price}`);
}

console.log(JSON.stringify({
  result: 'PASS',
  attemptedCrossingSends: 40,
  crossingDsDispatched: 0,
  safeDsDispatched: newOrders.length,
  identicalAloRetriesAttempted: 20,
  identicalAloRetriesDispatched: 0,
  slideL1RecoveryOrders: slideOrders.length,
}));
