function parseInteger(env, name, defaultValue, { allowZero = false } = {}) {
  const raw = env?.[name];
  const value = raw === undefined || raw === null || raw === '' ? defaultValue : Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return value;
}

/** Validate polling controls before any timer or exchange request is created. */
export function buildFeedPollConfig(env) {
  return Object.freeze({
    pyusdUsdPollIntervalMs: parseInteger(env, 'PYUSD_USD_POLL_INTERVAL_MS', 5000, { allowZero: true }),
    pyusdUsdPollTimeoutMs: parseInteger(env, 'PYUSD_USD_POLL_TIMEOUT_MS', 1000),
    pyusdUsdStaleThresholdMs: parseInteger(env, 'PYUSD_USD_STALE_THRESHOLD_MS', 15000),
    truexEbboPollIntervalMs: parseInteger(env, 'TRUEX_EBBO_POLL_INTERVAL_MS', 1000),
  });
}
