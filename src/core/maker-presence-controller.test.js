import { describe, expect, test } from 'bun:test';
import { MakerPresenceController, validateMakerPresenceConfig } from './maker-presence-controller.js';

const CONFIG = {
  minActiveLevelsPerSide: 1,
  minimumFundedQuoteSize: 0.005,
  l1ReserveBase: 0.005,
  l1ReserveQuote: 500,
  maxSideGapMs: 1000,
  alertThresholdMs: 500,
  alertRateLimitMs: 2000,
  degradedMaxLevels: 2,
  degradedSizeFactor: 0.5,
  defensiveSpreadFloorBps: 80,
};
const live = (side, state = 'active') => ({ side, level: 1, state, acknowledgedLive: true, remainingSize: 0.01 });

describe('maker presence configuration', () => {
  test('rejects absent, non-finite, fractional, and contradictory obligations', () => {
    expect(() => validateMakerPresenceConfig({})).toThrow();
    expect(() => validateMakerPresenceConfig({ ...CONFIG, minActiveLevelsPerSide: 1.5 })).toThrow();
    expect(() => validateMakerPresenceConfig({ ...CONFIG, l1ReserveQuote: Infinity })).toThrow();
    expect(() => validateMakerPresenceConfig({ ...CONFIG, l1ReserveBase: 0.001 })).toThrow();
  });
});

describe('MakerPresenceController', () => {
  test('counts only acknowledged venue-live orders, including cancel-in-flight', () => {
    const presence = new MakerPresenceController(CONFIG, { now: () => 100 });
    const status = presence.observe({
      orders: [live('buy'), live('sell', 'cancel-in-flight'), { side: 'sell', state: 'pending-new', acknowledgedLive: false }],
    });
    expect(status.activeLevels).toEqual({ buy: 1, sell: 1 });
    expect(status.present).toEqual({ buy: true, sell: true, twoSided: true });
    expect(status.executionState).toBe('normal');
  });

  test('tracks gap recovery, uptime, and rate-limited side alerts', () => {
    let now = 0;
    const presence = new MakerPresenceController(CONFIG, { now: () => now });
    presence.observe({ orders: [live('buy'), live('sell')] });
    now = 100;
    expect(presence.observe({ orders: [live('buy')] }).alerts).toEqual([]);
    now = 700;
    expect(presence.observe({ orders: [live('buy')] }).alerts).toEqual([
      { side: 'sell', gapDurationMs: 600, reason: 'missing-acknowledged-sell' },
    ]);
    now = 900;
    expect(presence.observe({ orders: [live('buy')] }).alerts).toEqual([]);
    now = 1200;
    const recovered = presence.observe({ orders: [live('buy'), live('sell')] });
    expect(recovered.gaps.sell).toMatchObject({ active: false, lastDurationMs: 1100, recoveries: 1 });
    expect(recovered.twoSidedUptimePct).toBeCloseTo((100 / 1200) * 100, 6);
  });

  test('fails unsafe when an acknowledged side gap reaches the configured maximum', () => {
    let now = 0;
    const presence = new MakerPresenceController(CONFIG, { now: () => now });
    expect(presence.observe({ orders: [live('buy')] }).executionState).toBe('degraded');

    now = CONFIG.maxSideGapMs;
    expect(presence.observe({ orders: [live('buy')] })).toMatchObject({
      executionState: 'unsafe',
      reasons: expect.arrayContaining([
        'missing-acknowledged-sell',
        'sell-side-gap-exceeded',
      ]),
    });
  });

  test('classifies healthy missing presence as degraded and safety failures as unsafe', () => {
    const presence = new MakerPresenceController(CONFIG, { now: () => 1000 });
    expect(presence.observe({ orders: [] })).toMatchObject({
      executionState: 'degraded',
      reasons: ['missing-acknowledged-buy', 'missing-acknowledged-sell'],
    });
    expect(presence.observe({ orders: [], oeHealthy: false }).reasons).toContain('order-entry-unhealthy');
    expect(presence.observe({ orders: [], referenceHealthy: false }).reasons).toContain('reference-unhealthy');
    expect(presence.observe({ orders: [], reconciliationState: 'failed', fundedSizeBySide: { buy: 0, sell: 0 } }).reasons).toContain('reconciliation-failed-no-safe-l1');
    expect(presence.observe({ orders: [], emergency: true }).reasons).toContain('emergency-kill-switch');
  });

  test('reports capital reconciliation degradation even with acknowledged L1 on both sides', () => {
    const controller = new MakerPresenceController(CONFIG, { now: () => 1000 });
    const orders = [
      { side: 'buy', level: 1, remainingSize: 0.01, acknowledgedLive: true },
      { side: 'sell', level: 1, remainingSize: 0.01, acknowledgedLive: true },
    ];
    expect(controller.observe({ orders, reconciliationState: 'degraded', blockedSides: ['sell'] })).toMatchObject({
      executionState: 'degraded', reasons: expect.arrayContaining(['capital-reconciliation-degraded', 'capital-side-blocked-sell']),
    });
    expect(controller.observe({ orders, reconciliationState: 'failed' })).toMatchObject({
      executionState: 'degraded',
      reasons: expect.arrayContaining(['capital-reconciliation-failed']),
    });
  });

  test('failed reconciliation is unsafe without an acknowledged funded safe L1', () => {
    const controller = new MakerPresenceController(CONFIG, { now: () => 1000 });
    const onlyDepth = [
      { side: 'buy', level: 2, remainingSize: 0.01, acknowledgedLive: true },
      { side: 'sell', level: 2, remainingSize: 0.01, acknowledgedLive: true },
    ];
    expect(controller.observe({
      orders: onlyDepth,
      reconciliationState: 'failed',
      fundedSizeBySide: { buy: 1, sell: 1 },
    })).toMatchObject({
      executionState: 'unsafe',
      reasons: expect.arrayContaining([
        'capital-reconciliation-failed', 'reconciliation-failed-no-safe-l1',
      ]),
    });
  });
});
