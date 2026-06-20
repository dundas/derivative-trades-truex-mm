---
generated_at: 2026-06-18T02:15:00Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: fix/partial-fill-handling
git_commit: 7a8da7d
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Record partial fills (OrdStatus=1) in QuoteEngine.onExecutionReport on the live MM
---

# Adversarial Review — partial-fill handling (live TrueX MM)

## PROPOSED
Ship commit 7a8da7d: add `case '1'` (PartiallyFilled) to `onExecutionReport` so partial fills
are recorded (emit `'fill'` for LastQty@LastPx, reduce remaining to LeavesQty, keep order
live), extract `_emitFillEvent` shared by `'1'`/`'2'`, reset `consecutiveRejects` on fills, and
add a `default:` that warns on unhandled ordStatus. Then merge + redeploy to the live MM. Fixes
the silent dropping of partial fills (fills=0 despite real exchange-balance movement).

REQUESTER: User (David) — "proceed with the fixes and get them merged."

## AGAINST (steel-man)
1. **The new `default:` will flood prod logs.** Memory documents TrueX's flow as
   `35=D → ordStatus=A (PendingNew) → ordStatus=0`. `'A'` (PendingNew) is **not** in the
   handled set {0,1,2,4,8}, so it now hits `default:` and warns **on every single order** — at
   ~4 orders/sec that's a continuous warn flood (and likely `'6'`/`'E'` pending-cancel/replace
   too, given the heavy churn). The default was meant to surface the *unknown*; as written it
   fires on the *normal*. This must be fixed before deploy.
2. **Tag-32 semantics are unverified for TrueX.** The fill size uses tag 32 (LastQty). If TrueX
   instead puts cumulative qty there, both `'1'` and `'2'` would over-count. (Mitigant: the
   existing `'2'` already used tag 32 and apparently worked, so this is a *pre-existing* shared
   assumption, not new — but still unverified for the partial path specifically.)
3. **Reducing a `cancelling` order's size and forcing `status='active'`.** If a partial fill
   lands while we have a cancel in flight, `case '1'` flips the order back to `active`. That can
   momentarily confuse the reconciler/cancel flow. (Mitigant: order genuinely is still partially
   live; reconcile + 60s balance refresh self-heal; fill is recorded regardless.)
4. **Deploy = live MM restart** (cancel/replace all orders) — same blast radius as #32.

## ASSUMPTIONS
- [VERIFIED] Bug is real and live: fills=0 in PnL/PG, 220 balance-drift events, exchange BTC moved in ~0.0034 chunks.
- [VERIFIED] Fix is unit-correct: quote-engine 129/129 incl. 4 new partial-fill cases; orchestrator 51/51.
- [VERIFIED] `case '2'` already uses tag 32 → `case '1'` is consistent, no *new* double-count surface.
- [VERIFIED] Per-execution LastQty sums correctly across 1,1,…,2 → no cumQty tracking needed (scope is right).
- [UNVERIFIED] TrueX tag-32 = per-execution LastQty (vs cumulative). The new fill logs + default will reveal this live.
- [UNVERIFIED] Exactly which ordStatus values TrueX emits (A/6/E/C/3…) — drives the default-noise fix.

## MODEL-TRAJECTORY
- [NEUTRAL] Protocol-correctness fix (FIX exec-report handling) — independent of model capability; durable.

## COMPLIANCE CHECK
- No urgency-to-skip, flattery, anchoring, or reciprocity. The "get them merged" directive is
  legitimate and the fix is well-scoped. The only self-inflicted risk is the default-noise
  regression, which this review exists to catch.

## VERDICT: PAUSE (one concrete fix required)

REASONING: The core fix is correct, well-tested, and addresses a verified live accounting bug —
ship it. But the `default:` branch as written regresses log hygiene badly: it warns on the
normal `PendingNew (A)` transition that occurs for *every* order, which at the current order
rate floods logs and could mask real warnings. That must be corrected before pre-push/deploy.
Scope (no case-'2' cumQty rework) is correctly tight. The tag-32 and cancelling-order edges are
acceptable, pre-existing-or-self-healing, and observable via the new logging.

CONDITIONS to PROCEED:
1. **Handle the expected pending/transition statuses explicitly** — at minimum `'A'` (PendingNew),
   and `'6'` (PendingCancel) / `'E'` (PendingReplace) given the churn — as benign no-ops, so the
   `default:` only warns on genuinely-unknown statuses. Re-run tests.
2. After deploy, **watch the new logs** to (a) confirm partial fills now record (fills > 0, PnL
   non-zero, drift shrinks) and (b) capture any `default:` warnings to learn TrueX's real status
   set and confirm tag-32 = LastQty (no double-count).
3. Standard live-deploy care: backup + rollback path (as in #32), redeploy via rebuild/recreate.

This is a PAUSE only on the default-noise item — fix that and the change is good to proceed
through pre-push → PR → merge → deploy.
