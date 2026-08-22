---
kind: adversarial-review
date: 2026-08-22
scope: adaptive-spread-policy
---

# Adversarial Review — Adaptive Spread Policy

## Proposed action

Retain a pure, shadow-only adaptive spread calculator that uses fresh volatility, reference-feed, side-specific adverse-selection, and inventory-risk evidence. It has no quote-engine, FIX, or deployment coupling.

## Against

1. A later adapter might treat `unavailable` as a neutral zero adjustment and silently narrow risk controls.
2. A poorly selected operator cap can withdraw liquidity during volatile conditions.
3. Current evidence does not establish that the calculated components improve realized P&L.
4. Wiring directly to execution before markout evidence would turn an analytics model into an unproven strategy change.

## Assumptions

- [VERIFIED] Every unavailable result explicitly carries `recommendedAction: hold`; available results are `shadow-only`.
- [VERIFIED] The module contains no order/FIX/deployment imports or side effects.
- [VERIFIED] Input freshness, corruption, positivity, component caps, and floor headroom are tested.
- [UNVERIFIED] Operator-approved component/cap values and prospective fill-markout improvement.
- [UNVERIFIED] A future adapter preserving the hold/shadow-only contract.

## Verdict: PROCEED for shadow analysis only; PAUSE execution wiring

The component is appropriate to collect recommendations and evaluate them against realized reference markouts. It must not modify quote prices or enable live dispatch until an explicit adapter preserves its hold contract, uses approved values, and passes a bounded canary with measured economics.
