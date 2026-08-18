import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_REGIME_VALIDATOR_CONFIG,
  clusterFragmentedFills,
  deterministicClusterBootstrap,
  validateRegimeStrategy as validateRegimeStrategyRaw,
} from './regime-strategy-validator.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const CANDIDATE_ID = 'regime-buffer-v1';
const TEST_BASIS_CONFIG = {
  basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
  basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
  basisSystem: 'CLOB', basisVenueAllowlist: ['TEST'], maxBasisRttMs: 1_000,
  maxBasisSourceAgeMs: 5_000,
};

function validateRegimeStrategy(input = {}) {
  return validateRegimeStrategyRaw({
    ...input,
    config: {
      ...input.config,
      sourceQuality: { ...TEST_BASIS_CONFIG, ...input.config?.sourceQuality },
    },
  });
}

function permissiveGates(overrides = {}) {
  return {
    minClusters: 1,
    minObservationDays: 1,
    minReferenceCoverage: 0,
    minLowerBoundBps: 0,
    minShadowClusters: 1,
    minShadowFillSurvivalRate: 0.01,
    ...overrides,
  };
}

function shadowEvidence(overrides = {}) {
  return {
    observed: true,
    candidateId: CANDIDATE_ID,
    fillSurvivalRate: 0.8,
    clusterCount: 1,
    ...overrides,
  };
}

function reference(timestamp, mid, overrides = {}) {
  return {
    timestamp,
    bid: mid - 0.5,
    ask: mid + 0.5,
    sourceType: 'top-of-book',
    sourceExchange: 'coinbase', sourceTimestamp: timestamp - 20,
    receivedTimestamp: timestamp - 10,
    product: 'BTC-USD',
    quoteCurrency: 'USD',
    basisAdjustmentBps: 0,
    promotionGrade: true,
    basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
    basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
    basisVenue: 'TEST', basisSystem: 'CLOB', basisRequestTimestamp: timestamp - 50,
    basisReceivedTimestamp: timestamp - 10, basisBid: 0.9999, basisAsk: 1.0001,
    basisPrice: 1, basisBidQty: 10, basisAskQty: 11, basisBidCount: 1, basisAskCount: 2,
    basisBidSubmissionTimestamp: timestamp - 40, basisBidPublicationTimestamp: timestamp - 20,
    basisAskSubmissionTimestamp: timestamp - 35, basisAskPublicationTimestamp: timestamp - 15,
    basisTimestamp: timestamp - 20,
    ...overrides,
  };
}

function fill(timestamp, overrides = {}) {
  return {
    fillId: `fill-${timestamp}-${overrides.side || 'buy'}`,
    timestamp,
    decisionTimestamp: timestamp - 1_000,
    side: 'buy',
    price: 99,
    quantity: 0.01,
    ...overrides,
  };
}

function evidence({ days = 7, clustersPerDay = 20 } = {}) {
  const fills = [];
  const references = [];
  for (let day = 0; day < days; day++) {
    const base = Date.UTC(2026, 7, 1 + day);
    for (let index = 0; index < clustersPerDay; index++) {
      const timestamp = base + index * 10 * MINUTE + 1_000;
      fills.push(fill(timestamp, { fillId: `f-${day}-${index}`, price: 100 }));
      references.push(reference(timestamp - 1_000, 100));
      references.push(reference(timestamp + 5 * MINUTE, 100.05));
    }
  }
  return { fills, references };
}

