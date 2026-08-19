import { randomUUID } from 'node:crypto';

const CRYPTOCOM_PUBLIC_MARKET_ENDPOINT = 'wss://stream.crypto.com/exchange/v1/market';

const STRING_FIELDS = [
  'product', 'quoteCurrency', 'sourceExchange', 'sourceType',
];
const NONNEGATIVE_INTEGER_FIELDS = [
  'maxSourceAgeMs', 'maxLatenessMs', 'maxAbsBasisAdjustmentBps',
];
const POSITIVE_INTEGER_FIELDS = [
  'pollIntervalMs', 'batchSize', 'retentionMs', 'retentionSweepIntervalMs',
  'retentionBatchSize', 'retentionMaxBatchesPerSweep',
  'maxQuoteDecisionsPerSecond', 'planningFillEventsPerSecond',
  'retentionMaxDurationMs', 'retentionYieldMs', 'dbStatementTimeoutMs',
  'dbQueryTimeoutMs', 'dbLockTimeoutMs', 'maxPendingDecisionWrites',
  'maxPendingFillWrites',
  'telemetryWriteConcurrency', 'maxConsecutiveFillStarts',
  'fillHorizonSafetyMarginMs', 'auditMaxGroups', 'maxBasisRttMs',
];
const isOfficialCryptoComEndpoint = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname === 'stream.crypto.com' &&
      (url.port === '' || url.port === '443') && url.pathname === '/exchange/v1/market' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

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
  if (config.referenceMode === undefined) config.referenceMode = 'coinbase-basis';
  if (config.sourceInstrument === undefined) config.sourceInstrument = null;
  if (config.sourceChannel === undefined) config.sourceChannel = null;
  if (config.sourceEndpointAllowlist === undefined) config.sourceEndpointAllowlist = [];
  if (config.retentionBatchSize === undefined) config.retentionBatchSize = 10_000;
  if (config.retentionMaxBatchesPerSweep === undefined) config.retentionMaxBatchesPerSweep = 12;
  if (config.maxQuoteDecisionsPerSecond === undefined) config.maxQuoteDecisionsPerSecond = 10;
  if (config.planningFillEventsPerSecond === undefined) config.planningFillEventsPerSecond = 6;
  if (config.retentionMaxDurationMs === undefined) config.retentionMaxDurationMs = 30_000;
  if (config.retentionYieldMs === undefined) config.retentionYieldMs = 10;
  if (config.dbStatementTimeoutMs === undefined) config.dbStatementTimeoutMs = 2_000;
  if (config.dbQueryTimeoutMs === undefined) config.dbQueryTimeoutMs = 2_500;
  if (config.dbLockTimeoutMs === undefined) config.dbLockTimeoutMs = 500;
  if (config.maxPendingDecisionWrites === undefined) config.maxPendingDecisionWrites = 100;
  if (config.maxPendingFillWrites === undefined) config.maxPendingFillWrites = 80;
  if (config.telemetryWriteConcurrency === undefined) config.telemetryWriteConcurrency = 4;
  if (config.maxConsecutiveFillStarts === undefined) config.maxConsecutiveFillStarts = 10;
  if (config.fillHorizonSafetyMarginMs === undefined) config.fillHorizonSafetyMarginMs = 1_000;
  for (const field of STRING_FIELDS) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
    config[field] = config[field].trim();
  }
  if (config.referenceMode === 'cryptocom-direct') {
    if (config.product !== 'BTC-PYUSD' || config.quoteCurrency !== 'PYUSD' ||
        config.sourceExchange !== 'cryptocom' || config.sourceType !== 'public-ws-book' ||
        config.sourceInstrument !== 'BTC_PYUSD' || config.sourceChannel !== 'book.BTC_PYUSD.10') {
      throw new Error('direct reference source must be Crypto.com BTC_PYUSD book depth 10');
    }
    if (!Array.isArray(config.sourceEndpointAllowlist) || config.sourceEndpointAllowlist.length < 1 ||
        config.sourceEndpointAllowlist.some(value => !isOfficialCryptoComEndpoint(value))) {
      throw new Error('sourceEndpointAllowlist must contain only the exact official Crypto.com endpoint');
    }
    config.sourceEndpointAllowlist = Object.freeze([CRYPTOCOM_PUBLIC_MARKET_ENDPOINT]);
    config.basisVenueAllowlist = Object.freeze([]);
  } else if (config.referenceMode === 'coinbase-basis') {
    for (const field of ['basisSource', 'basisRequestedPair', 'basisResolvedPair',
      'basisBase', 'basisQuote', 'basisSystem']) {
      if (typeof config[field] !== 'string' || config[field].trim() === '') {
        throw new Error(`${field} must be a non-empty string`);
      }
      config[field] = config[field].trim();
    }
    if (config.product !== 'BTC-USD' || config.quoteCurrency !== 'USD' ||
        config.sourceExchange !== 'coinbase' || config.sourceType !== 'top-of-book') {
      throw new Error('reference source must be Coinbase BTC-USD top-of-book quoted in USD');
    }
    if (config.basisSource !== 'kraken-pretrade' || config.basisResolvedPair !== 'PYUSD/USD' ||
        config.basisBase !== 'PYUSD' || config.basisQuote !== 'USD' || config.basisSystem !== 'CLOB') {
      throw new Error('basis identity must be Kraken PreTrade PYUSD/USD CLOB');
    }
    if (!Array.isArray(config.basisVenueAllowlist) || config.basisVenueAllowlist.length === 0 ||
        config.basisVenueAllowlist.some(value => typeof value !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,32}$/.test(value))) {
      throw new Error('basisVenueAllowlist must contain at least one valid configured venue');
    }
    config.basisVenueAllowlist = Object.freeze([...new Set(config.basisVenueAllowlist)]);
  } else {
    throw new Error('referenceMode must be coinbase-basis or cryptocom-direct');
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
  if (config.retentionBatchSize > 10_000) {
    throw new Error('retentionBatchSize must be at most 10000');
  }
  if (config.retentionMaxBatchesPerSweep > 100 || config.maxQuoteDecisionsPerSecond > 100 ||
      config.planningFillEventsPerSecond > 100 || config.telemetryWriteConcurrency > 20) {
    throw new Error('retention batch count and quote-decision rate must be at most 100');
  }
  const observationsPerSweep = Math.ceil(config.retentionSweepIntervalMs / config.pollIntervalMs);
  const decisionsPerSweep = Math.ceil(config.retentionSweepIntervalMs / 1_000) *
    config.maxQuoteDecisionsPerSecond;
  const workRowsPerSweep = Math.ceil(config.retentionSweepIntervalMs / 1_000) *
    config.planningFillEventsPerSecond * config.horizonsMs.length;
  if (config.retentionBatchSize * config.retentionMaxBatchesPerSweep <
      Math.max(observationsPerSweep, decisionsPerSweep, workRowsPerSweep)) {
    throw new Error('retention throughput must cover configured observation, quote-decision, and horizon-work rates');
  }
  if (config.dbLockTimeoutMs > config.dbStatementTimeoutMs ||
      config.dbStatementTimeoutMs > config.dbQueryTimeoutMs) {
    throw new Error('database timeouts must satisfy lock <= statement <= query');
  }
  if (config.referenceMode === 'coinbase-basis' && config.maxBasisRttMs > config.maxSourceAgeMs) {
    throw new Error('maxBasisRttMs must not exceed maxSourceAgeMs');
  }
  if (config.retentionMaxDurationMs >= config.retentionSweepIntervalMs ||
      config.dbQueryTimeoutMs + config.retentionYieldMs >= config.retentionMaxDurationMs) {
    throw new Error('retention duration must exceed one query plus yield and remain below sweep interval');
  }
  const boundedDecisionOutstanding = Math.ceil(config.maxQuoteDecisionsPerSecond *
    config.dbQueryTimeoutMs / 1_000);
  const boundedFillOutstanding = Math.ceil(config.planningFillEventsPerSecond *
    config.dbQueryTimeoutMs / 1_000);
  if (config.maxPendingDecisionWrites < boundedDecisionOutstanding ||
      config.maxPendingFillWrites < boundedFillOutstanding) {
    throw new Error('pending write lanes must cover their planned bounded database windows');
  }
  if (config.maxConsecutiveFillStarts > 100) {
    throw new Error('maxConsecutiveFillStarts must be at most 100');
  }
  const fairnessDecisionStarts = Math.ceil(config.maxPendingFillWrites /
    config.maxConsecutiveFillStarts);
  const worstAdmittedFillLatencyMs = (1 + Math.ceil((config.maxPendingFillWrites +
    fairnessDecisionStarts) / config.telemetryWriteConcurrency)) * config.dbQueryTimeoutMs;
  if (worstAdmittedFillLatencyMs + config.fillHorizonSafetyMarginMs >= config.horizonsMs[0]) {
    throw new Error('fill queue capacity and database bound exceed the earliest horizon');
  }
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
    sourceFeed = null,
    config, logger = console, now = () => Date.now(), monotonicNow = () => performance.now(),
    yieldFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
    claimTokenNamespace = randomUUID() } = {}) {
    this.config = validateReferenceMarkoutConfig(config);
    this.writer = writer;
    this.marketProvider = marketProvider;
    this.basisProvider = basisProvider;
    this.sourceFeed = sourceFeed;
    this.logger = logger;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.yieldFn = yieldFn;
    if (typeof claimTokenNamespace !== 'string' || claimTokenNamespace.length === 0) {
      throw new Error('claimTokenNamespace must be a non-empty string');
    }
    this._claimTokenNamespace = claimTokenNamespace;
    this._processing = false;
    this._timer = null;
    this._retentionTimer = null;
    this._retentionProcessing = false;
    this._claimSequence = 0;
    this._lastRetentionSweepAt = null;
    this._fillWriteQueue = [];
    this._decisionWriteQueue = [];
    this._telemetryWritesActive = 0;
    this._consecutiveFillStarts = 0;
    this.stats = {
      decisionsRecorded: 0, fillsScheduled: 0, observationsCompleted: 0,
      unavailableCompleted: 0, claimsReleased: 0, persistenceErrors: 0,
      processCycles: 0, marketObservationsRecorded: 0,
      promotionGradeMarketObservationsRecorded: 0,
      lastCycleAt: null, lastMarketObservationAt: null,
      lastErrorReason: null, lastErrorAt: null,
      retentionRowsPruned: { work: 0, decisions: 0, observations: 0 },
      retentionBacklog: { work: false, decisions: false, observations: false },
      lastRetentionSweepAt: null,
      openWindow: false, samplingState: 'idle-no-open-window',
      invalidSampleReasons: {}, telemetryWritesActive: 0, telemetryWritesWaiting: 0,
      telemetryWritesRejected: 0,
      fillWritesWaiting: 0, decisionWritesWaiting: 0,
      fillWritesRejected: 0, decisionWritesRejected: 0,
      consecutiveFillStarts: 0, maxConsecutiveFillStartsObserved: 0,
      decisionFairnessStarts: 0,
    };
  }

  setWriter(writer) {
    this.writer = writer;
  }

  getStats() {
    const config = Object.freeze({
      product: this.config.product,
      referenceMode: this.config.referenceMode,
      quoteCurrency: this.config.quoteCurrency,
      sourceExchange: this.config.sourceExchange,
      sourceType: this.config.sourceType,
      sourceInstrument: this.config.sourceInstrument || null,
      sourceChannel: this.config.sourceChannel || null,
      sourceEndpointAllowlist: Object.freeze([...(this.config.sourceEndpointAllowlist || [])]),
      horizonsMs: Object.freeze([...this.config.horizonsMs]),
      maxSourceAgeMs: this.config.maxSourceAgeMs,
      maxLatenessMs: this.config.maxLatenessMs,
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
      claimLeaseMs: this.config.claimLeaseMs,
      retentionMs: this.config.retentionMs,
      retentionSweepIntervalMs: this.config.retentionSweepIntervalMs,
      retentionBatchSize: this.config.retentionBatchSize,
      retentionMaxBatchesPerSweep: this.config.retentionMaxBatchesPerSweep,
      maxQuoteDecisionsPerSecond: this.config.maxQuoteDecisionsPerSecond,
      planningFillEventsPerSecond: this.config.planningFillEventsPerSecond,
      retentionMaxDurationMs: this.config.retentionMaxDurationMs,
      retentionYieldMs: this.config.retentionYieldMs,
      dbStatementTimeoutMs: this.config.dbStatementTimeoutMs,
      dbQueryTimeoutMs: this.config.dbQueryTimeoutMs,
      dbLockTimeoutMs: this.config.dbLockTimeoutMs,
      maxPendingDecisionWrites: this.config.maxPendingDecisionWrites,
      maxPendingFillWrites: this.config.maxPendingFillWrites,
      telemetryWriteConcurrency: this.config.telemetryWriteConcurrency,
      maxConsecutiveFillStarts: this.config.maxConsecutiveFillStarts,
      fillHorizonSafetyMarginMs: this.config.fillHorizonSafetyMarginMs,
      auditMaxGroups: this.config.auditMaxGroups,
      maxAbsBasisAdjustmentBps: this.config.maxAbsBasisAdjustmentBps,
      basisSource: this.config.basisSource,
      basisRequestedPair: this.config.basisRequestedPair,
      basisResolvedPair: this.config.basisResolvedPair,
      basisBase: this.config.basisBase,
      basisQuote: this.config.basisQuote,
      basisSystem: this.config.basisSystem,
      basisVenueAllowlist: Object.freeze([...this.config.basisVenueAllowlist]),
      maxBasisRttMs: this.config.maxBasisRttMs,
    });
    return {
      ...this.stats,
      retentionRowsPruned: Object.freeze({ ...this.stats.retentionRowsPruned }),
      retentionBacklog: Object.freeze({ ...this.stats.retentionBacklog }),
      invalidSampleReasons: Object.freeze({ ...this.stats.invalidSampleReasons }),
      persistence: Object.freeze({ ...(this.writer?.getReferencePersistenceStats?.() || {}) }),
      running: this._timer !== null,
      source: this.sourceFeed?.getStats?.() || null,
      config,
    };
  }

  start() {
    if (this._timer) return;
    try { this.sourceFeed?.start?.(); } catch (error) {
      this._warn('reference source start failed', error);
    }
    this.processDue().catch(error => this._warn('initial due processing failed', error));
    this._timer = setInterval(() => {
      this.processDue().catch(error => this._warn('due processing failed', error));
    }, this.config.pollIntervalMs);
    this.runRetentionSweep().catch(error => this._warn('retention sweep failed', error));
    this._retentionTimer = setInterval(() => {
      this.runRetentionSweep().catch(error => this._warn('retention sweep failed', error));
    }, this.config.retentionSweepIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._retentionTimer) clearInterval(this._retentionTimer);
    this._retentionTimer = null;
    try { this.sourceFeed?.stop?.(); } catch (error) {
      this._warn('reference source stop failed', error);
    }
  }

  _warn(message, error) {
    this.stats.persistenceErrors += 1;
    this.stats.lastErrorReason = message;
    const errorAt = this.now();
    this.stats.lastErrorAt = finiteTimestamp(errorAt) ? errorAt : Date.now();
    this.logger.warn?.(`[ReferenceMarkoutCollector] ${message}: ${error?.message || error}`);
  }

  _pumpTelemetryWrites() {
    while (this._telemetryWritesActive < this.config.telemetryWriteConcurrency &&
        (this._fillWriteQueue.length > 0 || this._decisionWriteQueue.length > 0)) {
      const forceDecision = this._fillWriteQueue.length > 0 && this._decisionWriteQueue.length > 0 &&
        this._consecutiveFillStarts >= this.config.maxConsecutiveFillStarts;
      const item = forceDecision
        ? this._decisionWriteQueue.shift()
        : (this._fillWriteQueue.shift() || this._decisionWriteQueue.shift());
      if (item.kind === 'fill scheduling') {
        this._consecutiveFillStarts = Math.min(this.config.maxConsecutiveFillStarts,
          this._consecutiveFillStarts + 1);
        this.stats.maxConsecutiveFillStartsObserved = Math.max(
          this.stats.maxConsecutiveFillStartsObserved, this._consecutiveFillStarts);
      } else {
        if (forceDecision) this.stats.decisionFairnessStarts += 1;
        this._consecutiveFillStarts = 0;
      }
      this.stats.consecutiveFillStarts = this._consecutiveFillStarts;
      this._telemetryWritesActive += 1;
      this.stats.telemetryWritesActive = this._telemetryWritesActive;
      this._syncWriteQueueStats();
      Promise.resolve().then(item.operation).then(item.resolve, error => {
        this._warn(`${item.kind} persistence failed`, error);
        item.resolve(false);
      }).finally(() => {
        this._telemetryWritesActive -= 1;
        this.stats.telemetryWritesActive = this._telemetryWritesActive;
        this._syncWriteQueueStats();
        this._pumpTelemetryWrites();
      });
    }
  }

  _syncWriteQueueStats() {
    this.stats.fillWritesWaiting = this._fillWriteQueue.length;
    this.stats.decisionWritesWaiting = this._decisionWriteQueue.length;
    this.stats.telemetryWritesWaiting = this._fillWriteQueue.length + this._decisionWriteQueue.length;
  }

  _enqueuePersistence(kind, operation) {
    const isFill = kind === 'fill scheduling';
    const queue = isFill ? this._fillWriteQueue : this._decisionWriteQueue;
    const capacity = isFill ? this.config.maxPendingFillWrites : this.config.maxPendingDecisionWrites;
    if (queue.length >= capacity) {
      this.stats.telemetryWritesRejected += 1;
      if (isFill) this.stats.fillWritesRejected += 1;
      else this.stats.decisionWritesRejected += 1;
      this._warn(`${kind} queue saturated`, new Error('bounded telemetry queue at capacity'));
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const item = { kind, operation, resolve };
      queue.push(item);
      this._syncWriteQueueStats();
      this._pumpTelemetryWrites();
    });
  }

  _basisAt(observationTimestamp, basisInput) {
    const basis = basisInput === undefined ? this.basisProvider?.() : basisInput;
    if (!basis) return { reason: 'missing-basis' };
    if (basis.source !== this.config.basisSource) {
      return { reason: 'non-promotion-grade-basis-source' };
    }
    if (!finiteTimestamp(basis.basisTimestamp) || !finitePositive(basis.price) ||
        !finitePositive(basis.bid) || !finitePositive(basis.ask) || basis.bid > basis.ask ||
        !finitePositive(basis.bidQty) || !finitePositive(basis.askQty) ||
        !Number.isSafeInteger(basis.bidCount) || basis.bidCount <= 0 ||
        !Number.isSafeInteger(basis.askCount) || basis.askCount <= 0) {
      return { reason: 'invalid-basis' };
    }
    const identityMatches = basis.source === this.config.basisSource &&
      basis.requestedPair === this.config.basisRequestedPair &&
      basis.resolvedPair === this.config.basisResolvedPair && basis.base === this.config.basisBase &&
      basis.quote === this.config.basisQuote && basis.system === this.config.basisSystem;
    if (!identityMatches) return { reason: 'basis-identity-mismatch' };
    if (!this.config.basisVenueAllowlist.includes(basis.venue)) {
      return { reason: 'basis-venue-not-allowed' };
    }
    const requiredTimestamps = [basis.requestTimestamp, basis.receivedTimestamp,
      basis.bidPublicationTimestamp, basis.askPublicationTimestamp];
    if (requiredTimestamps.some(value => !finiteTimestamp(value))) {
      return { reason: 'invalid-basis-timestamp' };
    }
    const submissionMissing = basis.bidSubmissionTimestamp === null ||
      basis.bidSubmissionTimestamp === undefined || basis.askSubmissionTimestamp === null ||
      basis.askSubmissionTimestamp === undefined;
    const optionalSubmissionValid = value => value === null || value === undefined ||
      finiteTimestamp(value);
    if (!optionalSubmissionValid(basis.bidSubmissionTimestamp) ||
        !optionalSubmissionValid(basis.askSubmissionTimestamp)) {
      return { reason: 'invalid-basis-timestamp' };
    }
    if (basis.requestTimestamp > basis.receivedTimestamp) {
      return { reason: 'invalid-basis-request-order' };
    }
    if ((basis.bidSubmissionTimestamp !== null && basis.bidSubmissionTimestamp !== undefined &&
        basis.bidSubmissionTimestamp > basis.bidPublicationTimestamp) ||
        (basis.askSubmissionTimestamp !== null && basis.askSubmissionTimestamp !== undefined &&
        basis.askSubmissionTimestamp > basis.askPublicationTimestamp) ||
        basis.bidPublicationTimestamp > basis.receivedTimestamp ||
        basis.askPublicationTimestamp > basis.receivedTimestamp) {
      return { reason: 'invalid-basis-side-order' };
    }
    if (basis.receivedTimestamp > observationTimestamp) {
      return { reason: 'lookahead-basis-receipt' };
    }
    if (basis.receivedTimestamp - basis.requestTimestamp > this.config.maxBasisRttMs) {
      return { reason: 'basis-rtt-exceeded' };
    }
    const conservativeTimestamp = Math.min(
      basis.bidPublicationTimestamp, basis.askPublicationTimestamp,
    );
    if (basis.basisTimestamp !== conservativeTimestamp) {
      return { reason: 'basis-timestamp-mismatch' };
    }
    const midpoint = (basis.bid + basis.ask) / 2;
    if (Math.abs(midpoint - basis.price) > Math.max(1e-12, midpoint * 1e-12)) {
      return { reason: 'basis-midpoint-mismatch' };
    }
    if (basis.basisTimestamp > observationTimestamp) return { reason: 'lookahead-basis' };
    if (observationTimestamp - basis.bidPublicationTimestamp > this.config.maxSourceAgeMs ||
        observationTimestamp - basis.askPublicationTimestamp > this.config.maxSourceAgeMs ||
        observationTimestamp - basis.receivedTimestamp > this.config.maxSourceAgeMs) {
      return { reason: 'stale-basis' };
    }
    // Coinbase is USD-quoted while fills are PYUSD-quoted. PYUSD/USD is USD per
    // PYUSD, so converting USD prices to PYUSD requires multiplication by 1/price.
    const basisAdjustmentBps = (1 / basis.price - 1) * 10_000;
    if (Math.abs(basisAdjustmentBps) > this.config.maxAbsBasisAdjustmentBps) {
      return { reason: 'basis-out-of-bounds' };
    }
    const provenance = {
      basisTimestamp: basis.basisTimestamp, basisPrice: basis.price, basisAdjustmentBps,
      basisSource: basis.source, basisRequestedPair: basis.requestedPair,
      basisResolvedPair: basis.resolvedPair, basisBase: basis.base, basisQuote: basis.quote,
      basisVenue: basis.venue, basisSystem: basis.system,
      basisRequestTimestamp: basis.requestTimestamp,
      basisReceivedTimestamp: basis.receivedTimestamp,
      basisBid: basis.bid, basisAsk: basis.ask, basisBidQty: basis.bidQty,
      basisAskQty: basis.askQty, basisBidCount: basis.bidCount, basisAskCount: basis.askCount,
      basisBidSubmissionTimestamp: basis.bidSubmissionTimestamp,
      basisBidPublicationTimestamp: basis.bidPublicationTimestamp,
      basisAskSubmissionTimestamp: basis.askSubmissionTimestamp,
      basisAskPublicationTimestamp: basis.askPublicationTimestamp,
      promotionGrade: !submissionMissing,
    };
    return submissionMissing
      ? { reason: 'missing-basis-submission-provenance', diagnosticPersistable: true, ...provenance }
      : provenance;
  }

  _observe({ observationTimestamp, notBeforeTimestamp = null, notAfterTimestamp = null,
    marketInput, basisInput }) {
    if (notBeforeTimestamp !== null && observationTimestamp < notBeforeTimestamp) {
      return this._unavailable('before-due', observationTimestamp);
    }
    const afterDeadline = notAfterTimestamp !== null && observationTimestamp > notAfterTimestamp;
    const market = marketInput === undefined ? this.marketProvider?.() : marketInput;
    const source = this.config.referenceMode === 'cryptocom-direct'
      ? market
      : market?.sources?.find(item => item?.exchange === this.config.sourceExchange);
    if (!source) {
      return this._unavailable(afterDeadline ? 'after-deadline' : 'missing-book',
        observationTimestamp);
    }
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
    if (this.config.referenceMode === 'cryptocom-direct') {
      if (source.exchange !== this.config.sourceExchange ||
          source.sourceType !== this.config.sourceType ||
          source.instrument !== this.config.sourceInstrument ||
          source.channel !== this.config.sourceChannel ||
          !this.config.sourceEndpointAllowlist.includes(source.sourceEndpoint)) {
        return this._unavailable('source-identity-mismatch', observationTimestamp);
      }
      if (!Number.isSafeInteger(source.sequence) || source.sequence < 0 ||
          !Number.isSafeInteger(source.generation) || source.generation <= 0 ||
          typeof source.sourceSessionId !== 'string' || source.sourceSessionId.length < 8 ||
          source.sourceSessionId.length > 64 ||
          typeof source.sourceBookHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceBookHash) ||
          source.depth !== 10 || !finitePositive(source.bidQty) || !finitePositive(source.askQty) ||
          !Number.isSafeInteger(source.bidCount) || source.bidCount <= 0 ||
          !Number.isSafeInteger(source.askCount) || source.askCount <= 0 ||
          !finiteTimestamp(source.bookUpdateTimestamp) || source.bookUpdateTimestamp > sourceTimestamp) {
        return this._unavailable('invalid-source-provenance', observationTimestamp);
      }
      const directEvidence = {
        available: true, unavailableReason: null, observationTimestamp,
        referenceMode: 'cryptocom-direct',
        product: this.config.product, quoteCurrency: this.config.quoteCurrency,
        sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
        sourceTimestamp, receivedTimestamp, bid, ask, midpoint: (bid + ask) / 2,
        basisTimestamp: null, basisPrice: null, basisAdjustmentBps: 0,
        sourceInstrument: source.instrument, sourceChannel: source.channel,
        sourceSequence: source.sequence, sourceGeneration: source.generation,
        sourceSessionId: source.sourceSessionId,
        sourceEndpoint: source.sourceEndpoint, sourceBookHash: source.sourceBookHash,
        sourceDepth: source.depth, sourceBidQty: source.bidQty, sourceAskQty: source.askQty,
        sourceBidCount: source.bidCount, sourceAskCount: source.askCount,
        sourceBookUpdateTimestamp: source.bookUpdateTimestamp, promotionGrade: true,
      };
      return afterDeadline
        ? this._unavailable('after-deadline', observationTimestamp, true, directEvidence)
        : directEvidence;
    }
    const basis = this._basisAt(observationTimestamp, basisInput);
    const evidence = {
      available: true, unavailableReason: null, observationTimestamp,
      product: this.config.product, quoteCurrency: this.config.quoteCurrency,
      sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
      sourceTimestamp, receivedTimestamp, bid, ask, midpoint: (bid + ask) / 2,
      ...basis,
    };
    if (basis.reason) {
      return basis.diagnosticPersistable
        ? this._unavailable(afterDeadline ? 'after-deadline' : basis.reason,
          observationTimestamp, true, evidence)
        : this._unavailable(basis.reason, observationTimestamp);
    }
    return afterDeadline
      ? this._unavailable('after-deadline', observationTimestamp, true, evidence)
      : evidence;
  }

  _unavailable(unavailableReason, observationTimestamp, countSample = true, preserved = {}) {
    if (countSample) {
      this.stats.invalidSampleReasons[unavailableReason] =
        (this.stats.invalidSampleReasons[unavailableReason] || 0) + 1;
    }
    return {
      available: false, unavailableReason, observationTimestamp,
      product: this.config.product, quoteCurrency: this.config.quoteCurrency,
      sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
      sourceTimestamp: null, receivedTimestamp: null, bid: null, ask: null, midpoint: null,
      basisTimestamp: null, basisPrice: null, basisAdjustmentBps: null,
      basisSource: null, basisRequestedPair: null, basisResolvedPair: null,
      basisBase: null, basisQuote: null, basisVenue: null, basisSystem: null,
      basisRequestTimestamp: null, basisReceivedTimestamp: null,
      basisBid: null, basisAsk: null, basisBidQty: null, basisAskQty: null,
      basisBidCount: null, basisAskCount: null,
      basisBidSubmissionTimestamp: null, basisBidPublicationTimestamp: null,
      basisAskSubmissionTimestamp: null, basisAskPublicationTimestamp: null,
      promotionGrade: false,
      referenceMode: this.config.referenceMode,
      sourceInstrument: null, sourceChannel: null, sourceSequence: null,
      sourceGeneration: null, sourceSessionId: null, sourceBookUpdateTimestamp: null,
      sourceEndpoint: null, sourceBookHash: null, sourceDepth: null,
      sourceBidQty: null, sourceAskQty: null, sourceBidCount: null, sourceAskCount: null,
      ...preserved,
      available: false, unavailableReason, observationTimestamp,
    };
  }

  async recordQuoteDecision(event = {}) {
    if (!this.writer?.recordReferenceQuoteDecision) return false;
    try {
      const decisionTimestamp = finiteTimestamp(event.decisionTimestamp)
        ? event.decisionTimestamp : this.now();
      const observation = this._observe({ observationTimestamp: decisionTimestamp });
      return this._enqueuePersistence('quote decision', async () => {
        await this.writer.recordReferenceQuoteDecision({ ...event, decisionTimestamp, ...observation });
        this.stats.decisionsRecorded += 1;
        return true;
      });
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
      return this._enqueuePersistence('fill scheduling', async () => {
        await this.writer.scheduleReferenceMarkouts({
          ...fill, fillTimestamp, horizonsMs, dueTimestamps, deadlineTimestamps,
          product: this.config.product, quoteCurrency: this.config.quoteCurrency,
          sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
        });
        this.stats.fillsScheduled += 1;
        return true;
      });
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

  async _runRetentionSweep(cutoffTimestamp) {
    const batchSize = this.config.retentionBatchSize;
    const maxBatches = this.config.retentionMaxBatchesPerSweep;
    const startedAt = this.monotonicNow();
    const targets = [
      ['work', 'pruneReferenceMarkoutEvidence'],
      ['decisions', 'pruneReferenceQuoteDecisions'],
      ['observations', 'pruneReferenceMarketObservations'],
    ];
    for (const [label, method] of targets) {
      if (typeof this.writer?.[method] !== 'function') continue;
      let lastRows = 0;
      let batches = 0;
      do {
        if (this.monotonicNow() - startedAt + this.config.dbQueryTimeoutMs >
            this.config.retentionMaxDurationMs) {
          this.stats.retentionBacklog[label] = true;
          for (const [remainingLabel] of targets.slice(targets.findIndex(([name]) => name === label) + 1)) {
            this.stats.retentionBacklog[remainingLabel] = true;
          }
          return;
        }
        const result = await this.writer[method](cutoffTimestamp, batchSize);
        lastRows = Number.isSafeInteger(result?.rowCount) && result.rowCount >= 0
          ? result.rowCount : 0;
        this.stats.retentionRowsPruned[label] += lastRows;
        batches += 1;
        if (lastRows === batchSize && this.config.retentionYieldMs > 0) {
          if (this.monotonicNow() - startedAt + this.config.retentionYieldMs +
              this.config.dbQueryTimeoutMs >= this.config.retentionMaxDurationMs) {
            this.stats.retentionBacklog[label] = true;
            for (const [remainingLabel] of targets.slice(
              targets.findIndex(([name]) => name === label) + 1)) {
              this.stats.retentionBacklog[remainingLabel] = true;
            }
            return;
          }
          await this.yieldFn(this.config.retentionYieldMs);
        }
      } while (lastRows === batchSize && batches < maxBatches);
      this.stats.retentionBacklog[label] = batches === maxBatches && lastRows === batchSize;
    }
    this.stats.lastRetentionSweepAt = this.now();
  }

  async runRetentionSweep() {
    if (this._retentionProcessing) return { skipped: 'in-flight' };
    if (!this.writer?.pruneReferenceMarkoutEvidence) return { skipped: 'no-writer' };
    this._retentionProcessing = true;
    try {
      const now = this.now();
      await this._runRetentionSweep(now - this.config.retentionMs);
      this._lastRetentionSweepAt = now;
      return { completed: true };
    } finally {
      this._retentionProcessing = false;
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
      this.stats.lastCycleAt = now;
      // Capture one immutable cycle sample before claiming work. Production writers
      // persist it, allowing every work row (and a restarted process) to select the
      // same earliest valid observation rather than rereading mutable market state.
      let cycleMarket;
      let cycleBasis;
      const shouldSample = typeof this.writer.hasOpenReferenceMarkoutWindow !== 'function' ||
        await this.writer.hasOpenReferenceMarkoutWindow(now);
      this.stats.openWindow = shouldSample;
      this.stats.samplingState = shouldSample ? 'sampling-open-window' : 'idle-no-open-window';
      const persistCycleSample = async () => {
        cycleMarket = this.marketProvider?.();
        cycleBasis = this.basisProvider?.();
        const cycleObservation = this._observe({
          observationTimestamp: now, marketInput: cycleMarket, basisInput: cycleBasis,
        });
        if ((cycleObservation.available || cycleObservation.diagnosticPersistable === true) &&
            this.writer.recordReferenceMarketObservation) {
          const inserted = await this.writer.recordReferenceMarketObservation(cycleObservation);
          if (inserted === true) {
            this.stats.marketObservationsRecorded += 1;
            if (cycleObservation.promotionGrade === true) {
              this.stats.promotionGradeMarketObservationsRecorded += 1;
            }
            this.stats.lastMarketObservationAt = cycleObservation.observationTimestamp;
          }
        }
      };
      if (shouldSample) await persistCycleSample();
      const workItems = await this.writer.claimDueReferenceMarkouts({
        now, claimToken, leaseMs: this.config.claimLeaseMs, batchSize: this.config.batchSize,
      });
      result.claimed = workItems.length;
      // A horizon can be scheduled concurrently between the open-window check and
      // the atomic claim. Capture exactly one immutable batch sample in that race;
      // never fall through to per-work reads of mutable providers.
      if (!shouldSample && workItems.length > 0) await persistCycleSample();
      for (const work of workItems) {
        let observation;
        if (!finiteTimestamp(work.decisionTimestamp) || !work.quoteId ||
            !['buy', 'sell'].includes(work.side) || !Number.isSafeInteger(work.level) ||
            typeof work.policyId !== 'string' || work.policyId.length === 0) {
          observation = this._unavailable('missing-quote-attribution', now, false);
        } else {
          observation = this.writer.getFirstReferenceMarketObservation
            ? await this.writer.getFirstReferenceMarketObservation({
              dueTimestamp: work.dueTimestamp, deadlineTimestamp: work.deadlineTimestamp,
              product: this.config.product, quoteCurrency: this.config.quoteCurrency,
              sourceExchange: this.config.sourceExchange, sourceType: this.config.sourceType,
              referenceMode: this.config.referenceMode,
              sourceInstrument: this.config.sourceInstrument,
              sourceChannel: this.config.sourceChannel,
              sourceEndpointAllowlist: this.config.sourceEndpointAllowlist,
              maxSourceAgeMs: this.config.maxSourceAgeMs,
              maxAbsBasisAdjustmentBps: this.config.maxAbsBasisAdjustmentBps,
              basisSource: this.config.basisSource,
              basisRequestedPair: this.config.basisRequestedPair,
              basisResolvedPair: this.config.basisResolvedPair,
              basisBase: this.config.basisBase,
              basisQuote: this.config.basisQuote,
              basisSystem: this.config.basisSystem,
              basisVenueAllowlist: this.config.basisVenueAllowlist,
              maxBasisRttMs: this.config.maxBasisRttMs,
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
          ? (this.config.referenceMode === 'cryptocom-direct'
            ? observation.midpoint : observation.midpoint / observation.basisPrice)
          : null;
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
      return result;
    } catch (error) {
      this._warn('due processing failed', error);
      return { ...result, error: error.message };
    } finally {
      this._processing = false;
    }
  }
}
