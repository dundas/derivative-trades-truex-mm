# 0020 — Canary EBBO Transient-Poll Tolerance

## Goal

Prevent a bounded live canary from stopping on one failed TrueX EBBO poll while
its last venue observation remains fresh and strict maker safety still rejects
stale, invalid, or marketable orders.

## Requirements

1. An enabled canary stops and cancels immediately if no fresh valid EBBO is
   available after a poll failure.
2. One poll failure must not stop the canary while the last successful EBBO is
   still within the configured strict freshness window.
3. Persistent failures stop/cancel once that cached EBBO is stale.
4. Normal maker behavior, EBBO backoff, health reporting, and final send
   checks remain unchanged.

## Non-goals

- Extending the EBBO freshness window or accepting an invalid observation.
- Changing order size, canary fill/duration limits, or normal-market policy.
