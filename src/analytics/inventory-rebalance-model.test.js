import { describe, expect, it } from 'bun:test';
import {
  buildInventoryRebalanceCurve,
  evaluateInventoryRebalance,
  validateInventoryRebalanceConfig,
} from './inventory-rebalance-model.js';

const config = Object.freeze({
  targetInventoryBTC: 0.04,
  inventorySigmaBTC: 0.01,
  centerBandSigma: 0.5,
  softHedgeBandSigma: 2,
  hardHedgeBandSigma: 3,
  minimumMakerParticipation: 0.25,
  maxQuoteSkewBps: 10,
  maxSizeAsymmetry: 0.75,
});

describe('inventory rebalance bell model', () => {
  it('is pure trading at the target with symmetric quotes and no hedge', () => {
    const point = evaluateInventoryRebalance(0.04, config);
    expect(point.zone).toBe('trade');
    expect(point.tradingWeight).toBe(1);
    expect(point.rebalancingWeight).toBe(0);
    expect(point.quote).toEqual({
      bidSkewBps: 0,
      askSkewBps: -0,
      bidSizeMultiplier: 1,
      askSizeMultiplier: 1,
    });
    expect(point.hedge).toMatchObject({ intensity: 0, side: null, quantityBTC: 0 });
  });

  it('produces mirror-symmetric control pressure around the target', () => {
    const below = evaluateInventoryRebalance(0.03, config);
    const above = evaluateInventoryRebalance(0.05, config);
    expect(below.tradingWeight).toBeCloseTo(above.tradingWeight, 12);
    expect(below.quote.bidSkewBps).toBeCloseTo(-above.quote.bidSkewBps, 12);
    expect(below.quote.askSkewBps).toBeCloseTo(-above.quote.askSkewBps, 12);
    expect(below.quote.bidSizeMultiplier).toBeCloseTo(above.quote.askSizeMultiplier, 12);
    expect(below.quote.askSizeMultiplier).toBeCloseTo(above.quote.bidSizeMultiplier, 12);
    expect(below.zone).toBe(above.zone);
  });

  it('encourages the side that returns inventory toward target', () => {
    const below = evaluateInventoryRebalance(0.03, config);
    expect(below.quote.bidSkewBps).toBeLessThan(0);
    expect(below.quote.askSkewBps).toBeGreaterThan(0);
    expect(below.quote.bidSizeMultiplier).toBeGreaterThan(below.quote.askSizeMultiplier);
    expect(below.quote.askSizeMultiplier).toBeLessThan(1);

    const above = evaluateInventoryRebalance(0.05, config);
    expect(above.quote.bidSkewBps).toBeGreaterThan(0);
    expect(above.quote.askSkewBps).toBeLessThan(0);
    expect(above.quote.bidSizeMultiplier).toBeLessThan(1);
    expect(above.quote.askSizeMultiplier).toBeGreaterThan(above.quote.bidSizeMultiplier);
  });

  it('keeps a maker participation floor in extreme tails', () => {
    const point = evaluateInventoryRebalance(1, config);
    expect(point.makerParticipation).toBeCloseTo(config.minimumMakerParticipation, 12);
    expect(point.quote.bidSizeMultiplier).toBeCloseTo(0.25, 12);
    expect(point.quote.askSizeMultiplier).toBeCloseTo(0.4375, 12);
  });

  it('starts external hedging only outside two sigma and reaches full intensity at three', () => {
    const atSoftBand = evaluateInventoryRebalance(0.06, config);
    const halfway = evaluateInventoryRebalance(0.065, config);
    const atHardBand = evaluateInventoryRebalance(0.07, config);
    expect(atSoftBand.hedge.intensity).toBe(0);
    expect(atSoftBand.hedge.quantityBTC).toBe(0);
    expect(atSoftBand.zone).toBe('external-rebalance');
    expect(halfway.hedge.intensity).toBeCloseTo(0.5, 12);
    expect(halfway.hedge.side).toBe('sell');
    expect(atHardBand.hedge.intensity).toBe(1);
    expect(atHardBand.hedge.quantityBTC).toBeCloseTo(0.01, 12);
    expect(atHardBand.hedge.returnsToInventoryBTC).toBeCloseTo(0.06, 12);
  });

  it('builds an inclusive, ordered curve', () => {
    const curve = buildInventoryRebalanceCurve(config, { minSigma: -3, maxSigma: 3, stepSigma: 0.5 });
    expect(curve).toHaveLength(13);
    expect(curve[0].zScore).toBeCloseTo(-3, 12);
    expect(curve.at(-1).zScore).toBeCloseTo(3, 12);
    expect(curve.map(point => point.inventoryBTC)).toEqual(
      [...curve].map(point => point.inventoryBTC).sort((a, b) => a - b),
    );
  });

  it('rejects shapes that could silently invert policy bands', () => {
    expect(() => validateInventoryRebalanceConfig({ ...config, inventorySigmaBTC: 0 }))
      .toThrow('inventorySigmaBTC must be positive');
    expect(() => validateInventoryRebalanceConfig({ ...config, softHedgeBandSigma: 3 }))
      .toThrow('softHedgeBandSigma must be below hardHedgeBandSigma');
    expect(() => validateInventoryRebalanceConfig({ ...config, maxSizeAsymmetry: 1.1 }))
      .toThrow('maxSizeAsymmetry must be between 0 and 1');
  });
});
