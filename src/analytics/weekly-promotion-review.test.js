import { describe, expect, test } from 'bun:test';
import { buildWeeklyPromotionReview, formatWeeklyPromotionReview } from './weekly-promotion-review.js';

describe('weekly promotion review', () => {
  test('holds without seven clean daily reports and an eligible shadow report', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: [{ date: '2026-08-01', verdict: 'WARN' }], shadowReport: { recommendation: 'HOLD' } });
    expect(review.decision).toBe('HOLD');
    expect(review.productionChangeAuthorized).toBe(false);
  });
  test('requires explicit approval even when all evidence is favorable', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: Array.from({ length: 7 }, (_, index) => ({ date: `2026-08-0${index + 1}`, verdict: 'OK' })), shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL', selectedCandidateId: 'candidate-a' } });
    expect(review.decision).toBe('CANDIDATE_REQUIRES_OPERATOR_APPROVAL');
    expect(review.productionChangeAuthorized).toBe(false);
    expect(formatWeeklyPromotionReview(review)).toContain('NOT AUTHORIZED');
  });
  test('fails closed on missing verdicts, duplicate days, or no selected candidate', () => {
    const review = buildWeeklyPromotionReview({ dailyReports: Array.from({ length: 7 }, () => ({ date: '2026-08-01', verdict: 'OK' })).map((report, index) => index === 0 ? { date: report.date } : report), shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL' } });
    expect(review.decision).toBe('HOLD');
    expect(review.blockers).toContain('daily-review-missing-warn-or-error');
    expect(review.blockers).toContain('insufficient-distinct-daily-reports:1/7');
    expect(review.blockers).toContain('shadow-report-missing-selected-candidate');
  });
});
