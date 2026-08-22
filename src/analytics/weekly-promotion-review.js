/** Read-only weekly synthesis. It cannot modify runtime configuration or deploy. */
function sumObserved(dailyReports, selector, initial, add) {
  return dailyReports.reduce((total, report) => {
    const value = selector(report);
    return value?.evidence === 'observed' ? add(total, value) : total;
  }, initial);
}

function performanceEvidence(report, component) {
  if (!report?.performance) {
    return { evidence: 'unavailable', reason: 'daily-performance-missing' };
  }
  const value = report.performance[component];
  if (!value || (value.evidence !== 'observed' && value.evidence !== 'unavailable')) {
    return { evidence: 'unavailable', reason: `daily-performance-component-missing:${component}` };
  }
  return value;
}

function unavailableEvidence(dailyReports, component) {
  const evidence = dailyReports.map(report => performanceEvidence(report, component));
  const unavailable = evidence.filter(value => value.evidence === 'unavailable');
  return {
    days: unavailable.length,
    reasons: [...new Set(unavailable.map(value => value.reason))],
    coverage: { reviewedDays: dailyReports.length, observedDays: evidence.length - unavailable.length, unavailableDays: unavailable.length },
  };
}

function buildWeeklyPerformanceSummary(dailyReports) {
  const sameDayOpposingFillProxy = sumObserved(dailyReports, report => performanceEvidence(report, 'sameDayOpposingFillProxy'), { days: 0, pnl: 0, matchedQty: 0 }, (total, value) => ({ days: total.days + 1, pnl: total.pnl + value.pnl, matchedQty: total.matchedQty + value.matchedQty }));
  const rejectEvidence = dailyReports.map(report => performanceEvidence(report, 'rejects'));
  const attributableRejectRates = rejectEvidence.every(value => value.evidence === 'observed' && Number.isFinite(value.rate));
  const rejects = sumObserved(dailyReports, report => performanceEvidence(report, 'rejects'), { attempts: 0, rejects: 0, rate: null, rateAvailable: attributableRejectRates }, (total, value) => ({ attempts: total.attempts + (value.attempts ?? 0), rejects: total.rejects + value.rejects, rate: null, rateAvailable: total.rateAvailable }));
  rejects.rate = rejects.rateAvailable && rejects.attempts > 0 ? rejects.rejects / rejects.attempts : null;
  const pnl = sumObserved(dailyReports, report => performanceEvidence(report, 'pnl'), { realizedGross: 0, fees: 0, netRealizedAfterFees: 0 }, (total, value) => ({ realizedGross: total.realizedGross + value.realizedGross, fees: total.fees + value.fees, netRealizedAfterFees: total.netRealizedAfterFees + value.netRealizedAfterFees }));
  return {
    observed: { sameDayOpposingFillProxy, rejects, pnl },
    unavailable: {
      realizedSpread: unavailableEvidence(dailyReports, 'realizedSpread'),
      sameDayOpposingFillProxy: unavailableEvidence(dailyReports, 'sameDayOpposingFillProxy'),
      uptime: unavailableEvidence(dailyReports, 'uptime'),
      rejects: unavailableEvidence(dailyReports, 'rejects'),
      inventory: unavailableEvidence(dailyReports, 'inventory'),
    },
    // Weekly aggregation must never turn missing daily counterfactuals into an estimate.
    counterfactual: { evidence: 'unavailable', reason: 'no counterfactual performance is inferred from observed fills' },
  };
}

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
    performance: buildWeeklyPerformanceSummary(dailyReports),
    decision: blockers.length ? 'HOLD' : 'CANDIDATE_REQUIRES_OPERATOR_APPROVAL',
    productionChangeAuthorized: false,
    requiredBeforeCanary: ['separate canary PRD', 'explicit operator approval', 'pre-deploy effective-state check', 'post-deploy effective-state verification', 'rollback plan'],
  };
}

export function formatWeeklyPromotionReview(review) {
  const p = review.performance;
  return `Weekly promotion review: ${review.decision}\nDaily reports: ${review.dailyReportsReviewed}\nCandidate: ${review.selectedCandidateId || 'none'}\nBlockers: ${review.blockers.join('|') || 'none'}\nObserved performance: same-day opposing-fill proxy (not realized spread) ${p.observed.sameDayOpposingFillProxy.pnl} on ${p.observed.sameDayOpposingFillProxy.matchedQty}; rejects ${p.observed.rejects.rejects}/${p.observed.rejects.attempts}${p.observed.rejects.rateAvailable ? '' : ' (rate unavailable)'}; PnL net ${p.observed.pnl.netRealizedAfterFees}\nUnavailable performance evidence: realized spread ${p.unavailable.realizedSpread.days} day(s); same-day opposing-fill proxy ${p.unavailable.sameDayOpposingFillProxy.days} day(s); uptime ${p.unavailable.uptime.days} day(s); rejects ${p.unavailable.rejects.days} day(s); inventory ${p.unavailable.inventory.days} day(s)\nCounterfactual: unavailable (${p.counterfactual.reason})\nProduction change: NOT AUTHORIZED. Required before canary: ${review.requiredBeforeCanary.join('; ')}`;
}
