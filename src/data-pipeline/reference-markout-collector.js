import { randomUUID } from 'node:crypto';

const STRING_FIELDS = ['product', 'quoteCurrency', 'sourceExchange', 'sourceType'];
const NONNEGATIVE_INTEGER_FIELDS = [
  'maxSourceAgeMs', 'maxLatenessMs', 'maxAbsBasisAdjustmentBps',
];
const POSITIVE_INTEGER_FIELDS = [
  'pollIntervalMs', 'batchSize', 'retentionMs', 'retentionSweepIntervalMs', 'auditMaxGroups',
];

function requireSafeInteger(name, value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

export function validateReferenceMarkoutConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('reference mark-out config must be an object');
  }
  const config = { ...input };
  for (const field of STRING_FIELDS) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
    config[field] = config[field].trim();
  }
  if (config.product !== 'BTC-USD' || config.quoteCurrency !== 'USD' ||
      config.sourceExchange !== 'coinbase' || config.sourceType !== 'top-of-book') {
    throw new Error('reference source must be Coinbase BTC-USD top-of-book quoted in USD');
  }
  if (!Array.isArray(config.horizonsMs) || config.horizonsMs.length === 0) {
    throw new Error('horizonsMs must be a non-empty array');
  }
  for (const horizon of config.horizonsMs) {
    requireSafeInteger('horizonsMs', horizon, { positive: true });
  }
  if (new Set(config.horizonsMs).size !== config.horizonsMs.length) {
    throw new Error('horizonsMs must contain unique values');
  }
  config.horizonsMs = [...config.horizonsMs].sort((a, b) => a - b);
  for (const field of NONNEGATIVE_INTEGER_FIELDS) requireSafeInteger(field, config[field]);
  for (const field of POSITIVE_INTEGER_FIELDS) requireSafeInteger(field, config[field], { positive: true });
  requireSafeInteger('claimLeaseMs', config.claimLeaseMs, { positive: true });
  if (config.claimLeaseMs < config.pollIntervalMs) {
    throw new Error('claimLeaseMs must be at least pollIntervalMs');
  }
  return Object.freeze(config);
}

