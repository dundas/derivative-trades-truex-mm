import { describe, expect, test } from 'bun:test';
import { buildWeeklyPromotionReview, formatWeeklyPromotionReview } from './weekly-promotion-review.js';

describe('weekly promotion review', () => {
  test('holds without seven clean daily reports and an eligible shadow report', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: [{ date: '2026-08-01', verdict: { status: 'WARN', reasons: [] } }], shadowReport: { recommendation: 'HOLD' } });
    expect(review.decision).toBe('HOLD');
    expect(review.productionChangeAuthorized).toBe(false);
  });
  test('marks an empty weekly PnL aggregate unavailable rather than observed zero', () => {
    const review = buildWeeklyPromotionReview();
    expect(review.performance.observed.pnl).toEqual({
      realizedGross: 0, fees: 0, netRealizedAfterFees: 0,
      availability: {
        evidence: 'unavailable', reason: 'no-daily-pnl-evidence',
        coverage: { reviewedDays: 0, observedDays: 0, unavailableDays: 0 },
      },
    });
    expect(formatWeeklyPromotionReview(review)).toContain('PnL unavailable (0/0 observed; no-daily-pnl-evidence)');
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
    expect(review.performance.observed.pnl).toEqual({
      realizedGross: 21, fees: 3.5, netRealizedAfterFees: 17.5,
      availability: { evidence: 'observed', coverage: { reviewedDays: 7, observedDays: 7, unavailableDays: 0 } },
    });
    expect(review.performance.unavailable.realizedSpread).toMatchObject({ days: 7, reasons: ['no quote-linked FIFO lot attribution'], coverage: { reviewedDays: 7, observedDays: 0, unavailableDays: 7 } });
    expect(review.performance.unavailable.sameDayOpposingFillProxy).toMatchObject({ days: 1, reasons: ['no matched opposing fill volume'], coverage: { reviewedDays: 7, observedDays: 6, unavailableDays: 1 } });
    expect(review.performance.unavailable.uptime).toMatchObject({ days: 7, reasons: ['no acknowledged two-sided presence observations'], coverage: { reviewedDays: 7, observedDays: 0, unavailableDays: 7 } });
    expect(review.performance.counterfactual).toEqual({ evidence: 'unavailable', reason: 'no counterfactual performance is inferred from observed fills' });
    expect(formatWeeklyPromotionReview(review)).toContain('Observed performance');
    expect(formatWeeklyPromotionReview(review)).toContain('Unavailable performance evidence');
  });

  test('treats legacy daily reports and missing components as unavailable instead of zero observed evidence', () => {
    const current = {
      date: '2026-08-01', verdict: { status: 'OK' }, performance: {
        sameDayOpposingFillProxy: { evidence: 'observed', pnl: 2, matchedQty: 0.01 },
        rejects: { evidence: 'observed', attempts: 10, rejects: 1, rate: 0.1 },
        pnl: { evidence: 'observed', realizedGross: 2, fees: 0, netRealizedAfterFees: 2 },
      },
    };
    const legacy = { date: '2026-08-02', verdict: { status: 'OK' } };
    const partial = { date: '2026-08-03', verdict: { status: 'OK' }, performance: { rejects: { evidence: 'observed', attempts: 5, rejects: 1, rate: 0.2 } } };
    const review = buildWeeklyPromotionReview({ dailyReports: [current, legacy, partial] });
    expect(review.performance.observed.sameDayOpposingFillProxy).toEqual({ days: 1, pnl: 2, matchedQty: 0.01 });
    expect(review.performance.observed.pnl).toMatchObject({ realizedGross: 2, fees: 0, netRealizedAfterFees: 2 });
    expect(review.performance.unavailable.sameDayOpposingFillProxy).toMatchObject({
      days: 2, reasons: ['daily-performance-missing', 'daily-performance-component-missing:sameDayOpposingFillProxy'],
      coverage: { reviewedDays: 3, observedDays: 1, unavailableDays: 2 },
    });
    expect(review.performance.unavailable.inventory).toMatchObject({
      days: 3, reasons: ['daily-performance-component-missing:inventory', 'daily-performance-missing'],
      coverage: { reviewedDays: 3, observedDays: 0, unavailableDays: 3 },
    });
    expect(review.performance.observed.pnl.availability).toEqual({
      evidence: 'unavailable', reason: 'one-or-more-daily-pnl-components-unavailable',
      coverage: { reviewedDays: 3, observedDays: 1, unavailableDays: 2 },
    });
    expect(formatWeeklyPromotionReview(review)).toContain('PnL unavailable (1/3 observed; one-or-more-daily-pnl-components-unavailable)');
  });

  test('never calculates an aggregate rejection rate when any daily rate is unavailable', () => {
    const observed = (date, rejects) => ({
      date, verdict: { status: 'OK' }, performance: { rejects, sameDayOpposingFillProxy: { evidence: 'unavailable', reason: 'none' }, pnl: { evidence: 'observed', realizedGross: 0, fees: 0, netRealizedAfterFees: 0 } },
    });
    const review = buildWeeklyPromotionReview({ dailyReports: [
      observed('2026-08-01', { evidence: 'observed', attempts: 10, rejects: 1, rate: 0.1 }),
      observed('2026-08-02', { evidence: 'observed', attempts: null, rejects: 2, rate: null, rateUnavailableReason: 'unmatched-reject' }),
      { date: '2026-08-03', verdict: { status: 'OK' } },
    ] });
    expect(review.performance.observed.rejects).toEqual({ attempts: 10, rejects: 3, rate: null, rateAvailable: false });
    expect(review.performance.unavailable.rejects).toMatchObject({
      days: 1, reasons: ['daily-performance-missing'], coverage: { reviewedDays: 3, observedDays: 2, unavailableDays: 1 },
    });
  });
});
