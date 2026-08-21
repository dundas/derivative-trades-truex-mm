/**
 * Pure offline inventory-control model.
 *
 * The Gaussian is a desired inventory distribution, not a forecast. It splits
 * policy emphasis between ordinary spread capture near the target and
 * inventory control in the tails. This module has no venue, FIX, or order-send
 * dependencies and cannot trade.
 */

export const DEFAULT_INVENTORY_REBALANCE_SHAPE = Object.freeze({
  centerBandSigma: 0.5,
  softHedgeBandSigma: 2,
  hardHedgeBandSigma: 3,
  minimumMakerParticipation: 0.25,
});

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function ratio(value, label, { allowZero = true } = {}) {
  finite(value, label);
  if (value > 1 || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label} must be ${allowZero ? 'between 0 and 1' : 'in (0, 1]'}`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - (2 * x));
}

export function validateInventoryRebalanceConfig(config = {}) {
  const merged = { ...DEFAULT_INVENTORY_REBALANCE_SHAPE, ...config };
  finite(merged.targetInventoryBTC, 'targetInventoryBTC');
  positive(merged.inventorySigmaBTC, 'inventorySigmaBTC');
  positive(merged.centerBandSigma, 'centerBandSigma');
  positive(merged.softHedgeBandSigma, 'softHedgeBandSigma');
  positive(merged.hardHedgeBandSigma, 'hardHedgeBandSigma');
  if (merged.centerBandSigma >= merged.softHedgeBandSigma) {
    throw new Error('centerBandSigma must be below softHedgeBandSigma');
  }
  if (merged.softHedgeBandSigma >= merged.hardHedgeBandSigma) {
    throw new Error('softHedgeBandSigma must be below hardHedgeBandSigma');
  }
  ratio(merged.minimumMakerParticipation, 'minimumMakerParticipation', { allowZero: false });
  ratio(merged.maxSizeAsymmetry, 'maxSizeAsymmetry');
  positive(merged.maxQuoteSkewBps, 'maxQuoteSkewBps');
  return Object.freeze(merged);
}

/**
 * Evaluate one inventory point.
 *
 * Sign conventions match InventoryManager:
 * - positive bid/ask skew widens that side;
 * - negative bid/ask skew tightens that side.
 */
export function evaluateInventoryRebalance(inventoryBTC, config = {}) {
  finite(inventoryBTC, 'inventoryBTC');
  const policy = validateInventoryRebalanceConfig(config);
  const deviationBTC = inventoryBTC - policy.targetInventoryBTC;
  const zScore = deviationBTC / policy.inventorySigmaBTC;
  const absoluteZ = Math.abs(zScore);
  const direction = Math.sign(zScore);

  const tradingWeight = Math.exp(-0.5 * zScore * zScore);
  const rebalancingWeight = 1 - tradingWeight;
  const makerParticipation = policy.minimumMakerParticipation +
    ((1 - policy.minimumMakerParticipation) * tradingWeight);
  const signedPressure = direction * rebalancingWeight;

  const bidSkewBps = signedPressure * policy.maxQuoteSkewBps;
  const askSkewBps = -signedPressure * policy.maxQuoteSkewBps;
  const bidSizeMultiplier = clamp(
    makerParticipation * (1 - (signedPressure * policy.maxSizeAsymmetry)),
    policy.minimumMakerParticipation,
    1 + policy.maxSizeAsymmetry,
  );
  const askSizeMultiplier = clamp(
    makerParticipation * (1 + (signedPressure * policy.maxSizeAsymmetry)),
    policy.minimumMakerParticipation,
    1 + policy.maxSizeAsymmetry,
  );

  const hedgeProgress = (absoluteZ - policy.softHedgeBandSigma) /
    (policy.hardHedgeBandSigma - policy.softHedgeBandSigma);
  const hedgeIntensity = smoothstep(hedgeProgress);
  const excessBeyondSoftBandBTC = Math.max(
    0,
    Math.abs(deviationBTC) - (policy.softHedgeBandSigma * policy.inventorySigmaBTC),
  );
  const hedgeQuantityBTC = excessBeyondSoftBandBTC * hedgeIntensity;

  let zone = 'organic-rebalance';
  if (absoluteZ <= policy.centerBandSigma) zone = 'trade';
  else if (absoluteZ >= policy.softHedgeBandSigma - 1e-12) zone = 'external-rebalance';

  return {
    inventoryBTC,
    targetInventoryBTC: policy.targetInventoryBTC,
    deviationBTC,
    zScore,
    zone,
    tradingWeight,
    rebalancingWeight,
    makerParticipation,
    quote: {
      bidSkewBps,
      askSkewBps,
      bidSizeMultiplier,
      askSizeMultiplier,
    },
    hedge: {
      intensity: hedgeIntensity,
      side: hedgeQuantityBTC === 0 ? null : (deviationBTC > 0 ? 'sell' : 'buy'),
      quantityBTC: hedgeQuantityBTC,
      returnsToInventoryBTC: deviationBTC > 0
        ? inventoryBTC - hedgeQuantityBTC
        : inventoryBTC + hedgeQuantityBTC,
    },
  };
}

export function buildInventoryRebalanceCurve(config = {}, options = {}) {
  const policy = validateInventoryRebalanceConfig(config);
  const minSigma = options.minSigma ?? -policy.hardHedgeBandSigma;
  const maxSigma = options.maxSigma ?? policy.hardHedgeBandSigma;
  const stepSigma = options.stepSigma ?? 0.25;
  finite(minSigma, 'minSigma');
  finite(maxSigma, 'maxSigma');
  positive(stepSigma, 'stepSigma');
  if (minSigma >= maxSigma) throw new Error('minSigma must be below maxSigma');

  const points = [];
  const count = Math.floor(((maxSigma - minSigma) / stepSigma) + 1e-12);
  for (let index = 0; index <= count; index++) {
    const sigma = index === count ? maxSigma : minSigma + (index * stepSigma);
    const inventoryBTC = policy.targetInventoryBTC + (sigma * policy.inventorySigmaBTC);
    points.push(evaluateInventoryRebalance(inventoryBTC, policy));
  }
  if (points.at(-1).zScore < maxSigma - 1e-10) {
    points.push(evaluateInventoryRebalance(
      policy.targetInventoryBTC + (maxSigma * policy.inventorySigmaBTC),
      policy,
    ));
  }
  return points;
}
