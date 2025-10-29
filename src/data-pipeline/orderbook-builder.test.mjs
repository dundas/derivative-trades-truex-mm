import test from 'node:test';
import assert from 'node:assert/strict';

import { OrderBookBuilder } from './orderbook-builder.js';

test('OrderBookBuilder normalizes prices to tick and maintains top-of-book', () => {
  const ob = new OrderBookBuilder('BTC-PYUSD', 10);
  // Snapshot with non-tick-aligned prices
  ob.applySnapshot({
    bids: [[100.26, 1.0]],
    asks: [[101.24, 2.0]],
  });
  const tob = ob.getTopOfBook();
  // 0.5 tick: 100.26 -> 100.5, 101.24 -> 101.0
  assert.equal(tob.bestBid.price, 100.5);
  assert.equal(tob.bestBid.size, 1.0);
  assert.equal(tob.bestAsk.price, 101.0);
  assert.equal(tob.bestAsk.size, 2.0);
});

test('OrderBookBuilder applies Coinbase l2 deltas and removes levels at zero size', () => {
  const ob = new OrderBookBuilder('BTC-PYUSD', 10);
  ob.applySnapshot({ bids: [[100.0, 1.0]], asks: [[101.0, 1.0]] });

  ob.applyCoinbaseL2Update({
    type: 'l2update',
    changes: [
      ['buy', '100.00', '0.5'], // reduce bid size
      ['sell', '101.00', '0'],   // remove ask level
      ['buy', '99.74', '0.3'],   // non-tick -> 99.5 after normalization
    ],
  });

  const depth = ob.getDepth(5);
  // Bid at 100.0 should be 0.5 now
  const bid100 = depth.bids.find((l) => l.price === 100.0);
  assert.ok(bid100);
  assert.equal(bid100.size, 0.5);

  // Ask at 101 should be removed
  const ask101 = depth.asks.find((l) => l.price === 101.0);
  assert.equal(ask101, undefined);

  // New bid near 99.74 normalizes to 99.5
  const bid995 = depth.bids.find((l) => l.price === 99.5);
  assert.ok(bid995);
  assert.equal(bid995.size, 0.3);
});



