# Adversarial Review: Task 3.0 Shadow Take Detection

## Proposed Action

- `PROPOSED`: Merge additive shadow take detection for `BTC-PYUSD` that evaluates would-take opportunities from `truexEbbo`, cached Coinbase fair value, and `pyusdUsd`, while guaranteeing zero FIX dispatch.
- `REASON`: Complete task `3.0` of `tasks-0006-prd-cross-venue-opportunistic-take.md` under the no-send Phase 1 requirement.
- `REQUESTER`: User / STANDARD_DEV_WORKFLOW.

## Against

1. This is still trading-adjacent logic; a hidden send edge or accidental maker-path interaction would create real financial risk.
2. The new path consumes multiple freshness signals and an external tape cache; stale or malformed data could create false positives or alert noise.
3. Coinbase-side reevaluation runs near the hot path; if the coalescing logic is wrong, it could create unnecessary load or accidental quote churn.
4. New alerts can page on bad thresholds rather than genuine problems.
5. The tape guard adds another REST dependency; if it quietly becomes hot-path polling, it could degrade the process during production volatility.

## Assumptions

- `[VERIFIED]` `evaluateShadowTake()` returns data only and does not call `_prepareQuoteForSend`, `_sendNewOrder`, or `_sendCancel`.
- `[VERIFIED]` `/market/quote` poll path triggers shadow evaluation without FIX send edges in orchestrator tests.
- `[VERIFIED]` Coinbase-side reevaluation is rate-limited and input-change-gated in orchestrator tests.
- `[VERIFIED]` Tape caching is exercised in tests and the dedicated smoke proves one would-take log plus dedup on the second identical poll.
- `[VERIFIED]` Targeted suite passes: `bun test tests/quote-engine.test.js tests/market-maker-orchestrator.test.js`.
- `[VERIFIED]` Dedicated smoke passes: `bun scripts/smoke-shadow-take.ts`.
- `[UNVERIFIED]` Live alert thresholds are well calibrated for production noise. This is acceptable because task `3.24` explicitly blocks deployment.

## Compliance Pattern Check

- `AUTHORITY`: present in the weak sense that the workflow requires proceeding, but not in a way that bypassed validation.
- No urgency, incrementalism, or test-skipping patterns detected.

## Verdict

- `VERDICT`: `PROCEED`
- `REASONING`: The dangerous part of this task is accidental execution. That invariant is explicitly encoded in the design, asserted in unit coverage, and proven in the smoke. Residual risk is threshold calibration and alert quality, which is acceptable because this phase is intentionally merge-only and `3.24` blocks deployment.
- `CONDITIONS`: Do not deploy from this branch. Preserve the no-send invariant during PR review and rerun `/pre-push-review` before any push.
