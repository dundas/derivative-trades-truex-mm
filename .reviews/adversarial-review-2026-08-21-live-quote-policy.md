---
kind: adversarial-review
date: 2026-08-21
scope: live-quote-policy-config
---

# Adversarial Review — Live Quote Policy Configuration

## Proposed action

Retain the uncommitted, fail-closed policy change for normal quote size/depth/spread and contractual depth/maximum displayed spread. Do not deploy it or enable quote dispatch yet.

## Against

1. A width cap can suppress quotes under a narrow operator policy, reducing liquidity rather than improving it.
2. The actual-book check adds state-sensitive order logic; an incorrect status or level interpretation could block valid replenishment.
3. No approved TrueX contractual values exist yet, so a deployment would either fail safely or risk an invented operating limit.
4. Observer mode has produced no new fills, so neither profitability nor post-change real-fill behavior is proven.
5. A regression can be financially material: it can either violate a spread promise or withdraw valid maker liquidity.

## Assumptions

- [VERIFIED] Startup rejects absent, invalid, or contradictory required policy variables.
- [VERIFIED] Generated, post-only-slid, and actual-book-checked candidate paths are covered by focused tests; the final transport boundary rechecks after reservation.
- [VERIFIED] Quote dispatch remains observer-only; this change does not enable `35=D` in production.
- [UNVERIFIED] Operator-approved TrueX maximum spread, required depth, minimum size, reserve, and gap values.
- [UNVERIFIED] Production order-state variants and actual two-sided behavior under a bounded live canary.
- [UNVERIFIED] Profitability and 1/5/60-minute markout evidence from new fills.

## Compliance-pattern check

- Urgency: present in the commercial objective, mitigated by retaining observer mode and refusing invented values.
- Incrementalism: risk present if a configuration guard is treated as authority to enable live orders; explicitly rejected.
- Authority: user authorization exists for development, not for unbounded live parameter selection.

## Verdict: PAUSE deployment; PROCEED with review-only integration

The code direction is justified because it makes unsafe configuration fail closed. It must not be deployed or used to enable live quoting until operator values are supplied, the merged build is verified in observer mode, and a bounded live canary has a rollback plan and measured two-sided/fill evidence.
