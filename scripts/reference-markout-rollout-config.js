import { validateReferenceMarkoutConfig } from '../src/data-pipeline/reference-markout-collector.js';

const DEFAULTS = Object.freeze({
  product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
  sourceType: 'top-of-book', horizonsMs: Object.freeze([60_000, 300_000, 3_600_000]),
  maxSourceAgeMs: 5_000, maxLatenessMs: 30_000, pollIntervalMs: 1_000,
  batchSize: 100, claimLeaseMs: 5_000, retentionMs: 90 * 86_400_000,
  retentionSweepIntervalMs: 3_600_000, auditMaxGroups: 500,
  maxAbsBasisAdjustmentBps: 25,
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

function horizonsFromEnv(env) {
  const raw = env.REFERENCE_MARKOUT_HORIZONS_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return [...DEFAULTS.horizonsMs];
  const values = String(raw).split(',').map(value => Number(value.trim()));
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new Error('REFERENCE_MARKOUT_HORIZONS_MS must be a comma-separated list of safe integers');
  }
  return values;
}

export function buildReferenceMarkoutRolloutOptions(env = {}) {
  if (!enabledFromEnv(env)) return {};
  const referenceMarkoutConfig = validateReferenceMarkoutConfig({
    product: env.REFERENCE_MARKOUT_PRODUCT || DEFAULTS.product,
    quoteCurrency: env.REFERENCE_MARKOUT_QUOTE_CURRENCY || DEFAULTS.quoteCurrency,
    sourceExchange: env.REFERENCE_MARKOUT_SOURCE_EXCHANGE || DEFAULTS.sourceExchange,
    sourceType: env.REFERENCE_MARKOUT_SOURCE_TYPE || DEFAULTS.sourceType,
    horizonsMs: horizonsFromEnv(env),
    maxSourceAgeMs: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_SOURCE_AGE_MS', DEFAULTS.maxSourceAgeMs),
    maxLatenessMs: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_LATENESS_MS', DEFAULTS.maxLatenessMs),
    pollIntervalMs: numberFromEnv(env, 'REFERENCE_MARKOUT_POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs),
    batchSize: numberFromEnv(env, 'REFERENCE_MARKOUT_BATCH_SIZE', DEFAULTS.batchSize),
    claimLeaseMs: numberFromEnv(env, 'REFERENCE_MARKOUT_CLAIM_LEASE_MS', DEFAULTS.claimLeaseMs),
    retentionMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_MS', DEFAULTS.retentionMs),
    retentionSweepIntervalMs: numberFromEnv(env, 'REFERENCE_MARKOUT_RETENTION_SWEEP_INTERVAL_MS', DEFAULTS.retentionSweepIntervalMs),
    auditMaxGroups: numberFromEnv(env, 'REFERENCE_MARKOUT_AUDIT_MAX_GROUPS', DEFAULTS.auditMaxGroups),
    maxAbsBasisAdjustmentBps: numberFromEnv(env, 'REFERENCE_MARKOUT_MAX_ABS_BASIS_BPS', DEFAULTS.maxAbsBasisAdjustmentBps),
  });
  return { referenceMarkoutConfig };
}
