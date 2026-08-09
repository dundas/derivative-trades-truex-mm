/** Pure, offline, observed-evidence evaluator. It never dispatches orders. */
export const DEFAULT_ASSUMPTIONS = Object.freeze({ queueFillProbability: 0.5, latencyPenaltyBps: 1, inventoryRiskPenaltyPerBtc: 0, minContextCoverage: 0.8 });
const HORIZONS = { '1m': 60000, '5m': 300000, '60m': 3600000 };

export function validatePolicyVector(policy = {}) {
  const keys = ['targetInventoryBTC', 'maxSkewTicks', 'anchorBufferTicks', 'baseSpreadBps', 'levelSpacingTicks', 'baseSizeBTC', 'sizeDecayFactor', 'repriceThresholdTicks'];
  const missing = keys.filter(key => !Number.isFinite(policy[key]));
  if (missing.length) throw new Error(`Policy vector missing finite values: ${missing.join(', ')}`);
  return { ...policy };
}
export function chronologicalSplit(events, split = {}) {
  const { trainEnd, validationStart, validationEnd } = split;
  if (![trainEnd, validationStart, validationEnd].every(Number.isFinite) || trainEnd > validationStart || validationStart >= validationEnd) throw new Error('Chronological split requires trainEnd <= validationStart < validationEnd');
  const ids = new Set();
  for (const event of events) { if (!Number.isFinite(event.timestamp)) throw new Error('Events require finite timestamps'); if (event.eventId && ids.has(event.eventId)) throw new Error(`Duplicate eventId: ${event.eventId}`); if (event.eventId) ids.add(event.eventId); }
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  return { train: sorted.filter(e => e.timestamp < trainEnd), validation: sorted.filter(e => e.timestamp >= validationStart && e.timestamp < validationEnd) };
}
function closestReference(references, horizon) { return references.find(r => Number.isFinite(r.timestamp) && r.timestamp >= horizon && Number.isFinite(r.price)) || null; }

