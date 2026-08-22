import { describe, expect, test } from 'bun:test';
import { buildWeeklyPromotionReview, formatWeeklyPromotionReview } from './weekly-promotion-review.js';

describe('weekly promotion review', () => {
  test('holds without seven clean daily reports and an eligible shadow report', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: [{ date: '2026-08-01', verdict: { status: 'WARN', reasons: [] } }], shadowReport: { recommendation: 'HOLD' } });
    expect(review.decision).toBe('HOLD');
    expect(review.productionChangeAuthorized).toBe(false);
  });
  test('requires explicit approval even when all evidence is favorable', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: Array.from({ length: 7 }, (_, index) => ({ date: `2026-08-0${index + 1}`, verdict: { status: 'OK', reasons: [] } })), shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL', selectedCandidateId: 'candidate-a' } });
    expect(review.decision).toBe('CANDIDATE_REQUIRES_OPERATOR_APPROVAL');
    expect(review.productionChangeAuthorized).toBe(false);
    expect(formatWeeklyPromotionReview(review)).toContain('NOT AUTHORIZED');
  });
  test('fails closed on missing verdicts, duplicate days, or no selected candidate', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: Array.from({ length: 7 }, () => ({ date: '2026-08-01', verdict: { status: 'OK', reasons: [] } })).map((report, index) => index === 0 ? { date: report.date } : report), shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL' } });
    expect(review.decision).toBe('HOLD');
    expect(review.blockers).toContain('daily-review-missing-warn-or-error');
    expect(review.blockers).toContain('insufficient-distinct-daily-reports:1/7');
    expect(review.blockers).toContain('shadow-report-missing-selected-candidate');
  });
  test('summarizes only observed daily performance and preserves unavailable and counterfactual evidence', () => {
    const dailyReports = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-08-0${index + 1}`,
      verdict: { status: 'OK', reasons: [] },
      performance: {
        realizedSpread: { evidence: 'unavailable', reason: 'no quote-linked FIFO lot attribution' },
        sameDayOpposingFillProxy: index === 0 ? { evidence: 'unavailable', reason: 'no matched opposing fill volume' } : { evidence: 'observed', pnl: 2, matchedQty: 0.01 },
        uptime: { evidence: 'unavailable', reason: 'no acknowledged two-sided presence observations' },
        rejects: { evidence: 'observed', attempts: 10, rejects: 1, rate: 0.1 },
        inventory: { evidence: 'observed', min: -0.01, max: 0.02, end: 0.01, samples: 3 },
        pnl: { evidence: 'observed', realizedGross: 3, fees: 0.5, netRealizedAfterFees: 2.5 },
        counterfactual: { evidence: 'unavailable', reason: 'no counterfactual performance is inferred from observed fills' },
      },
    }));
    const review = buildWeeklyPromotionReview({ dailyReports, shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL', selectedCandidateId: 'candidate-a' } });
    expect(review.performance.observed.sameDayOpposingFillProxy.days).toBe(6);
    expect(review.performance.observed.sameDayOpposingFillProxy.pnl).toBe(12);
    expect(review.performance.observed.sameDayOpposingFillProxy.matchedQty).toBeCloseTo(0.06, 12);
    expect(review.performance.observed.rejects).toEqual({ attempts: 70, rejects: 7, rate: 0.1, rateAvailable: true });
    expect(review.performance.observed.pnl).toEqual({ realizedGross: 21, fees: 3.5, netRealizedAfterFees: 17.5 });
    expect(review.performance.unavailable.realizedSpread).toEqual({ days: 7, reasons: ['no quote-linked FIFO lot attribution'] });
    expect(review.performance.unavailable.sameDayOpposingFillProxy).toEqual({ days: 1, reasons: ['no matched opposing fill volume'] });
    expect(review.performance.unavailable.uptime).toEqual({ days: 7, reasons: ['no acknowledged two-sided presence observations'] });
    expect(review.performance.counterfactual).toEqual({ evidence: 'unavailable', reason: 'no counterfactual performance is inferred from observed fills' });
    expect(formatWeeklyPromotionReview(review)).toContain('Observed performance');
    expect(formatWeeklyPromotionReview(review)).toContain('Unavailable performance evidence');
  });
});
