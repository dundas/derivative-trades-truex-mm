# Inventory Rebalancing Bell Model

This offline model describes how the maker should divide attention between ordinary spread
capture and inventory control. It cannot place orders and is not wired into production.

## Shape

Let `z = (inventoryBTC - targetInventoryBTC) / inventorySigmaBTC`.

- Trading weight: `exp(-0.5 * z^2)`
- Rebalancing weight: `1 - tradingWeight`
- Maker participation: `makerFloor + (1 - makerFloor) * tradingWeight`

The Gaussian is the desired inventory distribution. Near the target, the maker trades normally.
Moving into either tail gradually increases price skew and side-size asymmetry. The maker floor
prevents inventory control from withdrawing all liquidity. Gross quote size also falls in the
tails: the inventory-reducing side stays larger than the inventory-accumulating side, but neither
side falls below the configured participation floor before the live contractual-size clamp.

The normalized starting shape is:

| Absolute deviation | Policy emphasis |
|---:|---|
| `0–0.5 sigma` | Ordinary two-sided trading |
| `0.5–2 sigma` | Organic rebalancing through quote price and size |
| `2–3 sigma` | Organic rebalancing plus smoothly increasing external hedge |
| `3+ sigma` | Full hedge intensity back toward the two-sigma boundary |

At one sigma the Gaussian assigns about 61% to ordinary trading and 39% to inventory control. At
two sigma it assigns about 14% to ordinary trading and 86% to inventory control. External hedging
starts at two sigma because, under the desired distribution, only about 5% of observations should
fall outside that two-sided band.

## Direction

Below target, bids become larger and more competitive while asks become smaller and wider. Above
target, the relationship reverses. External hedging acts only on the excess outside the soft band;
it does not flatten the entire venue inventory or move the maker to a zero-BTC target.

## Running the model

All capital-sensitive inputs are required rather than embedded as production constants:

```bash
bun scripts/model-inventory-rebalancing.js \
  --target-btc=0.04 \
  --sigma-btc=0.01 \
  --max-skew-bps=10 \
  --max-size-asymmetry=0.75
```

The values above are illustrative only. The production target, sigma, quote skew, size asymmetry,
and contractual minimum quote size require explicit approval and validation against observed fills,
reference markouts, hedge costs, and TrueX market-making obligations.
