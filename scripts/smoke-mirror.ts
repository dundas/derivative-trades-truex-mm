#!/usr/bin/env bun
/**
 * Smoke test: coinbase-mirror quoting end-to-end through the QuoteEngine.
 *
 * Validates that with quoteAnchorMode='coinbase-mirror' the engine:
 *   1. anchors L1 to the Coinbase best bid/ask offset by the buffer,
 *   2. emits both bid and ask orders via the FIX connection,
 *   3. produces a spread ~Coinbase width (far tighter than baseSpreadBps),
 *   4. falls back to mid-anchored quoting when the Coinbase book is absent.
 *
 * No network, no real orders. Exit 0 = PASS, non-zero = BLOCK.
 */
import { QuoteEngine } from '../src/core/quote-engine.js';

const sent: any[] = [];
const engine = new QuoteEngine({
  inventoryManager: { getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }), canQuote: () => true },
  fixConnection: { sendMessage: (f: any) => sent.push(f) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  levels: 2,
  quoteAnchorMode: 'coinbase-mirror',
  coinbaseAnchorBufferTicks: 1,
  baseSpreadBps: 30,
  levelSpacingTicks: 2,
  tickSize: 0.5,
  baseSizeBTC: 0.01,
  sizeDecimalPlaces: 4,
  minNotional: 1.0,
  priceBandPct: 2.5,
  clientId: 'SMOKE',
  symbol: 'BTC-PYUSD',
});

function fail(msg: string): never { console.error(`BLOCK: ${msg}`); process.exit(1); }

// Synthetic price: Coinbase source is $20 wide (65690/65710), but the cross-venue
// bestBid/bestAsk is deliberately TIGHTER (65699/65701). The anchor must follow the
// Coinbase source, NOT the cross-venue BBO — so if the engine regressed to reading
// bestBid/bestAsk, the L1 assertions below would fail.
const price = {
  weightedMidpoint: 65700, bestBid: 65699, bestAsk: 65701,
  confidence: 1.0, timestamp: Date.now(), symbol: 'BTC-PYUSD',
  sources: [{ exchange: 'coinbase', bid: 65690, ask: 65710, midpoint: 65700, weight: 1, isStale: false, latencyMs: 5 }],
};
engine.onPriceUpdate(price as any);

const newOrders = sent.filter((f) => f['35'] === 'D');
const bids = newOrders.filter((f) => f['54'] === '1').map((f) => parseFloat(f['44']));
const asks = newOrders.filter((f) => f['54'] === '2').map((f) => parseFloat(f['44']));

if (!bids.length || !asks.length) fail(`expected both bids and asks, got bids=${bids.length} asks=${asks.length}`);

const topBid = Math.max(...bids);
const topAsk = Math.min(...asks);
// L1 bid = 65690 - 1 tick = 65689.5 ; L1 ask = 65710 + 1 tick = 65710.5
if (Math.abs(topBid - 65689.5) > 0.5) fail(`L1 bid not anchored to Coinbase bid: ${topBid} (want ~65689.5)`);
if (Math.abs(topAsk - 65710.5) > 0.5) fail(`L1 ask not anchored to Coinbase ask: ${topAsk} (want ~65710.5)`);

const spread = topAsk - topBid;
if (spread > 30) fail(`mirror spread ${spread} too wide — anchor likely not applied (baseSpreadBps would give ~${(30 / 10000) * 65700})`);

// Fallback: with NO Coinbase book, a fresh engine must still quote (mid-anchored, not throw).
const fbSent: any[] = [];
const fbEngine = new QuoteEngine({
  inventoryManager: { getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }), canQuote: () => true },
  fixConnection: { sendMessage: (f: any) => fbSent.push(f) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  levels: 2, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
  baseSpreadBps: 30, levelSpacingTicks: 2, tickSize: 0.5, baseSizeBTC: 0.01,
  sizeDecimalPlaces: 4, minNotional: 1.0, priceBandPct: 2.5, clientId: 'SMOKE', symbol: 'BTC-PYUSD',
});
fbEngine.onPriceUpdate({ weightedMidpoint: 65700, bestBid: 0, bestAsk: 0, confidence: 1.0, timestamp: Date.now(), symbol: 'BTC-PYUSD' } as any);
const fbOrders = fbSent.filter((f) => f['35'] === 'D');
const fbBids = fbOrders.filter((f) => f['54'] === '1').map((f) => parseFloat(f['44']));
if (!fbBids.length) fail('no quotes emitted on missing-book fallback');
// Mid-anchored fallback bid must be ~baseSpreadBps below mid (far below the mirror anchor).
if (Math.max(...fbBids) > 65690) fail(`fallback bid ${Math.max(...fbBids)} not mid-anchored (should be ~30bps below 65700)`);

console.log(`PASS: mirror L1 bid=${topBid} ask=${topAsk} spread=$${spread.toFixed(2)} (~Coinbase width); fallback OK`);
process.exit(0);
