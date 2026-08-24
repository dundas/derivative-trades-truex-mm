## Relevant Files

- `src/core/market-maker-orchestrator.js` — EBBO error/backoff scheduler.
- `src/core/market-maker-orchestrator.test.js` — deterministic scheduler tests.
- `tasks/0021-prd-canary-freshness-aware-retry.md` — planning authority.

## Task Ordering & Dependencies

1.0 is required before the implementation and all release gates. No external
configuration or schema change is needed.

## Tasks

- [ ] 1.0 Preserve strict authority while recovering one transient canary poll failure
  - [ ] 1.1 Commit these planning artifacts before implementation.
  - [ ] 1.2 Add a canary-only, non-429 retry-delay cap based on cached EBBO
    receipt time, existing strict maximum age, and existing poll timeout.
  - [ ] 1.3 Retain normal and 429 backoff behavior; do not extend freshness.
  - [ ] 1.4 Add deterministic tests for timely retry, 429 preservation, and
    expiry fallback.
  - [ ] 1.5 Run focused tests and L1 canary smoke.
  - [ ] 1.6 Run adversarial review, Semgrep, roborev, and smoke before push.
  - [ ] 1.7 Open PR naming this PRD/task list; solicit Claude review.
  - [ ] 1.8 Run the PR review loop, merge after Claude pass, deploy from a
    clean worktree, and verify normal live health before any new canary.
