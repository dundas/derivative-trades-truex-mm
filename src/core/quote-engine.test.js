import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { QuoteEngine } from './quote-engine.js';

/**
 * Minimal InventoryManager stub for QuoteEngine tests.
 */
function makeInventoryManager(overrides = {}) {
  return {
    balancesInitialized: true,
    canQuote: jest.fn(() => true),
    getAvailableForSide: jest.fn((side) => {
      if (side === 'buy') return overrides.quoteAvailable ?? 1000;
      if (side === 'sell') return overrides.baseAvailable ?? 1.0;
      return 0;
    }),
    getSkew: jest.fn(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
    ...overrides,
  };
}

function makeQuoteEngine(inventoryManagerOverrides = {}, configOverrides = {}) {
  const fixConnection = { sendMessage: jest.fn().mockResolvedValue(true) };
  return new QuoteEngine({
    inventoryManager: makeInventoryManager(inventoryManagerOverrides),
    fixConnection,
    sizeDecimalPlaces: 4,
    baseSizeBTC: 0.01,
    levels: 3,
    baseSpreadBps: 80,
    tickSize: 0.5,
    minNotional: 1.0,
    sizeDecayFactor: 1.0,
    levelSpacingTicks: 1,
    ...configOverrides,
  });
}

// ---------------------------------------------------------------------------
// _capSizeToBalance — floor rounding
// ---------------------------------------------------------------------------

describe('QuoteEngine._capSizeToBalance — floor rounding', () => {
  let engine;

  beforeEach(() => {
    // Available: 284.25 PYUSD (buy side), price = 71636.56
    // 284.25 / 71636.56 = 0.003969... → toFixed(4) rounds UP to 0.0040 → WRONG
    // floor rounding → 0.0039 → CORRECT
    engine = makeQuoteEngine({ quoteAvailable: 284.25 });
  });

  it('floors rather than rounds when converting balance to size', () => {
    // 284.25 / 71636.56 = 0.003969...
    // toFixed(4) would give 0.0040 (rounds up)
    // floor must give 0.0039
    const result = engine._capSizeToBalance('buy', 1.0, 71636.56, 0);
    expect(result).toBe(0.0039);
  });

  it('does not round 0.003969 up to 0.0040 (regression guard)', () => {
    const result = engine._capSizeToBalance('buy', 1.0, 71636.56, 0);
    expect(result).not.toBe(0.004);
  });

  it('correctly floors a value that is already at an exact boundary', () => {
    // 100 / 10000 = 0.0100 exactly — should remain 0.0100
    engine = makeQuoteEngine({ quoteAvailable: 100 });
    const result = engine._capSizeToBalance('buy', 1.0, 10000, 0);
    expect(result).toBe(0.01);
  });

  it('returns 0 when remaining balance is 0', () => {
    engine = makeQuoteEngine({ quoteAvailable: 0 });
    const result = engine._capSizeToBalance('buy', 0.01, 71636.56, 0);
    expect(result).toBe(0);
  });

  it('caps size to desiredSize when balance is ample', () => {
    // 10000 / 71636.56 >> 0.0039; desired 0.0039 should return 0.0039
    engine = makeQuoteEngine({ quoteAvailable: 10000 });
    const result = engine._capSizeToBalance('buy', 0.0039, 71636.56, 0);
    expect(result).toBe(0.0039);
  });

  it('floors sell-side size correctly', () => {
    // available 0.003969 BTC, no committed, desired large → floors to 0.0039
    engine = makeQuoteEngine({ baseAvailable: 0.003969 });
    const result = engine._capSizeToBalance('sell', 1.0, 71636.56, 0);
    expect(result).toBe(0.0039);
  });
});
