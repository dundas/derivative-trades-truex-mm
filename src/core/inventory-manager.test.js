import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { InventoryManager } from './inventory-manager.js';

function makeIM(opts = {}) {
  return new InventoryManager({
    maxPositionBTC: 1.0,
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// getAvailableForSide — transferHold behaviour
// ---------------------------------------------------------------------------

describe('InventoryManager.getAvailableForSide — transferHold', () => {
  let im;

  beforeEach(() => {
    im = makeIM();
  });

  it('returns total - transferHold for buy side when transferHold > 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 80, held: 20, total: 100, transferHold: 5 },
    });
    // total=100, transferHold=5 → 95
    expect(im.getAvailableForSide('buy')).toBe(95);
  });

  it('returns total when transferHold is 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 100, held: 0, total: 100, transferHold: 0 },
    });
    expect(im.getAvailableForSide('buy')).toBe(100);
  });

  it('returns total when transferHold is absent', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    expect(im.getAvailableForSide('buy')).toBe(100);
  });

  it('returns total - transferHold for sell side when transferHold > 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.03, held: 0.01, total: 0.04, transferHold: 0.005 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    // total=0.04, transferHold=0.005 → 0.035
    expect(im.getAvailableForSide('sell')).toBeCloseTo(0.035, 8);
  });

  it('returns total when sell-side transferHold is 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.04, held: 0, total: 0.04, transferHold: 0 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    expect(im.getAvailableForSide('sell')).toBe(0.04);
  });

  it('returns total when sell-side transferHold is absent', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.04, held: 0, total: 0.04 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    expect(im.getAvailableForSide('sell')).toBe(0.04);
  });
});

// ---------------------------------------------------------------------------
// canQuote — transferHold integration
// ---------------------------------------------------------------------------

describe('InventoryManager.canQuote — transferHold integration', () => {
  let im;

  beforeEach(() => {
    im = makeIM();
  });

  it('returns false for buy when total - transferHold <= 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 0, held: 100, total: 100, transferHold: 100 },
    });
    expect(im.canQuote('buy')).toBe(false);
  });

  it('returns true for buy when total - transferHold > 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 0, held: 90, total: 100, transferHold: 5 },
    });
    // total(100) - transferHold(5) = 95 > 0
    expect(im.canQuote('buy')).toBe(true);
  });

  it('returns false for buy when total - transferHold is exactly 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 0, held: 50, total: 50, transferHold: 50 },
    });
    expect(im.canQuote('buy')).toBe(false);
  });

  it('returns false for sell when total - transferHold <= 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0, held: 0, total: 0.044, transferHold: 0.044 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    expect(im.canQuote('sell')).toBe(false);
  });

  it('returns true for sell when total - transferHold > 0', () => {
    im.initializeFromBalances({
      baseBalance: { available: 0, held: 0.03, total: 0.044, transferHold: 0.005 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    // total(0.044) - transferHold(0.005) = 0.039 > 0
    expect(im.canQuote('sell')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transferHold stored on quoteBalance and baseBalance
// ---------------------------------------------------------------------------

describe('InventoryManager — transferHold stored on balances', () => {
  it('initializeFromBalances preserves transferHold on quoteBalance', () => {
    const im = makeIM();
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044, transferHold: 0 },
      quoteBalance: { available: 80, held: 20, total: 100, transferHold: 7 },
    });
    expect(im.quoteBalance.transferHold).toBe(7);
  });

  it('initializeFromBalances preserves transferHold on baseBalance', () => {
    const im = makeIM();
    im.initializeFromBalances({
      baseBalance: { available: 0.03, held: 0.01, total: 0.04, transferHold: 0.005 },
      quoteBalance: { available: 100, held: 0, total: 100, transferHold: 0 },
    });
    expect(im.baseBalance.transferHold).toBe(0.005);
  });

  it('refreshBalances preserves transferHold on quoteBalance', () => {
    const im = makeIM();
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 100, held: 0, total: 100 },
    });
    im.refreshBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044, transferHold: 0 },
      quoteBalance: { available: 80, held: 20, total: 100, transferHold: 12 },
    });
    expect(im.quoteBalance.transferHold).toBe(12);
    expect(im.getAvailableForSide('buy')).toBe(88); // 100 - 12
  });
});

// ---------------------------------------------------------------------------
// fill-time total synchronisation
// ---------------------------------------------------------------------------

describe('InventoryManager — total kept in sync with fills', () => {
  let im;

  beforeEach(() => {
    im = makeIM();
    im.initializeFromBalances({
      baseBalance: { available: 0.044, held: 0, total: 0.044 },
      quoteBalance: { available: 1000, held: 0, total: 1000 },
    });
  });

  it('buy fill decreases quoteBalance.total and increases baseBalance.total', () => {
    im.onFill({ side: 'buy', quantity: 0.01, price: 70000, venue: 'truex', execID: 'e1' });
    // PYUSD spent = 700, BTC received = 0.01
    expect(im.quoteBalance.total).toBeCloseTo(300, 2);
    expect(im.baseBalance.total).toBeCloseTo(0.054, 8);
  });

  it('sell fill decreases baseBalance.total and increases quoteBalance.total', () => {
    im.onFill({ side: 'sell', quantity: 0.01, price: 70000, venue: 'truex', execID: 'e2' });
    // BTC sold = 0.01, PYUSD received = 700
    expect(im.baseBalance.total).toBeCloseTo(0.034, 8);
    expect(im.quoteBalance.total).toBeCloseTo(1700, 2);
  });

  it('getAvailableForSide reflects updated total immediately after fill', () => {
    im.onFill({ side: 'buy', quantity: 0.01, price: 70000, venue: 'truex', execID: 'e3' });
    // total went from 1000 → 300; getAvailableForSide('buy') = total - transferHold = 300
    expect(im.getAvailableForSide('buy')).toBeCloseTo(300, 2);
  });
});
