# PRD 0021: Canary Freshness-Aware EBBO Retry

## Overview

The L1 touch canary uses a strict three-second verified TrueX EBBO freshness
window. PR #110 correctly cancels resting canary quotes when that window
expires during an EBBO poll failure. Production evidence shows that the normal
1.5x retry backoff can itself consume the remaining window after a 900ms
timeout, so a transient timeout ends a canary before it can provide a trading
observation.

## Goal

When, and only when, an enabled minimal live canary still has a verified fresh
EBBO after a non-429 poll failure, schedule its next retry early enough that a
successful bounded request can finish before the existing freshness deadline.

## Functional requirements

1. Preserve the existing strict EBBO maximum age, expiry cancellation, order
   cancellation, price, size, post-only, fill, and duration controls.
2. For an enabled canary with a currently usable cached EBBO and a non-429
   failure, cap the scheduled retry delay to the remaining freshness budget
   minus the already-configured EBBO request timeout.
3. Never use this cap for HTTP 429 responses; retain the exponential backoff
   to respect venue rate limiting.
4. If no retry can complete before expiry, retain the existing expiry timer;
   it must cancel the canary rather than extending stale authority.
5. Normal non-canary polling and health/backoff reporting must retain their
   current behavior.
6. Cover retry-within-budget, rate-limit backoff, and expired/missing-cache
   behavior with deterministic unit tests.

## Non-goals

- No larger EBBO freshness window.
- No additional market-data venue, FIX-MD migration, or exchange strategy
  change in this PR.
- No retry storm, request parallelism, or changes to production canary limits.

## Rollout and gates

Follow `STANDARD_DEV_WORKFLOW`: planning artifacts committed before code;
adversarial necessity review; focused tests; Semgrep and roborev; smoke;
Claude review on every PR push; merge only after review; clean-worktree
production deployment and health validation. This change does not alter
`scripts/` or `docs/`; generated documentation is not required.

## Success criteria

- A transient non-429 failure with a fresh cached EBBO gets one retry that can
  finish before the unchanged strict deadline.
- A 429 keeps existing backoff and no stale quote can survive the deadline.
- Normal live quoting remains healthy after deployment.

