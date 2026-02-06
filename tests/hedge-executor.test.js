import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { HedgeExecutor } from '../src/core/hedge-executor.js';

function createMockKraken(overrides = {}) {
  return {
    addOrder: mock(() => Promise.resolve({
      txid: ['OXXXXX-XXXXX-XXXXXX'],
      descr: { order: 'sell 1.0 XBTUSD @ limit 99950' },
    })),
    queryOrders: mock(() => Promise.resolve({
      'OXXXXX-XXXXX-XXXXXX': {
        status: 'closed',
        vol_exec: '1.0',
        price: '99960',
      },
    })),
    cancelOrder: mock(() => Promise.resolve({ count: 1 })),
    ...overrides,
  };
}

function createMockAggregator(overrides = {}) {
  return {
    getAggregatedPrice: mock(() => ({
      bestBid: 100000,
      bestAsk: 100050,
      weightedMidpoint: 100025,
      ...overrides,
    })),
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('HedgeExecutor', () => {
  let executor;
  let mockKraken;
  let mockAggregator;

  beforeEach(() => {
    mockKraken = createMockKraken();
    mockAggregator = createMockAggregator();
    executor = new HedgeExecutor({
      krakenClient: mockKraken,
      priceAggregator: mockAggregator,
      logger: silentLogger,
      limitTimeoutMs: 100,
      pollIntervalMs: 20,
    });
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const e = new HedgeExecutor({ krakenClient: mockKraken });
      expect(e.config.hedgeVenue).toBe('kraken');
      expect(e.config.hedgeSymbol).toBe('XBTUSD');
      expect(e.config.minHedgeSizeBTC).toBe(0.001);
      expect(e.config.maxHedgeSizeBTC).toBe(1.0);
      expect(e.config.limitPriceOffsetBps).toBe(5);
      expect(e.config.limitTimeoutMs).toBe(5000);
      expect(e.config.pollIntervalMs).toBe(1000);
      expect(e.isHedging).toBe(false);
      expect(e.openHedges.size).toBe(0);
      expect(e.hedgeHistory.length).toBe(0);
    });

    it('should accept custom config', () => {
      const e = new HedgeExecutor({
        krakenClient: mockKraken,
        hedgeSymbol: 'ETHUSD',
        minHedgeSizeBTC: 0.01,
        maxHedgeSizeBTC: 5.0,
        limitPriceOffsetBps: 10,
      });
      expect(e.config.hedgeSymbol).toBe('ETHUSD');
      expect(e.config.minHedgeSizeBTC).toBe(0.01);
      expect(e.config.maxHedgeSizeBTC).toBe(5.0);
      expect(e.config.limitPriceOffsetBps).toBe(10);
    });
  });

  describe('executeHedge - successful limit fill', () => {
    it('should place a limit order and report fill on success', async () => {
      const placedEvents = [];
      const filledEvents = [];
      executor.on('hedge-placed', (e) => placedEvents.push(e));
      executor.on('hedge-filled', (e) => filledEvents.push(e));

      const result = await executor.executeHedge('sell', 0.5);

      expect(result).not.toBeNull();
      expect(result.orderId).toBe('OXXXXX-XXXXX-XXXXXX');
      expect(result.side).toBe('sell');
      expect(result.type).toBe('limit');
      expect(result.size).toBe(1.0); // parsed from vol_exec

      // Verify addOrder was called with limit params
      expect(mockKraken.addOrder).toHaveBeenCalledTimes(1);
      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      expect(callArgs.pair).toBe('XBTUSD');
      expect(callArgs.type).toBe('sell');
      expect(callArgs.ordertype).toBe('limit');
      expect(callArgs.volume).toBe('0.5');

      // Verify events
      expect(placedEvents.length).toBeGreaterThan(0);
      expect(placedEvents[0].side).toBe('sell');
      expect(placedEvents[0].orderId).toBe('OXXXXX-XXXXX-XXXXXX');
      expect(placedEvents[0].type).toBe('limit');

      expect(filledEvents.length).toBeGreaterThan(0);
      expect(filledEvents[0].side).toBe('sell');
      expect(filledEvents[0].price).toBe(99960);
    });

    it('should place buy limit order with correct aggressive price', async () => {
      await executor.executeHedge('buy', 0.1);

      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      expect(callArgs.type).toBe('buy');
      // Buy: bestAsk * (1 + 5/10000) = 100050 * 1.0005 = 100100.025
      const expectedPrice = 100050 * (1 + 5 / 10000);
      expect(parseFloat(callArgs.price)).toBeCloseTo(expectedPrice, 2);
    });

    it('should place sell limit order with correct aggressive price', async () => {
      await executor.executeHedge('sell', 0.1);

      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      expect(callArgs.type).toBe('sell');
      // Sell: bestBid * (1 - 5/10000) = 100000 * 0.9995 = 99950
      const expectedPrice = 100000 * (1 - 5 / 10000);
      expect(parseFloat(callArgs.price)).toBeCloseTo(expectedPrice, 2);
    });
  });

  describe('executeHedge - timeout fallback to market', () => {
    it('should cancel limit and place market order on timeout', async () => {
      let queryCallCount = 0;
      mockKraken.queryOrders = mock(() => {
        queryCallCount++;
        // Return 'open' for all queries (never fills limit)
        return Promise.resolve({
          'OXXXXX-XXXXX-XXXXXX': {
            status: 'open',
            vol_exec: '0',
            price: '0',
          },
        });
      });

      // Market order returns different txid
      const marketTxid = 'OMARKET-XXXXX-XXXXXX';
      let addOrderCallCount = 0;
      mockKraken.addOrder = mock(() => {
        addOrderCallCount++;
        if (addOrderCallCount === 1) {
          // First call = limit order
          return Promise.resolve({
            txid: ['OXXXXX-XXXXX-XXXXXX'],
            descr: { order: 'sell 1.0 XBTUSD @ limit 99950' },
          });
        }
        // Second call = market order
        return Promise.resolve({
          txid: [marketTxid],
          descr: { order: 'sell 1.0 XBTUSD @ market' },
        });
      });

      // For market order query, return filled
      const origQueryOrders = mockKraken.queryOrders;
      mockKraken.queryOrders = mock((params) => {
        if (params.txid === marketTxid) {
          return Promise.resolve({
            [marketTxid]: {
              status: 'closed',
              vol_exec: '0.5',
              price: '99940',
            },
          });
        }
        return Promise.resolve({
          'OXXXXX-XXXXX-XXXXXX': {
            status: 'open',
            vol_exec: '0',
            price: '0',
          },
        });
      });

      const events = [];
      executor.on('hedge-timeout', (e) => events.push({ type: 'timeout', ...e }));
      executor.on('hedge-cancelled', (e) => events.push({ type: 'cancelled', ...e }));
      executor.on('hedge-filled', (e) => events.push({ type: 'filled', ...e }));

      const result = await executor.executeHedge('sell', 0.5);

      // Should have called cancelOrder for the limit
      expect(mockKraken.cancelOrder).toHaveBeenCalledTimes(1);

      // Should have placed 2 orders (limit + market)
      expect(mockKraken.addOrder).toHaveBeenCalledTimes(2);
      const marketCallArgs = mockKraken.addOrder.mock.calls[1][0];
      expect(marketCallArgs.ordertype).toBe('market');

      // Verify timeout event
      const timeout = events.find(e => e.type === 'timeout');
      expect(timeout).toBeTruthy();
      expect(timeout.orderId).toBe('OXXXXX-XXXXX-XXXXXX');

      // Verify fill event from market order
      const filled = events.find(e => e.type === 'filled');
      expect(filled).toBeTruthy();
      expect(result).not.toBeNull();
      expect(result.type).toBe('market');
    });
  });

  describe('size clamping', () => {
    it('should clamp size to maxHedgeSizeBTC', async () => {
      await executor.executeHedge('sell', 5.0);

      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      // Max is 1.0, so volume should be clamped
      expect(callArgs.volume).toBe('1');
    });

    it('should not clamp size below max', async () => {
      await executor.executeHedge('buy', 0.5);

      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      expect(callArgs.volume).toBe('0.5');
    });
  });

  describe('min size guard', () => {
    it('should reject size below minimum', async () => {
      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      const result = await executor.executeHedge('sell', 0.0001);

      expect(result).toBeNull();
      expect(mockKraken.addOrder).not.toHaveBeenCalled();
      expect(events.length).toBe(1);
      expect(events[0].error).toContain('below minimum');
    });

    it('should accept exactly minimum size', async () => {
      const result = await executor.executeHedge('sell', 0.001);

      expect(result).not.toBeNull();
      expect(mockKraken.addOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent hedge prevention', () => {
    it('should reject second hedge while first is pending', async () => {
      // Make the first hedge take a while by returning 'open' status repeatedly
      mockKraken.queryOrders = mock(() => Promise.resolve({
        'OXXXXX-XXXXX-XXXXXX': { status: 'open', vol_exec: '0', price: '0' },
      }));

      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      // Start first hedge (will timeout)
      const first = executor.executeHedge('sell', 0.5);

      // Wait a tick for isHedging to be set
      await new Promise(resolve => setTimeout(resolve, 10));

      // Try second hedge while first is pending
      const second = await executor.executeHedge('buy', 0.3);

      expect(second).toBeNull();
      const concurrentFail = events.find(e => e.error === 'Hedge already in progress');
      expect(concurrentFail).toBeTruthy();

      // Let first one finish (timeout)
      await first;
    });
  });

  describe('fill reporting', () => {
    it('should emit hedge-filled with correct fields', async () => {
      const filledEvents = [];
      executor.on('hedge-filled', (e) => filledEvents.push(e));

      await executor.executeHedge('sell', 0.5);

      expect(filledEvents.length).toBe(1);
      const e = filledEvents[0];
      expect(e.side).toBe('sell');
      expect(e.size).toBe(1.0); // from vol_exec
      expect(e.price).toBe(99960); // from price
      expect(e.orderId).toBe('OXXXXX-XXXXX-XXXXXX');
      expect(typeof e.slippage).toBe('number');
    });
  });

  describe('slippage calculation', () => {
    it('should calculate negative slippage for sell filled below expected', async () => {
      // bestBid = 100000, offset = 5bps => limit = 99950
      // fill price = 99960 (from mock) => slippage = 99960 - 99950 = +10
      const filledEvents = [];
      executor.on('hedge-filled', (e) => filledEvents.push(e));

      await executor.executeHedge('sell', 0.5);

      const slippage = filledEvents[0].slippage;
      // fillPrice(99960) - expectedPrice(99950) = +10 (positive = better than expected for sell)
      expect(slippage).toBeCloseTo(10, 0);
    });

    it('should calculate slippage for buy correctly', async () => {
      // bestAsk = 100050, offset = 5bps => limit = 100050 * 1.0005 = 100100.025
      // mock fill price = 99960
      mockKraken.queryOrders = mock(() => Promise.resolve({
        'OXXXXX-XXXXX-XXXXXX': {
          status: 'closed',
          vol_exec: '0.5',
          price: '100060',
        },
      }));

      const filledEvents = [];
      executor.on('hedge-filled', (e) => filledEvents.push(e));

      await executor.executeHedge('buy', 0.5);

      const expectedLimitPrice = 100050 * (1 + 5 / 10000);
      const fillPrice = 100060;
      // For buy: expectedPrice - fillPrice = positive if better
      const expectedSlippage = expectedLimitPrice - fillPrice;
      expect(filledEvents[0].slippage).toBeCloseTo(expectedSlippage, 2);
    });
  });

  describe('stats tracking', () => {
    it('should increment totalHedges and totalHedgedBTC on fill', async () => {
      await executor.executeHedge('sell', 0.5);

      const stats = executor.getHedgeStats();
      expect(stats.totalHedges).toBe(1);
      expect(stats.totalHedgedBTC).toBe(1.0); // vol_exec from mock
      expect(stats.limitFills).toBe(1);
      expect(stats.marketFills).toBe(0);
    });

    it('should accumulate stats across multiple hedges', async () => {
      await executor.executeHedge('sell', 0.5);
      await executor.executeHedge('buy', 0.3);

      const stats = executor.getHedgeStats();
      expect(stats.totalHedges).toBe(2);
      expect(stats.totalHedgedBTC).toBe(2.0); // 1.0 + 1.0 from mock vol_exec
      expect(stats.limitFills).toBe(2);
    });

    it('should track failed hedges', async () => {
      // No hedge-failed stat incremented on validation failures (before isHedging)
      // but Kraken API error should increment it
      mockKraken.addOrder = mock(() => Promise.reject(new Error('Kraken down')));

      await executor.executeHedge('sell', 0.5);

      const stats = executor.getHedgeStats();
      expect(stats.failedHedges).toBe(1);
      expect(stats.totalHedges).toBe(0);
    });

    it('should compute average slippage', async () => {
      // Two fills with known slippage
      await executor.executeHedge('sell', 0.5);
      await executor.executeHedge('sell', 0.5);

      const stats = executor.getHedgeStats();
      expect(stats.avgSlippage).toBeDefined();
      expect(typeof stats.avgSlippage).toBe('number');
    });

    it('should compute limitFillRate correctly', async () => {
      await executor.executeHedge('sell', 0.5); // limit fill

      const stats = executor.getHedgeStats();
      expect(stats.limitFillRate).toBe(1.0); // 100% limit fills
    });
  });

  describe('cancelHedge', () => {
    it('should call krakenClient.cancelOrder and emit cancelled event', async () => {
      const events = [];
      executor.on('hedge-cancelled', (e) => events.push(e));

      await executor.cancelHedge('OTEST-12345-ABCDEF');

      expect(mockKraken.cancelOrder).toHaveBeenCalledTimes(1);
      expect(mockKraken.cancelOrder.mock.calls[0][0]).toEqual({ txid: 'OTEST-12345-ABCDEF' });
      expect(events.length).toBe(1);
      expect(events[0].orderId).toBe('OTEST-12345-ABCDEF');
    });
  });

  describe('Kraken API error handling', () => {
    it('should emit hedge-failed and reset isHedging on addOrder error', async () => {
      mockKraken.addOrder = mock(() => Promise.reject(new Error('Insufficient funds')));

      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      const result = await executor.executeHedge('sell', 0.5);

      expect(result).toBeNull();
      expect(events.length).toBe(1);
      expect(events[0].error).toBe('Insufficient funds');
      expect(events[0].side).toBe('sell');

      // isHedging should be reset
      expect(executor.isHedging).toBe(false);
    });

    it('should allow new hedge after previous one failed', async () => {
      mockKraken.addOrder = mock(() => Promise.reject(new Error('Temporary error')));
      await executor.executeHedge('sell', 0.5);

      // Reset mock to succeed
      mockKraken.addOrder = mock(() => Promise.resolve({
        txid: ['ONEW-XXXXX-XXXXXX'],
        descr: { order: 'sell 0.5 XBTUSD @ limit 99950' },
      }));
      mockKraken.queryOrders = mock(() => Promise.resolve({
        'ONEW-XXXXX-XXXXXX': { status: 'closed', vol_exec: '0.5', price: '99960' },
      }));

      const result = await executor.executeHedge('sell', 0.5);
      expect(result).not.toBeNull();
      expect(result.orderId).toBe('ONEW-XXXXX-XXXXXX');
    });
  });

  describe('getHedgePosition', () => {
    it('should return empty when no open hedges', () => {
      const pos = executor.getHedgePosition();
      expect(pos.openOrders).toEqual([]);
      expect(pos.totalPendingSize).toBe(0);
      expect(pos.lastHedgeAt).toBeNull();
    });

    it('should reflect open hedges added manually', () => {
      executor.openHedges.set('ORDER-1', {
        side: 'sell',
        size: 0.5,
        price: 99950,
        placedAt: 1000,
        status: 'open',
      });
      executor.openHedges.set('ORDER-2', {
        side: 'buy',
        size: 0.3,
        price: 100100,
        placedAt: 2000,
        status: 'open',
      });

      const pos = executor.getHedgePosition();
      expect(pos.openOrders.length).toBe(2);
      expect(pos.totalPendingSize).toBeCloseTo(0.8, 8);
      expect(pos.lastHedgeAt).toBe(2000);
    });
  });

  describe('getHedgeStats', () => {
    it('should return zero stats initially', () => {
      const stats = executor.getHedgeStats();
      expect(stats.totalHedges).toBe(0);
      expect(stats.totalHedgedBTC).toBe(0);
      expect(stats.avgSlippage).toBe(0);
      expect(stats.limitFillRate).toBe(0);
      expect(stats.failedHedges).toBe(0);
    });
  });

  describe('market urgency', () => {
    it('should skip limit and go straight to market on urgency=urgent', async () => {
      const events = [];
      executor.on('hedge-placed', (e) => events.push(e));

      // queryOrders must handle the market order txid
      mockKraken.queryOrders = mock(() => Promise.resolve({
        'OXXXXX-XXXXX-XXXXXX': { status: 'closed', vol_exec: '0.5', price: '99940' },
      }));

      const result = await executor.executeHedge('sell', 0.5, 'urgent');

      expect(result).not.toBeNull();

      // Should have placed only 1 order (market, not limit)
      expect(mockKraken.addOrder).toHaveBeenCalledTimes(1);
      const callArgs = mockKraken.addOrder.mock.calls[0][0];
      expect(callArgs.ordertype).toBe('market');
      expect(callArgs.price).toBeUndefined();

      // Event should show type=market
      expect(events[0].type).toBe('market');

      // Stats should show market fill
      const stats = executor.getHedgeStats();
      expect(stats.marketFills).toBe(1);
      expect(stats.limitFills).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should reject zero size', async () => {
      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      const result = await executor.executeHedge('sell', 0);

      expect(result).toBeNull();
      expect(mockKraken.addOrder).not.toHaveBeenCalled();
    });

    it('should reject negative size', async () => {
      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      const result = await executor.executeHedge('sell', -1);

      expect(result).toBeNull();
      expect(mockKraken.addOrder).not.toHaveBeenCalled();
    });

    it('should reject invalid side', async () => {
      const events = [];
      executor.on('hedge-failed', (e) => events.push(e));

      const result = await executor.executeHedge('hold', 0.5);

      expect(result).toBeNull();
      expect(mockKraken.addOrder).not.toHaveBeenCalled();
      expect(events[0].error).toBe('Invalid side');
    });

    it('should reject null side', async () => {
      const result = await executor.executeHedge(null, 0.5);
      expect(result).toBeNull();
    });

    it('should handle missing price aggregator', async () => {
      const noAggregator = new HedgeExecutor({
        krakenClient: mockKraken,
        logger: silentLogger,
        limitTimeoutMs: 50,
        pollIntervalMs: 10,
      });

      const events = [];
      noAggregator.on('hedge-failed', (e) => events.push(e));

      const result = await noAggregator.executeHedge('sell', 0.5);

      expect(result).toBeNull();
      expect(events.length).toBe(1);
      expect(events[0].error).toContain('No price source');
    });
  });

  describe('checkHedgeStatus', () => {
    it('should return parsed order status from Kraken', async () => {
      mockKraken.queryOrders = mock(() => Promise.resolve({
        'OTEST-ID': { status: 'closed', vol_exec: '0.75', price: '100010' },
      }));

      const status = await executor.checkHedgeStatus('OTEST-ID');
      expect(status.status).toBe('closed');
      expect(status.filledSize).toBe('0.75');
      expect(status.avgPrice).toBe('100010');
    });

    it('should return unknown for missing order', async () => {
      mockKraken.queryOrders = mock(() => Promise.resolve({}));

      const status = await executor.checkHedgeStatus('ONOTEXIST');
      expect(status.status).toBe('unknown');
      expect(status.filledSize).toBe('0');
    });
  });

  describe('hedgeHistory', () => {
    it('should record completed hedges in history', async () => {
      await executor.executeHedge('sell', 0.5);

      expect(executor.hedgeHistory.length).toBe(1);
      const entry = executor.hedgeHistory[0];
      expect(entry.side).toBe('sell');
      expect(entry.orderId).toBe('OXXXXX-XXXXX-XXXXXX');
      expect(entry.type).toBe('limit');
      expect(entry.filledAt).toBeDefined();
    });
  });

  describe('placeLimitOrder', () => {
    it('should call krakenClient.addOrder with limit params', async () => {
      await executor.placeLimitOrder('sell', 0.5, 99950);

      expect(mockKraken.addOrder).toHaveBeenCalledTimes(1);
      const args = mockKraken.addOrder.mock.calls[0][0];
      expect(args.pair).toBe('XBTUSD');
      expect(args.type).toBe('sell');
      expect(args.ordertype).toBe('limit');
      expect(args.price).toBe('99950');
      expect(args.volume).toBe('0.5');
    });
  });

  describe('placeMarketOrder', () => {
    it('should call krakenClient.addOrder with market params (no price)', async () => {
      await executor.placeMarketOrder('buy', 0.3);

      expect(mockKraken.addOrder).toHaveBeenCalledTimes(1);
      const args = mockKraken.addOrder.mock.calls[0][0];
      expect(args.pair).toBe('XBTUSD');
      expect(args.type).toBe('buy');
      expect(args.ordertype).toBe('market');
      expect(args.volume).toBe('0.3');
      expect(args.price).toBeUndefined();
    });
  });
});
