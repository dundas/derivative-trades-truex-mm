import { afterEach, describe, expect, jest, test } from 'bun:test';
import { PriceAggregator } from './PriceAggregator';

describe('PriceAggregator source provenance', () => {
  afterEach(() => jest.restoreAllMocks());

  test('keeps the receipt timestamp paired with the ticker that supplied bid and ask', () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const aggregator = new PriceAggregator({ symbol: 'BTC-PYUSD', weights: { coinbase: 1 } });
    aggregator.updateTicker({
      exchange: 'coinbase', symbol: 'BTC-PYUSD', timestamp: 900,
      bid: 99, ask: 101, last: 100, volume24h: 1,
    });
    now = 1_100;
    aggregator.updateOrderBook({
      exchange: 'coinbase', symbol: 'BTC-PYUSD', timestamp: 950,
      bids: [{ price: 98, size: 1 }], asks: [{ price: 102, size: 1 }],
    });
    const source = aggregator.getAggregatedPrice()!.sources[0];
    expect(source).toMatchObject({
      bid: 99, ask: 101, sourceTimestamp: 900, receivedTimestamp: 1_000,
    });
  });

  test('preserves missing source timestamps as null', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const aggregator = new PriceAggregator({ symbol: 'BTC-PYUSD', weights: { coinbase: 1 } });
    aggregator.updateTicker({
      exchange: 'coinbase', symbol: 'BTC-PYUSD', timestamp: null as unknown as number,
      bid: 99, ask: 101, last: 100, volume24h: 1,
    });
    expect(aggregator.getAggregatedPrice()!.sources[0].sourceTimestamp).toBeNull();
  });
});