export function evaluatePolicy(events, { policy, split, assumptions = {}, referencePrices = [] } = {}) {
  validatePolicyVector(policy); const config = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  if (!(config.queueFillProbability >= 0 && config.queueFillProbability <= 1) || !Number.isFinite(config.latencyPenaltyBps)) throw new Error('Invalid conservative assumptions');
  const { validation } = chronologicalSplit(events, split);
  const vectorKeys = ['targetInventoryBTC','maxSkewTicks','anchorBufferTicks','baseSpreadBps','levelSpacingTicks','baseSizeBTC','sizeDecayFactor','repriceThresholdTicks'];
  const malformedPolicyVectors = validation.filter(e => e.policyVector && vectorKeys.some(key => !Number.isFinite(e.policyVector[key]))).length;
  const quotes = new Map(), outcomes = { cancelled: 0, rejected: 0, filled: 0, unlinkedFills: 0, timeToFillMs: [] };
  for (const event of validation) {
    if (event.eventType === 'create' || event.eventType === 'replace') quotes.set(event.quoteId, { ...event, fillQty: 0, fillEvents: [] });
    if (event.eventType === 'cancel') outcomes.cancelled++;
    if (event.eventType === 'reject') outcomes.rejected++;
    if (event.eventType === 'partial_fill' || event.eventType === 'full_fill') {
      const quote = quotes.get(event.quoteId); if (!quote) { outcomes.unlinkedFills++; continue; }
      quote.fillQty += Number(event.size) || 0; quote.fillEvents.push(event); outcomes.filled++;
      outcomes.timeToFillMs.push(Math.max(0, event.timestamp - quote.timestamp));
    }
  }
  const refs = Array.isArray(referencePrices) ? [...referencePrices].sort((a,b) => a.timestamp-b.timestamp) : Object.entries(referencePrices).map(([timestamp, price]) => ({ timestamp: Number(timestamp), price })).sort((a,b) => a.timestamp-b.timestamp);
  const allFills = [...quotes.values()].flatMap(q => q.fillEvents);
  let grossSpread = 0, fees = 0, hedgeSlippage = 0, inventoryChange = 0;
  const markouts = Object.fromEntries(Object.keys(HORIZONS).map(k => [k, { pnl: 0, available: 0, unavailable: 0, rate: null, references: [] }]));
  for (const fill of allFills) {
    const qty = Number(fill.size) || 0, price = Number(fill.price) || 0, sign = fill.side === 'buy' ? 1 : -1, fair = Number(fill.context?.fairValue);
    inventoryChange += sign * qty;
    if (Number.isFinite(fair) && price) grossSpread += (fill.side === 'buy' ? fair-price : price-fair) * qty;
    fees += Number(fill.fee ?? fill.context?.fee ?? 0); hedgeSlippage += Number(fill.hedgeSlippage ?? 0);
    for (const [key, delay] of Object.entries(HORIZONS)) { const horizon = fill.timestamp + delay, ref = closestReference(refs, horizon); if (!ref || (Number.isFinite(config.maxReferenceAgeMs) && ref.timestamp - horizon > config.maxReferenceAgeMs)) markouts[key].unavailable++; else { markouts[key].available++; markouts[key].references.push({ fillEventId: fill.eventId || null, timestamp: ref.timestamp, price: ref.price, source: ref.source || null }); markouts[key].pnl += (fill.side === 'buy' ? ref.price-price : price-ref.price) * qty; } }
  }
  for (const result of Object.values(markouts)) result.rate = allFills.length ? result.available / allFills.length : null;
  const eligible = quotes.size, observed = allFills.length;
  const filledQuotes = [...quotes.values()].filter(q => q.fillEvents.length > 0);
  // Candidate compatibility is deliberately bounded by observed quote context:
  // size cannot score above the observed quote size; spread uses only the
  // observed fair-value edge. It changes a candidate score without inventing fills.
  let missingPolicyVectors = 0;
  let unsupportedQuoteVectors = 0;
  let malformedQuoteVectors = 0;
  const compatibility = eligible ? [...quotes.values()].reduce((sum, q) => {
    const observed = q.policyVector || q.context?.policyVector;
    if (!observed) { missingPolicyVectors++; unsupportedQuoteVectors++; return sum; }
    if (vectorKeys.some(key => !Number.isFinite(observed[key]))) { malformedQuoteVectors++; unsupportedQuoteVectors++; return sum; }
    // Formula: product over all declared dimensions of min(candidate/observed,
    // observed/candidate), with a signed-target comparison shifted by 1 BTC.
    // It is in [0,1], so candidate scoring cannot amplify observed fills.
    const factor = vectorKeys.reduce((product, key) => {
      const candidate = Math.abs(policy[key]) + (key === 'targetInventoryBTC' ? 1 : 1e-12);
      const historical = Math.abs(observed[key]) + (key === 'targetInventoryBTC' ? 1 : 1e-12);
      return product * Math.min(candidate / historical, historical / candidate);
    }, 1);
    return sum + factor;
  }, 0) / eligible : 0;
  const conservativeFillFactor = eligible ? Math.min(1, config.queueFillProbability * compatibility * (filledQuotes.length / eligible || 0)) : 0;
  const latencyCost = allFills.reduce((s, f) => s + (Number(f.price)||0)*(Number(f.size)||0)*config.latencyPenaltyBps/10000, 0);
  const inventoryPenalty = Math.abs(inventoryChange) * config.inventoryRiskPenaltyPerBtc;
  const netPnl = (grossSpread - fees - hedgeSlippage - latencyCost - inventoryPenalty) * conservativeFillFactor;
  const contextCoverage = validation.length ? validation.filter(e => Number.isFinite(e.context?.fairValue)).length / validation.length : 0;
  const warnings = []; if (!validation.length) warnings.push('unsupported-regime:no-validation-events'); if (!observed) warnings.push('unsupported-regime:no-observed-fills'); if (contextCoverage < config.minContextCoverage) warnings.push(`missing-context:coverage=${contextCoverage.toFixed(3)}`); if (missingPolicyVectors) warnings.push(`missing-policy-vector:${missingPolicyVectors}`); if (malformedPolicyVectors + malformedQuoteVectors) warnings.push(`malformed-policy-vector:${malformedPolicyVectors + malformedQuoteVectors}`); if (unsupportedQuoteVectors) warnings.push(`unsupported-quote-policy-vector:${unsupportedQuoteVectors}`); if (outcomes.unlinkedFills) warnings.push(`unlinked-fills:${outcomes.unlinkedFills}`); if (Object.values(markouts).some(v => v.unavailable)) warnings.push('markout-unavailable-or-stale');
  const positions = allFills.reduce((a, f) => { a.push((a.at(-1)||0)+(f.side === 'buy' ? 1 : -1)*(Number(f.size)||0)); return a; }, []);
  return { policy, assumptions: config, split, policyOutcome: warnings.length ? 'not-promotable' : 'evaluable', methodology: 'Observed fills only; candidate score = observed net P&L × queue probability × filled-quote rate × product(min(candidate/historical,historical/candidate)) across every declared policy dimension. No synthetic fills.', coverage: { events: validation.length, eligibleQuotes: eligible, unsupportedQuoteVectors, filledQuotes: filledQuotes.length, observedFills: observed, context: contextCoverage, observedFillProbability: eligible ? filledQuotes.length/eligible : null, policyCompatibility: compatibility, conservativeFillFactor, outcomes, timeToFillMs: outcomes.timeToFillMs }, decomposition: { grossSpread, fees, hedgeSlippage, latencyCost, inventoryPenalty, netPnl, inventoryChange, markouts }, inventory: { final: inventoryChange, min: Math.min(0,...positions), max: Math.max(0,...positions) }, uncertainty: { missingContextEvents: validation.length - Math.round(contextCoverage*validation.length), markoutUnavailable: Object.fromEntries(Object.entries(markouts).map(([k,v])=>[k,v.unavailable])) }, warnings, promotable: warnings.length===0 };
}
export function formatEvaluationReport(r) { const d=r.decomposition,c=r.coverage; return `Policy evaluation (${r.policyOutcome})\nQuotes ${c.eligibleQuotes}; fills ${c.observedFills}; context ${(c.context*100).toFixed(1)}%; time-to-fill ${c.timeToFillMs.join(',')||'unavailable'}ms\nNet P&L ${d.netPnl.toFixed(2)}; gross ${d.grossSpread.toFixed(2)}; fees ${d.fees.toFixed(2)}; hedge ${d.hedgeSlippage.toFixed(2)}; latency ${d.latencyCost.toFixed(2)}; inventory ${d.inventoryPenalty.toFixed(2)}\nMarkouts 1m/5m/60m: ${Object.entries(d.markouts).map(([k,v])=>`${k}:${v.available}/${v.available+v.unavailable}`).join(' ')}\nWarnings: ${r.warnings.join(', ')||'none'}`; }
