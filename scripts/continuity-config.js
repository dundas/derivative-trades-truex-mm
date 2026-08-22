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

const POLICY_ENV_FIELDS = {
  normalQuoteLevels: 'MM_NORMAL_QUOTE_LEVELS',
  baseQuoteSizeBTC: 'MM_BASE_QUOTE_SIZE_BTC',
  fallbackBaseSpreadBps: 'MM_FALLBACK_BASE_SPREAD_BPS',
  minimumQuoteWidthBps: 'MM_MIN_LIVE_QUOTE_WIDTH_BPS',
  contractMaxQuoteSpreadBps: 'MM_CONTRACT_MAX_QUOTE_SPREAD_BPS',
  contractRequiredLevelsPerSide: 'MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE',
  contractOrderStateMaxAgeMs: 'MM_CONTRACT_ORDER_STATE_MAX_AGE_MS',
};

function requiredFiniteEnv(env, envName) {
  const raw = env?.[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(`${envName} is required for production maker quote policy`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${envName} must be finite`);
  return value;
}

/**
 * The spread values in this policy are full bid-to-ask widths in basis points,
 * not a per-side distance from mid. This makes the contractual ceiling directly
 * comparable to QuoteEngine's `baseSpreadBps` and defensive spread floor.
 */
export function buildMakerQuotePolicyConfig(env) {
  const config = {};
  for (const [field, envName] of Object.entries(POLICY_ENV_FIELDS)) {
    config[field] = requiredFiniteEnv(env, envName);
  }
  if (!Number.isInteger(config.normalQuoteLevels) || config.normalQuoteLevels < 1) {
    throw new Error('MM_NORMAL_QUOTE_LEVELS must be a positive integer');
  }
  if (!Number.isInteger(config.contractRequiredLevelsPerSide) ||
      config.contractRequiredLevelsPerSide < 1) {
    throw new Error('MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE must be a positive integer');
  }
  if (config.contractRequiredLevelsPerSide > config.normalQuoteLevels) {
    throw new Error('MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE cannot exceed MM_NORMAL_QUOTE_LEVELS');
  }
  for (const field of ['baseQuoteSizeBTC', 'fallbackBaseSpreadBps', 'minimumQuoteWidthBps', 'contractMaxQuoteSpreadBps', 'contractOrderStateMaxAgeMs']) {
    if (config[field] <= 0) throw new Error(`${POLICY_ENV_FIELDS[field]} must be positive`);
  }
  if (config.fallbackBaseSpreadBps > config.contractMaxQuoteSpreadBps) {
    throw new Error('MM_FALLBACK_BASE_SPREAD_BPS cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
  }
  if (config.minimumQuoteWidthBps > config.contractMaxQuoteSpreadBps) {
    throw new Error('MM_MIN_LIVE_QUOTE_WIDTH_BPS cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
  }
  return Object.freeze({ ...config });
}

export function buildContinuityConfig(env, {
  normalQuoteLevels: levels,
  baseQuoteSizeBTC: baseSizeBTC,
  fallbackBaseSpreadBps: baseSpreadBps,
  minimumQuoteWidthBps,
  contractMaxQuoteSpreadBps,
  contractRequiredLevelsPerSide,
  contractOrderStateMaxAgeMs,
} = {}) {
  const config = {};
  for (const [field, envName] of Object.entries(ENV_FIELDS)) {
    config[field] = requiredFiniteEnv(env, envName);
  }
  const validated = validateMakerPresenceConfig(config);
  if (Number.isInteger(levels) && validated.minActiveLevelsPerSide > levels) {
    throw new Error('MM_MIN_ACTIVE_LEVELS_PER_SIDE cannot exceed configured quote levels');
  }
  if (Number.isInteger(levels) && validated.degradedMaxLevels > levels) {
    throw new Error('MM_DEGRADED_MAX_LEVELS cannot exceed configured quote levels');
  }
  if (validated.minActiveLevelsPerSide < contractRequiredLevelsPerSide) {
    throw new Error('MM_MIN_ACTIVE_LEVELS_PER_SIDE cannot be below MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE');
  }
  // A degraded state is still an operating state, not permission to claim a
  // contractual depth that we intentionally cannot maintain. Refuse to boot
  // such a deployment rather than silently advertising less depth after a
  // reconciliation degradation.
  if (validated.degradedMaxLevels < contractRequiredLevelsPerSide) {
    throw new Error('MM_DEGRADED_MAX_LEVELS cannot be below MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE');
  }
  if (validated.degradedMaxLevels < validated.minActiveLevelsPerSide) {
    throw new Error('MM_DEGRADED_MAX_LEVELS cannot be below MM_MIN_ACTIVE_LEVELS_PER_SIDE');
  }
  if (!Number.isInteger(levels) || levels < 2 || validated.degradedMaxLevels >= levels) {
    throw new Error('MM_DEGRADED_MAX_LEVELS must be below normal quote levels');
  }
  if (!Number.isInteger(contractRequiredLevelsPerSide) || contractRequiredLevelsPerSide < 1 ||
      contractRequiredLevelsPerSide > levels) {
    throw new Error('MM_CONTRACT_REQUIRED_LEVELS_PER_SIDE must be compatible with normal quote levels');
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
  if (!Number.isFinite(contractMaxQuoteSpreadBps) || contractMaxQuoteSpreadBps <= 0 ||
      baseSpreadBps > contractMaxQuoteSpreadBps ||
      validated.defensiveSpreadFloorBps > contractMaxQuoteSpreadBps) {
    throw new Error('normal and defensive maker spreads cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
  }
  if (!Number.isFinite(minimumQuoteWidthBps) || minimumQuoteWidthBps <= 0 ||
      minimumQuoteWidthBps > contractMaxQuoteSpreadBps) {
    throw new Error('MM_MIN_LIVE_QUOTE_WIDTH_BPS must be positive and cannot exceed MM_CONTRACT_MAX_QUOTE_SPREAD_BPS');
  }
  if (!Number.isFinite(contractOrderStateMaxAgeMs) || contractOrderStateMaxAgeMs <= 0) {
    throw new Error('MM_CONTRACT_ORDER_STATE_MAX_AGE_MS must be positive');
  }
  if (validated.alertThresholdMs > validated.maxSideGapMs) {
    throw new Error('MM_SIDE_GAP_ALERT_THRESHOLD_MS cannot exceed MM_MAX_SIDE_GAP_MS');
  }
  return Object.freeze({
    ...validated,
    contractMaxQuoteSpreadBps,
    minimumQuoteWidthBps,
    contractRequiredLevelsPerSide,
    contractOrderStateMaxAgeMs,
  });
}
