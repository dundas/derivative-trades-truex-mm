// In-memory L2 order book builder with top-N depth maintenance.
// Focus of 2.1: data structures and top-N retrieval; snapshot/delta application follows in 2.2.

import { normalizePriceForSymbol } from './symbol-ticks.js';

export class OrderBookBuilder {
  constructor(symbol, defaultDepth = 10) {
    this.symbol = symbol;
    this.defaultDepth = defaultDepth;
    this.bidPriceToSize = new Map(); // price -> size
    this.askPriceToSize = new Map(); // price -> size
    this.lastUpdatedAt = Date.now();
  }

  // Internal: normalize and coerce numeric values
  toNormalizedPrice(price) {
    return normalizePriceForSymbol(this.symbol, price);
  }

  toNumericSize(size) {
    const n = Number(size);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  // Set or remove a level; does not yet implement snapshot/delta ingestion logic (task 2.2)
  setLevel(side, price, size) {
    const p = this.toNormalizedPrice(price);
    const s = this.toNumericSize(size);
    const isBid = side === 'bid' || side === 'b';
    const isAsk = side === 'ask' || side === 'a';
    if (!isBid && !isAsk) return;

    const book = isBid ? this.bidPriceToSize : this.askPriceToSize;
    if (s > 0) {
      book.set(p, s);
    } else {
      book.delete(p);
    }
    this.lastUpdatedAt = Date.now();
  }

  clear() {
    this.bidPriceToSize.clear();
    this.askPriceToSize.clear();
    this.lastUpdatedAt = Date.now();
  }

  // 2.2: Deterministic application of snapshots and deltas
  // Generic snapshot shape: { bids: Array<[price, size]>, asks: Array<[price, size]> }
  applySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks)) return;
    this.clear();
    for (const [price, size] of snapshot.bids) {
      this.setLevel('bid', price, size);
    }
    for (const [price, size] of snapshot.asks) {
      this.setLevel('ask', price, size);
    }
    this.lastUpdatedAt = Date.now();
  }

  // Generic deltas: Array<{ side: 'bid'|'ask'|'b'|'a', price, size }>
  applyDeltas(deltas) {
    if (!Array.isArray(deltas)) return;
    for (const delta of deltas) {
      if (!delta) continue;
      const { side, price, size } = delta;
      this.setLevel(side, price, size);
    }
    this.lastUpdatedAt = Date.now();
  }

  // Coinbase formats
  // Snapshot: { type: 'snapshot', product_id, bids: [[priceStr, sizeStr], ...], asks: [[priceStr, sizeStr], ...] }
  applyCoinbaseSnapshot(message) {
    if (!message || !Array.isArray(message.bids) || !Array.isArray(message.asks)) return;
    const bids = message.bids.map((pair) => [Number(pair[0]), Number(pair[1])]);
    const asks = message.asks.map((pair) => [Number(pair[0]), Number(pair[1])]);
    this.applySnapshot({ bids, asks });
  }

  // L2 update: { type: 'l2update', product_id, changes: [[side, priceStr, sizeStr], ...] }
  applyCoinbaseL2Update(message) {
    if (!message || !Array.isArray(message.changes)) return;
    const deltas = [];
    for (const change of message.changes) {
      const sideRaw = change[0];
      const price = Number(change[1]);
      const size = Number(change[2]);
      const side = sideRaw === 'buy' ? 'bid' : sideRaw === 'sell' ? 'ask' : sideRaw;
      deltas.push({ side, price, size });
    }
    this.applyDeltas(deltas);
  }

  // Sorted views
  getSortedBids() {
    const entries = Array.from(this.bidPriceToSize.entries());
    entries.sort((a, b) => b[0] - a[0]);
    return entries;
  }

  getSortedAsks() {
    const entries = Array.from(this.askPriceToSize.entries());
    entries.sort((a, b) => a[0] - b[0]);
    return entries;
  }

  getTopOfBook() {
    const bids = this.getSortedBids();
    const asks = this.getSortedAsks();
    const bestBid = bids.length > 0 ? { price: bids[0][0], size: bids[0][1] } : null;
    const bestAsk = asks.length > 0 ? { price: asks[0][0], size: asks[0][1] } : null;
    return { bestBid, bestAsk, ts: this.lastUpdatedAt };
  }

  getDepth(depth = this.defaultDepth) {
    const bids = this.getSortedBids().slice(0, depth).map(([price, size]) => ({ price, size }));
    const asks = this.getSortedAsks().slice(0, depth).map(([price, size]) => ({ price, size }));
    return { symbol: this.symbol, bids, asks, ts: this.lastUpdatedAt };
  }

  toSnapshot(depth = this.defaultDepth) {
    const depthView = this.getDepth(depth);
    return {
      symbol: depthView.symbol,
      ts: depthView.ts,
      bids: depthView.bids,
      asks: depthView.asks,
    };
  }
}


