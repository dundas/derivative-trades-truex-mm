import { describe, expect, test } from 'bun:test';
import { buildContinuityConfig } from './continuity-config.js';

const VALID = {
  MM_MIN_ACTIVE_LEVELS_PER_SIDE: '1',
  MM_MIN_FUNDED_QUOTE_SIZE_BTC: '0.0001',
  MM_L1_RESERVE_BASE_BTC: '0.01',
  MM_L1_RESERVE_QUOTE_PYUSD: '1000',
  MM_MAX_SIDE_GAP_MS: '5000',
  MM_SIDE_GAP_ALERT_THRESHOLD_MS: '3000',
  MM_SIDE_GAP_ALERT_RATE_LIMIT_MS: '60000',
  MM_DEGRADED_MAX_LEVELS: '1',
  MM_DEGRADED_SIZE_FACTOR: '0.5',
  MM_DEFENSIVE_SPREAD_FLOOR_BPS: '80',
};

describe('production continuity config', () => {
  test('requires every deployment obligation and returns a validated immutable config', () => {
    const config = buildContinuityConfig(VALID, { levels: 2, baseSizeBTC: 0.01, baseSpreadBps: 50 });
    expect(config).toEqual({
      minActiveLevelsPerSide: 1,
      minimumFundedQuoteSize: 0.0001,
      l1ReserveBase: 0.01,
      l1ReserveQuote: 1000,
      maxSideGapMs: 5000,
      alertThresholdMs: 3000,
      alertRateLimitMs: 60000,
      degradedMaxLevels: 1,
      degradedSizeFactor: 0.5,
      defensiveSpreadFloorBps: 80,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('fails closed for absent, ambiguous, or contradictory values', () => {
    expect(() => buildContinuityConfig({}, { levels: 2, baseSizeBTC: 0.01, baseSpreadBps: 50 })).toThrow('MM_MIN_ACTIVE_LEVELS_PER_SIDE is required');
    expect(() => buildContinuityConfig({ ...VALID, MM_L1_RESERVE_BASE_BTC: 'NaN' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_MIN_ACTIVE_LEVELS_PER_SIDE: '3' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_SIDE_GAP_ALERT_THRESHOLD_MS: '6000' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEGRADED_MAX_LEVELS: '1.5' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEGRADED_SIZE_FACTOR: '1.1' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEFENSIVE_SPREAD_FLOOR_BPS: '0' }, { levels: 2 })).toThrow();
    expect(() => buildContinuityConfig(VALID, { levels: 2, baseSizeBTC: 0.0001, baseSpreadBps: 50 })).toThrow('scaled L1');
    expect(() => buildContinuityConfig(VALID, { levels: 1, baseSizeBTC: 0.01, baseSpreadBps: 50 })).toThrow('below normal');
    expect(() => buildContinuityConfig(VALID, { levels: 2, baseSizeBTC: 0.01, baseSpreadBps: 100 })).toThrow('above normal');
  });
});
