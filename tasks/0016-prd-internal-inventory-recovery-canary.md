# 0016 — Internal Inventory-Recovery Quote Mode

## Objective

Allow the maker to restore a BTC inventory deficit using only passive, two-sided
TrueX quotes. The feature must be safe to deploy in `observe` mode and must not
authorize or enable live order dispatch.

## Context

The maker currently holds materially less BTC than its fixed inventory target.
There is no available external execution venue. The existing Gaussian inventory
model is shadow-only, while the current near-touch mirror has adverse-selection
evidence that is not sufficient for a live promotion.

## Scope

- Reuse the validated Gaussian inventory policy as an explicit, opt-in quote
  adjustment: below target it tightens/enlarges bids and widens/reduces asks;
  above target the behavior is symmetric.
- Preserve passive, two-sided quoting and all existing EBBO, contract-width,
  authoritative-own-order, capital, and dispatch guards.
- Add an operator-owned enabled flag and interim inventory target. Disabled is
  the default. Enabling requires an explicit, valid recovery configuration;
  no economic values are embedded in source.
- Stop applying recovery pressure once the interim target is reached. The
  ordinary policy then continues without an inventory-recovery adjustment.
- Surface recovery status/decision in health or existing quote status for
  observer verification.

## Explicit non-goals

- No taker orders, external hedge/venue, automatic deployment, or change from
  `MM_QUOTE_DISPATCH_MODE=observe` to `live`.
- No automatic full rebalance to the long-run target and no parameter tuning
  from the prior adverse-selection window.
- No modification to the pure shadow policy's external-hedge recommendation.

## Acceptance criteria

1. Disabled/default behavior is byte-for-byte equivalent in quote shape and
   creates no new configuration requirement.
2. In an enabled below-interim-target case, L1 remains two-sided, the bid is
   more competitive and no smaller than the base policy's bid, and the ask is
   no more competitive and no larger than the base policy's ask.
3. At or above the configured interim target, recovery adjustment is absent;
   an inverse excess-inventory case is symmetric if configured to operate.
4. All generated values remain tick-valid, passive under existing strict EBBO
   checks, and within the configured contractual width floor/ceiling.
5. `observe` mode proves zero `35=D`, reservation, and local active-order
   mutation for recovery-shaped candidates.
6. Invalid recovery configuration fails startup/config construction before any
   exchange connection or timer side effect.
7. Focused engine, orchestrator, config, and observer-smoke coverage pass.

## Promotion gate

This PR is implementation and observer verification only. Any live canary
requires separate operator authorization, a configured interim target and
limits, zero-order observer evidence, and measured 1/5/60-minute markouts.
