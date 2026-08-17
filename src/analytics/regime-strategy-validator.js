/**
 * Pure offline regime validation. This module intentionally has no imports and
 * no capability to dispatch orders, mutate configuration, or contact a venue.
 */

const HORIZONS = Object.freeze({ '1m': 60_000, '5m': 300_000, '60m': 3_600_000 });
const PROMOTION_GRADE_SOURCE_TYPES = Object.freeze([
  'top-of-book',
  'point-in-time-book',
  'equivalent-point-in-time',
]);

export const DEFAULT_REGIME_VALIDATOR_CONFIG = Object.freeze({
  clusterBurstMs: 1_000,
  priceTolerance: 0,
  decisionReferenceMaxAgeMs: 5_000,
  markoutReferenceMaxAgeMs: 30_000,
  heldOutDays: 5,
  primaryHorizon: '5m',
  regime: Object.freeze({ lookbackMs: 60_000, directionalMoveBps: 5, highVolatilityBps: 15, staleReferenceAgeMs: 5_000 }),
  sourceQuality: Object.freeze({ promotionGradeSourceTypes: PROMOTION_GRADE_SOURCE_TYPES, referenceProduct: 'BTC-USD', quoteCurrency: 'USD', maxAbsBasisAdjustmentBps: 25 }),
  bootstrap: Object.freeze({ iterations: 2_000, confidenceLevel: 0.95, seed: 17 }),
  gates: Object.freeze({ minReferenceCoverage: 0.95, minClusters: 100, minObservationDays: 5, minLowerBoundBps: 2, minShadowClusters: 100, minShadowFillSurvivalRate: 0.5 }),
});

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegative(value, label) {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function ratio(value, label) {
  finite(value, label);
  if (value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function validatePromotionSourceTypes(sourceTypes) {
  if (!Array.isArray(sourceTypes) || sourceTypes.length === 0
    || new Set(sourceTypes).size !== sourceTypes.length
    || sourceTypes.some(sourceType => !PROMOTION_GRADE_SOURCE_TYPES.includes(sourceType))) {
    throw new Error(`promotion-grade source types must be a non-empty unique subset of: ${PROMOTION_GRADE_SOURCE_TYPES.join(', ')}`);
  }
  return sourceTypes;
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function mergeConfig(config = {}) {
  const merged = {
    ...DEFAULT_REGIME_VALIDATOR_CONFIG,
    ...config,
    regime: { ...DEFAULT_REGIME_VALIDATOR_CONFIG.regime, ...config.regime },
    sourceQuality: { ...DEFAULT_REGIME_VALIDATOR_CONFIG.sourceQuality, ...config.sourceQuality },
    bootstrap: { ...DEFAULT_REGIME_VALIDATOR_CONFIG.bootstrap, ...config.bootstrap },
    gates: { ...DEFAULT_REGIME_VALIDATOR_CONFIG.gates, ...config.gates },
  };
  nonNegativeInteger(merged.clusterBurstMs, 'clusterBurstMs');
  nonNegative(merged.priceTolerance, 'priceTolerance');
  nonNegativeInteger(merged.decisionReferenceMaxAgeMs, 'decisionReferenceMaxAgeMs');
  nonNegativeInteger(merged.markoutReferenceMaxAgeMs, 'markoutReferenceMaxAgeMs');
  positiveInteger(merged.heldOutDays, 'heldOutDays');
  nonNegativeInteger(merged.regime.lookbackMs, 'regime.lookbackMs');
  nonNegative(merged.regime.directionalMoveBps, 'regime.directionalMoveBps');
  nonNegative(merged.regime.highVolatilityBps, 'regime.highVolatilityBps');
  nonNegativeInteger(merged.regime.staleReferenceAgeMs, 'regime.staleReferenceAgeMs');
  positiveInteger(merged.bootstrap.iterations, 'bootstrap.iterations');
  if (!(Number.isFinite(merged.bootstrap.confidenceLevel) && merged.bootstrap.confidenceLevel > 0 && merged.bootstrap.confidenceLevel < 1)) throw new Error('bootstrap.confidenceLevel must be greater than zero and less than one');
  nonNegativeInteger(merged.bootstrap.seed, 'bootstrap.seed');
  if (merged.bootstrap.seed > 0xFFFFFFFF) throw new Error('bootstrap.seed must fit in an unsigned 32-bit integer');
  nonEmptyString(merged.sourceQuality.referenceProduct, 'sourceQuality.referenceProduct');
  nonEmptyString(merged.sourceQuality.quoteCurrency, 'sourceQuality.quoteCurrency');
  nonNegative(merged.sourceQuality.maxAbsBasisAdjustmentBps, 'sourceQuality.maxAbsBasisAdjustmentBps');
  validatePromotionSourceTypes(merged.sourceQuality.promotionGradeSourceTypes);
  ratio(merged.gates.minReferenceCoverage, 'gates.minReferenceCoverage');
  nonNegativeInteger(merged.gates.minClusters, 'gates.minClusters');
  nonNegativeInteger(merged.gates.minObservationDays, 'gates.minObservationDays');
  nonNegative(merged.gates.minLowerBoundBps, 'gates.minLowerBoundBps');
  nonNegativeInteger(merged.gates.minShadowClusters, 'gates.minShadowClusters');
  ratio(merged.gates.minShadowFillSurvivalRate, 'gates.minShadowFillSurvivalRate');
  if (!HORIZONS[merged.primaryHorizon]) throw new Error(`Unsupported primaryHorizon: ${merged.primaryHorizon}`);
  return merged;
}

function validateFill(fill, index) {
  if (!fill || !['buy', 'sell'].includes(fill.side)) throw new Error(`Fill ${index} requires side buy or sell`);
  for (const key of ['timestamp', 'decisionTimestamp', 'price', 'quantity']) finite(fill[key], `Fill ${index} ${key}`);
  if (fill.price <= 0 || fill.quantity <= 0 || fill.decisionTimestamp > fill.timestamp) throw new Error(`Fill ${index} has invalid price, quantity, or decision timestamp`);
  return { ...fill, fillId: fill.fillId || `fill-${index}` };
}

export function clusterFragmentedFills(fills = [], config = {}) {
  const clusterBurstMs = config.clusterBurstMs ?? DEFAULT_REGIME_VALIDATOR_CONFIG.clusterBurstMs;
  const priceTolerance = config.priceTolerance ?? DEFAULT_REGIME_VALIDATOR_CONFIG.priceTolerance;
  nonNegativeInteger(clusterBurstMs, 'clusterBurstMs');
  nonNegative(priceTolerance, 'priceTolerance');
  const sorted = fills.map(validateFill).sort((a, b) => a.timestamp - b.timestamp || a.fillId.localeCompare(b.fillId));
  const clusters = [];
  let activeClusterIndexes = [];
  for (const fill of sorted) {
    activeClusterIndexes = activeClusterIndexes.filter(index => fill.timestamp - clusters[index].endTimestamp <= clusterBurstMs);
    const matchingIndexes = activeClusterIndexes.filter(index => {
      const cluster = clusters[index];
      return fill.side === cluster.side && Math.abs(fill.price - cluster.anchorPrice) <= priceTolerance;
    });
    const matchingIndex = matchingIndexes.sort((left, right) => clusters[right].endTimestamp - clusters[left].endTimestamp || left - right)[0];
    if (matchingIndex === undefined) {
      clusters.push({
        clusterId: `cluster-${clusters.length + 1}`,
        side: fill.side,
        price: fill.price,
        quantity: fill.quantity,
        timestamp: fill.timestamp,
        endTimestamp: fill.timestamp,
        decisionTimestamp: fill.decisionTimestamp,
        fragmentCount: 1,
        fillIds: [fill.fillId],
        anchorPrice: fill.price,
      });
      activeClusterIndexes.push(clusters.length - 1);
      continue;
    }
    const previous = clusters[matchingIndex];
    const totalQuantity = previous.quantity + fill.quantity;
    previous.price = (previous.price * previous.quantity + fill.price * fill.quantity) / totalQuantity;
    previous.quantity = totalQuantity;
    previous.endTimestamp = fill.timestamp;
    previous.timestamp = fill.timestamp; // conservative horizon starts after the final fragment
    previous.decisionTimestamp = Math.min(previous.decisionTimestamp, fill.decisionTimestamp);
    previous.fragmentCount += 1;
    previous.fillIds.push(fill.fillId);
  }
  return clusters.map(({ anchorPrice, ...cluster }) => cluster);
}

function classifyFills(fills) {
  const idCounts = new Map();
  for (const fill of fills) if (fill?.fillId) idCounts.set(fill.fillId, (idCounts.get(fill.fillId) || 0) + 1);
  let maxSeen = -Infinity;
  let outOfOrderFills = 0;
  let duplicateFills = 0;
  const valid = [];
  fills.forEach((fill, index) => {
    const normalized = validateFill(fill, index);
    const duplicate = Boolean(fill.fillId && idCounts.get(fill.fillId) > 1);
    const outOfOrder = normalized.timestamp < maxSeen;
    maxSeen = Math.max(maxSeen, normalized.timestamp);
    if (duplicate) duplicateFills += 1;
    if (outOfOrder) outOfOrderFills += 1;
    if (!duplicate && !outOfOrder) valid.push(normalized);
  });
  return { valid, summary: { totalFills: fills.length, validFills: valid.length, duplicateFills, outOfOrderFills } };
}

function referenceKey(reference) {
  return `${reference.sourceType || ''}|${reference.product || ''}|${reference.quoteCurrency || ''}|${typeof reference.timestamp}:${reference.timestamp}`;
}

function referenceMid(reference, config) {
  const validBook = Number.isFinite(reference.bid) && Number.isFinite(reference.ask) && reference.bid > 0 && reference.ask > 0 && reference.bid <= reference.ask;
  const raw = validBook ? (reference.bid + reference.ask) / 2 : Number.NaN;
  const basisValid = Number.isFinite(reference.basisAdjustmentBps) && Math.abs(reference.basisAdjustmentBps) <= config.sourceQuality.maxAbsBasisAdjustmentBps;
  const adjusted = basisValid && Number.isFinite(raw) ? raw * (1 + reference.basisAdjustmentBps / 10_000) : Number.NaN;
  return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : Number.NaN;
}

function classifyReferences(references, config) {
  const duplicateCounts = new Map();
  for (const reference of references) duplicateCounts.set(referenceKey(reference), (duplicateCounts.get(referenceKey(reference)) || 0) + 1);
  let maxSeen = -Infinity;
  const records = references.map((reference, index) => {
    const timestamp = reference?.timestamp;
    const outOfOrder = Number.isFinite(timestamp) && timestamp < maxSeen;
    if (Number.isFinite(timestamp)) maxSeen = Math.max(maxSeen, timestamp);
    const duplicate = duplicateCounts.get(referenceKey(reference)) > 1;
    const metadataValid = Number.isFinite(timestamp) && typeof reference.product === 'string' && typeof reference.quoteCurrency === 'string' && typeof reference.sourceType === 'string' && Number.isFinite(reference.basisAdjustmentBps);
    const productMatches = reference.product === config.sourceQuality.referenceProduct && reference.quoteCurrency === config.sourceQuality.quoteCurrency;
    const mid = referenceMid(reference, config);
    const promotionGrade = metadataValid && productMatches
      && PROMOTION_GRADE_SOURCE_TYPES.includes(reference.sourceType)
      && config.sourceQuality.promotionGradeSourceTypes.includes(reference.sourceType)
      && Number.isFinite(mid);
    let quality = 'promotion-grade';
    if (!metadataValid) quality = 'malformed';
    else if (duplicate) quality = 'duplicate';
    else if (outOfOrder) quality = 'out-of-order';
    else if (!promotionGrade) quality = 'non-promotion-grade';
    return { ...reference, inputIndex: index, mid, quality };
  });
  return {
    records: records.sort((a, b) => {
      const aValid = Number.isFinite(a.timestamp);
      const bValid = Number.isFinite(b.timestamp);
      if (aValid && bValid) return a.timestamp - b.timestamp || a.inputIndex - b.inputIndex;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.inputIndex - b.inputIndex;
    }),
    summary: {
      totalReferences: references.length,
      promotionGradeReferences: records.filter(record => record.quality === 'promotion-grade').length,
      duplicateReferences: records.filter(record => record.quality === 'duplicate').length,
      outOfOrderReferences: records.filter(record => record.quality === 'out-of-order').length,
      nonPromotionGradeReferences: records.filter(record => record.quality === 'non-promotion-grade').length,
      malformedReferences: records.filter(record => record.quality === 'malformed').length,
    },
  };
}

function publicReference(record) {
  return record ? { timestamp: record.timestamp, price: record.mid, sourceType: record.sourceType, product: record.product, quoteCurrency: record.quoteCurrency, basisAdjustmentBps: record.basisAdjustmentBps } : null;
}

function backwardReference(records, timestamp, maxAgeMs) {
  const candidates = records.filter(record => Number.isFinite(record.timestamp) && record.timestamp <= timestamp).sort((a, b) => b.timestamp - a.timestamp || b.inputIndex - a.inputIndex);
  const candidate = candidates[0];
  if (!candidate) return { status: 'missing', reference: null };
  if (candidate.quality !== 'promotion-grade') return { status: candidate.quality, reference: publicReference(candidate) };
  if (timestamp - candidate.timestamp > maxAgeMs) return { status: 'stale', reference: publicReference(candidate) };
  return { status: 'available', reference: publicReference(candidate), record: candidate };
}

function forwardReference(records, timestamp, maxAgeMs) {
  const candidate = records.find(record => Number.isFinite(record.timestamp) && record.timestamp >= timestamp);
  if (!candidate) return { status: 'missing', reference: null };
  if (candidate.timestamp - timestamp > maxAgeMs) return { status: 'stale', reference: publicReference(candidate) };
  if (candidate.quality !== 'promotion-grade') return { status: candidate.quality, reference: publicReference(candidate) };
  return { status: 'available', reference: publicReference(candidate), record: candidate };
}

function observedEdgeBps(cluster, futurePrice) {
  return (cluster.side === 'buy' ? futurePrice - cluster.price : cluster.price - futurePrice) / cluster.price * 10_000;
}

function classifyRegime(cluster, decisionJoin, records, config) {
  if (decisionJoin.status !== 'available') return 'stale-reference';
  if (cluster.decisionTimestamp - decisionJoin.record.timestamp > config.regime.staleReferenceAgeMs) return 'stale-reference';
  const start = cluster.decisionTimestamp - config.regime.lookbackMs;
  const history = records.filter(record => record.quality === 'promotion-grade' && record.timestamp >= start && record.timestamp <= cluster.decisionTimestamp);
  if (history.length < 2) return 'clean';
  const first = history[0].mid;
  const last = decisionJoin.record.mid;
  const moveBps = (last - first) / first * 10_000;
  const extremaBps = (Math.max(...history.map(item => item.mid)) - Math.min(...history.map(item => item.mid))) / first * 10_000;
  if (extremaBps >= config.regime.highVolatilityBps) return 'high-volatility';
  const dangerous = (cluster.side === 'buy' && moveBps <= -config.regime.directionalMoveBps) || (cluster.side === 'sell' && moveBps >= config.regime.directionalMoveBps);
  return dangerous ? 'directional-risk' : 'clean';
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4_294_967_296;
  };
}

function percentile(sorted, probability) {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(probability * sorted.length)));
  return sorted[index];
}

export function deterministicClusterBootstrap(values, options = {}) {
  if (!Array.isArray(values) || !values.length || values.some(value => !Number.isFinite(value))) throw new Error('Bootstrap requires non-empty finite cluster samples');
  const iterations = options.iterations ?? DEFAULT_REGIME_VALIDATOR_CONFIG.bootstrap.iterations;
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_REGIME_VALIDATOR_CONFIG.bootstrap.confidenceLevel;
  const seed = options.seed ?? DEFAULT_REGIME_VALIDATOR_CONFIG.bootstrap.seed;
  if (!Number.isSafeInteger(iterations) || iterations < 1
    || !(Number.isFinite(confidenceLevel) && confidenceLevel > 0 && confidenceLevel < 1)
    || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new Error('Bootstrap options are invalid');
  const random = mulberry32(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - confidenceLevel) / 2;
  return { lower: percentile(means, tail), upper: percentile(means, 1 - tail), confidenceLevel, iterations, seed };
}

function summarizeEdges(edges, bootstrap) {
  if (!edges.length) return { count: 0, mean: null, confidenceInterval: null };
  return { count: edges.length, mean: edges.reduce((sum, edge) => sum + edge, 0) / edges.length, confidenceInterval: deterministicClusterBootstrap(edges, bootstrap) };
}

function scoreClusters(clusters, referenceRecords, config) {
  return clusters.map(cluster => {
    const decisionJoin = backwardReference(referenceRecords, cluster.decisionTimestamp, config.decisionReferenceMaxAgeMs);
    const markouts = {};
    for (const [name, delay] of Object.entries(HORIZONS)) {
      const joined = forwardReference(referenceRecords, cluster.timestamp + delay, config.markoutReferenceMaxAgeMs);
      markouts[name] = {
        status: joined.status,
        reference: joined.reference,
        observedEdgeBps: joined.status === 'available' ? observedEdgeBps(cluster, joined.record.mid) : null,
      };
    }
    const candle = referenceRecords.find(record => record.sourceType === 'candle'
      && record.product === config.sourceQuality.referenceProduct
      && record.quoteCurrency === config.sourceQuality.quoteCurrency
      && Number.isFinite(record.high) && record.high > 0
      && Number.isFinite(record.low) && record.low > 0 && record.low <= record.high
      && Number.isFinite(record.basisAdjustmentBps) && Math.abs(record.basisAdjustmentBps) <= config.sourceQuality.maxAbsBasisAdjustmentBps
      && (Number.isFinite(record.intervalStart) ? cluster.timestamp >= record.intervalStart : cluster.timestamp >= record.timestamp)
      && (Number.isFinite(record.intervalEnd) ? cluster.timestamp <= record.intervalEnd : cluster.timestamp < record.timestamp + 60_000));
    let candleRangeDiagnostic = { status: 'unavailable', promotionGrade: false };
    if (candle) {
      const adjustment = 1 + candle.basisAdjustmentBps / 10_000;
      const high = candle.high * adjustment;
      const low = candle.low * adjustment;
      const definitelyStale = cluster.side === 'buy' ? cluster.price > high : cluster.price < low;
      candleRangeDiagnostic = { status: definitelyStale ? 'definitely-stale' : 'not-definitely-stale', promotionGrade: false, reference: { timestamp: candle.timestamp, high, low, sourceType: candle.sourceType, product: candle.product, quoteCurrency: candle.quoteCurrency, basisAdjustmentBps: candle.basisAdjustmentBps } };
    }
    return { ...cluster, utcDay: utcDay(cluster.timestamp), regime: classifyRegime(cluster, decisionJoin, referenceRecords, config), decisionReferenceStatus: decisionJoin.status, decisionReference: decisionJoin.reference, candleRangeDiagnostic, markouts };
  });
}

export function validateRegimeStrategy({ fills = [], references = [], candidateBuffersBps = [], candidateId = null, shadowEvidence = null, config: inputConfig = {} } = {}) {
  if (!Array.isArray(fills) || !Array.isArray(references) || !Array.isArray(candidateBuffersBps)) throw new Error('fills, references, and candidateBuffersBps must be arrays');
  if (candidateBuffersBps.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Candidate buffers must be finite and non-negative');
  const config = mergeConfig(inputConfig);
  const referenceEvidence = classifyReferences(references, config);
  const fillEvidence = classifyFills(fills);
  const clusters = clusterFragmentedFills(fillEvidence.valid, config);
  const days = [...new Set(clusters.map(cluster => utcDay(cluster.timestamp)))].sort();
  const heldOutDays = days.slice(-config.heldOutDays);
  const trainingDays = days.slice(0, Math.max(0, days.length - heldOutDays.length));
  const heldOutSet = new Set(heldOutDays);
  const heldOutClusters = scoreClusters(clusters.filter(cluster => heldOutSet.has(utcDay(cluster.timestamp))), referenceEvidence.records, config);
  const scoredHeldOutClusters = heldOutClusters.filter(cluster => cluster.decisionReferenceStatus === 'available' && cluster.regime !== 'stale-reference' && cluster.markouts[config.primaryHorizon].status === 'available');
  const primaryEdges = scoredHeldOutClusters.map(cluster => cluster.markouts[config.primaryHorizon].observedEdgeBps);
  const scoredObservationDays = [...new Set(scoredHeldOutClusters.map(cluster => cluster.utcDay))].sort();
  const coverage = heldOutClusters.length ? primaryEdges.length / heldOutClusters.length : 0;
  const observedSummary = summarizeEdges(primaryEdges, config.bootstrap);
  const regimes = Object.fromEntries(['clean', 'directional-risk', 'high-volatility', 'stale-reference'].map(regime => {
    const regimeEdges = heldOutClusters.filter(cluster => cluster.regime === regime && cluster.decisionReferenceStatus === 'available' && cluster.regime !== 'stale-reference').map(cluster => cluster.markouts[config.primaryHorizon]).filter(markout => markout.status === 'available').map(markout => markout.observedEdgeBps);
    return [regime, summarizeEdges(regimeEdges, config.bootstrap)];
  }));
  const blockers = [];
  if (coverage < config.gates.minReferenceCoverage) blockers.push(`reference-coverage:${coverage.toFixed(3)}/${config.gates.minReferenceCoverage.toFixed(3)}`);
  if (heldOutClusters.length < config.gates.minClusters) blockers.push(`independent-clusters:${heldOutClusters.length}/${config.gates.minClusters}`);
  if (scoredObservationDays.length < config.gates.minObservationDays) blockers.push(`observation-days:${scoredObservationDays.length}/${config.gates.minObservationDays}`);
  if (!observedSummary.confidenceInterval || observedSummary.confidenceInterval.lower <= config.gates.minLowerBoundBps) blockers.push(`lower-bound:${observedSummary.confidenceInterval?.lower?.toFixed(3) ?? 'unavailable'}/${config.gates.minLowerBoundBps.toFixed(3)}`);
  const validCandidateId = typeof candidateId === 'string' && candidateId.trim().length > 0;
  const validShadow = shadowEvidence?.observed === true
    && validCandidateId
    && shadowEvidence.candidateId === candidateId
    && Number.isFinite(shadowEvidence.fillSurvivalRate)
    && shadowEvidence.fillSurvivalRate >= config.gates.minShadowFillSurvivalRate
    && shadowEvidence.fillSurvivalRate <= 1
    && Number.isSafeInteger(shadowEvidence.clusterCount)
    && shadowEvidence.clusterCount >= 0
    && shadowEvidence.clusterCount >= config.gates.minShadowClusters;
  if (!validShadow) blockers.push('shadow-fill-survival-unavailable');
  const mean = observedSummary.mean;
  return {
    mode: 'offline-observed-validation',
    candidateId: validCandidateId ? candidateId : null,
    methodology: 'Chronological UTC-day holdout; strict point-in-time joins; fragmented fills collapsed before scoring; cluster bootstrap uncertainty.',
    config,
    split: { trainingDays, heldOutDays, randomized: false },
    evidenceQuality: { ...fillEvidence.summary, ...referenceEvidence.summary },
    heldOut: {
      independentClusters: heldOutClusters.length,
      scoredClusters: primaryEdges.length,
      scoredObservationDays,
      referenceCoverage: coverage,
      clusters: heldOutClusters,
      metrics: { primaryHorizon: config.primaryHorizon, observedEdgeBps: observedSummary, byRegime: regimes },
    },
    counterfactualSensitivity: {
      methodology: 'Same-fill sensitivity only: candidate buffer is added to observed edge on the same historical fills. It does not infer those fills would survive wider quotes.',
      candidates: candidateBuffersBps.map(bufferBps => ({ bufferBps, sameHistoricalClusterCount: primaryEdges.length, meanEdgeBps: mean === null ? null : mean + bufferBps })),
      usedForPromotion: false,
    },
    shadowEvidence: validShadow ? { ...shadowEvidence, status: 'observed' } : { status: 'unavailable' },
    blockers,
    recommendation: blockers.length ? 'HOLD' : 'CANDIDATE_FOR_HUMAN_REVIEW',
    operatorApprovalRequired: true,
    productionChangeAuthorized: false,
    dispatches: 0,
  };
}
