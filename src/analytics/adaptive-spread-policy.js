const REQUIRED_NON_NEGATIVE = [
  'baseFloorBps',
  'maxFloorBps',
];

const REQUIRED_POSITIVE = [
  'maxFeedAgeMs',
  'maxAdverseSelectionAgeMs',
  'maxInventoryRiskAgeMs',
  'volatilityMultiplier',
  'maxVolatilityContributionBps',
  'adverseSelectionMultiplier',
  'maxAdverseSelectionContributionBps',
  'inventoryRiskMultiplier',
  'maxInventoryRiskContributionBps',
];

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number >= 0`);
}

function finitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite number > 0`);
}

function boundedContribution(value, multiplier, maximum) {
  return Math.min(Math.max(0, value) * multiplier, maximum);
}

function unavailable(reason) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    recommendedAction: 'hold',
    floorBySideBps: null,
    componentsBySideBps: null,
  });
}

/**
 * A pure, shadow-safe calculator for the adaptive component of a maker spread
 * floor. It intentionally has no order/FIX dependencies; callers must opt in
 * to applying its recommendation after independent promotion evidence exists.
 */
export class AdaptiveSpreadPolicy {
  constructor(config) {
    for (const name of REQUIRED_NON_NEGATIVE) finiteNonNegative(config?.[name], `config.${name}`);
    for (const name of REQUIRED_POSITIVE) finitePositive(config?.[name], `config.${name}`);
    if (config.baseFloorBps <= 0 || config.maxFloorBps <= config.baseFloorBps) {
      throw new Error('config.maxFloorBps must be > config.baseFloorBps > 0');
    }
    this.config = Object.freeze({ ...config });
  }

  evaluate(input) {
    const feed = input?.referenceFeed;
    if (!feed || feed.fresh !== true || !Number.isFinite(feed.ageMs) || feed.ageMs < 0) {
      return unavailable('reference-feed-unavailable');
    }
    if (feed.ageMs > this.config.maxFeedAgeMs) return unavailable('reference-feed-stale');
    if (!Number.isFinite(input?.volatilityBps) || input.volatilityBps < 0) {
      return unavailable('volatility-unavailable');
    }
    const adverse = input?.adverseSelectionBySide;
    const inventory = input?.inventoryRiskBySide;
    if (!adverse || !inventory || !['buy', 'sell'].every(side =>
      Number.isFinite(adverse[side]?.bps) && Number.isFinite(adverse[side]?.ageMs) &&
      Number.isFinite(inventory[side]?.bps) && Number.isFinite(inventory[side]?.ageMs))) {
      return unavailable('side-risk-unavailable');
    }
    if (['buy', 'sell'].some(side => adverse[side].bps < 0 || inventory[side].bps < 0)) {
      return unavailable('side-risk-invalid');
    }
    if (['buy', 'sell'].some(side => adverse[side].ageMs < 0 || inventory[side].ageMs < 0)) {
      return unavailable('side-risk-invalid');
    }
    if (['buy', 'sell'].some(side => adverse[side].ageMs > this.config.maxAdverseSelectionAgeMs)) {
      return unavailable('adverse-selection-stale');
    }
    if (['buy', 'sell'].some(side => inventory[side].ageMs > this.config.maxInventoryRiskAgeMs)) {
      return unavailable('inventory-risk-stale');
    }

    const volatilityBps = boundedContribution(
      input.volatilityBps,
      this.config.volatilityMultiplier,
      this.config.maxVolatilityContributionBps,
    );
    const componentsBySideBps = {};
    const floorBySideBps = {};
    for (const side of ['buy', 'sell']) {
      const adverseSelectionBps = boundedContribution(
        adverse[side].bps,
        this.config.adverseSelectionMultiplier,
        this.config.maxAdverseSelectionContributionBps,
      );
      const inventoryRiskBps = boundedContribution(
        inventory[side].bps,
        this.config.inventoryRiskMultiplier,
        this.config.maxInventoryRiskContributionBps,
      );
      componentsBySideBps[side] = Object.freeze({
        baseFloorBps: this.config.baseFloorBps,
        volatilityBps,
        adverseSelectionBps,
        inventoryRiskBps,
      });
      floorBySideBps[side] = Math.min(
        this.config.maxFloorBps,
        this.config.baseFloorBps + volatilityBps + adverseSelectionBps + inventoryRiskBps,
      );
    }
    return Object.freeze({
      status: 'available',
      reason: null,
      recommendedAction: 'shadow-only',
      floorBySideBps: Object.freeze(floorBySideBps),
      componentsBySideBps: Object.freeze(componentsBySideBps),
    });
  }
}
