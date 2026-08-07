# Daily Performance Review (`scripts/daily-perf-review.ts`)

Read-only daily performance review over the `truex_analytics` store. Answers
"how did the market maker do yesterday?" with one command: realized PnL,
adverse-selection evidence, session continuity, and quoting gaps.

**Companion PR**: the script ships in PR #54 (task `tasks/0007-tasks-daily-perf-review.md`).

## Why it exists

The 2026-08-06 equity reconciliation showed **-$298 realized trading loss**
(-$298.16 exact) since funding versus only -$16 attributable to BTC price
decline. The loss was
adverse selection: resting quotes were picked off on Coinbase lead-lag
(~-$41/BTC wrong-way on ~$430k of round-trip volume). Before this script there
was no daily measurement of that bleed.

## Usage

```bash
bun scripts/daily-perf-review.ts [--date YYYY-MM-DD] [--json] [options]
```

Requires `DATABASE_URL` (Bun auto-loads `.env`). Issues **SELECT statements
only** — asserted by a source-scan unit test.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--date` | yesterday (UTC) | Day to review (UTC boundaries) |
| `--json` | off | Machine-readable output (same values as text mode) |
| `--since YYYY-MM-DD` | none | Lower bound for the FIFO/mark-out horizon — scopes out earlier account eras (the store mixes UAT/prod fills in the same tables) |
| `--seed-btc N --seed-price P` | none | Funding inventory entering FIFO as an initial long lot (both required, both positive) |
| `--symbol` | `BTC-PYUSD` | Scope filter on sessions/orders/fills |
| `--trading-mode` | all | Additional scope filter (fills scoped via their session) |
| `--markout-window-min` | `60` | Mark-out window: fill vs next opposite-side fill within N minutes |
| `--max-daily-loss` | `50` | WARN threshold on daily realized loss (USD). `0` disables the check |
| `--max-adverse-bps` | `25` | WARN threshold on average adverse mark-out (bps). `0` disables the check |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Report produced, verdict OK |
| 1 | Report produced, verdict WARN (threshold breach) |
| 2 | Error (bad arguments, DB unreachable) |

## Operational run (funded prod account)

```bash
bun scripts/daily-perf-review.ts \
  --since 2026-06-26 --seed-btc 0.01812 --seed-price 65383
```

- `--since 2026-06-26` — funded-era start; keeps March UAT fills out of the FIFO.
- Seed values — inferred funding (0.01812 BTC + 4,815 PYUSD ≈ $6k at
  BTC ≈ $65,383). Recalibrate if the account is re-funded.
- With this scoping the script reproduces the hand reconciliation:
  lifetime realized -$295.05 vs -$298.16 hand-computed (delta = today's fills).

## Reading the report

- **Sessions** — overlapping sessions for the day. `STALE` marks `running`
  rows with no end signal whose last activity predates the reviewed day
  (leaked session rows — worth cleaning up, but not counted as live).
- **Orders** — volume, status mix, and `zero-order hours` (quoting gaps).
- **Fills** — buys/sells vwap and the **round-trip adverse $/BTC**:
  `vwap(buys) - vwap(sells)` on matched volume. Persistently positive =
  paying to trade (adverse selection).
- **Realized PnL (FIFO)** — true lot-based FIFO; daily figure is cumulative
  realized at day-end minus day-start. Seed choice changes the basis of
  funded-inventory sales; seeded and unseeded runs are both labeled.
- **Mark-out** — average adverse bps of each fill vs the next opposite-side
  fill within the window. On the current sparse tape (~40 fills/day) the
  default window is 60 min; at 5 min most days produce zero pairs.

## Known limitations / follow-ups

- Mark-out uses the next opposite-side fill as a price proxy. True fair-value
  mark-out needs mid history (`ohlc` table is currently empty — wire the
  1-min OHLC writer, then switch this metric to Coinbase-mid-at-fill).
- `fills.liquidityind` is unpopulated, so maker/taker attribution is unavailable.
- `balance_snapshots` is empty; the equity curve is reconstructed from fills,
  not balances.
- Not yet scheduled — run manually or wire into heartbeat/cron as a follow-up.
