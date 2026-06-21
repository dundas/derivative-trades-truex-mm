---
generated_at: 2026-06-17T01:26:00Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: refactor/truex-prod-host-env
git_commit: 71ec64c
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Enable coinbase-mirror anchor mode on live MM (spread ~$21 vs ~$520)
---

# Adversarial Review — coinbase-mirror anchor mode (live TrueX MM)

## PROPOSED
Ship commit 71ec64c and deploy: switch live quoting from mid±80bps (~$520 spread,
~$263/side) to `coinbase-mirror` — L1 anchored to Coinbase best bid/ask ±1 tick, giving a
spread of ~Coinbase width + 2 ticks (~$21, ~$10.5/side). Real-money account (~$6k). Deploy
requires restarting the live MM.

REQUESTER: User (David), originating from VKG's Slack: *"able to bring your spread in a bit?"*

## AGAINST (steel-man)

1. **"A bit" ≠ 25×.** The counterparty asked to bring the spread *in a bit*. We built the
   maximal tightening — mirroring Coinbase to ~$21 from ~$520, a ~25× cut. That's not "a
   bit"; it makes an illiquid, unhedged venue quote as tight as the reference exchange. The
   implementation has outrun the request. This gap alone warrants confirming intent before
   live.

2. **Reprice cadence is fundamentally mismatched to a tight spread — this is the killer.**
   `repriceThresholdTicks: 3` ($1.50) and `minRepriceIntervalMs: 5000` (5s), `maxOrdersPerSecond: 4`
   were tuned for a $260/side spread. Against a **$10.5/side** spread, a normal $30 BTC move in
   5s is **286% of the half-spread** — the market fully traverses our quote before we can
   reprice, so momentum runs us over on the stale side every time. At 80bps that same move was
   ~11% of half-spread (survivable). Tightening 25× without tightening reprice is a systematic
   adverse-selection loss engine. **The supporting parameters were not changed alongside the
   spread.**

3. **No hedge = one-way ratchet.** `krakenClient: null`. Every adversely-selected fill
   accumulates inventory toward `maxPositionBTC 0.05` / `emergencyLimitBTC 0.06` with no
   offset. The prior 270h already drifted 0.044→0.0135 BTC at the WIDE spread; at mirror
   tightness fills come far faster and more toxic.

4. **No TrueX book → blind crossing.** Prod feeds the Coinbase adapter into `updateTrueXBook()`;
   there is no real TrueX book. The marketable/slide guard therefore protects only against the
   Coinbase book (which our buffer already clears), so it is effectively a no-op for its stated
   purpose. Actual TrueX-side crossing is caught only reactively by reject-backoff (3→5s pause),
   which at a tight spread can mean repeated reject/backoff churn that itself degrades quoting.

5. **PYUSD/USD basis now dominates.** Mid/anchor is Coinbase BTC-USD; we quote BTC-PYUSD. A
   few-bps PYUSD depeg is a large fraction of a $21 spread and systematically feeds one side.

6. **Skipping the intermediate data point.** The 80→30 step hasn't been observed live for even
   one session. We're proposing to jump past it to the most aggressive setting with no live
   evidence of how fills/inventory behave at any tighter spread.

## ASSUMPTIONS
- [VERIFIED] Unit behavior correct: quote-engine 99/99; mid mode unchanged; missing-book fallback covered.
- [VERIFIED] semgrep/roborev pending (next gate) — implementation-level review not yet run.
- [VERIFIED] Default mode stays 'mid' — opt-in; blast radius limited to run-prod.js enabling it.
- [VERIFIED] Kill switch exists (`bun scripts/kill-switch.js --prod`) — reversible.
- [UNVERIFIED] That mirror tightness is actually what VKG/David want vs a moderate step.
- [UNVERIFIED] Whether rate limits + 5s reprice can even sustain quoting at mirror tightness without constant staleness.
- [UNVERIFIED] Live Coinbase spread width / typical 5s volatility at current regime.
- [ASSUMED] Hetzner WireGuard/REST healthy enough to restart into (was ECONNRESETing earlier this session).

## MODEL-TRAJECTORY
- [NEUTRAL] Trading-logic parameter/strategy — independent of model capability. Durable either way.

## COMPLIANCE CHECK
- **Incrementalism (reverse escalation)**: within one session the goal drifted "tighten a bit
  (30bps)" → "mirror Coinbase exactly." Each step felt reasonable; the aggregate is a 25× change
  on live money. Flagged.
- **Anchoring**: the mirror option menu presented "match width + small buffer" as recommended/first.
  The most aggressive viable interpretation became the default.
- **Authority**: "VKG asked" is doing work, but VKG asked for "a bit," not a mirror — so authority
  is being borrowed for a scope they did not request.
- No urgency-to-skip-gates, flattery, or reciprocity.

## VERDICT: PAUSE (strong)

REASONING: The code is clean, opt-in, well-tested, and reversible — mechanically fine. But as a
*live trading decision* it has a concrete, quantifiable loss mechanism: a 25× spread cut with the
reprice cadence, rate limits, hedge, and basis controls all still set for the old wide regime.
The single most likely outcome of deploying as-is is systematic adverse-selection bleed. It also
exceeds the counterparty's stated ask ("a bit"). This should not go live until the regime
parameters are made consistent with the spread and intent is confirmed.

CONDITIONS to PROCEED:
1. **Confirm the target with the human/VKG.** "In a bit" vs full mirror is a real fork. If they
   want mirror, proceed under the conditions below; if "a bit," ship the 80→30 step first.
2. **Fix the reprice-regime mismatch before any tight spread goes live**: lower
   `minRepriceIntervalMs` (e.g. 500–1000ms) and `repriceThresholdTicks` (→1), and confirm
   `maxOrdersPerSecond` / TrueX rate + 50-order limits can sustain it. Without this, do not deploy.
3. **Canary, supervised**: first live run with reduced `baseSizeBTC` and tighter `maxPositionBTC`,
   kill switch staged, watching fill rate / realized adverse selection / inventory drift for a
   bounded window. Roll back on drift.
4. **Consider a larger initial buffer** (not 1 tick) or stage 30bps → observe → mirror, rather
   than jumping straight to the touch.
5. **Verify Hetzner WireGuard/REST health** before restarting the live process.

This is a PAUSE, not a BLOCK: it is opt-in, reversible, and safe to *merge* (behind the default-off
flag). The PAUSE is specifically on **enabling it live in run-prod.js + deploying** until 1–3 hold.
