import { describe, expect, test } from 'bun:test';
import { AdaptiveSpreadPolicy } from './adaptive-spread-policy.js';

const config = {
  baseFloorBps: 4,
  maxFloorBps: 20,
  maxFeedAgeMs: 1_000,
  maxAdverseSelectionAgeMs: 2_000,
  maxInventoryRiskAgeMs: 3_000,
  volatilityMultiplier: 0.5,
  maxVolatilityContributionBps: 6,
  adverseSelectionMultiplier: 1,
  maxAdverseSelectionContributionBps: 5,
  inventoryRiskMultiplier: 1,
  maxInventoryRiskContributionBps: 7,
};

function validInput(overrides = {}) {
  return {
    referenceFeed: { fresh: true, ageMs: 100 },
    volatilityBps: 8,
    adverseSelectionBySide: { buy: { bps: 1, ageMs: 20 }, sell: { bps: 3, ageMs: 30 } },
    inventoryRiskBySide: { buy: { bps: 2, ageMs: 20 }, sell: { bps: 4, ageMs: 30 } },
    ...overrides,
  };
}

describe('AdaptiveSpreadPolicy', () => {
  test('produces bounded side-specific shadow recommendations from complete fresh evidence', () => {
    const result = new AdaptiveSpreadPolicy(config).evaluate(validInput());
    expect(result).toMatchObject({
      status: 'available',
      floorBySideBps: { buy: 11, sell: 15 },
      componentsBySideBps: {
        buy: { baseFloorBps: 4, volatilityBps: 4, adverseSelectionBps: 1, inventoryRiskBps: 2 },
        sell: { baseFloorBps: 4, volatilityBps: 4, adverseSelectionBps: 3, inventoryRiskBps: 4 },
      },
    });
  });

  test('is monotonic in each adverse-selection and inventory-risk side contribution', () => {
    const policy = new AdaptiveSpreadPolicy(config);
    const baseline = policy.evaluate(validInput());
    const widerBuy = policy.evaluate(validInput({
      adverseSelectionBySide: { buy: { bps: 4, ageMs: 20 }, sell: { bps: 3, ageMs: 30 } },
      inventoryRiskBySide: { buy: { bps: 5, ageMs: 20 }, sell: { bps: 4, ageMs: 30 } },
    }));
    expect(widerBuy.floorBySideBps.buy).toBeGreaterThan(baseline.floorBySideBps.buy);
    expect(widerBuy.floorBySideBps.sell).toBe(baseline.floorBySideBps.sell);
  });

  test('caps every contribution and the resulting floor, without rewarding negative risk inputs', () => {
    const result = new AdaptiveSpreadPolicy(config).evaluate(validInput({
      volatilityBps: 1_000,
      adverseSelectionBySide: { buy: { bps: 1_000, ageMs: 20 }, sell: { bps: 5, ageMs: 30 } },
      inventoryRiskBySide: { buy: { bps: 1_000, ageMs: 20 }, sell: { bps: 2, ageMs: 30 } },
    }));
    expect(result.floorBySideBps).toEqual({ buy: 20, sell: 17 });
    expect(result.componentsBySideBps.sell).toMatchObject({ adverseSelectionBps: 5, inventoryRiskBps: 2 });
  });

  test('returns explicit unavailable instead of a neutral floor for missing or stale evidence', () => {
    const policy = new AdaptiveSpreadPolicy(config);
    expect(policy.evaluate(validInput({ referenceFeed: { fresh: false, ageMs: 10 } }))).toMatchObject({
      status: 'unavailable', reason: 'reference-feed-unavailable', recommendedAction: 'hold', floorBySideBps: null,
    });
    expect(policy.evaluate(validInput({ referenceFeed: { fresh: true, ageMs: 1_001 } }))).toMatchObject({
      status: 'unavailable', reason: 'reference-feed-stale', floorBySideBps: null,
    });
    expect(policy.evaluate(validInput({ adverseSelectionBySide: { buy: { bps: 1, ageMs: 1 } } }))).toMatchObject({
      status: 'unavailable', reason: 'side-risk-unavailable', floorBySideBps: null,
    });
  });

  test('holds rather than treating stale or corrupt side-risk samples as neutral', () => {
    const policy = new AdaptiveSpreadPolicy(config);
    expect(policy.evaluate(validInput({
      adverseSelectionBySide: { buy: { bps: 1, ageMs: 2_001 }, sell: { bps: 3, ageMs: 30 } },
    }))).toMatchObject({ status: 'unavailable', reason: 'adverse-selection-stale', recommendedAction: 'hold' });
    expect(policy.evaluate(validInput({
      inventoryRiskBySide: { buy: { bps: -1, ageMs: 20 }, sell: { bps: 4, ageMs: 30 } },
    }))).toMatchObject({ status: 'unavailable', reason: 'side-risk-invalid', recommendedAction: 'hold' });
  });

  test('rejects impossible or malformed configuration', () => {
    expect(() => new AdaptiveSpreadPolicy({ ...config, maxFloorBps: 3 })).toThrow('maxFloorBps');
    expect(() => new AdaptiveSpreadPolicy({ ...config, maxFeedAgeMs: -1 })).toThrow('maxFeedAgeMs');
    expect(() => new AdaptiveSpreadPolicy({ ...config, volatilityMultiplier: NaN })).toThrow('volatilityMultiplier');
    expect(() => new AdaptiveSpreadPolicy({ ...config, baseFloorBps: 0 })).toThrow('maxFloorBps');
    expect(() => new AdaptiveSpreadPolicy({ ...config, maxFloorBps: config.baseFloorBps })).toThrow('maxFloorBps');
    expect(() => new AdaptiveSpreadPolicy({ ...config, maxAdverseSelectionAgeMs: 0 })).toThrow('maxAdverseSelectionAgeMs');
    expect(() => new AdaptiveSpreadPolicy({ ...config, inventoryRiskMultiplier: 0 })).toThrow('inventoryRiskMultiplier');
    expect(() => new AdaptiveSpreadPolicy({ ...config, maxVolatilityContributionBps: 0 })).toThrow('maxVolatilityContributionBps');
  });

  test('treats an age exactly at each configured boundary as usable', () => {
    const result = new AdaptiveSpreadPolicy(config).evaluate(validInput({
      referenceFeed: { fresh: true, ageMs: config.maxFeedAgeMs },
      adverseSelectionBySide: {
        buy: { bps: 1, ageMs: config.maxAdverseSelectionAgeMs },
        sell: { bps: 3, ageMs: config.maxAdverseSelectionAgeMs },
      },
      inventoryRiskBySide: {
        buy: { bps: 2, ageMs: config.maxInventoryRiskAgeMs },
        sell: { bps: 4, ageMs: config.maxInventoryRiskAgeMs },
      },
    }));
    expect(result.status).toBe('available');
  });
});
