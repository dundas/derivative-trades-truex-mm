import { describe, expect, test } from 'bun:test';
import { buildContinuityConfig, buildMakerQuotePolicyConfig } from './continuity-config.js';

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
  MM_NORMAL_QUOTE_LEVELS: '2',
  MM_BASE_QUOTE_SIZE_BTC: '0.01',
  MM_FALLBACK_BASE_SPREAD_BPS: '30',
  MM_MIN_LIVE_QUOTE_WIDTH_BPS: '30',
  MM_CONTRACT_MAX_QUOTE_SPREAD_BPS: '100',
  MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE: '1',
  MM_CONTRACT_ORDER_STATE_MAX_AGE_MS: '5000',
};

describe('production maker quote-policy config', () => {
  test('requires explicit normal policy and contractual spread/depth obligations', () => {
    expect(buildMakerQuotePolicyConfig(VALID)).toEqual({
      normalQuoteLevels: 2,
      baseQuoteSizeBTC: 0.01,
      fallbackBaseSpreadBps: 30,
      minimumQuoteWidthBps: 30,
      contractMaxQuoteSpreadBps: 100,
      contractRequiredLevelsPerSide: 1,
      contractOrderStateMaxAgeMs: 5000,
    });
  });

  test('fails closed for missing, non-finite, fractional, or contradictory policy values', () => {
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_NORMAL_QUOTE_LEVELS: '' }))
      .toThrow('MM_NORMAL_QUOTE_LEVELS is required');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_NORMAL_QUOTE_LEVELS: '1.5' }))
      .toThrow('MM_NORMAL_QUOTE_LEVELS must be a positive integer');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_BASE_QUOTE_SIZE_BTC: 'NaN' }))
      .toThrow('MM_BASE_QUOTE_SIZE_BTC must be finite');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE: '3' }))
      .toThrow('cannot exceed MM_NORMAL_QUOTE_LEVELS');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_FALLBACK_BASE_SPREAD_BPS: '101' }))
      .toThrow('cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_MIN_LIVE_QUOTE_WIDTH_BPS: '' }))
      .toThrow('MM_MIN_LIVE_QUOTE_WIDTH_BPS is required');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_MIN_LIVE_QUOTE_WIDTH_BPS: '101' }))
      .toThrow('cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
  });
});

describe('production continuity config', () => {
  test('requires every deployment obligation and returns a validated immutable config', () => {
    const policy = buildMakerQuotePolicyConfig(VALID);
    const config = buildContinuityConfig(VALID, policy);
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
      contractMaxQuoteSpreadBps: 100,
      minimumQuoteWidthBps: 30,
      contractRequiredLevelsPerSide: 1,
      contractOrderStateMaxAgeMs: 5000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('fails closed for absent, ambiguous, or contradictory values', () => {
    expect(() => buildContinuityConfig({}, buildMakerQuotePolicyConfig(VALID))).toThrow('MM_MIN_ACTIVE_LEVELS_PER_SIDE is required');
    expect(() => buildContinuityConfig({ ...VALID, MM_L1_RESERVE_BASE_BTC: 'NaN' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_MIN_ACTIVE_LEVELS_PER_SIDE: '3' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_MIN_ACTIVE_LEVELS_PER_SIDE: '1' }, buildMakerQuotePolicyConfig({ ...VALID, MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE: '2' }))).toThrow('MM_MIN_ACTIVE_LEVELS_PER_SIDE cannot be below MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE');
    expect(() => buildContinuityConfig({ ...VALID, MM_MIN_ACTIVE_LEVELS_PER_SIDE: '2', MM_DEGRADED_MAX_LEVELS: '1' }, buildMakerQuotePolicyConfig({ ...VALID, MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE: '2' }))).toThrow('MM_DEGRADED_MAX_LEVELS cannot be below MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE');
    expect(() => buildContinuityConfig({ ...VALID, MM_SIDE_GAP_ALERT_THRESHOLD_MS: '6000' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEGRADED_MAX_LEVELS: '1.5' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEGRADED_SIZE_FACTOR: '1.1' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_DEFENSIVE_SPREAD_FLOOR_BPS: '0' }, buildMakerQuotePolicyConfig(VALID))).toThrow();
    expect(() => buildContinuityConfig({ ...VALID, MM_BASE_QUOTE_SIZE_BTC: '0.0001' }, buildMakerQuotePolicyConfig({ ...VALID, MM_BASE_QUOTE_SIZE_BTC: '0.0001' }))).toThrow('scaled L1');
    expect(() => buildContinuityConfig({ ...VALID, MM_NORMAL_QUOTE_LEVELS: '1' }, buildMakerQuotePolicyConfig({ ...VALID, MM_NORMAL_QUOTE_LEVELS: '1' }))).toThrow('below normal');
    expect(() => buildContinuityConfig({ ...VALID, MM_DEFENSIVE_SPREAD_FLOOR_BPS: '101' }, buildMakerQuotePolicyConfig(VALID))).toThrow('cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
    expect(() => buildMakerQuotePolicyConfig({ ...VALID, MM_CONTRACT_ORDER_STATE_MAX_AGE_MS: '0' })).toThrow('must be positive');
    expect(() => buildContinuityConfig(VALID, buildMakerQuotePolicyConfig({ ...VALID, MM_MIN_LIVE_QUOTE_WIDTH_BPS: '101' })))
      .toThrow('cannot exceed');
  });
});
