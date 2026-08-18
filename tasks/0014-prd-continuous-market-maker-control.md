# PRD 0014 — Continuous Market-Maker Control and Profitability Iteration

## 1. Overview

TrueX depends on this system to provide continuous two-sided BTC-PYUSD liquidity. The current
maker must therefore not respond to funding pressure, inventory drift, or market volatility by
letting the market disappear. At the same time, production evidence shows repeated
`Insufficient balance` rejections, exchange/local balance drift, aggressive one-tick Coinbase
mirroring, and adverse-selection losses.

This program adds the execution control plane required to keep a valid funded L1 quote on each
side whenever market data and order entry are healthy, then adds measurable adaptive pricing and
inventory controls to improve profitability. It does not authorize taker trading.

## 2. Goals

- Maintain continuous, verified two-sided maker presence within operator-configured TrueX
  obligations.
- Eliminate preventable funding rejects through one authoritative reservation model.
- Treat inventory relative to an explicit configurable operating target, not an assumed zero.
- Widen, resize, and reprice defensively without withdrawing valid L1 liquidity.
- Produce side-specific, reference-price-based evidence that supports rapid but controlled policy
  iteration.

## 3. User Stories

- As a venue operator, I always see at least one valid acknowledged bid and ask while the maker is
  healthy and funded.
- As a risk operator, I can distinguish exchange funds, venue-held funds, local reservations, and
  pending order state without double counting them.
- As a strategy operator, I can see whether a policy loses to adverse selection, inventory carry,
  or missing market presence.
- As an operator, I can make a policy canary change only after shadow and held-out evidence is
  available, and can roll it back through configuration.

## 4. Functional Requirements

### FR1 — Authoritative capital and order-state reconciliation

1. Introduce a single capital-reservation component used by all maker placement, replacement,
   cancellation, fill, and balance-refresh paths.
2. Model exchange `available`, `held`, and `total` balances separately from local pending-new,
   active, cancel-in-flight, and replacement reservations. It must never subtract the same hold
   twice.
3. Reserve funds synchronously before dispatching a new order and release or convert the
   reservation exactly once on accept, reject, cancel, expiry, or fill.
4. On an insufficient-funds reject, reconcile exchange balances and live orders before another
   placement on that side; retry only with a newly computed funded size.
5. Expose a structured reconciliation status and drift reason. No credentials or account IDs may
   be persisted in telemetry.

### FR2 — Continuous two-sided presence controller

1. Derive side presence from acknowledged live exchange orders, not desired quotes or outbound
   messages.
2. Maintain a configurable `minActiveLevelsPerSide`, minimum funded quote size, and maximum
   side-gap duration. These are deployment configuration, not source constants.
3. Reserve capital for L1 before allocating deeper levels. When funds are constrained, suppress
   L2+ first and retain a funded L1 bid and ask.
4. Detect a missing acknowledged side, classify its cause, and restore it using the reserved L1
   budget without bypassing post-only, balance, rate, or market-data safety gates.
5. Record side-gap starts, recoveries, duration, reason, and two-sided uptime. Alert only after a
   configurable threshold with rate limiting.

### FR3 — Fail-soft execution mode

1. Add explicit `normal`, `degraded`, and `unsafe` maker execution states.
2. `degraded` must reduce levels and sizes and apply a defensive spread floor while retaining
   funded L1 quotes on both sides whenever order entry and reference data are healthy.
3. `unsafe` may cancel or withhold quotes only for stale/invalid reference data, order-entry loss,
   failed reconciliation with no safe funded quote, or an explicit emergency kill switch.
4. Every side/level suppression must include a machine-readable reason and the state transition
   that caused it.
5. The controller must never label a desired, pending, or locally cached order as venue presence;
   only an acknowledged live order can satisfy a continuity obligation.

### FR4 — Adaptive quote policy

1. Add configurable, bounded spread-floor calculation using volatility, reference-feed age,
   recent side-specific adverse selection, and an inventory-risk component.
2. Preserve contractual maximum-spread and minimum-size constraints supplied at deployment.
3. Add target-relative inventory bands, bps-based price skew, and side-size asymmetry. A positive
   deviation must discourage additional buys and encourage sells; the inverse applies below target.
4. Add directional repricing: immediately protect a quote made more dangerous by a reference move,
   while batching safe-side improvements subject to quote-age and action-budget limits.
5. Wire fresh TrueX EBBO into maker post-only/crossing safety and presence verification without
   mutating the separate shadow-take state.

### FR5 — Measurement and policy iteration

1. Deploy and validate the existing quote-lifecycle telemetry, offline evaluator, and shadow
   promotion components against production data.
2. Persist and report Coinbase reference mark-outs at 1, 5, and 60 minutes after every fill,
   separately by side, level, policy version, and data availability.
3. Report realized spread, fill probability, time-to-fill, two-sided uptime, rejection rate,
   inventory distribution, and net PnL decomposition.
4. A policy candidate may change live configuration only after configured coverage, held-out
   evaluation, shadow evidence, and an explicit operator approval. It must never auto-promote.
5. Add a pure offline regime-strategy validator that accepts normalized fill/reference evidence
   and never imports or invokes FIX, exchange-order, or deployment code.
6. Join each fill only to reference observations available at or before the decision timestamp and
   to 1/5/60-minute observations at or after the requested horizon within a configured maximum age.
   Missing, stale, duplicate, or out-of-order evidence must be classified explicitly and must not
   be scored as neutral or favorable.
7. Collapse fragmented fills from the same side/price execution burst into configurable independent
   clusters before calculating coverage, quantiles, confidence intervals, or promotion gates,
   including matching fragments separated by interleaved fills from another side or price.
