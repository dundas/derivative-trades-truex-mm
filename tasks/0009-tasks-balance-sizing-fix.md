# Task 0009 — Balance-Aware Sizing Fix (cancel/place race gate)

**Status**: in-progress
**Branch**: fix/balance-aware-sizing
**Date**: 2026-08-07
**Context**: 2026-08-06 prod observation: **323 `Insufficient balance` rejections/hour**;
avail BTC fell to 0.00007 while resting sells held 0.01. Task 0007/0008 made the bleed
measurable; this is Phase-2 engine item (a).

## Root cause (verified in code)

- Maker cap `_capSizeToBalance` (quote-engine.js) sizes against
  `inventoryManager.getAvailableForSide()` = **`total − transferHold`** — which includes
  funds held by our own resting orders. Intentional clean-slate assumption: a reprice
  cancels old orders before the venue evaluates new ones.
- `passive-safe` replacements honor this (place-after-cancel-confirm via
  `pendingReplacements`), **but pure `toPlace` actions are dispatched in the same burst
  right after cancels are *sent*** — not confirmed. Placement reaching TrueX before the
  cancel is processed → old hold still live → new + held > available → rejection.
- Fill-path balance math is already correct (`recordFill` adjusts `available` and
  `total`); no change needed there.

## Fix (focused, conservative)

1. `_hasInflightCancels(side)` — derived from `activeOrders` (`status === 'cancelling'`);
   stateless, self-healing (inherits existing cancel-timeout/orphan recovery).
2. Dispatch loop: pure `place` actions are **skipped this cycle** when a same-side cancel
   is in flight (`replaceMode !== 'place-before-cancel'` only). Next reprice re-derives
   the desired ladder with fresh prices — skip beats draining stale queued quotes.
3. Same gate applied to the `actionQueue` drain path (otherwise rate-limited places
   bypass the gate).
4. Observability: `placementsDeferredForCancels` counter + one INFO log per cycle that
   defers.

**Deliberately NOT touched**: the `pendingReplacements` flush path (cancel already
confirmed → hold released). Residual narrow edge (replacement shrinking size while other
same-side cancels in flight) documented as known residual; self-heals next cycle and is
measurable via rejection logs after deploy.

## Acceptance Criteria

- AC1: with a same-side cancel in flight, pure placements are not dispatched (unit test).
- AC2: with no cancels in flight, placements dispatch immediately (unit test).
- AC3: `place-before-cancel` mode unchanged (gate bypassed — unit test).
- AC4: rate-limit queue drain also gated (unit test).
- AC5: deferral counter increments; replacement flush path unaffected (unit tests).
- AC6: full suite green (no regression in the 62 quote-engine tests or elsewhere).
- AC7: no live-exchange dependency in tests (mock FIX).

## Dialectical notes (coach pass)

- Skip-and-retry chosen over a deferred-placement queue: stateless, no flush wiring, no
  starvation risk, and next-cycle quotes carry fresh prices. Cost: new levels delayed ≤ 1
  reprice interval while same-side cancels in flight — the same tradeoff passive-safe
  already makes for replacements.
- Derived state (`'cancelling'` scan) chosen over event counters: counters can leak on
  lost acks; the map is reconciled by existing timeout/orphan logic.
- Rejected alternatives: cap-minus-resting (collapses cap mid-reprice → quote gaps);
  exchange-`available` cap (stale between 60s polls → under-quoting); reprice slowing
  (masks, doesn't fix).

## Review Fixes

- **roborev round 1 Medium**: queue-drain gate now DROPS gated placements instead of
  re-queueing them — held quotes would be stale by the time the cancel clears;
  `deferredRepriceNeeded` re-derives fresh quotes (same guarantee as the dispatch skip).
  Drain tests updated to drop-semantics + fresh-rebuild-after-confirm.
- **roborev round 2 Medium**: a gated cycle no longer re-stamps `lastRepriceAt`; while
  `heldPlacementsPending`, the completion retry bypasses `minRepriceIntervalMs` (prod runs
  1500ms) — otherwise the follow-up reprice that replaces held placements gets debounced.
- **roborev round 3 Medium**: debounce bypass scoped to `_runDeferredReprice` (the
  completion-retry path) only; ordinary `onPriceUpdate` stays debounced during slow
  cancel-ack windows (no global bypass, no extra churn). Regression test added.
- **roborev round 4 Low**: `heldPlacementsPending` cleared on the no-actions completion
  branch of `_runDeferredReprice` so a resolved hold can't leave the bypass stuck.
- **roborev loop concluded after round 4** (past the 3-fix-round cap; every round produced
  real, fixed findings). Remaining merge gate: PR-level review per `.ai/code-reviewers.json`.

## SO-13 note

Touches `src/` only (not `scripts/`, `docs/`, content pipeline) → docs-generator not
mandatory; behavior noted in daily log + PR body.
