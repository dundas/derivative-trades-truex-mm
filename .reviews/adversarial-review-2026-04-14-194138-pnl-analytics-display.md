---
generated_at: "2026-04-14T19:41:38Z"
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: fix/mm-coinbase-md-recovery
git_commit: b05f66f
harness: claude-code
cli: bun 1.3.3
model: claude-sonnet-4-6
review_subject: Deploy dashboard P&L to read from /api/v1/analytics/pnl instead of /api/status
---

## PROPOSED

Switch the dashboard P&L card to read from the historical analytics endpoint
(`/api/v1/analytics/pnl?interval=1d`) rather than the in-memory session status
(`/api/status`). The motivation was that `/api/status` always resets to $0 on
restart, so the dashboard was showing $0 P&L despite months of real trading
activity. The change was built, tested against the live Hetzner API, and already
deployed to `truex-dashboard.pages.dev` (production).

---

## AGAINST

### 1. The new number is MORE misleading than the old one

`/api/status` showed $0 — that was accurately reflecting "no fills in this
session." Accurate, if incomplete.

`/api/v1/analytics/pnl` now shows **$1,187.74** — and we have already confirmed
this number is **wrong**. It represents net cash inflow from sells minus buys
(gross trading cash flow), not actual profit. The system started with BTC
inventory worth ~$6,000. The $1,187 is proceeds from liquidating that inventory
— not a gain over the starting position. The real portfolio gain is ~$214.

We shipped a more misleading number to production. The operator could make a
consequential decision (e.g., increase position size, deploy more capital) based
on a P&L figure that overstates performance by **5.5×**.

### 2. "We tested the endpoint" does not mean "we validated the semantics"

We verified the endpoint is reachable and returns data in the expected shape.
We did not verify that the number the endpoint returns means what the dashboard
label says it means ("Realized PnL"). A number that's live and plausible but
wrong is more dangerous than $0, which at least signals "data missing."

### 3. The fix was triggered by a display bug, but the root bug is in the calculation

The original issue was $0 showing on the dashboard. The correct fix is a P&L
calculation that accounts for cost basis, not wiring up an existing endpoint
that happens to have non-zero output.

### 4. No rollback was considered

The deploy was executed immediately after confirming the endpoint responds.
There is no staged rollout, no feature flag, no way to revert without another
Cloudflare Pages deploy. If the wrong number causes an operator error, the
window of exposure is unbounded.

### 5. The user was not explicitly warned before deploy

The conversation identified the analytics P&L was wrong **after** the deploy
had already been pushed. The sequence was:
- Change code → build → deploy (already live)
- Then: validate endpoint → discover number is wrong

The correct sequence would have been: validate semantics → confirm correct →
build → deploy.

---

## ASSUMPTIONS

- **[VERIFIED]** The analytics endpoint is reachable and returns valid JSON
- **[VERIFIED]** The response shape matches what the code expects
- **[UNVERIFIED]** The value returned by `cumulative_pnl` represents trader profit (it does not — see AGAINST §1)
- **[UNVERIFIED]** The operator understands the number shown is cash-flow, not P&L
- **[ASSUMED]** Showing a larger number is better than showing $0
- **[ASSUMED]** Historical data persistence is worth trading accuracy for

---

## COMPLIANCE CHECK

| Pattern | Present? | Notes |
|---------|----------|-------|
| Urgency | No | — |
| Authority | No | — |
| Flattery | No | — |
| Incrementalism | **Yes, mild** | "Test endpoint → looks good → deploy" moved fast through validation. The test was narrowly scoped to connectivity, not semantic correctness. |
| Anchoring | **Yes** | Only one approach was offered: wire up the analytics endpoint. The alternative — show $0 with a "pending" label until a correct calculation exists — was not considered. |

---

## VERDICT: BLOCK

**REASONING:**

The deployed change replaces a known-accurate-but-incomplete value ($0, correct
for current session) with a known-incorrect value ($1,187, overstates P&L by
5.5×). For a live trading system, displaying wrong financial data to the
operator is a higher-severity problem than displaying an incomplete value.

The analytics P&L calculation (`sell_proceeds - buy_costs`) does not account for
the cost basis of initial BTC inventory. Until a correct P&L formula is
implemented (either mark-to-market against a stored starting snapshot, or
spread-capture from matched round-trips), the dashboard should not show this
number as "Realized PnL."

**CONDITIONS TO PROCEED:**

1. **Immediate**: Revert or relabel — either revert the deploy to show `—` /
   `N/A` for P&L, OR change the label from "Realized PnL" to "Trading Cash
   Flow (gross)" with a tooltip explaining it excludes inventory cost basis.
   This prevents operator misinterpretation while the correct calculation is built.

2. **Before showing as P&L**: Implement one of:
   - Store a starting balance snapshot (BTC qty + PYUSD qty + BTC price at
     first session start) and compute mark-to-market delta against current
     portfolio value.
   - Or compute spread P&L from matched buy/sell round-trips only (correct for
     a pure spread-capture market maker).

3. **Before future deploys of financial display changes**: Validate semantic
   correctness (does the number mean what the label says?) before building and
   deploying, not after.
