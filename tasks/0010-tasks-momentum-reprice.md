# Task 0010 — Momentum Reprice (Coinbase lead-lag defense, v1)

**Status**: in-progress
**Branch**: feat/momentum-reprice
**Date**: 2026-08-07
**Context**: Baseline established 2026-08-03→06 (pre-change): round-trip adverse
$122–252/BTC, daily realized -$0.86 to -$5.05, mark-out 1.3–40.7bps. The pick-off
mechanism: TrueX takers see Coinbase move and lift/hit our stale quotes. The only brake
on repricing is `minRepriceIntervalMs` (prod: 1500ms) — during fast moves, quotes stay
stale for up to 1.5s. That window is the adverse-selection surface.

## Design (v1 — momentum-triggered debounce bypass)

When the aggregated mid (Coinbase-weighted) has moved >= `momentumRepriceBps` since the
last DISPATCHED reprice, bypass the `minRepriceIntervalMs` debounce and reprice
immediately on the next price tick. Downstream machinery is untouched: reconcile +
passive-safe replacement + task-0009's balance gate handle the withdrawal/requote.

- Config `momentumRepriceBps` (default 10; prod env `MOMENTUM_REPRICE_BPS`)
- State `lastRepricedMid` stamped with `lastRepriceAt` on dispatched cycles
- Counter `momentumReprices` + one INFO log per bypass that actually skips the debounce
- `momentumRepriceBps <= 0` disables the feature
- Self-limiting: each dispatched reprice re-baselines the reference mid, so the trigger
  fires per N bps of movement, not per tick

## Why bypass-only (not a new cancel path)

A fresh momentum move needs withdrawal of exposed levels — reconcile already produces
exactly those cancels/replacements the instant it runs. The ONLY thing stopping it from
running is the debounce. Removing the brake reuses every proven safety mechanism
(passive-safe ordering, balance gate, rate limiter, minActiveLevels) instead of adding a
parallel send path. Failure mode: extra repricing churn (bounded by rate limiter), never
an unsafe send.

## Acceptance Criteria

- AC1: move >= threshold since last dispatched reprice → debounce bypassed, actions sent (unit).
- AC2: move < threshold → debounce holds (unit).
- AC3: `momentumRepriceBps <= 0` disables the bypass (unit).
- AC4: `lastRepricedMid` stamps on dispatched cycles only; never-repriced engine doesn't bypass (unit).
- AC5: prod wiring: `MOMENTUM_REPRICE_BPS` env via parseNumber, default 10.
- AC6: full suite green.

## Measurement plan

Nightly scheduled reports (task 0008) track round-trip $/BTC + mark-out bps. Success =
sustained reduction vs the baseline above over 2–3 days without fill-rate collapse.
Tuning order if flat: threshold (10 → 6bps), then vol-adaptive spread floor (task 0011).

## SO-13 note

Touches `src/` + `scripts/run-prod.js` (not `scripts/` top-level review scope; run-prod.js
IS under `scripts/` — docs note added to `docs/DAILY_PERF_REVIEW.md` follow-ups section is
NOT required; PR body documents the env var). → SO-13 applies for `scripts/run-prod.js`;
llms.txt/docs update included in this PR (small, keeps the docs PR count at one).
