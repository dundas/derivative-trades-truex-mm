---
generated_at: "2026-06-18T10:36:01-05:00"
repo: "true_markets_mm"
repo_remote: "https://github.com/dundas/derivative-trades-truex-mm.git"
git_branch: "feat/truex-ebbo-feed"
git_commit: "de4a909"
harness: "codex"
cli: "bun 1.3.3"
model: "unknown"
review_subject: "Task 1.0 TrueX EBBO poller after deterministic default test-gate fix"
---

PROPOSED: Commit and open a PR for task `1.0` of `tasks/tasks-0006-prd-cross-venue-opportunistic-take.md`, including the additive TrueX EBBO poller plus the deterministic test-gate fix that makes live Kraken integration tests opt-in.

REASON: The feature work is complete, the default repo test suite is now deterministic, and the smoke path confirms the new poller populates `truexEbbo` without sending any FIX orders.

REQUESTER: User

AGAINST:
1. The PR still contains a small amount of opportunistic cleanup outside the core EBBO path (`audit-logger` test-stability fix, stale test expectation updates, live-test gating), which increases review surface.
2. The poller auto-starts whenever `restClient` exists, so environments that instantiate REST for unrelated reasons will now perform background polling unless explicitly configured otherwise.
3. Skipping live Kraken tests by default can hide integration drift if the repo never runs `RUN_LIVE_KRAKEN_TESTS=1` somewhere intentional.

ASSUMPTIONS:
- [VERIFIED] `quoteEngine.updateTruexEbbo()` stores EBBO state separately from `truexBook`.
- [VERIFIED] The orchestrator poller updates only the EBBO state and does not touch the maker send path.
- [VERIFIED] `bun scripts/smoke-truex-ebbo.ts` passes with zero FIX sends.
- [VERIFIED] `bun test` now exits cleanly with `961 pass / 8 skip / 0 fail`.
- [VERIFIED] The skipped tests are explicitly the live Kraken integration file and require `RUN_LIVE_KRAKEN_TESTS=1`.
- [ASSUMED] There is an external place to run live Kraken integration coverage when credentials and network are appropriate.
- [ASSUMED] Auto-start polling is desired for deployed orchestrator instances that have a REST client configured.

MODEL-TRAJECTORY:
- [DURABLE] Venue-specific market-data separation and safe background polling are durable trading-system concerns.
- [DURABLE] Deterministic local test gates remain valuable regardless of model capability.
- [NEUTRAL] The live-test opt-in flag is simple operational hygiene, not model-sensitive scaffolding.

COMPLIANCE PATTERNS:
- Incrementalism: mitigated. The prior "known failing live tests" ambiguity is now made explicit in code.
- Authority: low. Workflow pressure no longer bypasses a failing default gate.

VERDICT: PROCEED

REASONING: The strongest objection was the ambiguous `bun test` gate; that is now resolved. The remaining risks are ordinary review items, not reasons to stop. The feature is additive, isolated from order placement, covered by targeted tests plus smoke, and the default suite is green.

CONDITIONS:
1. In the PR description, state that live Kraken coverage now requires `RUN_LIVE_KRAKEN_TESTS=1`.
2. During review, call out that the EBBO poller is additive-only and intentionally does not drive quoting yet.
3. If operations do not want background EBBO polling by default, make that a follow-up config hardening task rather than blocking this PR.
