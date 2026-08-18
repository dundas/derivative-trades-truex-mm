import { validateReferenceMarkoutConfig } from '../src/data-pipeline/reference-markout-collector.js';

const DEFAULTS = Object.freeze({
  referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD', quoteCurrency: 'PYUSD',
  sourceExchange: 'cryptocom', sourceType: 'public-ws-book',
  sourceInstrument: 'BTC_PYUSD', sourceChannel: 'book.BTC_PYUSD.10',
  sourceDepth: 10, sourceReconnectDelayMs: 1_000,
  sourceSubscribeDelayMs: 1_000, sourceHeartbeatTimeoutMs: 15_000,
  sourceReconnectJitterMs: 250,
  horizonsMs: Object.freeze([60_000, 300_000, 3_600_000]),
  maxSourceAgeMs: 5_000, maxLatenessMs: 30_000, pollIntervalMs: 1_000,
  batchSize: 100, claimLeaseMs: 5_000, retentionMs: 90 * 86_400_000,
  retentionSweepIntervalMs: 3_600_000, auditMaxGroups: 500,
  retentionBatchSize: 10_000,
  retentionMaxBatchesPerSweep: 12, maxQuoteDecisionsPerSecond: 10,
  planningFillEventsPerSecond: 6,
  retentionMaxDurationMs: 30_000, retentionYieldMs: 10,
  dbStatementTimeoutMs: 2_000, dbQueryTimeoutMs: 2_500, dbLockTimeoutMs: 500,
  maxPendingDecisionWrites: 100, maxPendingFillWrites: 80, telemetryWriteConcurrency: 4,
  maxConsecutiveFillStarts: 10, fillHorizonSafetyMarginMs: 1_000,
  maxAbsBasisAdjustmentBps: 25,
  basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
  basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
  basisSystem: 'CLOB', maxBasisRttMs: 1_000,
});

function enabledFromEnv(env) {
  const raw = env.REFERENCE_MARKOUT_ENABLED;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('REFERENCE_MARKOUT_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off)');
}

function numberFromEnv(env, name, fallback) {
  const raw = env[name];
  return raw === undefined || raw === null || String(raw).trim() === '' ? fallback : Number(raw);
}
function officialCryptoComEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname === 'stream.crypto.com' &&
      (url.port === '' || url.port === '443') && url.pathname === '/exchange/v1/market' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function horizonsFromEnv(env) {
  const raw = env.REFERENCE_MARKOUT_HORIZONS_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return [...DEFAULTS.horizonsMs];
  const values = String(raw).split(',').map(value => Number(value.trim()));
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new Error('REFERENCE_MARKOUT_HORIZONS_MS must be a comma-separated list of safe integers');
  }
  return values;
}

function venueAllowlistFromEnv(env) {
  const raw = env.REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST is required when reference mark-outs are enabled');
  }
  return String(raw).split(',').map(value => value.trim()).filter(Boolean);
}

