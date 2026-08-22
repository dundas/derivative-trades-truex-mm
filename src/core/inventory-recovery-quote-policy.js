import {
  evaluateInventoryRebalance,
  validateInventoryRebalanceConfig,
} from '../analytics/inventory-rebalance-model.js';

const POLICY_KEYS = [
  'interimTargetInventoryBTC',
  'inventorySigmaBTC',
  'centerBandSigma',
  'softHedgeBandSigma',
  'hardHedgeBandSigma',
  'minimumMakerParticipation',
  'maxSizeAsymmetry',
  'maxQuoteSkewBps',
];

/**
 * Validate the opt-in adapter around the offline Gaussian policy.  Economic
 * controls intentionally have no defaults: an operator must supply all of
 * them when enabling recovery.
 */
export function validateInventoryRecoveryQuoteConfig(config = {}) {
  if (config === null || typeof config !== 'object') {
    throw new Error('inventoryRecoveryConfig must be an object');
  }
  if (config.enabled === undefined || config.enabled === false) {
    return Object.freeze({ enabled: false });
  }
  if (config.enabled !== true) throw new Error('inventoryRecoveryConfig.enabled must be boolean');
  for (const key of POLICY_KEYS) {
    if (!Number.isFinite(config[key])) {
      throw new Error(`inventoryRecoveryConfig.${key} must be explicitly configured and finite`);
    }
  }
  if (config.operateOnExcess !== undefined && typeof config.operateOnExcess !== 'boolean') {
    throw new Error('inventoryRecoveryConfig.operateOnExcess must be boolean');
  }
  const policy = validateInventoryRebalanceConfig({
    targetInventoryBTC: config.interimTargetInventoryBTC,
    inventorySigmaBTC: config.inventorySigmaBTC,
    centerBandSigma: config.centerBandSigma,
    softHedgeBandSigma: config.softHedgeBandSigma,
    hardHedgeBandSigma: config.hardHedgeBandSigma,
    minimumMakerParticipation: config.minimumMakerParticipation,
    maxSizeAsymmetry: config.maxSizeAsymmetry,
    maxQuoteSkewBps: config.maxQuoteSkewBps,
  });
  return Object.freeze({
    enabled: true,
    operateOnExcess: config.operateOnExcess === true,
    ...policy,
    interimTargetInventoryBTC: config.interimTargetInventoryBTC,
  });
}

export function evaluateInventoryRecoveryQuote(inventoryBTC, config) {
  const recovery = validateInventoryRecoveryQuoteConfig(config);
  if (!recovery.enabled) return Object.freeze({ enabled: false, adjustmentApplied: false, reason: 'disabled' });
  if (!Number.isFinite(inventoryBTC)) {
    return Object.freeze({ enabled: true, adjustmentApplied: false, reason: 'inventory-unavailable' });
  }
  if (inventoryBTC >= recovery.interimTargetInventoryBTC && !recovery.operateOnExcess) {
    return Object.freeze({ enabled: true, adjustmentApplied: false, reason: 'interim-target-reached' });
  }
  const evaluation = evaluateInventoryRebalance(inventoryBTC, recovery);
  // The Gaussian has zero pressure exactly at target. Preserve that as an
  // explicit observer-visible state rather than claiming an adjustment.
  if (evaluation.rebalancingWeight === 0) {
    return Object.freeze({ enabled: true, adjustmentApplied: false, reason: 'at-interim-target', evaluation });
  }
  return Object.freeze({
    enabled: true,
    adjustmentApplied: true,
    reason: inventoryBTC < recovery.interimTargetInventoryBTC ? 'below-interim-target' : 'above-interim-target',
    evaluation,
    // The offline model's participation factor controls total maker exposure.
    // This adapter is intentionally two-sided, so retain its side asymmetry
    // while normalizing away that total-exposure reduction: recovery must grow
    // the desired side relative to the ordinary quote and reduce the other.
    quote: Object.freeze({
      bidSkewBps: evaluation.quote.bidSkewBps,
      askSkewBps: evaluation.quote.askSkewBps,
      bidSizeMultiplier: evaluation.quote.bidSizeMultiplier / evaluation.makerParticipation,
      askSizeMultiplier: evaluation.quote.askSizeMultiplier / evaluation.makerParticipation,
    }),
  });
}
