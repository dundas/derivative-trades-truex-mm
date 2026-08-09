/** Read-only weekly synthesis. It cannot modify runtime configuration or deploy. */
export function buildWeeklyPromotionReview({ dailyReports = [], shadowReport = null, requiredDays = 7 } = {}) {
  const blockers = [];
  const dates = dailyReports.map(report => report.date).filter(date => typeof date === 'string' && date.length > 0);
  const distinctDays = new Set(dates).size;
  if (distinctDays < requiredDays) blockers.push(`insufficient-distinct-daily-reports:${distinctDays}/${requiredDays}`);
  const verdictOf = report => typeof report.verdict === 'string' ? report.verdict : report.verdict?.status;
  if (dailyReports.some(report => verdictOf(report) !== 'OK')) blockers.push('daily-review-missing-warn-or-error');
  if (!shadowReport) blockers.push('missing-shadow-promotion-report');
  if (shadowReport?.recommendation !== 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL') blockers.push('shadow-report-not-eligible');
  const selectedCandidateId = shadowReport?.selectedCandidateId || null;
  if (!selectedCandidateId) blockers.push('shadow-report-missing-selected-candidate');
  return {
    cadence: 'weekly-read-only', dailyReportsReviewed: dailyReports.length, distinctDaysReviewed: distinctDays, selectedCandidateId, blockers,
    decision: blockers.length ? 'HOLD' : 'CANDIDATE_REQUIRES_OPERATOR_APPROVAL',
    productionChangeAuthorized: false,
    requiredBeforeCanary: ['separate canary PRD', 'explicit operator approval', 'pre-deploy effective-state check', 'post-deploy effective-state verification', 'rollback plan'],
  };
}

export function formatWeeklyPromotionReview(review) {
  return `Weekly promotion review: ${review.decision}\nDaily reports: ${review.dailyReportsReviewed}\nCandidate: ${review.selectedCandidateId || 'none'}\nBlockers: ${review.blockers.join('|') || 'none'}\nProduction change: NOT AUTHORIZED. Required before canary: ${review.requiredBeforeCanary.join('; ')}`;
}