export function buildReferenceMarkoutRolloutOptions(env = {}, {
  maxQuoteDecisionsPerSecond, basisPollTimeoutMs,
} = {}) {
  if (!enabledFromEnv(env)) return {};
  const referenceMode = env.REFERENCE_MARKOUT_REFERENCE_MODE || DEFAULTS.referenceMode;
  const sourceUrl = env.REFERENCE_MARKOUT_SOURCE_WS_URL;
  const sourceEndpointAllowlist = String(env.REFERENCE_MARKOUT_SOURCE_ENDPOINT_ALLOWLIST || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (referenceMode === 'cryptocom-direct' &&
      !officialCryptoComEndpoint(sourceUrl)) {
    throw new Error('REFERENCE_MARKOUT_SOURCE_WS_URL must be the exact official Crypto.com public market endpoint');
  }
  if (referenceMode === 'cryptocom-direct' && !sourceEndpointAllowlist.includes(sourceUrl)) {
    throw new Error('REFERENCE_MARKOUT_SOURCE_WS_URL must exactly match its configured endpoint allowlist');
  }
  const configuredDecisionRate = numberFromEnv(env,
    'REFERENCE_MARKOUT_MAX_QUOTE_DECISIONS_PER_SECOND',
    maxQuoteDecisionsPerSecond ?? DEFAULTS.maxQuoteDecisionsPerSecond);
  if (maxQuoteDecisionsPerSecond !== undefined &&
      configuredDecisionRate !== maxQuoteDecisionsPerSecond) {
    throw new Error('REFERENCE_MARKOUT_MAX_QUOTE_DECISIONS_PER_SECOND must equal the enforced order rate');
  }
  const referenceMarkoutConfig = validateReferenceMarkoutConfig({
    referenceMode,
    product: env.REFERENCE_MARKOUT_PRODUCT || DEFAULTS.product,
    quoteCurrency: env.REFERENCE_MARKOUT_QUOTE_CURRENCY || DEFAULTS.quoteCurrency,
    sourceExchange: env.REFERENCE_MARKOUT_SOURCE_EXCHANGE || DEFAULTS.sourceExchange,
    sourceType: env.REFERENCE_MARKOUT_SOURCE_TYPE || DEFAULTS.sourceType,
    sourceInstrument: env.REFERENCE_MARKOUT_SOURCE_INSTRUMENT || DEFAULTS.sourceInstrument,
    sourceChannel: env.REFERENCE_MARKOUT_SOURCE_CHANNEL || DEFAULTS.sourceChannel,
    sourceEndpointAllowlist: referenceMode === 'cryptocom-direct' ? sourceEndpointAllowlist : [],
    horizonsMs: horizonsFromEnv(env),
    maxSourceAgeMs: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_SOURCE_AGE_MS', DEFAULTS.maxSourceAgeMs),
    maxLatenessMs: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_LATENESS_MS', DEFAULTS.maxLatenessMs),
    pollIntervalMs: numberFromEnv(env, 'REFERENCE_MARKOUT_POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs),
    batchSize: numberFromEnv(env, 'REFERENCE_MARKOUT_BATCH_SIZE', DEFAULTS.batchSize),
    claimLeaseMs: numberFromEnv(env, 'REFERENCE_MARKOUT_CLAIM_LEASE_MS', DEFAULTS.claimLeaseMs),
    retentionMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_MS', DEFAULTS.retentionMs),
    retentionSweepIntervalMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_SWEEP_INTERVAL_MS', DEFAULTS.retentionSweepIntervalMs),
    retentionBatchSize: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_BATCH_SIZE', DEFAULTS.retentionBatchSize),
    retentionMaxBatchesPerSweep: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_MAX_BATCHES_PER_SWEEP', DEFAULTS.retentionMaxBatchesPerSweep),
    maxQuoteDecisionsPerSecond: configuredDecisionRate,
    planningFillEventsPerSecond: numberFromEnv(env, 'REFERENCE_MARKOUT_PLANNING_FILL_EVENTS_PER_SECOND', DEFAULTS.planningFillEventsPerSecond),
    retentionMaxDurationMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_MAX_DURATION_MS', DEFAULTS.retentionMaxDurationMs),
    retentionYieldMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_YIELD_MS', DEFAULTS.retentionYieldMs),
    dbStatementTimeoutMs: numberFromEnv(env, 'REFERENCE_MARKOUT_DB_STATEMENT_TIMEOUT_MS', DEFAULTS.dbStatementTimeoutMs),
    dbQueryTimeoutMs: numberFromEnv(env, 'REFERENCE_MARKOUT_DB_QUERY_TIMEOUT_MS', DEFAULTS.dbQueryTimeoutMs),
    dbLockTimeoutMs: numberFromEnv(env, 'REFERENCE_MARKOUT_DB_LOCK_TIMEOUT_MS', DEFAULTS.dbLockTimeoutMs),
    maxPendingDecisionWrites: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_PENDING_DECISION_WRITES', DEFAULTS.maxPendingDecisionWrites),
    maxPendingFillWrites: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_PENDING_FILL_WRITES', DEFAULTS.maxPendingFillWrites),
    telemetryWriteConcurrency: numberFromEnv(env, 'REFERENCE_MARKOUT_WRITE_CONCURRENCY', DEFAULTS.telemetryWriteConcurrency),
    maxConsecutiveFillStarts: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_CONSECUTIVE_FILL_STARTS', DEFAULTS.maxConsecutiveFillStarts),
    fillHorizonSafetyMarginMs: numberFromEnv(env, 'REFERENCE_MARKOUT_FILL_HORIZON_SAFETY_MARGIN_MS', DEFAULTS.fillHorizonSafetyMarginMs),
    auditMaxGroups: numberFromEnv(env, 'REFERENCE_MARKOUT_AUDIT_MAX_GROUPS', DEFAULTS.auditMaxGroups),
    maxAbsBasisAdjustmentBps: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_ABS_BASIS_BPS', DEFAULTS.maxAbsBasisAdjustmentBps),
    basisSource: env.REFERENCE_MARKOUT_BASIS_SOURCE || DEFAULTS.basisSource,
    basisRequestedPair: env.REFERENCE_MARKOUT_BASIS_REQUESTED_PAIR || DEFAULTS.basisRequestedPair,
    basisResolvedPair: env.REFERENCE_MARKOUT_BASIS_RESOLVED_PAIR || DEFAULTS.basisResolvedPair,
    basisBase: env.REFERENCE_MARKOUT_BASIS_BASE || DEFAULTS.basisBase,
    basisQuote: env.REFERENCE_MARKOUT_BASIS_QUOTE || DEFAULTS.basisQuote,
    basisSystem: env.REFERENCE_MARKOUT_BASIS_SYSTEM || DEFAULTS.basisSystem,
    basisVenueAllowlist: referenceMode === 'coinbase-basis' ? venueAllowlistFromEnv(env) : [],
    maxBasisRttMs: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_BASIS_RTT_MS', DEFAULTS.maxBasisRttMs),
  });
  if (referenceMode === 'coinbase-basis' && basisPollTimeoutMs !== undefined &&
      referenceMarkoutConfig.maxBasisRttMs > basisPollTimeoutMs) {
    throw new Error('REFERENCE_MARKOUT_MAX_BASIS_RTT_MS must not exceed PYUSD_USD_POLL_TIMEOUT_MS');
  }
  if (referenceMode !== 'cryptocom-direct') return { referenceMarkoutConfig };
  const url = sourceUrl;
  const sourceDepth = numberFromEnv(env, 'REFERENCE_MARKOUT_SOURCE_DEPTH', DEFAULTS.sourceDepth);
  const reconnectDelayMs = numberFromEnv(env, 'REFERENCE_MARKOUT_SOURCE_RECONNECT_DELAY_MS',
    DEFAULTS.sourceReconnectDelayMs);
  const subscribeDelayMs = numberFromEnv(env, 'REFERENCE_MARKOUT_SOURCE_SUBSCRIBE_DELAY_MS',
    DEFAULTS.sourceSubscribeDelayMs);
  const heartbeatTimeoutMs = numberFromEnv(env, 'REFERENCE_MARKOUT_SOURCE_HEARTBEAT_TIMEOUT_MS',
    DEFAULTS.sourceHeartbeatTimeoutMs);
  const reconnectJitterMs = numberFromEnv(env, 'REFERENCE_MARKOUT_SOURCE_RECONNECT_JITTER_MS',
    DEFAULTS.sourceReconnectJitterMs);
  if (sourceDepth !== 10 || !Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 100 ||
      reconnectDelayMs > 60_000 || !Number.isSafeInteger(subscribeDelayMs) ||
      subscribeDelayMs < 500 || subscribeDelayMs > 5_000 ||
      !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= subscribeDelayMs ||
      heartbeatTimeoutMs > 60_000 || !Number.isSafeInteger(reconnectJitterMs) ||
      reconnectJitterMs < 0 || reconnectJitterMs > reconnectDelayMs) {
    throw new Error('Crypto.com source depth/reconnect configuration is invalid');
  }
  return { referenceMarkoutConfig, referenceBookFeedConfig: {
    url, instrument: referenceMarkoutConfig.sourceInstrument, depth: sourceDepth,
    maxAgeMs: referenceMarkoutConfig.maxSourceAgeMs, reconnectDelayMs, subscribeDelayMs,
    heartbeatTimeoutMs, reconnectJitterMs,
  } };
}
