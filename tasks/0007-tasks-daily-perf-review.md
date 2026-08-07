# Task 0007 — Daily Performance Review Script

**Status**: in-progress
**Branch**: feat/daily-perf-review
**Date**: 2026-08-06
**Context**: Production equity reconciliation (2026-08-06) showed -$298 realized trading loss
since funding (vs only -$16 from BTC price decline). Loss is adverse selection: buys filled at
highs, sells at lows; ~-$41/BTC on ~$430k round-trip volume. No daily measurement exists —
`/api/v1/analytics/*` endpoints exist but are unused; `balance_snapshots` empty; `ohlc` empty;
`fills.liquidityind` unpopulated.

## Scope (bounded, read-only)

Add `scripts/daily-perf-review.ts` — a read-only daily performance review CLI that queries
`truex_analytics` (DATABASE_URL, auto-loaded from .env by Bun) and reports:

1. Sessions overlapping the day (continuity, restarts)
2. Order volume + hourly histogram (gap detection)
3. Fills by side: count, volume, avg price, fees
4. Realized PnL (FIFO over lifetime fills; optional funding seed `--seed-btc`/`--seed-price`;
   daily figure = cumulative-at-day-end minus cumulative-at-day-start)
5. Round-trip quality: avg buy vs avg sell × matched volume (adverse-selection headline)
6. Mark-out proxy: each fill vs next opposite-side fill within `--markout-window-min` (default 5);
   day average in bps. Limitation documented: true fair-value mark-out needs mid history (follow-up).
7. Verdict: thresholds `--max-daily-loss` (default $50) / `--max-adverse-bps` (default 10) →
   exit 1 WARN; 0 OK; 2 on DB/connectivity error. `--json` for machine-readable output.

Read-only guarantee: SELECT only, no writes (asserted by a test scanning the script source).

## Acceptance Criteria

- AC1: `bun scripts/daily-perf-review.ts --date 2026-08-05` runs against prod analytics DB,
  prints all sections, exits 0 or 1 (verdict), never 2.
- AC2: FIFO engine unit-tested: seeded + unseeded, partial close, position reversal, zero-reset.
- AC3: Mark-out function unit-tested on fixtures (window cutoff, same-side skip, bps math).
- AC4: DB failure → exit 2 with clear error; source contains no INSERT/UPDATE/DELETE/TRUNCATE/DDL.
- AC5: `--json` output parses and matches text-mode values.
- AC6: Threshold breaches → exit 1 and WARN section in output.
- AC7: `bun test tests/daily-perf-review.test.ts` green; no live-DB dependency in unit tests.

## Out of scope (follow-ups)

- Mid-history persistence for true fair-value mark-out (ohlc writer wiring)
- `liquidityind` population at ingest
- balance_snapshots writer (equity curve)
- Cron/heartbeat scheduling of this script (separate change)

## Review Fixes

- **roborev (codex gpt-5.4, 2026-08-06) High**: added explicit scope filters — `--symbol`
  (default BTC-PYUSD) on sessions/orders/fills, optional `--trading-mode` (fills scoped via
  session membership). Prevents mixing UAT/other-symbol data into the report.
- **roborev Medium**: numeric flags (`--markout-window-min`, `--max-daily-loss`,
  `--max-adverse-bps`) validated via `parseNumericFlag` (unit-tested); invalid → exit 2.
- **roborev round 2 High**: PnL engine was average-cost, not FIFO — replaced with true
  FIFO lot tracking (oldest lot closes first, long and short); added the reviewer's
  `buy1@100, buy1@200, sell1@150 → +50` test and its short mirror.
- **roborev round 2 Medium**: session end signal now `coalesce(endedat, completedat)` only;
  `lastupdated` is diagnostics-only (was wrongly usable as an end time).
- **roborev round 2 Medium**: thresholds reject negative values (`nonNegative` constraint);
  zero allowed (disables that breach path). `--seed-btc` must be positive (long seed lot).

## SO-13 note

Touches `scripts/` → docs-generator mandatory; docs PR opened before merge.
