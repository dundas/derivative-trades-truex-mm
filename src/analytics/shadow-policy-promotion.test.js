import { describe, expect, test } from 'bun:test';
import { buildShadowPromotionReport, formatShadowPromotionReport } from './shadow-policy-promotion.js';

const policy = { targetInventoryBTC: 0, maxSkewTicks: 3, anchorBufferTicks: 1, baseSpreadBps: 50, levelSpacingTicks: 1, baseSizeBTC: 0.01, sizeDecayFactor: 0.8, repriceThresholdTicks: 1 };
const split = { trainEnd: 100, validationStart: 100, validationEnd: 1000 };
const events = [
  { eventType: 'create', eventId: 'q', timestamp: 110, quoteId: 'q', side: 'buy', price: 100, size: 0.01, policyVector: policy, context: { fairValue: 101 } },
  { eventType: 'full_fill', eventId: 'f', timestamp: 120, quoteId: 'q', side: 'buy', price: 100, size: 0.01, context: { fairValue: 101 } },
];

describe('shadow policy promotion', () => {
  test('scores candidates without any FIX dispatch dependency', () => {
    let sends = 0;
    const fixConnection = { sendMessage: () => sends++ };
    const report = buildShadowPromotionReport({ events, candidates: [{ id: 'same', policy }], evaluator: { split, referencePrices: [{ timestamp: 60120, price: 101 }, { timestamp: 300120, price: 101 }, { timestamp: 3600120, price: 101 }] }, criteria: { minObservationEvents: 2, maxInventoryRangeBTC: 1 }, fixConnection });
    expect(report.mode).toBe('shadow-only');
    expect(report.dispatches).toBe(0);
    expect(report.productionChangeAuthorized).toBe(false);
    expect(report.operatorApprovalRequired).toBe(true);
    expect(sends).toBe(0);
    expect(report.observationWindow).toEqual({ start: 100, end: 1000 });
    expect(report.reports[0].netPnlRange.lower).toBeLessThanOrEqual(report.reports[0].netPnlRange.upper);
    expect(formatShadowPromotionReport(report)).toContain('NOT AUTHORIZED');
  });

  test('holds candidates with insufficient coverage or adverse markout', () => {
    let sends = 0;
    const report = buildShadowPromotionReport({ events, candidates: [{ id: 'candidate', policy }], evaluator: { split, referencePrices: [{ timestamp: 60120, price: 99 }, { timestamp: 300120, price: 99 }, { timestamp: 3600120, price: 99 }] }, criteria: { minObservationEvents: 3, maxInventoryRangeBTC: 1 }, fixConnection: { sendMessage: () => sends++ } });
    expect(report.recommendation).toBe('HOLD');
    expect(report.reports[0].blockers.some(x => x.startsWith('insufficient-observation-events'))).toBe(true);
    expect(report.reports[0].blockers.some(x => x.startsWith('adverse-markout'))).toBe(true);
    expect(sends).toBe(0);
    expect(formatShadowPromotionReport(report)).toContain('coverage=');
  });

  test('holds an otherwise-qualified short observation window with zero sends', () => {
    let sends = 0;
    const report = buildShadowPromotionReport({ events, candidates: [{ id: 'candidate', policy }], evaluator: { split, referencePrices: [{ timestamp: 60120, price: 101 }, { timestamp: 300120, price: 101 }, { timestamp: 3600120, price: 101 }] }, criteria: { minObservationEvents: 2, minObservationWindowMs: 100, maxInventoryRangeBTC: 1 }, fixConnection: { sendMessage: () => sends++ } });
    expect(report.recommendation).toBe('HOLD');
    expect(report.reports[0].blockers.some(x => x.startsWith('insufficient-observation-window:10/100'))).toBe(true);
    expect(sends).toBe(0);
  });

  test('enforces a stricter promotion coverage threshold than the evaluator', () => {
    const coverageEvents = [...events, { eventType: 'cancel', eventId: 'c', timestamp: 130, quoteId: 'q', context: { fairValue: 101 } }, { eventType: 'reject', eventId: 'r', timestamp: 140, quoteId: 'other' }];
    const report = buildShadowPromotionReport({ events: coverageEvents, candidates: [{ id: 'candidate', policy }], evaluator: { split, assumptions: { minContextCoverage: 0.7 }, referencePrices: [{ timestamp: 60120, price: 101 }, { timestamp: 300120, price: 101 }, { timestamp: 3600120, price: 101 }] }, criteria: { minObservationEvents: 2, minContextCoverage: 0.8, maxInventoryRangeBTC: 1 } });
    expect(report.reports[0].evaluation.coverage.context).toBe(0.75);
    expect(report.reports[0].blockers).toContain('insufficient-context-coverage:0.750');
  });
});
