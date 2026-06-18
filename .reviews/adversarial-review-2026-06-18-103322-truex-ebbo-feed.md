---
generated_at: "2026-06-18T10:33:22-05:00"
repo: "true_markets_mm"
repo_remote: "https://github.com/dundas/derivative-trades-truex-mm.git"
git_branch: "feat/truex-ebbo-feed"
git_commit: "de4a909"
harness: "codex"
cli: "bun 1.3.3"
model: "unknown"
review_subject: "Task 1.0 TrueX EBBO poller and quote-engine additive feed state"
---

PROPOSED: Commit and open a PR for task `1.0` of `tasks/tasks-0006-prd-cross-venue-opportunistic-take.md`, adding a REST-polled TrueX EBBO feed into the quote engine and orchestrator without changing the existing maker quoting path.

REASON: The task requires a non-invasive market-data path that populates EBBO state for later cross-venue opportunistic take logic. The implementation is complete, targeted tests pass, and the smoke script confirms zero FIX sends.

REQUESTER: User

AGAINST:
1. The repo-level gate is still ambiguous because `bun test` does not currently exit cleanly; there are 3 remaining failures in `lib/exchanges/KrakenWebSocketV2ExchangeAdapter.integration.test.js`.
2. Even if those failures are pre-existing/live-environment failures, opening the PR without explicitly resolving the gate semantics risks normalizing "green enough" rather than "green".
3. The new EBBO poller is enabled whenever a `restClient` exists. That is operationally reasonable, but it still adds recurring network traffic and alert noise to environments that were previously passive on this path.
4. The implementation touched `audit-logger` and two unrelated stale test expectations to recover suite health. Those look justified, but they widen the PR beyond a single-path additive feed change.
5. If the product only needs EBBO snapshots for later task stages, a simpler first move could have been an explicit manual fetch path or disabled-by-default poller; always-on polling adds lifecycle and alerting behavior now rather than when consumption logic lands.

ASSUMPTIONS:
- [VERIFIED] The EBBO state is additive and separate from `truexBook`; the maker guard / FIX send path is not used by the new poller.
- [VERIFIED] Targeted tests for quote-engine and orchestrator pass.
- [VERIFIED] `bun scripts/smoke-truex-ebbo.ts` passes and records zero FIX sends.
- [VERIFIED] Full `bun test` is reduced to 3 failing Kraken live integration tests; local regressions introduced during this task were fixed.
- [UNVERIFIED] Those 3 Kraken integration failures are accepted repo baseline rather than a release blocker for this task.
- [ASSUMED] Runtime environments that instantiate `restClient` should begin polling EBBO immediately and have alerting configured appropriately.
- [ASSUMED] The added `audit-logger` cleanup change has no unintended behavior change outside test execution.

MODEL-TRAJECTORY:
- [DURABLE] Exchange feed separation and explicit market-data state are durable trading-system architecture.
- [DURABLE] Alerted polling/backoff around external venue data remains operationally relevant.
- [NEUTRAL] Test-suite stabilization and smoke coverage are independent of model capability changes.
- [SUBSUMED] None material; this is concrete integration work, not workflow scaffolding.

COMPLIANCE PATTERNS:
- Authority: present in mild form because "proceed per workflow" can pressure the gate sequence forward even with unresolved suite ambiguity.
- Incrementalism: present if we treat persistent `bun test` failures as normal without documenting why.

VERDICT: PAUSE

REASONING: The core EBBO change appears justified and appropriately isolated, but the branch is not yet at an unambiguous Step 4 starting point. The implementation should likely ship, yet the current evidence still leaves a workflow-level question: does task `1.8` require a fully green default `bun test`, or are the remaining Kraken live integration failures an accepted out-of-scope baseline? Proceeding without answering that weakens the portfolio gate standard more than this feature justifies.

CONDITIONS:
1. Record and enforce the intended interpretation of the `bun test` gate for this repo.
2. Either:
   - eliminate or quarantine the live Kraken integration failures from the default suite, or
   - explicitly document them as pre-existing/non-blocking for this PR and keep them out of the acceptance claim for task `1.8`.
3. If polling should not auto-enable everywhere, gate the EBBO poller behind an explicit config flag before opening the PR.
