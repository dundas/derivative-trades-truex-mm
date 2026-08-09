import { describe, expect, test } from 'bun:test';
import { chronologicalSplit, evaluatePolicy, formatEvaluationReport } from './offline-policy-evaluator.js';
import { QuoteLifecycleTelemetry } from '../data-pipeline/quote-lifecycle-telemetry.js';

const policy = { targetInventoryBTC: 0, maxSkewTicks: 3, anchorBufferTicks: 1, baseSpreadBps: 50, levelSpacingTicks: 1, baseSizeBTC: 0.01, sizeDecayFactor: 0.8, repriceThresholdTicks: 1 };
const split = { trainEnd: 100, validationStart: 100, validationEnd: 1000 };
const events = [
  { eventType: 'create', timestamp: 10, quoteId: 'train' },
  { eventType: 'create', timestamp: 110, quoteId: 'q1', side: 'buy', size: 0.01, price: 100, policyVector: policy, context: { fairValue: 101 } },
  { eventType: 'full_fill', timestamp: 120, quoteId: 'q1', side: 'buy', price: 100, size: 1, fee: 0.1, context: { fairValue: 101 } },
];
describe('offline policy evaluator', () => {
  test('uses non-overlapping chronological validation and conservative costs', () => {
    const result = evaluatePolicy(events, { policy, split, assumptions: { queueFillProbability: 0.5, inventoryRiskPenaltyPerBtc: 0.2 }, referencePrices: { 60120: 99, 300120: 98, 3600120: 97 } });
    expect(result.coverage.events).toBe(2); expect(result.decomposition.fees).toBe(0.1);
    expect(result.decomposition.inventoryPenalty).toBe(0.2); expect(result.decomposition.markouts['1m'].available).toBe(1);
    expect(formatEvaluationReport(result)).toContain('Net P&L');
  });
  test('rejects overlapping and look-ahead splits', () => {
    expect(() => chronologicalSplit(events, { trainEnd: 200, validationStart: 100, validationEnd: 300 })).toThrow('Chronological split');
  });
  test('flags no fills and missing context rather than inventing results', () => {
    const result = evaluatePolicy([{ eventType: 'create', timestamp: 110, quoteId: 'q2' }], { policy, split });
    expect(result.warnings).toContain('unsupported-regime:no-observed-fills');
    expect(result.warnings.some(w => w.startsWith('missing-context'))).toBe(true);
  });
  test('attributes fills to lifecycle, charges latency, and reports one-sided downside', () => {
    const result = evaluatePolicy(events, { policy, split, assumptions: { latencyPenaltyBps: 10, queueFillProbability: 1 }, referencePrices: [] });
    expect(result.coverage.outcomes.timeToFillMs).toEqual([10]);
    expect(result.decomposition.latencyCost).toBeCloseTo(0.1);
    expect(result.inventory.max).toBe(1);
    expect(result.decomposition.markouts['1m'].unavailable).toBe(1);
  });
  test('treats null reference prices as unavailable rather than throwing', () => {
    const result = evaluatePolicy(events, { policy, split, referencePrices: null });
    expect(Number.isFinite(result.decomposition.netPnl)).toBe(true);
    expect(result.decomposition.markouts['1m'].unavailable).toBe(1);
    expect(result.warnings).toContain('markout-unavailable-or-stale');
  });
  test('rejects duplicate events and invalid policy vectors', () => {
    expect(() => chronologicalSplit([{ eventId: 'x', timestamp: 1 }, { eventId: 'x', timestamp: 2 }], split)).toThrow('Duplicate');
    expect(() => evaluatePolicy(events, { policy: {}, split })).toThrow('Policy vector');
  });
  test('scores candidate policies differently without inventing additional fills', () => {
    const small = evaluatePolicy(events, { policy: { ...policy, baseSizeBTC: 0.005 }, split, assumptions: { queueFillProbability: 1 } });
    const full = evaluatePolicy(events, { policy, split, assumptions: { queueFillProbability: 1 } });
    expect(small.coverage.observedFills).toBe(full.coverage.observedFills);
    expect(small.decomposition.netPnl).not.toBe(full.decomposition.netPnl);
  });
  test('does not use a reference before its markout horizon or stale after it', () => {
    const result = evaluatePolicy(events, { policy, split, assumptions: { maxReferenceAgeMs: 10 }, referencePrices: [{ timestamp: 60119, price: 80 }, { timestamp: 60140, price: 99 }] });
    expect(result.decomposition.markouts['1m'].available).toBe(0);
    expect(result.warnings).toContain('markout-unavailable-or-stale');
  });
  test('retains auditable adverse-selection references and excludes future validation events', () => {
    const refs = [{ timestamp: 60120, price: 99, source: 'coinbase' }];
    const baseline = evaluatePolicy(events, { policy, split, referencePrices: refs });
    const withFuture = evaluatePolicy([...events, { eventType: 'full_fill', quoteId: 'future', timestamp: 2000, side: 'sell', price: 999, size: 9 }], { policy, split, referencePrices: refs });
    expect(baseline.decomposition.markouts['1m'].pnl).toBeLessThan(0);
    expect(baseline.decomposition.markouts['1m'].references[0]).toMatchObject({ timestamp: 60120, source: 'coinbase', price: 99 });
    expect(withFuture.decomposition.netPnl).toBe(baseline.decomposition.netPnl);
  });
  test('handles normalized persisted telemetry and skips malformed vectors without NaN', async () => {
    const telemetry = new QuoteLifecycleTelemetry({ now: () => 110 });
    const create = await telemetry.record({ eventType: 'create', quoteId: 'normalized', timestamp: 110, side: 'buy', price: 100, size: 0.01, policyVector: policy, context: { fairValue: 101 } });
    const fill = await telemetry.record({ eventType: 'full_fill', quoteId: 'normalized', timestamp: 120, side: 'buy', price: 100, size: 0.01, policyVector: { ...policy, baseSizeBTC: 'bad' }, context: { fairValue: 101 } });
    const result = evaluatePolicy([create, fill], { policy, split });
    expect(Number.isFinite(result.decomposition.netPnl)).toBe(true);
    expect(result.warnings.some(w => w.startsWith('missing-policy-vector'))).toBe(false);
    expect(result.warnings.some(w => w.startsWith('malformed-policy-vector'))).toBe(false);
  });
  test('fails closed on a malformed persisted quote create without NaN metrics', () => {
    const badCreate = { eventType: 'create', quoteId: 'bad-create', timestamp: 110, side: 'buy', price: 100, size: 1, policyVector: { targetInventoryBTC: 0 } , context: { fairValue: 101 } };
    const badFill = { eventType: 'full_fill', quoteId: 'bad-create', timestamp: 120, side: 'buy', price: 100, size: 1, context: { fairValue: 101 } };
    const result = evaluatePolicy([badCreate, badFill], { policy, split });
    expect(result.coverage.unsupportedQuoteVectors).toBe(1);
    expect(result.warnings).toContain('unsupported-quote-policy-vector:1');
    for (const value of Object.values(result.decomposition)) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  });
});
