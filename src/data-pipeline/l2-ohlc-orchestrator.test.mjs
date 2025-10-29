import test from 'node:test';
import assert from 'node:assert/strict';

import { L2OhlcOrchestrator } from './l2-ohlc-orchestrator.js';

class FakeIngest {
  constructor({ symbols, onSnapshot, onL2Update, onTrade, onTicker }) {
    this.symbols = symbols;
    this.onSnapshot = onSnapshot;
    this.onL2Update = onL2Update;
    this.onTrade = onTrade;
    this.onTicker = onTicker;
  }
  async start() {
    // Emit a snapshot and deltas, then a trade
    const symbol = this.symbols[0];
    this.onSnapshot(symbol, {
      bids: [[100, 1]],
      asks: [[101, 2]],
    });
    this.onL2Update(symbol, [
      { side: 'bid', price: 100, size: 1.5 },
      { side: 'ask', price: 101, size: 0 },
    ]);
    this.onTrade(symbol, [{ price: 100.25, volume: 0.1, timestamp: Date.now() }]);
  }
  stop() {}
}

test('Orchestrator wires L2 and OHLC correctly', async () => {
  const orch = new L2OhlcOrchestrator({ symbols: ['BTC-PYUSD'], IngestClass: FakeIngest });
  await orch.start();

  const depth = orch.getDepth('BTC-PYUSD', 5);
  assert.ok(depth);
  const bid100 = depth.bids.find((l) => l.price === 100);
  assert.ok(bid100 && bid100.size === 1.5);
  const ask101 = depth.asks.find((l) => l.price === 101);
  assert.equal(ask101, undefined);

  const flushed = orch.flushCompleteCandles('BTC-PYUSD', Date.now() + 60_000);
  assert.ok(Array.isArray(flushed));
});



