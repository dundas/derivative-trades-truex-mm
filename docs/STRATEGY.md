# TrueX Market Maker — Strategy & Progress Tracker

**Last updated**: 2026-08-08 · **Owner**: true-markets brain · **Status**: live, optimizing

This is the single source of truth for *what we're doing, why, what we're optimizing, and
how we trace progress*. Architecture lives in `docs/ARCHITECTURE.md`; operational gotchas
in `memory/MEMORY.md`; infra readiness in `memory/production-readiness.md`.

---

## 1. Mission

Make markets profitably on **BTC-PYUSD on TrueX**, pricing off Coinbase BTC-USD, starting
from a small funded account and compounding through superior quoting — not directional bets.

**Capital**: funded 2026-06-26 with 0.01812 BTC + 4,815.27 PYUSD (≈ $6,000 @ BTC ≈ $65,383).
**Current equity**: ~$5,700 (2026-08-08). Drawdown to date: **-$298 realized trading loss**;
only -$16 of it was BTC price movement. **The bleed is our quoting, not the market.**

## 2. The core problem: adverse selection

TrueX takers watch Coinbase. When Coinbase moves, they lift/hit our stale TrueX quotes
before our reprice lands. We buy at local highs, sell at local lows.

**Evidence (baseline, 2026-08-03 → 08-06)**:

| Metric | Baseline range | Meaning |
|---|---|---|
| Round-trip wrong-way | **+$122 … +$252 / BTC** | matched buys cost more than matched sells return |
| Adverse mark-out (60m) | **1.3 … 40.7 bps** | price moves against us after our fills |
| Realized PnL | **-$0.86 … -$5.05 / day** | net of zero maker fees |
| `Insufficient balance` rejects | **323 / hour** | sizing bug burning rate budget (fixed 2026-08-07) |

## 3. What we optimize (metric hierarchy)

**North star**: daily realized PnL (true-FIFO, era-scoped, funding-seeded).

Driver metrics (in causal order):

1. **Adverse mark-out (bps)** — are we still being picked off? Target: sustained < 10bps.
2. **Round-trip wrong-way ($/BTC)** — the dollar translation; target: ≤ $0 (neutral-or-favorable).
3. **Fill rate / matched volume** — must not collapse when we defend (defense that kills
   fills is just quitting). Watch both together.
4. **Rejection count** — hygiene; target 0 (achieved 2026-08-07).

Guardrails (hard limits, alert on breach):
- WARN if daily realized < **-$50** or adverse mark-out > **25bps** (thresholds set in
  task 0007, alerting wired by task 0008)
- No over-commit: placements held while cancels in flight (task 0009)
- Position limits + stop tools: `MOMENTUM_REPRICE_BPS=0` rollback, REST cancel-all
  (`scripts/rest-cancel-all.js`), graceful container stop (cancels first).
  Gap: the `scripts/kill-switch.js` referenced by deploy tooling does not exist in the
  repo yet — tracked under known gaps

## 4. How we trace progress

Automated, daily, human-visible — no session required:

- **19:15 CDT**: scheduled review runs (`scripts/daily-perf-review-job.sh` on launchd)
- **Report page**: `https://truex-mm-reports.pages.dev/<date>` (+ 14-day archive index)
- **Email digest**: `truex-mm@derivative.email` → `david@derivative.io` — verdict, key
  metrics, 7-day trend table, page link
- **WARN alerts**: ADMP → decisive inbox + the email subject flags the verdict
- **Data path**: TrueX fills/orders → `truex_analytics` (Hetzner PG) → review script →
  page/email. Everything re-derivable from the fills table (era-scoped, seeded FIFO).

Reading the trend: judge in **3-day windows**, not single days (one quiet day can show
0bps with zero signal). A flat 3-day window at baseline levels = the current defense
isn't working → escalate to the next phase lever.

## 5. Phase plan & decision rules

| Phase | Lever | Status | Success criterion |
|---|---|---|---|
| 0 — Measure | Daily review + scheduling + email/pages | ✅ Done (tasks 0007-0008) | Reports arriving daily |
| 1a — Hygiene | Balance-aware sizing (no over-commit) | ✅ Deployed 2026-08-07 (task 0009) | Rejections → 0 ✓ |
| 1b — Defense | Momentum reprice: bypass 1.5s debounce on ≥10bps moves | ✅ Deployed 2026-08-07 (task 0010) | 3-day adverse avg < 10bps without fill collapse |
| 2 — Defense+ | **Vol-adaptive spread floor**: widen when vol spikes beyond what momentum can outrun | ⏳ Next, gated on Phase 1b data | 3-day wrong-way ≤ $50/BTC |
| 3 — Offense | Taker side (cross-venue opportunistic takes) | 🔒 Blocked on shadow evidence | Task 0006 analyzer: GO criteria in its spec |
| 4 — Scale | Size/levels up, second symbol | 🔒 Gated on sustained profitability | ≥ 2 weeks net-positive realized |

**Escalation rules**:
- Phase 1b flat after 3 days → tune `MOMENTUM_REPRICE_BPS` 10 → 6, re-measure 3 days
- Still flat → build Phase 2 (spread floor), calibrate against the mark-out distribution
- Any WARN alert → investigate same day (the email names the breached threshold)
- Drawdown > -$500 from current equity → stop quoting, post-mortem before resuming

## 6. Risk posture (fail-closed by design)

- **Kill switches**: `MOMENTUM_REPRICE_BPS=0` (defense off), kill-switch.js (cancel all),
  container stop (graceful cancel-first)
- **Sizing**: never quotes beyond available-minus-holds; placements wait for cancel confirms
- **Debounce exemptions**: completion retries only, never the ordinary path
- **Deploy**: human-gated, clean-worktree rsync, serialized build→recreate→verify
- **Known gaps** (tracked in production-readiness.md): prod NTP skew, mid-history for
  true fair-value mark-out (currently proxied by next-opposite-fill), `liquidityind`
  unpopulated, balance_snapshots empty, no dead-man's switch on the daily job

## 7. Where things live

| Concern | Location |
|---|---|
| This strategy | `docs/STRATEGY.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| Daily review usage | `docs/DAILY_PERF_REVIEW.md` |
| Operational gotchas | `memory/MEMORY.md` |
| Session history + baselines | `memory/daily/` (esp. 2026-08-06/07)* |
| Feature specs 0007-0011 | `tasks/00xx-*.md` |
| Infra readiness | `memory/production-readiness.md` |
| Live reports | https://truex-mm-reports.pages.dev/ |

\* `memory/` is intentionally untracked — it lives in the brain's runtime worktree
(`$DATA_ROOT`), not in git.
