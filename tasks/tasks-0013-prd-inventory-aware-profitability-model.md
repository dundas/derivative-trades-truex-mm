# Tasks — PRD 0013 Inventory-Aware Profitability Model

## Relevant Files

- `src/core/inventory-manager.js` — target-relative inventory and skew semantics.
- `src/core/quote-engine.js` — decision-time quote context and shadow-only policy integration.
- `src/core/market-maker-orchestrator.js` — wiring of market context and telemetry.
- `src/data-pipeline/` — additive persistence path for quote lifecycle events.
- `lib/postgresql-api/schemas/index.js` — additive analytics schema/index definitions.
- `scripts/run-prod.js` — configurable target inventory and policy identification; no deployment in this scope.
- `scripts/daily-perf-review.ts` — reuse/extend reporting conventions where appropriate.
- `scripts/` — offline evaluator and shadow-report CLI surfaces.
- `tests/inventory-manager.test.js` — target-relative skew tests.
- `tests/quote-engine.test.js` — quote decision/telemetry and non-dispatching tests.
- `docs/ARCHITECTURE.md` — inventory semantics and telemetry architecture.

## Task Ordering & Dependencies

1.0 establishes explicit, target-relative inventory semantics. It blocks telemetry because every event must state the policy target and deviation that produced a quote.

2.0 establishes immutable event evidence. It blocks the evaluator because a counterfactual score without observed decision context or lifecycle outcomes is not trustworthy.

3.0 builds the evaluator against recorded data. It blocks promotion reporting because it produces the policy score and uncertainty inputs.

4.0 exposes shadow-only policy reports and promotion criteria. It must remain non-dispatching and does not authorize a production rollout.

## Adversarial Review — Parent Plan

**Proposed action:** build target-relative inventory semantics, telemetry, an offline evaluator, and shadow reporting for a real-money maker.

**Strongest objections:** sparse one-sided fills can make a simulator look precise while it is unsupported; a raw BTC balance may be operating capital rather than excess inventory; quote-lifecycle rows are not a reliable queue model; and combining telemetry, policy changes, and deployment would create an unreviewable financial blast radius.

**Verdict: PROCEED WITH CONDITIONS.** The work is justified only as four bounded, independently reviewed PRs. The evaluator must expose missing coverage and conservative assumptions. Shadow paths must have a zero-FIX-send invariant. A production target, production configuration change, or canary is not authorized by this plan.

## Tasks

- [x] 1.0 Implement explicit target-relative inventory semantics
  - [x] 1.1 Add a configurable `targetInventoryBTC`; document its units, default behavior, and startup status visibility.
  - [x] 1.2 Calculate skew from `netPosition - targetInventoryBTC`; make positive deviation widen bids/tighten asks and negative deviation tighten bids/widen asks.
  - [x] 1.3 Preserve existing position-limit and balance-cap behavior; do not change a live target value in this task.
  - [x] 1.4 Add unit tests for zero deviation, positive/negative deviation, target-relative transitions, limits, and quote price direction.
  - [x] 1.5 Update architecture documentation with target-relative semantics.
  - [x] 1.6 Run `/adversarial-reviewer` on necessity/scope.
  - [x] 1.7 Run `/pre-push-review`; triage every finding.
  - [x] 1.8 Run focused unit tests plus a `NO_SERVER_SURFACE` smoke declaration.
  - [x] 1.9 Create a focused code PR; after each push solicit configured review and run `/pr-review-loop`.
  - [x] 1.10 Run `/docs-generator`, open/update the required docs PR, and send it through review.

- [ ] 2.0 Add append-only quote lifecycle and market-context telemetry
  - [ ] 2.1 Define a versioned quote-event schema for create, replace, cancel, reject, partial fill, and full fill events.
  - [ ] 2.2 Record stable identifiers, side, price, size, level, reason/action, policy ID, target/deviation, committed exposure, and decision timestamps.
  - [ ] 2.3 Attach available Coinbase, TrueX EBBO/top-of-book, fair-value, freshness, and volatility context without logging credentials or account identifiers.
  - [ ] 2.4 Add additive persistence, indexes, retention/error handling, and query helpers; do not mutate historical order/fill records.
  - [ ] 2.5 Test event creation, lifecycle linkage, unavailable-market fields, duplicate handling, and redaction.
  - [ ] 2.6 Run `/adversarial-reviewer`, `/pre-push-review`, and a persistence smoke against an isolated local test database or explicit `SMOKE_MISSING` follow-up.
  - [ ] 2.7 Create/review the code PR and required docs PR through `/pr-review-loop`.

- [ ] 3.0 Build the conservative offline policy evaluator
  - [ ] 3.1 Define the declared policy vector: skew, target, anchor buffer, spread, level spacing, sizing/decay, and reprice controls.
  - [ ] 3.2 Implement chronological train/validation splits and reject overlapping or look-ahead windows.
  - [ ] 3.3 Estimate fill probability with configurable conservative queue/latency assumptions; report coverage and unsupported regimes.
  - [ ] 3.4 Compute P&L decomposition: realized spread, mark-outs, fees, hedge/slippage when available, inventory-risk penalty, and uncertainty/missing-data warnings.
  - [ ] 3.5 Produce machine-readable and human-readable reports that name every input assumption.
  - [ ] 3.6 Add deterministic fixtures for no fills, one-sided fills, missing context, adverse selection, and train/validation leakage.
  - [ ] 3.7 Run `/adversarial-reviewer`, `/pre-push-review`, evaluator smoke with fixtures, PR review loop, and required docs workflow.

- [ ] 4.0 Add shadow-policy scoring and promotion reporting
  - [ ] 4.1 Evaluate declared candidate policies against new telemetry without changing quote parameters or dispatching FIX messages.
  - [ ] 4.2 Implement configurable, evidence-based promotion report fields: observation window, fill/context coverage, net-P&L range, inventory distribution, adverse-selection limits, and explicit blockers.
  - [ ] 4.3 Add hard tests that assert zero `fixConnection.sendMessage` calls on every shadow path.
  - [ ] 4.4 Add an operator-facing smoke that uses synthetic events and proves report generation with zero execution side effects.
  - [ ] 4.5 Run `/adversarial-reviewer`, `/pre-push-review`, smoke, PR review loop, and required docs workflow.
  - [ ] 4.6 Do not deploy or change production configuration. A future production canary requires a separate PRD, explicit operator approval, and post-deploy effective-state verification.

- [ ] 5.0 Merge and validate each approved PR
  - [ ] 5.1 Merge only after CI, an explicit non-Codex review on the final commit, smoke evidence, and required docs PR are complete.
  - [ ] 5.2 Pull `main`, run full relevant local validation, and validate each changed feature end to end.
  - [ ] 5.3 Write a mini-narrative and duration signal after each merge; promote durable process learnings to `memory/MEMORY.md`.
  - [ ] 5.4 Clean up each merged branch/worktree under SO-26.