describe('regime strategy validator', () => {
  test('keeps legacy available rows without explicit basis provenance diagnostic-only', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp)],
      references: [reference(timestamp - 1_000, 100, { promotionGrade: false })],
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates() },
      shadowEvidence: shadowEvidence(),
    });
    expect(report.evidenceQuality).toMatchObject({
      promotionGradeReferences: 0, nonPromotionGradeReferences: 1,
      nonPromotionGradeReasons: { 'legacy-missing-basis-provenance': 1 },
    });
    expect(report.heldOut.clusters[0].decisionReferenceStatus).toBe('non-promotion-grade');
  });

  test('requires explicit promotion attestation and independently rejects forged provenance', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const variants = [
      [reference(timestamp - 1_000, 100, { promotionGrade: undefined }),
        'promotion-attestation-required'],
      [reference(timestamp - 900, 100, { promotionGrade: true, basisVenue: 'FORGED' }),
        'basis-venue-not-allowed'],
      [reference(timestamp - 800, 100, { promotionGrade: true, basisPrice: 1.1 }),
        'basis-midpoint-mismatch'],
    ];
    for (const [candidate, reason] of variants) {
      const report = validateRegimeStrategy({
        fills: [fill(timestamp)], references: [candidate], candidateId: CANDIDATE_ID,
        config: { heldOutDays: 1, gates: permissiveGates() }, shadowEvidence: shadowEvidence(),
      });
      expect(report.evidenceQuality.promotionGradeReferences).toBe(0);
      expect(report.evidenceQuality.nonPromotionGradeReasons).toMatchObject({ [reason]: 1 });
    }
  });

  test('independently requires exact fresh no-lookahead Coinbase provenance', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const variants = [
      [{ sourceTimestamp: undefined }, 'missing-reference-source-provenance'],
      [{ sourceExchange: 'forged' }, 'reference-source-identity-mismatch'],
      [{ sourceTimestamp: timestamp, receivedTimestamp: timestamp - 1 },
        'invalid-reference-source-order'],
      [{ receivedTimestamp: timestamp + 1 }, 'invalid-reference-source-order'],
      [{ sourceTimestamp: timestamp - 7_000 }, 'stale-reference-source'],
    ];
    for (const [overrides, reason] of variants) {
      const report = validateRegimeStrategy({
        fills: [fill(timestamp)], references: [reference(timestamp - 1_000, 100, overrides)],
        candidateId: CANDIDATE_ID, config: { heldOutDays: 1, gates: permissiveGates() },
        shadowEvidence: shadowEvidence(),
      });
      expect(report.evidenceQuality.promotionGradeReferences).toBe(0);
      expect(report.evidenceQuality.nonPromotionGradeReasons).toMatchObject({ [reason]: 1 });
    }
  });

  test('keeps publication-only basis evidence diagnostic with an explicit reason', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp)], references: [reference(timestamp - 1_000, 100, {
        basisBidSubmissionTimestamp: null, basisAskSubmissionTimestamp: null,
      })], candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates() }, shadowEvidence: shadowEvidence(),
    });
    expect(report.evidenceQuality).toMatchObject({
      promotionGradeReferences: 0,
      nonPromotionGradeReasons: { 'missing-basis-submission-provenance': 1 },
    });
  });

  test('joins decision context backward and markout forward without lookahead', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [
        reference(timestamp - 1_000, 100),
        reference(timestamp + 1, 999),
        reference(timestamp + 5 * MINUTE - 1, 1),
        reference(timestamp + 5 * MINUTE, 100.05),
      ],
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates({ minReferenceCoverage: 1 }) },
      shadowEvidence: shadowEvidence(),
    });
    expect(report.heldOut.clusters[0].decisionReference.timestamp).toBe(timestamp - 1_000);
    expect(report.heldOut.clusters[0].markouts['5m'].reference.timestamp).toBe(timestamp + 5 * MINUTE);
    expect(report.heldOut.clusters[0].markouts['5m'].observedEdgeBps).toBeCloseTo(5);
  });

  test('clusters same-side same-price fragments before every gate and interval', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const clusters = clusterFragmentedFills([
      fill(timestamp, { fillId: 'a', quantity: 0.01 }),
      fill(timestamp + 200, { fillId: 'c', side: 'sell' }),
      fill(timestamp + 400, { fillId: 'b', quantity: 0.02 }),
      fill(timestamp + 2_000, { fillId: 'd' }),
    ], { clusterBurstMs: 1_000, priceTolerance: 0 });
    expect(clusters).toHaveLength(3);
    expect(clusters[0]).toMatchObject({ fragmentCount: 2, quantity: 0.03, side: 'buy' });
  });

  test('pins price tolerance to the cluster anchor instead of admitting a transitive drift chain', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const clusters = clusterFragmentedFills([
      fill(timestamp, { fillId: 'anchor', price: 100 }),
      fill(timestamp + 100, { fillId: 'interleaved', side: 'sell', price: 101 }),
      fill(timestamp + 200, { fillId: 'near-anchor', price: 100.5 }),
      fill(timestamp + 300, { fillId: 'drifted', price: 101 }),
      fill(timestamp + 400, { fillId: 'back-to-anchor', price: 100.1 }),
    ], { clusterBurstMs: 1_000, priceTolerance: 0.6 });

    const buyClusters = clusters.filter(cluster => cluster.side === 'buy');
    expect(buyClusters).toHaveLength(2);
    expect(buyClusters[0].fillIds).toEqual(['anchor', 'near-anchor', 'back-to-anchor']);
    expect(buyClusters[1].fillIds).toEqual(['drifted']);
  });

  test('rejects non-positive, crossed, and excessive-basis promotion references', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    for (const invalidReference of [
      reference(timestamp + 5 * MINUTE, -10, { mid: -10, bid: undefined, ask: undefined }),
      reference(timestamp + 5 * MINUTE, 100, { mid: 100, bid: undefined, ask: undefined }),
      reference(timestamp + 5 * MINUTE, 100, { bid: 101, ask: 99 }),
      reference(timestamp + 5 * MINUTE, 100, { basisAdjustmentBps: 26 }),
    ]) {
      const report = validateRegimeStrategy({
        fills: [fill(timestamp, { price: 100 })],
        references: [reference(timestamp - 1_000, 100), invalidReference],
        candidateId: CANDIDATE_ID,
        config: { heldOutDays: 1, gates: permissiveGates() },
        shadowEvidence: shadowEvidence(),
      });
      expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('non-promotion-grade');
      expect(report.recommendation).toBe('HOLD');
    }
  });

  test('keeps candle evidence diagnostic-only and rejects attempts to configure it as promotion-grade', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [
        reference(timestamp - 1_000, 100),
        reference(timestamp + 5 * MINUTE, 100.05, { sourceType: 'candle', high: 101, low: 99 }),
      ],
      candidateId: CANDIDATE_ID,
      config: {
        heldOutDays: 1,
        gates: permissiveGates(),
      },
      shadowEvidence: shadowEvidence(),
    });
    expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('non-promotion-grade');
    expect(report.recommendation).toBe('HOLD');
    expect(() => validateRegimeStrategy({
      config: { sourceQuality: { promotionGradeSourceTypes: ['top-of-book', 'candle'] } },
    })).toThrow('promotion-grade source types');
  });

  test('cannot promote an unknown source with a positive mid or expand the promotion source catalog', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const unknown = reference(timestamp + 5 * MINUTE, 100.05, {
      sourceType: 'caller-asserted-feed',
      bid: undefined,
      ask: undefined,
      mid: 100.05,
    });
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [reference(timestamp - 1_000, 100), unknown],
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates() },
      shadowEvidence: shadowEvidence(),
    });
    expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('non-promotion-grade');
    expect(report.recommendation).toBe('HOLD');
    expect(() => validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [reference(timestamp - 1_000, 100), unknown],
      candidateId: CANDIDATE_ID,
      config: {
        heldOutDays: 1,
        sourceQuality: { promotionGradeSourceTypes: ['top-of-book', 'caller-asserted-feed'] },
        gates: permissiveGates(),
      },
      shadowEvidence: shadowEvidence(),
    })).toThrow('promotion-grade source types');
  });

  test('requires a positive non-crossed bid and ask for every promotion source type', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    for (const sourceType of ['top-of-book', 'point-in-time-book', 'equivalent-point-in-time']) {
      const report = validateRegimeStrategy({
        fills: [fill(timestamp, { price: 100 })],
        references: [
          reference(timestamp - 1_000, 100),
          reference(timestamp + 5 * MINUTE, 100.05, {
            sourceType,
            bid: undefined,
            ask: undefined,
            mid: 100.05,
          }),
        ],
        candidateId: CANDIDATE_ID,
        config: { heldOutDays: 1, gates: permissiveGates() },
        shadowEvidence: shadowEvidence(),
      });
      expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('non-promotion-grade');
      expect(report.heldOut.scoredClusters).toBe(0);
      expect(report.recommendation).toBe('HOLD');
    }
  });

  test('classifies numeric-string reference timestamps as malformed and never joins them', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [
        reference(timestamp - 1_000, 100),
        reference(String(timestamp + 5 * MINUTE), 100.05),
      ],
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates() },
      shadowEvidence: shadowEvidence(),
    });

    expect(report.evidenceQuality.malformedReferences).toBe(1);
    expect(report.evidenceQuality.promotionGradeReferences).toBe(1);
    expect(report.heldOut.clusters[0].markouts['5m']).toMatchObject({ status: 'missing', observedEdgeBps: null });
    expect(report.recommendation).toBe('HOLD');
  });

  test('does not let a malformed numeric-string timestamp mark a numeric observation as duplicate', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const horizonTimestamp = timestamp + 5 * MINUTE;
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [
        reference(timestamp - 1_000, 100),
        reference(String(horizonTimestamp), 999),
        reference(horizonTimestamp, 100.05),
      ],
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates() },
      shadowEvidence: shadowEvidence(),
    });

    expect(report.evidenceQuality).toMatchObject({ malformedReferences: 1, duplicateReferences: 0 });
    expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('available');
  });

  test('classifies duplicate, out-of-order, stale, and candle evidence without favorable scoring', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 100 })],
      references: [
        reference(timestamp - 1_000, 100),
        reference(timestamp - 2_000, 100), // out of order
        reference(timestamp + 5 * MINUTE, 101),
        reference(timestamp + 5 * MINUTE, 101), // duplicate timestamp/source/product
        reference(timestamp + 60 * MINUTE, 102, { sourceType: 'candle', high: 103, low: 99, bid: undefined, ask: undefined }),
      ],
      config: { heldOutDays: 1 },
    });
    expect(report.evidenceQuality.outOfOrderReferences).toBe(1);
    expect(report.evidenceQuality.duplicateReferences).toBe(2);
    expect(report.evidenceQuality.nonPromotionGradeReferences).toBeGreaterThanOrEqual(1);
    expect(report.heldOut.clusters[0].markouts['5m'].status).toBe('duplicate');
    expect(report.heldOut.clusters[0].markouts['60m'].status).toBe('non-promotion-grade');
    expect(report.heldOut.scoredClusters).toBe(0);
    expect(report.recommendation).toBe('HOLD');
  });

  test('keeps candle-range staleness diagnostic-only and excludes bad fill evidence', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const duplicated = fill(timestamp, { fillId: 'duplicate', price: 105 });
    const report = validateRegimeStrategy({
      fills: [duplicated, { ...duplicated }, fill(timestamp + 2_000, { fillId: 'valid', price: 105 }), fill(timestamp + 1_000, { fillId: 'out-of-order' })],
      references: [
        reference(timestamp + 1_000, 100),
        reference(timestamp + 2_000, 100, { sourceType: 'candle', high: 101, low: 99, intervalStart: timestamp, intervalEnd: timestamp + MINUTE }),
        reference(timestamp + 2_000 - 1_000, 100),
        reference(timestamp + 2_000 + 5 * MINUTE, 100),
      ],
      config: { heldOutDays: 1 },
    });
    expect(report.evidenceQuality.duplicateFills).toBe(2);
    expect(report.evidenceQuality.outOfOrderFills).toBe(1);
    expect(report.heldOut.independentClusters).toBe(1);
    expect(report.heldOut.clusters[0].candleRangeDiagnostic).toMatchObject({ status: 'definitely-stale', promotionGrade: false });
    expect(report.recommendation).toBe('HOLD');
  });

  test('ignores candle diagnostics for a different product or quote currency', () => {
    const timestamp = Date.UTC(2026, 7, 1, 1);
    const report = validateRegimeStrategy({
      fills: [fill(timestamp, { price: 105 })],
      references: [
        reference(timestamp, 100, {
          sourceType: 'candle',
          product: 'ETH-USD',
          high: 101,
          low: 99,
          intervalStart: timestamp,
          intervalEnd: timestamp + MINUTE,
        }),
        reference(timestamp, 100, {
          sourceType: 'candle',
          quoteCurrency: 'EUR',
          high: 101,
          low: 99,
          intervalStart: timestamp,
          intervalEnd: timestamp + MINUTE,
        }),
      ],
      config: { heldOutDays: 1 },
    });
    expect(report.heldOut.clusters[0].candleRangeDiagnostic).toEqual({ status: 'unavailable', promotionGrade: false });
    expect(report.recommendation).toBe('HOLD');
  });

  test('keeps observed edge separate from labeled same-fill sensitivity', () => {
    const data = evidence({ days: 2, clustersPerDay: 2 });
    const report = validateRegimeStrategy({
      ...data,
      candidateBuffersBps: [3, 12],
      config: { heldOutDays: 1, gates: permissiveGates() },
      shadowEvidence: { observed: false },
    });
    const observed = report.heldOut.metrics.observedEdgeBps.mean;
    expect(report.counterfactualSensitivity.methodology).toContain('same historical fills');
    expect(report.counterfactualSensitivity.candidates[0].meanEdgeBps).toBeCloseTo(observed + 3);
    expect(report.counterfactualSensitivity.usedForPromotion).toBe(false);
    expect(report.blockers).toContain('shadow-fill-survival-unavailable');
    expect(report.recommendation).toBe('HOLD');
  });

  test('uses chronological held-out UTC days and deterministic cluster bootstrap', () => {
    const data = evidence({ days: 7, clustersPerDay: 2 });
    const options = {
      ...data,
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 5, bootstrap: { iterations: 200, confidenceLevel: 0.95, seed: 42 }, gates: permissiveGates() },
      shadowEvidence: shadowEvidence({ clusterCount: 2 }),
    };
    const first = validateRegimeStrategy(options);
    const second = validateRegimeStrategy(options);
    expect(first.split.trainingDays).toHaveLength(2);
    expect(first.split.heldOutDays).toHaveLength(5);
    expect(first.split.heldOutDays[0] > first.split.trainingDays.at(-1)).toBe(true);
    expect(first.heldOut.metrics.observedEdgeBps.confidenceInterval).toEqual(second.heldOut.metrics.observedEdgeBps.confidenceInterval);
  });

  test('counts observation days only from scored held-out clusters', () => {
    const fills = [];
    const references = [];
    for (let day = 0; day < 5; day++) {
      const timestamp = Date.UTC(2026, 7, 1 + day, 1);
      fills.push(fill(timestamp, { fillId: `day-${day}`, price: 100 }));
      references.push(reference(timestamp - 1_000, 100));
      if (day === 4) references.push(reference(timestamp + 5 * MINUTE, 100.05));
    }
    const report = validateRegimeStrategy({
      fills,
      references,
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 5, gates: permissiveGates({ minObservationDays: 5 }) },
      shadowEvidence: shadowEvidence(),
    });
    expect(report.split.heldOutDays).toHaveLength(5);
    expect(report.heldOut.scoredObservationDays).toEqual(['2026-08-05']);
    expect(report.blockers).toContain('observation-days:1/5');
    expect(report.recommendation).toBe('HOLD');
  });

  test('binds adequate positive shadow survival evidence to the candidate identity', () => {
    const data = evidence({ days: 1, clustersPerDay: 1 });
    const base = {
      ...data,
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 1, gates: permissiveGates({ minShadowClusters: 10, minShadowFillSurvivalRate: 0.5 }) },
    };
    for (const evidenceValue of [
      shadowEvidence({ candidateId: 'different-policy', clusterCount: 10 }),
      shadowEvidence({ clusterCount: 9 }),
      shadowEvidence({ clusterCount: 10, fillSurvivalRate: 0 }),
      shadowEvidence({ clusterCount: -1 }),
      shadowEvidence({ clusterCount: 1e100 }),
    ]) {
      const report = validateRegimeStrategy({ ...base, shadowEvidence: evidenceValue });
      expect(report.blockers).toContain('shadow-fill-survival-unavailable');
      expect(report.recommendation).toBe('HOLD');
    }
  });

  test('public CLI rejects an unsafe shadow cluster count instead of recommending review', () => {
    const data = evidence({ days: 1, clustersPerDay: 1 });
    const result = spawnSync('bun', ['scripts/validate-regime-strategy.js', '-'], {
      cwd: new URL('../..', import.meta.url).pathname,
      input: JSON.stringify({
        ...data,
        candidateId: CANDIDATE_ID,
        config: { heldOutDays: 1, bootstrap: { iterations: 10 }, gates: permissiveGates() },
        shadowEvidence: shadowEvidence({ clusterCount: 1e100 }),
      }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.recommendation).toBe('HOLD');
    expect(report.blockers).toContain('shadow-fill-survival-unavailable');
    expect(report.shadowEvidence).toEqual({ status: 'unavailable' });
    expect(report.dispatches).toBe(0);
  });

  test('defaults to HOLD and requires every conservative promotion gate', () => {
    const defaults = DEFAULT_REGIME_VALIDATOR_CONFIG.gates;
    expect(defaults).toMatchObject({ minReferenceCoverage: 0.95, minClusters: 100, minObservationDays: 5, minLowerBoundBps: 2, minShadowClusters: 100, minShadowFillSurvivalRate: 0.5 });
    const report = validateRegimeStrategy(evidence());
    expect(report.recommendation).toBe('HOLD');
    expect(report.productionChangeAuthorized).toBe(false);
    expect(report.operatorApprovalRequired).toBe(true);
    expect(report.blockers).toContain('shadow-fill-survival-unavailable');
  });

  test('can only recommend human review from observed held-out promotion-grade evidence', () => {
    const data = evidence({ days: 7, clustersPerDay: 20 });
    const report = validateRegimeStrategy({
      ...data,
      candidateId: CANDIDATE_ID,
      config: { heldOutDays: 5, bootstrap: { iterations: 200, seed: 9 } },
      shadowEvidence: shadowEvidence({ clusterCount: 100, fillSurvivalRate: 0.7 }),
    });
    expect(report.heldOut.independentClusters).toBe(100);
    expect(report.recommendation).toBe('CANDIDATE_FOR_HUMAN_REVIEW');
    expect(report.productionChangeAuthorized).toBe(false);
  });

  test('bootstrap rejects non-finite samples and remains deterministic', () => {
    expect(() => deterministicClusterBootstrap([1, Number.NaN])).toThrow('finite');
    expect(deterministicClusterBootstrap([1, 2, 3], { iterations: 50, seed: 7 }))
      .toEqual(deterministicClusterBootstrap([1, 2, 3], { iterations: 50, seed: 7 }));
  });

  test('rejects negative durations, tolerances, ages, and regime thresholds', () => {
    const invalidConfigs = [
      { clusterBurstMs: -1 },
      { priceTolerance: -0.01 },
      { decisionReferenceMaxAgeMs: -1 },
      { markoutReferenceMaxAgeMs: -1 },
      { regime: { lookbackMs: -1 } },
      { regime: { directionalMoveBps: -1 } },
      { regime: { highVolatilityBps: -1 } },
      { regime: { staleReferenceAgeMs: -1 } },
      { sourceQuality: { maxAbsBasisAdjustmentBps: -1 } },
      { gates: { minReferenceCoverage: -0.01 } },
      { gates: { minLowerBoundBps: -0.01 } },
      { gates: { minShadowFillSurvivalRate: -0.01 } },
    ];
    for (const config of invalidConfigs) {
      expect(() => validateRegimeStrategy({ config })).toThrow();
    }
    expect(() => clusterFragmentedFills([fill(1_000), fill(1_001)], { clusterBurstMs: -1 })).toThrow('clusterBurstMs');
    expect(() => clusterFragmentedFills([fill(1_000), fill(1_001)], { priceTolerance: -1 })).toThrow('priceTolerance');
  });

  test('requires integer count, duration, and bootstrap seed configuration where fractional values have no meaning', () => {
    const invalidConfigs = [
      { clusterBurstMs: 1.5 },
      { decisionReferenceMaxAgeMs: 1.5 },
      { markoutReferenceMaxAgeMs: 1.5 },
      { heldOutDays: 1.5 },
      { regime: { lookbackMs: 1.5 } },
      { regime: { staleReferenceAgeMs: 1.5 } },
      { bootstrap: { iterations: 1.5 } },
      { bootstrap: { seed: 1.5 } },
      { gates: { minClusters: 1.5 } },
      { gates: { minObservationDays: 1.5 } },
      { gates: { minShadowClusters: 1.5 } },
    ];
    for (const config of invalidConfigs) {
      expect(() => validateRegimeStrategy({ config })).toThrow();
    }
    expect(() => deterministicClusterBootstrap([1], { iterations: 1, seed: 1.5 })).toThrow('Bootstrap options');
  });

  test('allows valid zero-valued relaxations without allowing invalid confidence, ratios, identity, or source configuration', () => {
    expect(validateRegimeStrategy({
      config: {
        clusterBurstMs: 0,
        priceTolerance: 0,
        decisionReferenceMaxAgeMs: 0,
        markoutReferenceMaxAgeMs: 0,
        regime: { lookbackMs: 0, directionalMoveBps: 0, highVolatilityBps: 0, staleReferenceAgeMs: 0 },
        sourceQuality: { maxAbsBasisAdjustmentBps: 0, promotionGradeSourceTypes: ['equivalent-point-in-time'] },
        gates: { minReferenceCoverage: 0, minClusters: 0, minObservationDays: 0, minLowerBoundBps: 0, minShadowClusters: 0, minShadowFillSurvivalRate: 0 },
      },
    }).recommendation).toBe('HOLD');

    const invalidConfigs = [
      { heldOutDays: 0 },
      { bootstrap: { iterations: 0 } },
      { bootstrap: { seed: -1 } },
      { bootstrap: { confidenceLevel: 0 } },
      { bootstrap: { confidenceLevel: 1 } },
      { gates: { minReferenceCoverage: 1.01 } },
      { gates: { minShadowFillSurvivalRate: 1.01 } },
      { gates: { minClusters: -1 } },
      { gates: { minObservationDays: -1 } },
      { gates: { minShadowClusters: -1 } },
      { sourceQuality: { promotionGradeSourceTypes: [] } },
      { sourceQuality: { promotionGradeSourceTypes: ['top-of-book', 'top-of-book'] } },
      { sourceQuality: { referenceProduct: '' } },
      { sourceQuality: { quoteCurrency: '' } },
    ];
    for (const config of invalidConfigs) {
      expect(() => validateRegimeStrategy({ config })).toThrow();
    }
  });
});
