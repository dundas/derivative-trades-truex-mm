import { describe, it, expect, jest } from 'bun:test';
import { CoinbaseMarketDataAdapter } from './coinbase-market-data-adapter.js';

describe('CoinbaseMarketDataAdapter', () => {
  function baseMocks() {
    const ingest = {
      connected: true,
      start: jest.fn().mockResolvedValue(undefined),
      restart: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
    };
    const priceAggregator = {
      getStatus: jest.fn().mockReturnValue({
        feeds: {
          coinbase: { isStale: false, lastUpdate: Date.now(), hasData: true },
        },
      }),
      getAggregatedPrice: jest.fn().mockReturnValue({ spread: 2.5 }),
    };
    return { ingest, priceAggregator };
  }

  it('isLoggedOn is true when the socket is connected and the feed has fresh data', () => {
    const { ingest, priceAggregator } = baseMocks();
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    expect(adapter.isLoggedOn).toBe(true);
  });

  it('isLoggedOn is false when the WebSocket is disconnected', () => {
    const { ingest, priceAggregator } = baseMocks();
    ingest.connected = false;
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    expect(adapter.isLoggedOn).toBe(false);
  });

  it('isLoggedOn is false when the feed is stale (half-open socket, no fresh ticks)', () => {
    const { ingest, priceAggregator } = baseMocks();
    priceAggregator.getStatus.mockReturnValue({
      feeds: {
        coinbase: { isStale: true, lastUpdate: Date.now() - 120_000, hasData: true },
      },
    });
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    expect(adapter.isLoggedOn).toBe(false);
  });

  it('isLoggedOn is false when there is no ticker/orderbook data yet', () => {
    const { ingest, priceAggregator } = baseMocks();
    priceAggregator.getStatus.mockReturnValue({
      feeds: {
        coinbase: { isStale: false, lastUpdate: 0, hasData: false },
      },
    });
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    expect(adapter.isLoggedOn).toBe(false);
  });

  it('connect() restarts ingest when the socket is still open but the feed is unhealthy', async () => {
    const { ingest, priceAggregator } = baseMocks();
    ingest.connected = true;
    priceAggregator.getStatus.mockReturnValue({
      feeds: {
        coinbase: { isStale: true, lastUpdate: 0, hasData: true },
      },
    });
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    await adapter.connect();
    expect(ingest.restart).toHaveBeenCalledTimes(1);
    expect(ingest.start).not.toHaveBeenCalled();
  });

  it('connect() starts ingest when the socket is not connected', async () => {
    const { ingest, priceAggregator } = baseMocks();
    ingest.connected = false;
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    await adapter.connect();
    expect(ingest.start).toHaveBeenCalledTimes(1);
    expect(ingest.restart).not.toHaveBeenCalled();
  });

  it('connect() does not start or restart when already healthy', async () => {
    const { ingest, priceAggregator } = baseMocks();
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    await adapter.connect();
    expect(ingest.start).not.toHaveBeenCalled();
    expect(ingest.restart).not.toHaveBeenCalled();
  });

  it('disconnect() stops the ingest', () => {
    const { ingest, priceAggregator } = baseMocks();
    const adapter = new CoinbaseMarketDataAdapter({ ingest, priceAggregator });
    adapter.disconnect();
    expect(ingest.stop).toHaveBeenCalledTimes(1);
  });
});
