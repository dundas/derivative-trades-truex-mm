---
generated_at: 2026-06-17T01:15:33Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: refactor/truex-prod-host-env
git_commit: c1c6270
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Tighten live MM base spread baseSpreadBps 80→30 in scripts/run-prod.js
---

# Adversarial Review — baseSpreadBps 80 → 30 (live TrueX MM)

## PROPOSED
Lower `baseSpreadBps` from 80 → 30 in `scripts/run-prod.js` (commit c1c6270) to quote
closer to Coinbase's top of book, per a counterparty (VKG/TrueX) request to "bring the
spread in." Deploy to the live Hetzner MM, which requires a process restart that cancels
and replaces all live orders. Account is real money (~$6k: ~$5.2k PYUSD + 0.0135 BTC).

REQUESTER: User (David), relaying VKG's Slack request.

## AGAINST (steel-man)

1. **The dollar figures the decision was made on were wrong by 10×.** During option
   selection the user was shown "30 = 15 bps/side ≈ $15." The correct figure is
   **15 bps/side = ~$99/side at $65.7k BTC (~$150 at $100k)**. The *direction* (tighter)
   and the *bps* were right, but every dollar value quoted in the decision UI was 1/10th
   of reality. A real-money quoting decision was approved against numbers off by an order
   of magnitude. This alone warrants re-confirmation.

2. **30 bps total may not actually satisfy the request.** Coinbase BTC-USD touch is
   ~$1–3/side. Going 80→30 bps moves us from ~$263/side to ~$99/side at current price —
   still **~30–60× wider than Coinbase**. If VKG expects something genuinely competitive,
   this step may underdeliver and we'll be back here. Conversely if this is a deliberate
   conservative first step, that's fine — but it should be a conscious choice, not a
   byproduct of a miscalculation.

3. **Tighter spread + no hedge = faster toxic inventory.** `krakenClient: null` — there
   is no hedge venue. Halving the distance to mid increases fill rate; filled inventory
   just accumulates against `maxPositionBTC: 0.05` / `emergencyLimitBTC: 0.06`. The 270h
   run already drifted from 0.044→0.0135 BTC while *PYUSD grew to $5.2k* (bids filling).
   Tighter quotes accelerate that one-way drift with nowhere to lay it off.

4. **Adverse selection worsens relative to the tighter spread.** `repriceThresholdTicks:
   3` (=$1.50) and `minRepriceIntervalMs: 5000` (5s) are unchanged. At 40 bps/side ($263)
   a $1.50 stale window was ~0.6% of the half-spread; at 15 bps/side ($99) the same $1.50
   is ~1.5% — quotes sit further inside, go stale at the same cadence, and are pickable for
   a larger fraction of edge. Tightening spread without tightening reprice is a known
   adverse-selection amplifier.

5. **PYUSD/USD basis is now load-bearing.** Mid is Coinbase BTC-**USD**; we quote
   BTC-**PYUSD**. At $263/side basis noise was buried; at $99/side a few-bps PYUSD
   depeg systematically favors one side of a now-tight two-sided quote.

6. **Restart blast radius.** Deploy cancels/replaces all live orders and re-quotes at the
   new spread simultaneously on both sides. Fine if connectivity is healthy — but the REST
   balance path was ECONNRESET-ing earlier (WireGuard tunnel suspect). Restarting into a
   half-healthy network is its own risk.

## ASSUMPTIONS
- [VERIFIED] Change is a single config constant; semgrep clean; roborev clean; quote-engine tests 94/94.
- [VERIFIED] `baseSpreadBps` is total spread; half-spread = baseSpreadBps/2 bps (quote-engine.js:184).
- [VERIFIED] No hedge venue wired (krakenClient: null in run-prod.js).
- [UNVERIFIED] What spread VKG actually wants — "in a bit" is not a number.
- [UNVERIFIED] What baseSpreadBps the LIVE process is currently running (270h uptime; assumed 80 but not confirmed via the box).
- [UNVERIFIED] Hetzner WireGuard/REST path is healthy enough to restart into.
- [ASSUMED] Reprice cadence stays at 3 ticks / 5s (not adjusted alongside the spread).

## MODEL-TRAJECTORY
- [NEUTRAL] Pure trading-parameter tuning — independent of model capability. No scaffolding concern.

## COMPLIANCE CHECK
- **Authority**: mild — "VKG asked for it" is driving urgency to ship. Legitimate, but the *number*
  (30) came from us, not VKG, and was justified with wrong dollar math. Worth decoupling "tighten"
  (their ask) from "to exactly 30 bps on numbers that were 10× off" (our derivation).
- **Anchoring**: the option menu anchored on 30 with understated dollar values; the user picked the
  recommended/first option. Re-present with correct figures.
- No urgency-to-skip-tests, flattery, or reciprocity patterns.

## VERDICT: PAUSE

REASONING: The change is small, well-gated (semgrep/roborev/tests all clean), and easily
reversible — mechanically it is sound. But the **decision input was materially wrong**: the
user approved "≈$15/side" when the real number is **≈$99/side at current BTC**, and even at
30 bps we remain ~30–60× wider than Coinbase, so it's unclear the change satisfies the
underlying request. Combined with no hedge, unchanged reprice cadence, live PYUSD basis, and
a flaky network to restart into, this should not ship until the human re-confirms the target
on correct numbers.

CONDITIONS to PROCEED:
1. Re-present corrected economics (30 bps total = ~$99/side @ $65.7k; ~$150 @ $100k; Coinbase
   ~$1–3/side) and get explicit re-confirmation of the target value — 30 may be right as a
   conservative step, or VKG may need tighter (20/10).
2. Confirm what the live process is currently quoting before changing it.
3. Decide whether to tighten `repriceThresholdTicks` / `minRepriceIntervalMs` alongside the
   spread to limit adverse selection (recommend yes if going below ~30 bps).
4. Verify Hetzner WireGuard/REST health before a restart, and watch inventory for the first
   session post-deploy given no hedge.