function finiteTimestamp(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class ReferenceMarkoutCollector {
  constructor({ writer = null, marketProvider = () => null, basisProvider = () => null,
    config, logger = console, now = () => Date.now(), claimTokenNamespace = randomUUID() } = {}) {
    this.config = validateReferenceMarkoutConfig(config);
    this.writer = writer;
    this.marketProvider = marketProvider;
    this.basisProvider = basisProvider;
    this.logger = logger;
    this.now = now;
    if (typeof claimTokenNamespace !== 'string' || claimTokenNamespace.length === 0) {
      throw new Error('claimTokenNamespace must be a non-empty string');
    }
    this._claimTokenNamespace = claimTokenNamespace;
    this._processing = false;
    this._timer = null;
    this._claimSequence = 0;
    this._lastRetentionSweepAt = null;
    this.stats = {
      decisionsRecorded: 0, fillsScheduled: 0, observationsCompleted: 0,
      unavailableCompleted: 0, claimsReleased: 0, persistenceErrors: 0,
      processCycles: 0,
    };
  }

  setWriter(writer) {
    this.writer = writer;
  }

  getStats() {
    return { ...this.stats, running: this._timer !== null };
  }

  start() {
    if (this._timer) return;
    this.processDue().catch(error => this._warn('initial due processing failed', error));
    this._timer = setInterval(() => {
      this.processDue().catch(error => this._warn('due processing failed', error));
    }, this.config.pollIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _warn(message, error) {
    this.stats.persistenceErrors += 1;
    this.logger.warn?.(`[ReferenceMarkoutCollector] ${message}: ${error?.message || error}`);
  }

  _basisAt(observationTimestamp, basisInput) {
    const basis = basisInput === undefined ? this.basisProvider?.() : basisInput;
    if (!basis) return { reason: 'missing-basis' };
    if (!finiteTimestamp(basis.timestamp) || !finitePositive(basis.price)) {
      return { reason: 'invalid-basis' };
    }
    if (basis.timestamp > observationTimestamp) return { reason: 'lookahead-basis' };
    if (observationTimestamp - basis.timestamp > this.config.maxSourceAgeMs) {
      return { reason: 'stale-basis' };
    }
    // Coinbase is USD-quoted while fills are PYUSD-quoted. PYUSD/USD is USD per
    // PYUSD, so converting USD prices to PYUSD requires multiplication by 1/price.
    const basisAdjustmentBps = (1 / basis.price - 1) * 10_000;
    if (Math.abs(basisAdjustmentBps) > this.config.maxAbsBasisAdjustmentBps) {
      return { reason: 'basis-out-of-bounds' };
    }
    return { basisTimestamp: basis.timestamp, basisPrice: basis.price, basisAdjustmentBps };
  }

  _observe({ observationTimestamp, notBeforeTimestamp = null, notAfterTimestamp = null,
    marketInput, basisInput }) {
    if (notBeforeTimestamp !== null && observationTimestamp < notBeforeTimestamp) {
      return this._unavailable('before-due', observationTimestamp);
    }
    if (notAfterTimestamp !== null && observationTimestamp > notAfterTimestamp) {
      return this._unavailable('after-deadline', observationTimestamp);
    }
    const market = marketInput === undefined ? this.marketProvider?.() : marketInput;
    const source = market?.sources?.find(item =>
      item?.exchange === this.config.sourceExchange,
    );
    if (!source) return this._unavailable('missing-book', observationTimestamp);
    const { bid, ask, sourceTimestamp, receivedTimestamp } = source;
    if (!finitePositive(bid) || !finitePositive(ask)) {
      return this._unavailable('invalid-book', observationTimestamp);
    }
    if (bid > ask) return this._unavailable('crossed-book', observationTimestamp);
    if (!finiteTimestamp(sourceTimestamp) || !finiteTimestamp(receivedTimestamp)) {
      return this._unavailable('invalid-timestamp', observationTimestamp);
    }
    if (sourceTimestamp > receivedTimestamp) {
      return this._unavailable('invalid-timestamp-order', observationTimestamp);
    }
    if (sourceTimestamp > observationTimestamp || receivedTimestamp > observationTimestamp) {
      return this._unavailable('lookahead-source', observationTimestamp);
    }
    // Horizon eligibility is determined by when this immutable observation was
    // taken, not by requiring the underlying exchange tick to arrive after the
    // horizon. A still-fresh tick received just before due is valid evidence at
    // due; source/receipt must only be no-lookahead and fresh as of observation.
    if (observationTimestamp - sourceTimestamp > this.config.maxSourceAgeMs) {
      return this._unavailable('stale-source', observationTimestamp);
    }
    if (source.isStale === true) return this._unavailable('stale-source', observationTimestamp);
    const basis = this._basisAt(observationTimestamp, basisInput);
    if (basis.reason) return this._unavailable(basis.reason, observationTimestamp);
    return {
      available: true, unavailableReason: null, observationTimestamp,
      product: this.config.product, quoteCurrency: this.config.quoteCurrency,
      sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
      sourceTimestamp, receivedTimestamp, bid, ask, midpoint: (bid + ask) / 2,
      ...basis,
    };
  }

  _unavailable(unavailableReason, observationTimestamp) {
    return {
      available: false, unavailableReason, observationTimestamp,
      product: this.config.product, quoteCurrency: this.config.quoteCurrency,
      sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
      sourceTimestamp: null, receivedTimestamp: null, bid: null, ask: null, midpoint: null,
      basisTimestamp: null, basisPrice: null, basisAdjustmentBps: null,
    };
  }

  async recordQuoteDecision(event = {}) {
    if (!this.writer?.recordReferenceQuoteDecision) return false;
    try {
      const decisionTimestamp = finiteTimestamp(event.decisionTimestamp)
        ? event.decisionTimestamp : this.now();
      const observation = this._observe({ observationTimestamp: decisionTimestamp });
      await this.writer.recordReferenceQuoteDecision({ ...event, decisionTimestamp, ...observation });
      this.stats.decisionsRecorded += 1;
      return true;
    } catch (error) {
      this._warn('quote decision persistence failed', error);
      return false;
    }
  }

  async scheduleFill(fill = {}) {
    if (!this.writer?.scheduleReferenceMarkouts) return false;
    try {
      if (typeof fill.fillId !== 'string' || fill.fillId.length === 0) {
        throw new Error('fillId is required');
      }
      if (!['buy', 'sell'].includes(fill.side) || !finitePositive(fill.price)) {
        throw new Error('fill requires side buy/sell and a positive price');
      }
      const fillTimestamp = finiteTimestamp(fill.fillTimestamp) ? fill.fillTimestamp : this.now();
      const horizonsMs = [...this.config.horizonsMs];
      const dueTimestamps = horizonsMs.map(horizon => fillTimestamp + horizon);
      const deadlineTimestamps = dueTimestamps.map(due => due + this.config.maxLatenessMs);
      if ([...dueTimestamps, ...deadlineTimestamps].some(value => !Number.isSafeInteger(value))) {
        throw new Error('fill horizon timestamp exceeds safe integer range');
      }
      await this.writer.scheduleReferenceMarkouts({
        ...fill, fillTimestamp, horizonsMs, dueTimestamps, deadlineTimestamps,
        product: this.config.product, quoteCurrency: this.config.quoteCurrency,
        sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
      });
      this.stats.fillsScheduled += 1;
      return true;
    } catch (error) {
      this._warn('fill scheduling failed', error);
      return false;
    }
  }

  async getCoverageAudit(filters = {}) {
    if (!this.writer?.getReferenceMarkoutCoverage) {
      return { groups: [], truncated: false, limit: this.config.auditMaxGroups };
    }
    try {
      const requestedLimit = Number.isSafeInteger(filters.limit) && filters.limit > 0
        ? filters.limit : this.config.auditMaxGroups;
      return await this.writer.getReferenceMarkoutCoverage({
        ...filters, limit: Math.min(requestedLimit, this.config.auditMaxGroups),
      });
    } catch (error) {
      this._warn('coverage audit failed', error);
      return { groups: [], truncated: false, limit: this.config.auditMaxGroups, error: error.message };
    }
  }

  async processDue() {
    if (this._processing) return { skipped: 'in-flight' };
    if (!this.writer?.claimDueReferenceMarkouts) return { skipped: 'no-writer' };
    this._processing = true;
    const now = this.now();
    const claimToken = `markout:${this._claimTokenNamespace}:${now}:${++this._claimSequence}`;
    const result = { claimed: 0, completed: 0, released: 0 };
    try {
      this.stats.processCycles += 1;
      // Capture one immutable cycle sample before claiming work. Production writers
      // persist it, allowing every work row (and a restarted process) to select the
      // same earliest valid observation rather than rereading mutable market state.
      const cycleMarket = this.marketProvider?.();
      const cycleBasis = this.basisProvider?.();
      const cycleObservation = this._observe({
        observationTimestamp: now, marketInput: cycleMarket, basisInput: cycleBasis,
      });
      if (cycleObservation.available && this.writer.recordReferenceMarketObservation) {
        await this.writer.recordReferenceMarketObservation(cycleObservation);
      }
      const workItems = await this.writer.claimDueReferenceMarkouts({
        now, claimToken, leaseMs: this.config.claimLeaseMs, batchSize: this.config.batchSize,
      });
      result.claimed = workItems.length;
      for (const work of workItems) {
        let observation;
        if (!finiteTimestamp(work.decisionTimestamp) || !work.quoteId ||
            !['buy', 'sell'].includes(work.side) || !Number.isSafeInteger(work.level) ||
            typeof work.policyId !== 'string' || work.policyId.length === 0) {
          observation = this._unavailable('missing-quote-attribution', now);
        } else {
          observation = this.writer.getFirstReferenceMarketObservation
            ? await this.writer.getFirstReferenceMarketObservation({
              dueTimestamp: work.dueTimestamp, deadlineTimestamp: work.deadlineTimestamp,
              product: this.config.product, quoteCurrency: this.config.quoteCurrency,
              sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
              maxSourceAgeMs: this.config.maxSourceAgeMs,
              maxAbsBasisAdjustmentBps: this.config.maxAbsBasisAdjustmentBps,
            })
            : null;
          if (!observation) {
            observation = this._observe({
              observationTimestamp: now, notBeforeTimestamp: work.dueTimestamp,
              notAfterTimestamp: work.deadlineTimestamp, marketInput: cycleMarket,
              basisInput: cycleBasis,
            });
          }
        }
        if (!observation.available && now <= work.deadlineTimestamp) {
          await this.writer.releaseReferenceMarkoutClaim(work, claimToken, observation.unavailableReason);
          this.stats.claimsReleased += 1;
          result.released += 1;
          continue;
        }
        const adjustedMidpoint = observation.available
          ? observation.midpoint / observation.basisPrice : null;
        const observedEdgeBps = observation.available && finitePositive(work.price)
          ? (work.side === 'buy' ? adjustedMidpoint - work.price : work.price - adjustedMidpoint) /
            work.price * 10_000
          : null;
        await this.writer.completeReferenceMarkout(work, claimToken, {
          ...observation, adjustedMidpoint, observedEdgeBps,
        });
        this.stats.observationsCompleted += 1;
        if (!observation.available) this.stats.unavailableCompleted += 1;
        result.completed += 1;
      }
      if (this.writer.pruneReferenceMarkoutEvidence &&
          (this._lastRetentionSweepAt === null ||
            now - this._lastRetentionSweepAt >= this.config.retentionSweepIntervalMs)) {
        await this.writer.pruneReferenceMarkoutEvidence(now - this.config.retentionMs);
        await this.writer.pruneReferenceQuoteDecisions?.(now - this.config.retentionMs);
        await this.writer.pruneReferenceMarketObservations?.(now - this.config.retentionMs);
        this._lastRetentionSweepAt = now;
      }
      return result;
    } catch (error) {
      this._warn('due processing failed', error);
      return { ...result, error: error.message };
    } finally {
      this._processing = false;
    }
  }
}
