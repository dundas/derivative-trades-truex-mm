# 0018 — L1 TrueX Touch Canary

## Goal

Measure whether a minimal passive maker quote can earn fills by placing level 1
competitively against fresh TrueX EBBO, without changing inventory management,
rebalance policy, depth, or the existing canary envelope.

## Requirements

1. The feature is disabled by default and activates only within the existing
   `MM_MINIMAL_LIVE_CANARY_ENABLED` envelope.
2. On a fresh, valid TrueX EBBO, L1 joins the same-side touch exactly. It never
   improves beyond the touch, and existing strict maker-safety,
   contractual-width, and post-only checks still apply.
3. L2 and all non-canary quoting remain unchanged.
4. Missing, stale, crossed, or invalid EBBO preserves existing fail-closed
   behaviour; no new order is sent.
5. Existing canary stop/cancel controls remain the authority for expiry,
   rejects, cancels, fill cap, and adverse markout.
6. Tests cover default-off behaviour, exact touch join, decimal tick handling, and safety
   rejections.

## Non-goals

- Inventory-rebalance execution or parameter changes.
- Taker orders, hedging, external venues, or L2 placement changes.
- A new telemetry store; `quote_lifecycle_events` remains the evidence source.

## Acceptance gates

- Unit and focused engine tests pass.
- Smoke uses an in-memory strict-maker engine and proves no order crosses EBBO.
- Production canary is separately authorized only after review. It must retain
  the existing 15-minute, 0.0005 BTC, 30–80 bps envelope.

## Rollout evidence

The first live canary requires at least 60% at-or-inside-touch L1 decisions on
both sides, 95% two-sided presence, median quote residence of at least three
seconds, no increase in rejects/evidence gaps, and observed fills before any
size or depth expansion.
