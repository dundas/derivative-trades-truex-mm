const RECOVERABLE_GAP_REASONS = new Set([
  'buy-side-gap-exceeded',
  'sell-side-gap-exceeded',
]);

export function validateMakerPresenceRecoveryConfig(config = {}) {
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean');
  for (const field of ['cooldownMs', 'attemptWindowMs', 'rearmTimeoutMs']) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new Error(`${field} must be a finite positive number`);
    }
  }
  if (!Number.isInteger(config.maxAttemptsPerWindow) || config.maxAttemptsPerWindow < 1) {
    throw new Error('maxAttemptsPerWindow must be a positive integer');
  }
  return Object.freeze({ ...config });
}

/**
 * Bounded policy state for restoring a missing maker side. The controller has
 * no transport access: it can authorize an attempt, but the orchestrator must
 * obtain authoritative REST evidence before it rearms quote generation.
 */
export class MakerPresenceRecoveryController {
  constructor(config, { now = Date.now } = {}) {
    this.config = validateMakerPresenceRecoveryConfig(config);
    this.now = now;
    this.state = config.enabled ? 'monitoring' : 'disabled';
    this.attempts = [];
    this.inFlight = false;
    this.lastAttemptAt = null;
    this.rearmStartedAt = null;
    this.lastError = null;
  }

  observe(status, { authoritativeRecoveryAvailable = false } = {}) {
    const now = this.now();
    this._pruneAttempts(now);
    if (!this.config.enabled) return this.snapshot();

    if (status?.present?.twoSided) {
      this.state = 'monitoring';
      this.rearmStartedAt = null;
      this.lastError = null;
      return this.snapshot();
    }
    if (this.inFlight) return this.snapshot();
    if (status?.executionState === 'unsafe') {
      this.state = 'blocked-unsafe';
      return this.snapshot();
    }
    if (this.state === 'rearming' && now - this.rearmStartedAt < this.config.rearmTimeoutMs) {
      return this.snapshot();
    }
    if (this.state === 'rearming') {
      this.state = 'cooldown';
      this.lastError = 'two-sided-presence-not-restored-before-timeout';
    }

    const prolongedGap = status?.reasons?.some((reason) => RECOVERABLE_GAP_REASONS.has(reason));
    if (!prolongedGap) {
      this.state = 'monitoring';
      return this.snapshot();
    }
    if (!authoritativeRecoveryAvailable) {
      this.state = 'blocked-no-authoritative-rest';
      return this.snapshot();
    }
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.config.cooldownMs) {
      this.state = 'cooldown';
      return this.snapshot();
    }
    if (this.attempts.length >= this.config.maxAttemptsPerWindow) {
      this.state = 'blocked-attempt-budget';
      return this.snapshot();
    }

    this.inFlight = true;
    this.state = 'reconciling';
    this.lastAttemptAt = now;
    this.attempts.push(now);
    this.lastError = null;
    return { ...this.snapshot(), shouldRecover: true };
  }

  reconciled() {
    this.inFlight = false;
    this.state = 'rearming';
    this.rearmStartedAt = this.now();
  }

  failed(error) {
    this.inFlight = false;
    this.state = 'cooldown';
    this.lastError = error?.message || String(error || 'recovery-failed');
  }

  snapshot() {
    return {
      enabled: this.config.enabled,
      state: this.state,
      inFlight: this.inFlight,
      attemptsInWindow: this.attempts.length,
      maxAttemptsPerWindow: this.config.maxAttemptsPerWindow,
      lastAttemptAt: this.lastAttemptAt,
      rearmStartedAt: this.rearmStartedAt,
      lastError: this.lastError,
    };
  }

  _pruneAttempts(now) {
    this.attempts = this.attempts.filter((attemptedAt) => now - attemptedAt < this.config.attemptWindowMs);
  }
}
