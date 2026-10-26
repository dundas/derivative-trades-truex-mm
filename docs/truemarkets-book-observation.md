# True Markets book observation — October 26

Recommendation: use True Markets directly for book/activity monitoring, with connection health and quote age reported separately. Retain Kraken as a separate external reference candidate. This small sample does not support treating the venue midpoint alone as reliable fair value.

Observation: 2026-10-26T15:34:32.463000+00:00 to 2026-10-26T15:37:31.646000+00:00, bounded three-minute process, 180 one-second samples per symbol. Public feeds only; USD/USDC parity explicitly selected. No orders, credentials or funds touched.

| Measure | NVDAC-USDC | TSLAC-USDC |
| --- | --- | --- |
| Samples with live target transport | 179/180 | 179/180 |
| Live transport but old target quote | 92 | 179 |
| Sampled best price/size changes | 7 | 0 |
| Delivered depth update messages | 8 | 4 |
| Delivered live trade messages | 0 | 0 |
| Initial bid/ask levels | 6 / 3 | 3 / 4 |
| Initial bid/ask notional (USDC) | 79.19 / 51.66 | 72.94 / 57.23 |
| Median sampled target spread | 99.49 bps | 0.0258 bps |
| Raw midpoint difference vs Kraken, median | +6.32 bps | −182.45 bps |

Spread and difference medians weight one-second samples where both quotes exist. Nvidia had 86 samples with fresh quotes on both venues; their raw difference median was +7.22 bps. Tesla had none. These are raw numeric observations, not token-normalized fair values, profit estimates or executable arbitrage. The first sample precedes connection establishment.

Tesla's unchanged top was 387.999 bid (0.101 token) and 388 ask (0.001 token, roughly 0.388 USDC). A narrow displayed spread at negligible size does not establish useful liquidity. No trade messages were delivered during this window; activity outside the window is unknown.

## Implementation decision

The existing collector now records `sourceHealth`/`targetHealth` with transport liveness and source/receipt quote ages. Heartbeats keep transport alive but do not reset price timestamps or loosen quote eligibility. This is connection health, not proof of sequence-complete book synchronization.

True Markets DEPTH and TRADE events are retained raw, including snapshot/update markers. Depth is not reconstructed using guessed delta semantics. Historical trade snapshots do not count as new executions. `rawComparison` is explicitly labelled unnormalized and records the currency assumption. Default token mapping and inventory remain unverified, so proposals stay suppressed.

Keep the integration small: True Markets for venue state and activity, USD parity as the authorized currency assumption, and Kraken comparison kept separate until units are verified. Full L2 reconstruction, an extra venue adapter and changes to trading execution are not justified by this sample.

Evidence: `logs/equity-shadow/book-comparison-2026-10-26/comparison-summary.json`, atomic status and append-only observation files in the same directory. Focused suite: 42 tests, 143 assertions, zero failures; narrow TypeScript check passed.
