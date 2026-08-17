# Tasks — PRD 0014 Continuous Market-Maker Control and Profitability Iteration

## Relevant Files

- `.ai/code-reviewers.json` — reviewer-policy schema and PR solicitation.
- `src/core/inventory-manager.js` — exchange balance state and target-relative inventory.
- `src/core/quote-engine.js` — desired/live quotes, dispatch, reconciliation hooks, and lifecycle.
- `src/core/market-maker-orchestrator.js` — balance refresh, health state, REST reconciliation.
- `scripts/run-prod.js` — validated production configuration and rollout wiring.
- `src/data-pipeline/quote-lifecycle-telemetry.js` — quote/fill event storage.
- `src/analytics/offline-policy-evaluator.js` — held-out policy scoring.
- `src/analytics/shadow-policy-promotion.js` — approval-gated promotion evidence.
- `src/analytics/regime-strategy-validator.js` — pure regime scoring, clustered uncertainty, and gates.
- `src/analytics/regime-strategy-validator.test.js` — no-lookahead, regime, bootstrap, and fail-closed tests.
- `scripts/validate-regime-strategy.js` — offline JSON evidence/report entry point.
- `scripts/smoke-regime-strategy.js` — deterministic no-dispatch validation smoke.
- `tests/` and component `*.test.js` files — unit, integration, and smoke coverage.

## Task Ordering and Dependencies

Task 1 unblocks review governance. Task 2 is the source of truth for Tasks 3–4. Task 3 must
ship before adaptive policy changes so funding pressure cannot remove market presence. Task 4
uses the same state model and may begin after Task 2, but does not roll out before Task 3 so
profitability logic never undermines the continuity obligation. Task 5 validates the complete
measurement/promotion path after production telemetry is available.

## Tasks

- [ ] 1.0 Repair review-governance configuration
  - [ ] 1.1 Update reviewer entries with known family and approval-capability metadata.
  - [ ] 1.2 Declare the mandatory non-approving pre-push gate and named-human policy scope.
  - [ ] 1.3 Run the delivery-truth repo validator and record its result.
  - [ ] 1.4 Obtain the required approval for this reviewer-policy PR before merge.

- [ ] 2.0 Build the authoritative capital reservation and reconciliation model
  - [ ] 2.1 Define an idempotent reservation state model for pending-new, active, cancel-in-flight,
    replacement, rejected, cancelled, and filled orders.
  - [ ] 2.2 Reconcile REST available/held/total balances with local reservations without double-counting.
  - [ ] 2.3 Reserve before send; release/convert exactly once for every terminal execution path.
  - [ ] 2.4 Resync and recompute a funded size after insufficient-funds rejects.
  - [ ] 2.5 Add unit and integration coverage for duplicate, delayed, and out-of-order events.

- [ ] 3.0 Deliver verified two-sided presence and fail-soft execution
  - [ ] 3.1 Add acknowledged-live per-side presence state and configurable L1 reserve.
  - [ ] 3.2 Add normal/degraded/unsafe state transitions with structured causes.
  - [ ] 3.3 Preserve funded L1 when deeper levels are suppressed; restore an absent side safely.
  - [ ] 3.4 Add side-gap/two-sided-uptime metrics, alerts, and health output.
  - [ ] 3.5 Add a focused smoke and production soak proving continuous L1 plus zero funding rejects.

- [ ] 4.0 Deliver adaptive quote controls without reducing continuity
  - [ ] 4.1 Add validated obligation and policy configuration with fail-closed startup checks.
  - [ ] 4.2 Add a bounded volatility/feed-age/adverse-selection spread floor.
  - [ ] 4.3 Add target-relative inventory bands, bps skew, and side-size asymmetry.
  - [ ] 4.4 Add directional repricing, safe-side hysteresis, and action-budget metrics.
  - [ ] 4.5 Wire fresh TrueX EBBO into maker crossing safety and presence verification.
  - [ ] 4.6 Add shadow and canary coverage proving zero taker dispatch.

- [ ] 5.0 Close the profitability iteration loop
  - [ ] 5.1 Deploy/verify quote lifecycle telemetry and its coverage audit.
  - [ ] 5.2 Persist 1/5/60-minute side-specific Coinbase reference mark-outs.
  - [ ] 5.3 Implement a pure regime validator with strict no-lookahead reference joins and configurable
    clean/directional/high-volatility/stale classification.
  - [ ] 5.4 Cluster fragmented executions, run chronological held-out evaluation, and calculate
    deterministic cluster-bootstrap confidence intervals.
  - [ ] 5.5 Add an offline JSON CLI and smoke that separate observed evidence from same-fill buffer
    sensitivity and prove zero exchange/FIX dispatch capability.
  - [ ] 5.6 Gate every result on coverage, independent clusters, observation days, shadow fill-survival
    evidence, and lower-bound edge; default to `HOLD` and prohibit auto-promotion.
  - [ ] 5.7 Extend daily/weekly reports with realized spread, uptime, rejects, inventory, and PnL decomposition.
  - [ ] 5.8 Feed the held-out result into approval-gated shadow promotion and define canary rollback evidence.

## Required Gate Checklist for Each Code PR

- [ ] Create a fresh locked feature worktree from `origin/main`; never reuse a dusty branch.
- [ ] Run the dialectical player/coach loop for non-trivial changes.
- [ ] Commit small focused conventional commits.
- [ ] Run adversarial review, then pre-push review, then focused smoke.
- [ ] Push only after gates pass; solicit configured reviewers after every push and run the PR review loop.
- [ ] Run docs generation and a separate docs PR when scripts, docs, or content pipeline surfaces change.
- [ ] Merge only after CI, final reviewer approval, and valid smoke/soak evidence.
- [ ] From intended main, run full local validation, post-deploy effective-config verification, and a mini-narrative.
