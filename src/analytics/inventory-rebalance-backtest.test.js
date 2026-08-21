import { describe, expect, it } from 'bun:test';
import { backtestInventoryRebalancing, inferStartingBalances } from './inventory-rebalance-backtest.js';

const policy = {
  targetInventoryBTC: 1,
  inventorySigmaBTC: 0.25,
  centerBandSigma: 0.5,
  softHedgeBandSigma: 2,
  hardHedgeBandSigma: 3,
  minimumMakerParticipation: 0.25,
  maxQuoteSkewBps: 10,
  maxSizeAsymmetry: 0.75,
};

const fills = [
  { id: 'b1', orderId: 'buy-order', timestamp: 1, side: 'buy', price: 100, quantity: 0.2, orderSize: 0.4 },
  { id: 's1', orderId: 'sell-order', timestamp: 2, side: 'sell', price: 102, quantity: 0.1, orderSize: 0.4 },
];

describe('inventory rebalance fill-opportunity backtest', () => {
  it('infers starting balances and exactly reconstructs the supplied ending balances', () => {
    const start = inferStartingBalances(fills, { btc: 0.6, quote: 990.2 });
    expect(start.btc).toBeCloseTo(0.5, 12);
    expect(start.quote).toBeCloseTo(1000, 12);
    const result = backtestInventoryRebalancing({
      fills,
      endingBalances: { btc: 0.6, quote: 990.2 },
      policy,
      initialMarkPrice: 100,
      finalMarkPrice: 110,
    });
    expect(result.actual.endingBalances.btc).toBeCloseTo(0.6, 12);
    expect(result.actual.endingBalances.quote).toBeCloseTo(990.2, 12);
  });

  it('keeps below-target buys and rejects less-aggressive sells in strict survival mode', () => {
    const result = backtestInventoryRebalancing({
      fills,
      endingBalances: { btc: 0.6, quote: 990.2 },
      policy,
      initialMarkPrice: 100,
      finalMarkPrice: 110,
    });
    expect(result.strictFillSurvival.buyQuantityBTC).toBeGreaterThan(0);
    expect(result.strictFillSurvival.sellQuantityBTC).toBe(0);
    expect(result.strictFillSurvival.skippedFragments).toBe(1);
  });

  it('replays both sides under the same-opportunity assumption without inventing taker size', () => {
    const result = backtestInventoryRebalancing({
      fills,
      endingBalances: { btc: 0.6, quote: 990.2 },
      policy,
      initialMarkPrice: 100,
      finalMarkPrice: 110,
    });
    expect(result.sameOpportunity.buyQuantityBTC).toBeLessThanOrEqual(0.2);
    expect(result.sameOpportunity.sellQuantityBTC).toBeLessThanOrEqual(0.1);
    expect(result.sameOpportunity.fillQuantityBTC).toBeCloseTo(0.3, 12);
  });

  it('caps counterfactual buys at available quote capital', () => {
    const tiny = [{ id: 'b', orderId: 'b', timestamp: 1, side: 'buy', price: 100, quantity: 2, orderSize: 10 }];
    const result = backtestInventoryRebalancing({
      fills: tiny,
      endingBalances: { btc: 2, quote: 0 },
      policy: { ...policy, targetInventoryBTC: 10 },
      initialMarkPrice: 100,
      finalMarkPrice: 100,
    });
    expect(result.sameOpportunity.endingBalances.quote).toBeGreaterThanOrEqual(-1e-9);
    expect(result.sameOpportunity.capitalLimitedQuantityBTC).toBeGreaterThan(0);
  });

  it('rejects duplicate evidence and impossible balance inference', () => {
    expect(() => inferStartingBalances([{ ...fills[0] }, { ...fills[0] }], { btc: 1, quote: 1 }))
      .toThrow('duplicate fill id');
    expect(() => inferStartingBalances(fills, { btc: 0, quote: 0 }))
      .toThrow('inferred starting balances are negative');
  });
});
