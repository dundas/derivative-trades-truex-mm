---
generated_at: 2026-06-24T21:26:41Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: fix/analytics-spread-pnl-endpoint
git_commit: a572637
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Add GET /api/v1/analytics/spread-pnl summary endpoint to restore dashboard P&L tiles
---

## PROPOSED

Add a read-only analytics endpoint `GET /api/v1/analytics/spread-pnl` to `src/api/server.js`
returning a single summary object `{ spreadPnl, matchedVolume, avgBuyPrice, avgSellPrice,
tradingCashFlow }`. The deployed dashboard already calls this endpoint for the "Spread P&L
(matched round-trips)" and "Trading Cash Flow" tiles; it was never implemented server-side,
so it 404'd and both tiles showed $0 despite 359 fills and >$900 of net cash flow.

REASON: Restore broken dashboard P&L display (incident fix).
REQUESTER: User (David). Already deployed to prod at user request; now running gates.

## AGAINST (steel-man)

1. **FIFO pairing is economically loose.** The handler joins `buy.rn = sell.rn` within a
   session ordered by timestamp — it pairs the Nth buy with the Nth sell regardless of
   temporal order. A sell can be "matched" to a buy that happened *later*, producing a
   "spread P&L" that is not true realized round-trip P&L. Live result was **negative**
   (-$0.035), which can mislead an operator judging MM performance.
2. **Neither tile is mark-to-market P&L.** `tradingCashFlow` = sell proceeds − buy costs
   ignores the value of remaining inventory; `spreadPnl` only covers within-session matched
   pairs. A human could misread either as "the MM's profit."
3. **Unbounded all-time query on a 10s poll.** The dashboard calls the endpoint with no
   params → all-time scan with double `ROW_NUMBER() OVER (PARTITION BY sessionid)` + join +
   full cash aggregation, re-run every 10s. Trivial at 359 fills; could degrade as `fills`
   grows to 6-figures.
4. **Deployed before review.** The gate chain is running *after* the prod deploy (process
   inversion). The deploy also required recreating the `truex-market-maker` container (a live
   trading restart).
5. **Treats a symptom of a governance gap.** The endpoint exists to satisfy a deployed
   frontend bundle that is **not in git**. Shipping it "completes" a drifted deploy without
   fixing the drift.

## ASSUMPTIONS

- [VERIFIED] Read-only `SELECT`; behind admin-token auth (route is below the global
  `requireAdminToken` gate). No writes, no auth/secret surface touched.
- [VERIFIED] Response shape matches what the deployed frontend reads (`spreadPnlData.*`);
  confirmed live through the authenticated proxy path (HTTP 200, real values).
- [VERIFIED] SQL validated against the live DB; returns sensible numbers.
- [VERIFIED] FIFO pairing reuses the **existing** convention in `handleAnalyticsSpreadCapture`
  — this PR introduces no *new* semantics, it mirrors what the codebase already ships.
- [VERIFIED] Tiles are descriptively labeled ("matched round-trips", "sell proceeds − buy
  costs") — they do not claim to be realized/MTM P&L.
- [VERIFIED] Deploy already done; MM container healthy post-recreate.
- [UNVERIFIED] Index coverage on `fills(sessionid, timestamp)` for future scale.

## MODEL-TRAJECTORY

- [NEUTRAL] Pure analytics/SQL endpoint — independent of model capability trajectory.
- [DURABLE] Operator-facing P&L correctness matters more as capital scales.

## COMPLIANCE CHECK

- **Authority** ("user requested") — present but legitimate (owner, own dashboard).
- **Incrementalism** — mild: deployed-then-reviewed. Mitigated by read-only/low-blast-radius.
- No urgency/flattery/social-proof manipulation detected.

## VERDICT: PROCEED (with documented follow-ups)

REASONING: This is a read-only, admin-gated analytics endpoint whose response is
descriptively labeled and consistent with an existing codebase convention. Blast radius is
low and the change is trivially reversible (delete the route). The valid objections are about
*metric meaningfulness* and *future scale*, not correctness or safety of this PR — they are
follow-ups, not blockers. The pairing concern is pre-existing (shared with
`spread-capture`), so blocking this PR on it would be inconsistent.

CONDITIONS / FOLLOW-UPS (non-blocking):
1. File a follow-up to reconcile the **deployed dashboard frontend into git** — root cause of
   the missing endpoint; the real governance fix.
2. Consider a default time window (e.g. current session or trailing 24h) for the endpoint to
   bound the all-time scan, and confirm `fills(sessionid, timestamp)` indexing.
3. Track whether operators interpret "Spread P&L" as realized P&L; if so, relabel or back it
   with true realized/MTM P&L rather than naive same-rank pairing.
