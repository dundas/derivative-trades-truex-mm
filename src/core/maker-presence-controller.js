const REQUIRED_POSITIVE = [
  'minimumFundedQuoteSize',
  'l1ReserveBase',
  'l1ReserveQuote',
  'maxSideGapMs',
  'alertThresholdMs',
  'alertRateLimitMs',
  'defensiveSpreadFloorBps',
];

export function validateMakerPresenceConfig(config) {
  if (!config || !Number.isInteger(config.minActiveLevelsPerSide) || config.minActiveLevelsPerSide < 1) {
    throw new Error('minActiveLevelsPerSide must be a positive integer');
  }
  for (const field of REQUIRED_POSITIVE) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new Error(`${field} must be a finite positive number`);
    }
  }
  if (!Number.isInteger(config.degradedMaxLevels) || config.degradedMaxLevels < 1) {
    throw new Error('degradedMaxLevels must be a positive integer');
  }
  if (!Number.isFinite(config.degradedSizeFactor) || config.degradedSizeFactor <= 0 || config.degradedSizeFactor > 1) {
    throw new Error('degradedSizeFactor must be in (0, 1]');
  }
  if (config.l1ReserveBase < config.minimumFundedQuoteSize) {
    throw new Error('l1ReserveBase must fund at least minimumFundedQuoteSize');
  }
  return Object.freeze({ ...config });
}

export class MakerPresenceController {
  constructor(config, { now = Date.now } = {}) {
    this.config = validateMakerPresenceConfig(config);
    this.now = now;
    this.startedAt = null;
    this.lastObservedAt = null;
    this.lastTwoSided = false;
    this.twoSidedDurationMs = 0;
    this.gaps = {
      buy: { active: false, startedAt: null, lastDurationMs: 0, recoveries: 0, lastAlertAt: null },
      sell: { active: false, startedAt: null, lastDurationMs: 0, recoveries: 0, lastAlertAt: null },
    };
  }

  observe({
    orders = [],
    oeHealthy = true,
    referenceHealthy = true,
    reconciliationState = 'normal',
    fundedSizeBySide = { buy: Infinity, sell: Infinity },
    blockedSides = [],
    emergency = false,
  } = {}) {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('clock must return a finite non-negative timestamp');
    if (this.lastObservedAt !== null && now < this.lastObservedAt) {
      throw new Error('clock must be monotonic');
    }
    if (this.startedAt === null) this.startedAt = now;
    if (this.lastObservedAt !== null && this.lastTwoSided) {
      this.twoSidedDurationMs += Math.max(0, now - this.lastObservedAt);
    }

    const uniqueLevels = { buy: new Set(), sell: new Set() };
    const fundedSafeL1 = { buy: false, sell: false };
    for (const order of orders) {
      if (order?.acknowledgedLive !== true || !['buy', 'sell'].includes(order.side)) continue;
      if (!Number.isFinite(Number(order.remainingSize)) ||
          Number(order.remainingSize) < this.config.minimumFundedQuoteSize) continue;
      if (!Number.isInteger(Number(order.level)) || Number(order.level) <= 0) continue;
      const level = Number(order.level);
      uniqueLevels[order.side].add(level);
      if (level === 1) fundedSafeL1[order.side] = true;
    }
    const activeLevels = { buy: uniqueLevels.buy.size, sell: uniqueLevels.sell.size };
    const present = {
      buy: activeLevels.buy >= this.config.minActiveLevelsPerSide,
      sell: activeLevels.sell >= this.config.minActiveLevelsPerSide,
    };
    present.twoSided = present.buy && present.sell;

    const reasons = [];
    const alerts = [];
    const exceededSideGaps = [];
    for (const side of ['buy', 'sell']) {
      const gap = this.gaps[side];
      if (!present[side]) {
        const reason = `missing-acknowledged-${side}`;
        reasons.push(reason);
        if (!gap.active) {
          gap.active = true;
          gap.startedAt = now;
        }
        const duration = now - gap.startedAt;
        if (duration >= this.config.maxSideGapMs) {
          const exceededReason = `${side}-side-gap-exceeded`;
          reasons.push(exceededReason);
          exceededSideGaps.push(exceededReason);
        }
        const alertDue = duration >= this.config.alertThresholdMs &&
          (gap.lastAlertAt === null || now - gap.lastAlertAt >= this.config.alertRateLimitMs);
        if (alertDue) {
          alerts.push({ side, gapDurationMs: duration, reason });
          gap.lastAlertAt = now;
        }
      } else if (gap.active) {
        gap.active = false;
        gap.lastDurationMs = now - gap.startedAt;
        gap.startedAt = null;
        gap.recoveries++;
      }
    }

    const unsafeReasons = [];
    unsafeReasons.push(...exceededSideGaps);
    if (emergency) unsafeReasons.push('emergency-kill-switch');
    if (!oeHealthy) unsafeReasons.push('order-entry-unhealthy');
    if (!referenceHealthy) unsafeReasons.push('reference-unhealthy');
    const blocked = new Set(blockedSides);
    const reconciliationFailed = reconciliationState === 'failed';
    const capitalDegraded = reconciliationState === 'degraded' || reconciliationFailed || blocked.size > 0;
    if (reconciliationState === 'degraded') reasons.push('capital-reconciliation-degraded');
    if (reconciliationFailed) reasons.push('capital-reconciliation-failed');
    for (const side of [...blocked].sort()) reasons.push(`capital-side-blocked-${side}`);
    const noAcknowledgedFundedL1 = !fundedSafeL1.buy && !fundedSafeL1.sell;
    const bothSidesUnavailable = ['buy', 'sell'].every((side) =>
      blocked.has(side) || Number(fundedSizeBySide[side]) < this.config.minimumFundedQuoteSize);
    if (noAcknowledgedFundedL1 &&
        (reconciliationFailed || bothSidesUnavailable)) {
      unsafeReasons.push('reconciliation-failed-no-safe-l1');
    }
    reasons.push(...unsafeReasons);

    const executionState = unsafeReasons.length > 0
      ? 'unsafe'
      : (capitalDegraded || !present.twoSided ? 'degraded' : 'normal');
    this.lastObservedAt = now;
    this.lastTwoSided = present.twoSided;
    const elapsed = now - this.startedAt;

    return {
      executionState,
      reasons,
      activeLevels,
      present,
      gaps: { buy: { ...this.gaps.buy }, sell: { ...this.gaps.sell } },
      alerts,
      twoSidedDurationMs: this.twoSidedDurationMs,
      twoSidedUptimePct: elapsed > 0 ? (this.twoSidedDurationMs / elapsed) * 100 : (present.twoSided ? 100 : 0),
      observedAt: now,
    };
  }
}
