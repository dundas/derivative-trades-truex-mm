/**
 * TrueX OHLC Builder
 * Aggregates trades into time-bucketed OHLC candles.
 */
export class TrueXOhlcBuilder {
  constructor(options = {}) {
    this.symbol = options.symbol || 'BTC/USD';
    this.exchange = options.exchange || 'truex';
    this.intervalMs = options.intervalMs || 60_000; // 1m
    this.logger = options.logger || console;

    // Map key: `${symbol}:${bucketTs}` -> candle
    this.candles = new Map();
  }

  getBucketTs(ts) {
    return Math.floor(ts / this.intervalMs) * this.intervalMs;
  }

  updateWithTrade({ timestamp, price, volume, symbol }) {
    if (!timestamp || !price || !volume) return null;
    const sym = symbol || this.symbol;
    const bucketTs = this.getBucketTs(timestamp);
    const key = `${sym}:${bucketTs}`;

    let c = this.candles.get(key);
    if (!c) {
      c = {
        symbol: sym,
        exchange: this.exchange,
        interval: `${Math.round(this.intervalMs / 60000)}m`,
        timestamp: bucketTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        tradeCount: 0,
        source: 'trades',
        isComplete: false,
        data: {}
      };
      this.candles.set(key, c);
    }

    // Update fields
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += volume;
    c.tradeCount += 1;

    return c;
  }

  updateWithSnapshot({ timestamp, open, high, low, close, volume, symbol }) {
    if (!timestamp) return null;
    const sym = symbol || this.symbol;
    const bucketTs = this.getBucketTs(timestamp);
    const key = `${sym}:${bucketTs}`;

    const c = {
      symbol: sym,
      exchange: this.exchange,
      interval: `${Math.round(this.intervalMs / 60000)}m`,
      timestamp: bucketTs,
      open, high, low, close,
      volume: volume || 0,
      tradeCount: undefined,
      source: 'snapshot',
      isComplete: false,
      data: {}
    };

    this.candles.set(key, c);
    return c;
  }

  // Return and mark candles fully before 'now' as complete
  flushCompleteCandles(nowTs = Date.now()) {
    const completed = [];
    for (const [key, c] of this.candles.entries()) {
      const bucketEnd = c.timestamp + this.intervalMs;
      if (bucketEnd <= nowTs) {
        c.isComplete = true;
        completed.push(c);
        this.candles.delete(key);
      }
    }
    return completed.sort((a, b) => a.timestamp - b.timestamp);
  }
}
