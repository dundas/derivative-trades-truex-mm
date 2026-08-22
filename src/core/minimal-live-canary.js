// A deliberately small, process-local guard for the first live maker test.
// It does not track replacements or own-order lifecycle; the existing engine
// remains the authority for those concerns.
const ENVELOPE = Object.freeze({
  levels: 1,
  baseSizeBTC: 0.0005,
  minimumQuoteWidthBps: 30,
  contractMaxQuoteSpreadBps: 80, minimumMarkoutDeadlineMs: 60_000,
  maxDurationMs: 15 * 60_000,
});

export function validateMinimalLiveCanaryConfig(input = {}) {
  if (input?.enabled !== true) return Object.freeze({ enabled: false });
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(input.runId)) {
    throw new Error('minimalLiveCanaryConfig.runId must be an explicit 8-64 character operator run ID');
  }
  for (const key of ['durationMs', 'maxCumulativeFilledBTC', 'oneMinuteMarkoutDeadlineMs', 'levels', 'baseSizeBTC',
    'minimumQuoteWidthBps', 'contractMaxQuoteSpreadBps']) {
    if (!Number.isFinite(input[key])) throw new Error(`minimalLiveCanaryConfig.${key} must be explicitly configured and finite`);
  }
  if (input.levels !== ENVELOPE.levels || input.baseSizeBTC !== ENVELOPE.baseSizeBTC) {
    throw new Error('minimal live canary must use one level and 0.0005 BTC');
  }
  if (input.minimumQuoteWidthBps !== ENVELOPE.minimumQuoteWidthBps ||
      input.contractMaxQuoteSpreadBps !== ENVELOPE.contractMaxQuoteSpreadBps) {
    throw new Error('minimal live canary width must be 30-80 bps');
  }
  if (input.durationMs <= 0 || input.durationMs > ENVELOPE.maxDurationMs) {
    throw new Error('minimal live canary duration must be in (0, 15 minutes]');
  }
  if (input.maxCumulativeFilledBTC <= 0) {
    throw new Error('minimalLiveCanaryConfig.maxCumulativeFilledBTC must be positive');
  }
  if (input.oneMinuteMarkoutDeadlineMs < ENVELOPE.minimumMarkoutDeadlineMs) {
    throw new Error('minimal live canary markout deadline cannot precede its one-minute horizon');
  }
  if (input.maxCumulativeFilledBTC < 2 * ENVELOPE.baseSizeBTC) {
    throw new Error('minimal live canary fill cap must cover the initial two-sided exposure');
  }
  return Object.freeze({ ...input, enabled: true });
}

export class MinimalLiveCanary {
  constructor(config, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, stop = () => {} } = {}) {
    this.config = validateMinimalLiveCanaryConfig(config);
    this.now = now;
    this.stopFn = stop;
    this.setTimer = setTimer;
    this.cumulativeFilledBTC = 0;
    this.placementPausedAfterFill = false;
    this.pendingMarkouts = new Map();
    this.stopReason = null;
    this.startedAt = null;
    this.timer = null;
    this.clearTimer = clearTimer;
  }

  canPlace() {
    if (!this.config.enabled || this.stopReason) return false;
    if (this.startedAt === null) return false;
    if (this.startedAt !== null && this.now() - this.startedAt >= this.config.durationMs) return this.stop('expired');
    if (this.placementPausedAfterFill) return false;
    return true;
  }

  arm() {
    if (!this.config.enabled || this.stopReason || this.startedAt !== null) return false;
    this.startedAt = this.now();
    this.timer = this.setTimer(() => this.stop('expired'), this.config.durationMs);
    return true;
  }

  recordFill(size, fillId) {
    if (!this.config.enabled || this.stopReason) return false;
    if (!Number.isFinite(size) || size <= 0 || !fillId) return this.stop('invalid-fill-evidence');
    this.cumulativeFilledBTC += size;
    // Do not replenish after the first fill. With the required cap covering
    // both initial 0.0005 BTC orders, the already-resting remainder cannot
    // take the cumulative test beyond its approved envelope.
    this.placementPausedAfterFill = true;
    if (!this.pendingMarkouts.has(fillId)) {
      const timer = this.setTimer(
        () => this.stop('one-minute-markout-unavailable'),
        this.config.oneMinuteMarkoutDeadlineMs,
      );
      this.pendingMarkouts.set(fillId, timer);
    }
    if (this.cumulativeFilledBTC >= this.config.maxCumulativeFilledBTC) return this.stop('cumulative-fill-cap');
    return true;
  }

  recordMarkout({ fillId, available, attributed, observedEdgeBps } = {}) {
    if (!this.config.enabled || this.stopReason || !this.pendingMarkouts.has(fillId)) return false;
    this.clearTimer(this.pendingMarkouts.get(fillId));
    this.pendingMarkouts.delete(fillId);
    if (available !== true || attributed !== true || !Number.isFinite(observedEdgeBps)) {
      return this.stop('one-minute-markout-unavailable');
    }
    if (observedEdgeBps < 0) {
      return this.stop('adverse-one-minute-markout');
    }
    return true;
  }

  stop(reason) {
    if (!this.config.enabled || this.stopReason) return false;
    this.stopReason = reason || 'stopped';
    if (this.timer !== null) this.clearTimer(this.timer);
    for (const timer of this.pendingMarkouts.values()) this.clearTimer(timer);
    this.pendingMarkouts.clear();
    this.timer = null;
    this.stopFn(this.stopReason);
    return false;
  }

  dispose() {
    if (this.timer !== null) this.clearTimer(this.timer);
    for (const timer of this.pendingMarkouts.values()) this.clearTimer(timer);
    this.pendingMarkouts.clear();
    this.timer = null;
  }

  snapshot() {
    return Object.freeze({ enabled: this.config.enabled, startedAt: this.startedAt,
      stopReason: this.stopReason, cumulativeFilledBTC: this.cumulativeFilledBTC,
      pendingOneMinuteMarkouts: this.pendingMarkouts.size });
  }
}
