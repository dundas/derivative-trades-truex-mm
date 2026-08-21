---
generated_at: 2026-08-21T19:50:47Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: feat/quote-lifecycle-telemetry-revalidation
git_commit: f30e899
harness: codex
cli: bun 1.3.3
model: unknown
review_subject: Explicit missing quote-attribution classification in bounded reference-markout coverage
---

PROPOSED: Merge a two-file telemetry correction that labels a fill without a same-session, prior quote decision as `unavailable` with reason `missing-quote-attribution`. This makes an otherwise ambiguous coverage gap visible in the already bounded, read-only audit.

AGAINST:

1. A correlated attribution lookup can add database cost to a reporting query.
2. A false attribution rule could hide usable markouts or mistakenly call a coverage gap unavailable.
3. The word "telemetry" can invite a premature claim that the strategy is ready to trade.

ASSUMPTIONS:

- [VERIFIED] The lookup is constrained by session, quote id, and `decision_timestamp <= fill_timestamp`, so it does not use future decisions.
- [VERIFIED] The existing session/quote/timestamp index supports the lookup and the outer query is hard capped at `limit + 1`, maximum 1,000 groups.
- [VERIFIED] The changed path is reporting-only; focused tests and zero-FIX smokes preserve no order-dispatch capability.
- [UNVERIFIED] Production data volume remains within the expected report latency bound; this is why the post-merge observer rollout must run the bounded report.
- [UNVERIFIED] Real 1/5/60-minute coverage will accrue while observe mode remains active, because no new fills are created there.

MODEL-TRAJECTORY:

- [DURABLE] Immutable attribution and explicit unavailable reasons improve the evidence quality required for any future market-making decision.
- [NEUTRAL] The bounded SQL report is ordinary infrastructure, not model-dependent scaffolding.

COMPLIANCE CHECK: No urgency, authority, or verification-bypass pattern is accepted. The user objective calls for performance improvement, but this change must only improve measurement; it must not be represented as a profitability or live-trading promotion.

VERDICT: PROCEED

REASONING: The correction makes a known measurement ambiguity explicit without increasing execution authority. Proceed only through the normal PR path; keep Task 5.1 active until observer deployment, effective configuration verification, and elapsed-time coverage evidence exist.
