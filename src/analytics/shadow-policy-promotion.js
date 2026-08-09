import { evaluatePolicy } from './offline-policy-evaluator.js';

export const DEFAULT_PROMOTION_CRITERIA = Object.freeze({
  minObservationEvents: 100,
  minObservationWindowMs: 0,
  minContextCoverage: 0.8,
  minNetPnl: 0,
  maxInventoryRangeBTC: 0.05,
  maxAdverseMarkoutLoss: 0,
});

/**
 * Pure counterfactual scoring and promotion reporting. It deliberately has no
 * exchange, orchestrator, or FIX dependency: candidates are observations only.
 */
export function buildShadowPromotionReport({ events = [], candidates = [], evaluator = {}, criteria = {}, fixConnection = null } = {}) {
  const limits = { ...DEFAULT_PROMOTION_CRITERIA, ...criteria };
  if (!Array.isArray(candidates) || !candidates.length) throw new Error('At least one declared candidate policy is required');
  const reports = candidates.map(candidate => {
    const evaluation = evaluatePolicy(events, { ...evaluator, policy: candidate.policy });
    const blockers = [...evaluation.warnings];
    const inventoryRange = evaluation.inventory.max - evaluation.inventory.min;
    const validationEvents = events.filter(event => event.timestamp >= evaluator.split?.validationStart && event.timestamp < evaluator.split?.validationEnd);
    const timestamps = validationEvents.map(event => event.timestamp).filter(Number.isFinite);
    const observationWindowMs = timestamps.length ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    if (evaluation.coverage.events < limits.minObservationEvents) blockers.push(`insufficient-observation-events:${evaluation.coverage.events}/${limits.minObservationEvents}`);
    if (observationWindowMs < limits.minObservationWindowMs) blockers.push(`insufficient-observation-window:${observationWindowMs}/${limits.minObservationWindowMs}`);
    if (limits.minContextCoverage !== (evaluator.assumptions?.minContextCoverage ?? 0.8) && evaluation.coverage.context < limits.minContextCoverage) blockers.push(`insufficient-context-coverage:${evaluation.coverage.context.toFixed(3)}`);
    if (evaluation.decomposition.netPnl < limits.minNetPnl) blockers.push(`net-pnl-below-floor:${evaluation.decomposition.netPnl.toFixed(2)}`);
    if (inventoryRange > limits.maxInventoryRangeBTC) blockers.push(`inventory-range-above-limit:${inventoryRange.toFixed(6)}`);
    if (evaluation.decomposition.markouts['1m'].pnl < -Math.abs(limits.maxAdverseMarkoutLoss)) blockers.push(`adverse-markout-above-limit:${evaluation.decomposition.markouts['1m'].pnl.toFixed(2)}`);
    const adverseMarkout = evaluation.decomposition.markouts['1m'].pnl;
    const netPnl = evaluation.decomposition.netPnl;
    return { candidateId: candidate.id || 'unnamed', policy: candidate.policy, evaluation, observationWindowMs, inventoryRangeBTC: inventoryRange, adverseMarkout, netPnlRange: { lower: netPnl + Math.min(0, adverseMarkout), upper: netPnl }, blockers, eligibleForHumanReview: blockers.length === 0 };
  });
  const eligible = reports.filter(report => report.eligibleForHumanReview).sort((a, b) => b.evaluation.decomposition.netPnl - a.evaluation.decomposition.netPnl);
  return {
    mode: 'shadow-only',
    dispatches: 0,
    criteria: limits,
    observationWindow: { start: evaluator.split?.validationStart ?? null, end: evaluator.split?.validationEnd ?? null },
    reports,
    recommendation: eligible.length ? 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL' : 'HOLD',
    selectedCandidateId: eligible[0]?.candidateId || null,
    operatorApprovalRequired: true,
    productionChangeAuthorized: false,
    // Accepted only to make the no-dispatch boundary testable; never invoked.
    fixConnectionProvided: Boolean(fixConnection),
  };
}

export function formatShadowPromotionReport(report) {
  const lines = [`Shadow policy promotion: ${report.recommendation}`, `Dispatches: ${report.dispatches} (must remain 0)`];
  lines.push(`Observation window: ${report.observationWindow.start ?? 'unknown'}..${report.observationWindow.end ?? 'unknown'}`);
  for (const candidate of report.reports) lines.push(`${candidate.candidateId}: coverage=${candidate.evaluation.coverage.events}/${candidate.evaluation.coverage.eligibleQuotes} observed-window-ms=${candidate.observationWindowMs} net-range=${candidate.netPnlRange.lower.toFixed(2)}..${candidate.netPnlRange.upper.toFixed(2)} adverse-1m=${candidate.adverseMarkout.toFixed(2)} blockers=${candidate.blockers.join('|') || 'none'}`);
  lines.push('Production configuration change: NOT AUTHORIZED; explicit operator approval required.');
  return lines.join('\n');
}
