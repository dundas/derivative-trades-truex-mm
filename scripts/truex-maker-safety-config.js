function required(env, name) {
  const value = env?.[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${name} is required for production maker safety`);
  }
  return String(value).trim();
}

function positiveInteger(env, name) {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function buildTruexMakerSafetyConfig(env, { ebboPollIntervalMs, maxOrdersPerSecond } = {}) {
  if (required(env, 'TRUEX_MAKER_SAFETY_STRICT') !== 'true') {
    throw new Error('TRUEX_MAKER_SAFETY_STRICT must be true in production');
  }
  const marketablePostOnlyAction = required(env, 'TRUEX_MAKER_MARKETABLE_ACTION').toLowerCase();
  if (!['skip', 'slide'].includes(marketablePostOnlyAction)) {
    throw new Error('TRUEX_MAKER_MARKETABLE_ACTION must be skip or slide');
  }
  const truexMakerEbboMaxAgeMs = positiveInteger(env, 'TRUEX_MAKER_EBBO_MAX_AGE_MS');
  if (!Number.isSafeInteger(ebboPollIntervalMs) || ebboPollIntervalMs <= 0) {
    throw new Error('ebboPollIntervalMs must be a positive integer');
  }
  if (truexMakerEbboMaxAgeMs < ebboPollIntervalMs) {
    throw new Error('TRUEX_MAKER_EBBO_MAX_AGE_MS must be at least the EBBO poll interval');
  }
  if (truexMakerEbboMaxAgeMs > ebboPollIntervalMs * 3) {
    throw new Error('TRUEX_MAKER_EBBO_MAX_AGE_MS must be within three poll intervals');
  }
  if (!Number.isSafeInteger(maxOrdersPerSecond) || maxOrdersPerSecond <= 0) {
    throw new Error('maxOrdersPerSecond must be a positive integer');
  }
  const truexAloRetryCooldownMs = positiveInteger(env, 'TRUEX_ALO_RETRY_COOLDOWN_MS');
  if (truexAloRetryCooldownMs < ebboPollIntervalMs) {
    throw new Error('TRUEX_ALO_RETRY_COOLDOWN_MS must be at least the EBBO poll interval');
  }
  if (truexAloRetryCooldownMs > Math.min(60000, ebboPollIntervalMs * 60)) {
    throw new Error('TRUEX_ALO_RETRY_COOLDOWN_MS must be at most 60 poll intervals');
  }
  const truexAloRetryMaxEntries = positiveInteger(env, 'TRUEX_ALO_RETRY_MAX_ENTRIES');
  if (truexAloRetryMaxEntries > 10000) {
    throw new Error('TRUEX_ALO_RETRY_MAX_ENTRIES must be at most 10000');
  }
  const minimumEntries = maxOrdersPerSecond * (Math.ceil(truexAloRetryCooldownMs / 1000) + 1);
  if (truexAloRetryMaxEntries < minimumEntries) {
    throw new Error('TRUEX_ALO_RETRY_MAX_ENTRIES must cover the configured send-rate cooldown window');
  }
  return Object.freeze({
    strictTruexMakerSafety: true,
    marketablePostOnlyAction,
    truexMakerEbboMaxAgeMs,
    truexAloRetryCooldownMs,
    truexAloRetryMaxEntries,
  });
}
