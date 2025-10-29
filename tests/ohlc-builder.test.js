import { describe, it, expect, beforeEach } from '@jest/globals';
import { TrueXOhlcBuilder } from './ohlc-builder.js';

describe('TrueXOhlcBuilder', () => {
  let b;
  beforeEach(() => {
    b = new TrueXOhlcBuilder({ symbol: 'BTC/USD', intervalMs: 60_000, logger: console });
  });

  it('updates with trades and aggregates OHLC', () => {
    const t0 = 1_700_000_000_000;
    b.updateWithTrade({ timestamp: t0 + 5_000, price: 100, volume: 1, symbol: 'BTC/USD' });
    b.updateWithTrade({ timestamp: t0 + 10_000, price: 110, volume: 2, symbol: 'BTC/USD' });
    b.updateWithTrade({ timestamp: t0 + 20_000, price: 90, volume: 3, symbol: 'BTC/USD' });

    const key = `BTC/USD:${b.getBucketTs(t0 + 5_000)}`;
    const c = b.candles.get(key);
    expect(c.open).toBe(100);
    expect(c.high).toBe(110);
    expect(c.low).toBe(90);
    expect(c.close).toBe(90);
    expect(c.volume).toBe(6);
    expect(c.tradeCount).toBe(3);
  });

  it('creates snapshot candle', () => {
    const now = 1_700_000_060_000;
    const c = b.updateWithSnapshot({ timestamp: now, open: 100, high: 120, low: 90, close: 110, volume: 5, symbol: 'BTC/USD' });
    expect(c.open).toBe(100);
    expect(c.volume).toBe(5);
  });

  it('flushes completed candles older than now', () => {
    const base = 1_700_000_000_000;
    b.updateWithTrade({ timestamp: base + 1_000, price: 100, volume: 1 });
    const before = b.flushCompleteCandles(base + 30_000);
    // Not complete yet because bucketEnd = base+60_000
    expect(before.length).toBe(0);

    const after = b.flushCompleteCandles(base + 61_000);
    expect(after.length).toBe(1);
    expect(after[0].isComplete).toBe(true);
  });
});
