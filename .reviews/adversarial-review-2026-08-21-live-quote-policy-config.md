---
generated_at: "2026-08-21T00:00:00-05:00"
repo: "true_markets_mm"
repo_remote: "https://github.com/dundas/derivative-trades-truex-mm.git"
git_branch: "feat/live-quote-policy-config"
git_base_commit: "c912552"
harness: "codex"
review_subject: "Retain and later merge uncommitted fail-closed contractual maker quote-policy change"
---

# Adversarial Review — live maker quote-policy configuration

## PROPOSED

Retain the uncommitted policy change for normal review and later merge. It makes normal depth,
base size, fallback spread, maximum spread, and required depth environment-configured; rejects
contradictory values at startup; and suppresses sends outside a cap. Do not deploy it yet; retain
`MM_QUOTE_DISPATCH_MODE=observe`.

## AGAINST

1. A cap can withdraw both sides during volatility, off-tick rounding, a stale/misaligned
reference mid, or a post-only slide. It protects a ceiling by removing the liquidity obligation;
suppression does not prove a compliant funded L1 is retained or recovered.
2. The claimed actual pair is only local `activeOrders`, not an authoritative TrueX own-order
book/reconciliation snapshot. Disconnects, out-of-order reports, and untracked exchange orders
can make it falsely pass. Its level-local lookup also cannot prove an all-book or L1 contract
without the contract defining that scope.
3. PRD Section 9 still leaves TrueX min-size, max-spread, depth, and side-gap values unresolved.
Required placeholders are not operator approval and cannot establish compliance or profitability.
4. Observer-only production creates no new acknowledged fills: there is no elapsed 1/5/60-minute
attribution, two-sided live quote evidence, or 24-hour zero-funding-reject soak for this policy.
5. This is more than plumbing: it changes the QuoteEngine send boundary. `Infinity` defaults in
non-production callers leave finite-cap integration behavior incompletely demonstrated.

## ASSUMPTIONS

- [VERIFIED] Work is uncommitted on `feat/live-quote-policy-config` based on `c912552`.
- [VERIFIED] Compose/startup requires the proposed fields and focused tests reject absent, invalid,
and cross-field contradictory values.
- [VERIFIED] Focused tests exercise pre-send suppression for no tick pair, missing context,
envelope breach, and a locally tracked opposite pair.
- [VERIFIED] The PRD prohibits guessing obligations or production strategy changes while Section 9
values are unresolved.
- [UNVERIFIED] `activeOrders` represents every exchange-displayed own order at send time.
- [UNVERIFIED] The contract uses this reference-mid, level-local pair interpretation.
- [UNVERIFIED] An approved cap leaves a passive funded noncrossed L1 across volatility/tick cases.
- [UNVERIFIED] Effective live values, acknowledged quotes, fill attribution, and soak evidence;
production remains observer-only.

## COMPLIANCE PATTERNS

- **Urgency:** continual-trading pressure must not bypass missing obligations/evidence.
- **Authority:** user authorization does not supply exchange contract values.
- **Incrementalism:** retain/review and live enablement must remain separate gates.
- **Anchoring:** do not assume this is the only valid interpretation of “maximum spread.”

## VERDICT: PAUSE

Retain the work and send it through normal review; do not deploy or enable live dispatch. The
configuration direction is sound, but cap-induced withdrawal and a local-cache “actual-book” test
cannot yet establish continuous venue-compliant liquidity.

## CONDITIONS

1. Obtain/record approved non-secret TrueX minimum size, maximum-spread, depth, and side-gap
semantics/values; specify L1, per-level, or all-book cap scope.
2. Use authoritative acknowledged own-order/reconciliation state or narrow the policy claim;
test reconnects, out-of-order events, missing levels, and no-compliant-L1 caps.
3. Define/test cap-suppression outcome: retain/reprice compliant funded L1 where possible, else
emit an obligation breach and side-gap signal.
4. Complete standard review/merge gates without dispatch change; only then use an explicitly
approved live canary with effective config, acknowledged two-sided quotes, zero funding rejects,
1/5/60 evidence where fills occur, and a 24-hour soak.
