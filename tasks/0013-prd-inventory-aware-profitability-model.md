# PRD 0013 — Inventory-Aware Profitability Model

## 1. Overview

Build the measurement and offline decision system needed to optimize the BTC-PYUSD maker for risk-adjusted profitability. The system must not infer that a quote would have filled solely because its price was touched. It must measure actual quote lifecycle outcomes, market context, post-fill adverse selection, and inventory risk before scoring policy changes.

The existing profitability-engine specification defines `positionDecayTarget: 0.0`, but production initializes inventory from the BTC balance. Before any live skew behavior changes, this PRD requires an explicit, configurable target inventory and defines skew from the deviation from that target. A raw BTC balance must not be assumed to be excess inventory.

## 2. Goals

- Make inventory skew act on an explicit inventory deviation, rather than implicitly treating all BTC holdings as excess inventory.
- Persist sufficient quote and market context to explain per-side fill quality.
- Score candidate quote policies on out-of-sample, risk-adjusted net P&L.
- Validate a selected policy in shadow mode before any live parameter change.

## 3. User Stories

- As the operator, I can explain whether one-sided fills came from inventory policy, quote placement, market conditions, or unavailable capital.
- As the operator, I can compare candidate spread, buffer, size, ladder, and reprice policies using the same net-cost and risk assumptions.
- As the operator, I can reject a policy that appears profitable only because of optimistic fill assumptions or inventory drift.
- As the operator, I can review a shadow-policy report before separately approving a production rollout.

## 4. Functional Requirements

### FR1 — Explicit inventory target and skew semantics

1. Define a configurable `targetInventoryBTC` and calculate inventory deviation as `netPosition - targetInventoryBTC`.
2. A positive deviation must widen bids and tighten asks; a negative deviation must tighten bids and widen asks.
3. The target must be surfaced in status and telemetry, with an explicit startup log of the target and initial deviation.
4. Unit tests must cover target-relative long, short, zero, maximum, and position-transition cases.
5. Changing the production target or deploying changed skew semantics is out of scope for this PRD and requires explicit operator approval after shadow evidence.

### FR2 — Quote-lifecycle telemetry

1. Persist one immutable event for quote creation, replacement, cancellation, rejection, partial fill, and full fill.
2. Each event must include a stable quote/order identifier, side, price, size, level, timestamps, action/reason, inventory, committed exposure, and configured policy identifier.
3. Capture reference-market state at decision time: Coinbase best bid/ask, TrueX EBBO/top-of-book when available, fair value, feed age, and volatility/market-state fields available to the engine.
4. Avoid credentials, account IDs, and raw secrets in telemetry.

### FR3 — Fill-quality attribution

1. Attribute each fill to its quote lifecycle and contemporaneous market context.
2. Compute 1-, 5-, and 60-minute mark-outs using an explicit available reference price; mark unavailable data as unavailable rather than zero.
3. Report fill probability, time-to-fill, realized spread, fees, hedge/slippage cost when present, and net inventory change by side.

### FR4 — Offline policy evaluator

1. Evaluate a declared policy vector: inventory skew, anchor buffer, spread, level spacing, quote size/decay, and reprice controls.
2. Score a policy as net P&L less fees, hedge/slippage costs, and a configurable inventory-risk penalty.
3. Use chronological train/validation splits; never train and score on the same window.
4. Apply conservative, configurable assumptions for queue position, latency, and unobserved fill probability.
5. Produce a machine-readable result plus a concise human report containing assumptions, coverage, P&L decomposition, inventory distribution, downside metrics, and reasons a result is not promotable.

### FR5 — Shadow-policy gate

1. Shadow evaluation must never dispatch FIX orders or mutate live quote configuration.
2. A candidate becomes eligible for an operator-reviewed canary only after a configured minimum observation window, complete telemetry coverage, and no breach of inventory/adverse-selection limits.
3. Production deployment remains out of scope and requires a separate explicit approval.

## 5. Non-Goals

- Reinforcement learning or automatic live parameter optimization.
- Inferring queue position perfectly from incomplete book data.
- Enabling taker orders, changing hedge routing, or changing production configuration in this work.
- Automated production rollout.

## 6. Technical Considerations

- The current `orders` table stores lifecycle-like records but not sufficient quote context for counterfactual fill modeling; use an additive telemetry schema/API.
- Keep raw event storage append-only and normalize analysis separately so historical reports remain reproducible.
- Use only configurable model parameters; no hard-coded profit thresholds or credentials.
- Preserve existing maker execution behavior until the shadow gate produces reviewed evidence.

## 7. Rollout & Gates

This work follows `.ai/protocols/STANDARD_DEV_WORKFLOW.md`.

- Separate bounded PRs: inventory skew correction; telemetry; offline evaluator and shadow scorer.
- For each code PR: adversarial review, `/pre-push-review`, declared smoke result, PR review loop, reviewer solicitation after every push, and no merge on CI alone.
- Run `/docs-generator` because the work touches scripts and documentation; open and review a docs PR before the corresponding code PR merges.
- After merge: validate from `main`, run the changed functionality end to end, write a mini-narrative, and record duration.
- Production is excluded. Any future production rollout requires an explicit operator approval and executable verification of effective configuration.

## 8. Success Metrics

- Quote lifecycle coverage and any missing-data rate are measured and reported before a promotion threshold is selected; fills that cannot be joined to a quote event/context are explicitly classified.
- Mark-out availability and missing-data rates are reported, never silently imputed as favorable values.
- Offline reports identify both expected net P&L and worst-case inventory/adverse-selection outcomes on held-out windows.
- Shadow reports make every promotion decision reproducible from recorded evidence.

## 9. Open Questions

- What observation duration and minimum fill count should be required before a policy is eligible for review?
- What `targetInventoryBTC` and allowable deviation band reflect the desired operating allocation?
- Which reference price should be authoritative for 1-/5-/60-minute mark-outs when TrueX top-of-book is unavailable?
- What inventory-risk penalty and maximum acceptable adverse-selection threshold should govern policy scoring?