8. Classify clean, directional-risk, high-volatility, and stale-reference regimes from configurable
   thresholds. Report observed edge separately from same-fill candidate-buffer sensitivity; label
   the latter as counterfactual and never infer that historical fills would have survived wider quotes.
9. Evaluate chronological held-out days and deterministic cluster-bootstrap confidence intervals.
   No random train/test shuffle or look-ahead calibration is permitted.
10. Default to `HOLD` unless reference coverage, independent cluster count, distinct UTC days with
    scored held-out clusters, candidate-identity-bound shadow fill-survival evidence, and the
    configured lower confidence bound all pass. The model may recommend a candidate for human
    review but may never authorize production or auto-promote.
11. Record reference product, quote currency, source type, timestamp, and any PYUSD/USD basis
    adjustment. Every promotion-grade source requires a positive, non-crossed bid and ask and a basis
    adjustment inside a configurable absolute bound. Candle-range evidence may diagnose definite
    staleness but is never promotion-grade, even if a caller includes `candle` in the configured
    source list; promotion requires fresh top-of-book or equivalent point-in-time reference evidence.
12. Conservative default gates are at least 95% promotion-grade reference coverage, 100 independent
    fill clusters across five scored UTC days, at least 100 identity-bound shadow clusters with at
    least 50% observed fill survival, and a 95% cluster-bootstrap lower bound above +2bps at the
    configured primary horizon. Every default is validated configuration rather than an embedded
    production-policy authorization.
13. Treat reference mark-outs as append-only, idempotent evidence. Each unique fill must create
    durable pending observations for the configured horizons so process restarts can recover and
    complete them; an in-memory timer alone is insufficient. Duplicate or out-of-order execution
    reports must not create duplicate evidence.
14. A promotion-grade decision or horizon observation must contain the configured product and quote
    currency, a configured source type, source and receipt timestamps, and positive non-crossed
    Coinbase bid and ask prices. A horizon may use only the first valid observation at or after its
    due timestamp and within a configurable maximum lateness; otherwise it must persist an explicit
    unavailable reason. No future observation may be joined to a quote decision.
15. Reference collection and persistence are observability-only and fail soft: failures must be
    logged and counted but must never block, cancel, resize, reprice, or dispatch an order. Product,
    quote currency, source type, horizons, freshness/lateness bounds, batch size, poll interval, and
    retention must be validated configuration rather than embedded strategy constants.
16. Provide a bounded coverage audit grouped by side, quote level, policy version, horizon, and
    availability reason. It must report missing quote attribution and invalid or stale market data
    honestly and must never convert unavailable evidence into a neutral or favorable return.

## 5. Non-Goals

- Enabling live taker orders or cross-venue hedge dispatch.
- Guessing TrueX market-maker contractual limits.
- Automatically increasing quote size or widening beyond deployment-configured limits.
- Replacing the existing FIX protocol implementation.

## 6. Technical Considerations

- Extend `InventoryManager` and `QuoteEngine` only through explicit interfaces; local desired
  orders cannot be the source of truth for venue presence.
- Preserve the existing post-only behavior, cancel/replacement safeguards, rate limiter, and
  shadow-take non-dispatch guarantee.
- All policy and obligation values must use validated environment configuration with conservative
  defaults; secrets remain environment-only and never enter committed files.
- Production startup must fail closed if required market-maker-obligation configuration is absent,
  invalid, or internally contradictory (for example, a minimum L1 notional above its configured
  per-side reserve). A configuration check is not proof of venue compliance; the post-deploy smoke
  must verify the effective configuration and acknowledged quotes.
- Reconciliation must be idempotent under duplicate execution reports, out-of-order cancels, and
  REST snapshots that lag FIX messages.
- Mark-out recovery must claim due work safely across overlapping pollers and restart without
  duplicate completion. Retention may remove only completed/terminal evidence older than the
  configured cutoff; pending work remains recoverable.

## 7. Rollout and Gates

This program follows `.ai/protocols/STANDARD_DEV_WORKFLOW.md`.

1. Deliver the reviewer-policy repair as a separate governance PR.
2. Deliver capital reconciliation and two-sided continuity as the first code PR. Run the
   dialectical player/coach loop, adversarial review, pre-push review, executable smoke, PR review
   loop, and a production soak proving zero funding rejects and preserved L1 presence.
3. Deliver adaptive policy and reference mark-outs in separately reviewable PRs, with docs PRs
   where scripts or documentation change.
4. Each production deployment must be built serially, verified against effective configuration,
   and have a rollback command and previous-image identifier recorded before rollout.
5. Post-merge, test from intended `main`, run the full suite and focused smoke, write the required
   mini-narrative, and retain deployment/soak evidence.
6. No production strategy parameter change may proceed while the contractual obligation values in
   Section 9 are unresolved; continuity code may ship only with behavior no less protective of
   existing configured quoting than the current deployment.

## 8. Success Metrics

- Zero `Insufficient balance` rejects over a 24-hour production soak.
- Two-sided uptime and maximum one-sided gap meet deployment-configured obligations.
- L1 survives depth suppression when sufficient funds and healthy feeds exist.
- 100% of fills have a classified telemetry record; unavailable reference mark-outs are reported
  as unavailable rather than favorable.
- A policy cannot promote without explicit approval and positive configured held-out/shadow gates.
- The validator reproduces the August 10–16 evidence as `HOLD`, reports unavailable reference data
  honestly, and keeps observed and counterfactual results visibly separate.

## 9. Open Questions

- What are the binding TrueX minimum-size, maximum-spread, depth, and side-gap obligations?
- Which approved human/GitHub identity should be recorded for reviewer-policy governance?
- What inventory target and risk band should be applied after the exchange/local position model is
  reconciled?
