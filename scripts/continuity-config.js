import { validateMakerPresenceConfig } from '../src/core/maker-presence-controller.js';

const ENV_FIELDS = {
  minActiveLevelsPerSide: 'MM_MIN_ACTIVE_LEVELS_PER_SIDE',
  minimumFundedQuoteSize: 'MM_MIN_FUNDED_QUOTE_SIZE_BTC',
  l1ReserveBase: 'MM_L1_RESERVE_BASE_BTC',
  l1ReserveQuote: 'MM_L1_RESERVE_QUOTE_PYUSD',
  maxSideGapMs: 'MM_MAX_SIDE_GAP_MS',
  alertThresholdMs: 'MM_SIDE_GAP_ALERT_THRESHOLD_MS',
  alertRateLimitMs: 'MM_SIDE_GAP_ALERT_RATE_LIMIT_MS',
  degradedMaxLevels: 'MM_DEGRADED_MAX_LEVELS',
  degradedSizeFactor: 'MM_DEGRADED_SIZE_FACTOR',
  defensiveSpreadFloorBps: 'MM_DEFENSIVE_SPREAD_FLOOR_BPS',
};

export function buildContinuityConfig(env, { levels, baseSizeBTC, baseSpreadBps } = {}) {
  const config = {};
  for (const [field, envName] of Object.entries(ENV_FIELDS)) {
    const raw = env?.[envName];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new Error(`${envName} is required for production continuity control`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${envName} must be finite`);
    config[field] = value;
  }
  const validated = validateMakerPresenceConfig(config);
  if (Number.isInteger(levels) && validated.minActiveLevelsPerSide > levels) {
    throw new Error('MM_MIN_ACTIVE_LEVELS_PER_SIDE cannot exceed configured quote levels');
  }
  if (Number.isInteger(levels) && validated.degradedMaxLevels > levels) {
    throw new Error('MM_DEGRADED_MAX_LEVELS cannot exceed configured quote levels');
  }
  if (validated.degradedMaxLevels < validated.minActiveLevelsPerSide) {
    throw new Error('MM_DEGRADED_MAX_LEVELS cannot be below MM_MIN_ACTIVE_LEVELS_PER_SIDE');
  }
  if (!Number.isInteger(levels) || levels < 2 || validated.degradedMaxLevels >= levels) {
    throw new Error('MM_DEGRADED_MAX_LEVELS must be below normal quote levels');
  }
  if (!Number.isFinite(baseSizeBTC) || baseSizeBTC <= 0 ||
      baseSizeBTC * validated.degradedSizeFactor < validated.minimumFundedQuoteSize) {
    throw new Error('degraded scaled L1 must meet MM_MIN_FUNDED_QUOTE_SIZE_BTC');
  }
  if (validated.degradedSizeFactor >= 1) {
    throw new Error('MM_DEGRADED_SIZE_FACTOR must be below 1');
  }
  if (!Number.isFinite(baseSpreadBps) || baseSpreadBps <= 0 ||
      validated.defensiveSpreadFloorBps <= baseSpreadBps) {
    throw new Error('MM_DEFENSIVE_SPREAD_FLOOR_BPS must be above normal base spread');
  }
  if (validated.alertThresholdMs > validated.maxSideGapMs) {
    throw new Error('MM_SIDE_GAP_ALERT_THRESHOLD_MS cannot exceed MM_MAX_SIDE_GAP_MS');
  }
  return validated;
}
