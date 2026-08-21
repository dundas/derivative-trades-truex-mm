import { validateInventoryRebalanceConfig } from '../src/analytics/inventory-rebalance-model.js';
import { validateMakerPresenceRecoveryConfig } from '../src/core/maker-presence-recovery.js';

function booleanValue(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase())) return false;
  throw new Error(`${name} must be boolean`);
}

function numberValue(env, name, fallback) {
  const raw = env?.[name];
  const value = raw === undefined || raw === null || String(raw).trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

export function buildMakerPresenceRecoveryConfig(env = {}) {
  return validateMakerPresenceRecoveryConfig({
    enabled: booleanValue(env, 'MM_PRESENCE_RECOVERY_ENABLED', false),
    cooldownMs: numberValue(env, 'MM_PRESENCE_RECOVERY_COOLDOWN_MS', 60_000),
    attemptWindowMs: numberValue(env, 'MM_PRESENCE_RECOVERY_ATTEMPT_WINDOW_MS', 3_600_000),
    maxAttemptsPerWindow: numberValue(env, 'MM_PRESENCE_RECOVERY_MAX_ATTEMPTS', 3),
    rearmTimeoutMs: numberValue(env, 'MM_PRESENCE_RECOVERY_REARM_TIMEOUT_MS', 30_000),
  });
}

export function buildInventoryRebalanceShadowConfig(env = {}) {
  const targetInventoryBTC = numberValue(env, 'INVENTORY_REBALANCE_TARGET_BTC', 0.014);
  const inventorySigmaBTC = numberValue(
    env,
    'INVENTORY_REBALANCE_SIGMA_BTC',
    Math.abs(targetInventoryBTC) / 3,
  );
  const sampleIntervalMs = numberValue(env, 'INVENTORY_REBALANCE_SHADOW_INTERVAL_MS', 5_000);
  if (sampleIntervalMs <= 0) throw new Error('INVENTORY_REBALANCE_SHADOW_INTERVAL_MS must be positive');
  return Object.freeze({
    enabled: booleanValue(env, 'INVENTORY_REBALANCE_SHADOW_ENABLED', true),
    sampleIntervalMs,
    ...validateInventoryRebalanceConfig({
      targetInventoryBTC,
      inventorySigmaBTC,
      centerBandSigma: numberValue(env, 'INVENTORY_REBALANCE_CENTER_BAND_SIGMA', 0.5),
      softHedgeBandSigma: numberValue(env, 'INVENTORY_REBALANCE_SOFT_BAND_SIGMA', 2),
      hardHedgeBandSigma: numberValue(env, 'INVENTORY_REBALANCE_HARD_BAND_SIGMA', 3),
      minimumMakerParticipation: numberValue(env, 'INVENTORY_REBALANCE_MAKER_FLOOR', 0.25),
      maxSizeAsymmetry: numberValue(env, 'INVENTORY_REBALANCE_MAX_SIZE_ASYMMETRY', 0.75),
      maxQuoteSkewBps: numberValue(env, 'INVENTORY_REBALANCE_MAX_QUOTE_SKEW_BPS', 10),
    }),
  });
}
