# Inventory Rebalancing Backtest — 2026-08-07 to 2026-08-21

## Headline

The existing zero-BTC target sold a net 0.01305 BTC while BTC appreciated from approximately
$65,091.50 to $76,682.65. Actual ending value was $5,731.87, or $141.60 below simply holding the
inferred starting inventory.

Using the inferred opening balance (0.01428 BTC) as a no-hindsight operating target, the bell
policy improved modeled ending value by $61.24 to $133.03, depending on fill-survival assumptions.
It reduced turnover by 10% to 41% and finished with 0.00843 to 0.01320 BTC instead of 0.00123 BTC.

This is an execution-opportunity replay, not a full market simulation. Historical reference books,
queue position, and TrueX trade tape were not persisted for most of the window, so the backtest does
not invent new fills or claim that shifted passive quotes would have received unobserved flow.

## Evidence and marks

- Rolling window: 2026-08-07T12:00:00Z through 2026-08-21T12:00:00Z.
- Recorded evidence: 196 unique fill fragments across 137 TrueX orders.
- Fees recorded in the window: zero.
- Ending exchange balances: 0.00123 BTC and 5,637.551515 PYUSD.
- Inferred opening balances: 0.01428 BTC and 4,778.44609 PYUSD.
- Opening mark: $65,091.50, the first recorded execution after the window opened.
- Closing mark: approximately $76,682.65, inferred from the live 11:58 UTC PnL mark
  (`$73,890 short basis + $10.64 / 0.00381 BTC`).
- Balance inference assumes no deposits, withdrawals, unrecorded fills, or nonzero fees in-window.

## Primary policy: preserve opening inventory

Configuration: target 0.01428 BTC, sigma 0.00476 BTC, 10 bps maximum price skew, 75% maximum
size asymmetry, 25% minimum maker participation, organic rebalancing inside two sigma, and no
executed external hedge.

| Metric | Actual | Strict fill survival | Same-opportunity replay |
|---|---:|---:|---:|
| Ending portfolio value | $5,731.87 | $5,864.91 | $5,793.11 |
| Change versus actual | — | +$133.03 | +$61.24 |
| PnL over window | +$23.92 | +$156.95 | +$85.16 |
| PnL versus holding | -$141.60 | -$8.57 | -$80.36 |
| Ending BTC | 0.00123 | 0.01320 | 0.00843 |
| Net BTC sold | 0.01305 | 0.00108 | 0.00585 |
| BTC turnover | 0.24203 | 0.14141 | 0.21864 |
| Quote turnover | $15,750.32 | $9,233.53 | $14,186.87 |
| Filled fragments | 196 | 96 | 186 |
| Filled orders | 137 | 74 | 137 |
| Minimum BTC inventory | 0.00004 | 0.00883 | 0.00698 |

The strict scenario retains a recorded fill only when the shifted quote would have been at least as
aggressive as the quote that actually filled. The same-opportunity scenario assumes each recorded
taker also reaches the shifted quote. Neither scenario permits more quantity than the recorded
taker supplied, and candidate order size is capped by the original order size and available capital.

The two scenarios are execution-assumption sensitivity bounds, not a statistical confidence
interval. Strict fill survival is conservative about fills but can produce better PnL by selectively
removing the inventory-increasing side; it is not automatically a lower PnL bound.

## Target sensitivity: 0.025 BTC

The previously proposed shadow target of 0.025 BTC with sigma 0.008333 BTC increased modeled
ending value by $167.07 under same-opportunity replay and $259.87 under strict fill survival. Ending
BTC was 0.01730 to 0.02388 BTC. Because BTC rose about 17.8% between the selected marks, this
increment includes deliberate directional exposure and must not be described as spread alpha.

## Interpretation

The strongest supported conclusion is that targeting zero BTC was economically harmful in this
window. The bell policy would have reduced sell pressure, preserved more inventory, reduced
turnover, and materially narrowed the loss versus holding. The evidence does not yet prove that
10 bps maximum skew is optimal, that new shifted quotes would fill, or that this policy has positive
expected performance across falling and sideways regimes.

Before live wiring, rerun the same replay across multiple non-overlapping windows and obtain fresh
point-in-time Coinbase/TrueX books so quote survival, maker status, markouts, and queue effects can
be evaluated without proxy assumptions.
