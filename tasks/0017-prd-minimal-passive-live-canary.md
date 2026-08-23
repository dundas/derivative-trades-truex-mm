# 0017 — Minimal Passive Live Canary

## Goal

Measure a small passive BTC/PYUSD maker quote under the existing execution
safety controls. This is not inventory-recovery execution and does not add a
new order-lifecycle subsystem.

## Fixed canary envelope

- One level per side, `0.0005 BTC` base size, 30–80 bps contractual width.
- Maximum duration: 15 minutes.
- Maximum cumulative filled BTC: operator-configured, required, and positive.
- Stop/cancel on: stale/missing/invalid TrueX EBBO, venue order rejection or
  cancellation, or the first attributed adverse one-minute markout.
- No taker orders, external venue, hedge, or recovery-bias execution.

## Acceptance

1. Default behavior is unchanged and the canary is explicitly disabled.
2. The live canary validates its envelope before connection and cannot use
   more depth/size than approved.
3. Expiry, cumulative cap, EBBO loss, and venue rejection/cancellation prevent
   new orders and invoke the existing safe cancel path.
4. Focused tests prove the envelope and each stop path; no new lifecycle ledger
   or replacement accounting is introduced.
5. Merge and deployment are separate: production stays `observe` until the PR
   is reviewed, then a separately authorized release uses the rollback image.
