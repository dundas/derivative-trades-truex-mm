# tastytrade reference integrated with True Markets

The shadow collector supports tastytrade REST quotes as a reference, with explicit USD/USDC and token/share parity assumptions. A separate DXLink capture observes activity; its missing quote timestamps are excluded from pricing.

## Bounded live validation

On October26, the collector ran for120seconds with120samples per symbol. All24batched REST polls succeeded, with no provider errors or retries. Source quotes were present/fresh in119samples per symbol after startup. Median provider-record age was about2.57seconds and maximum about5.56seconds, using a5second polling interval.

| Metric | NVDAC-USDC | TSLAC-USDC |
| --- | --- | --- |
| Provider update records | 24 | 24 |
| Fresh source quote samples | 119 | 119 |
| Live target connection with old target quote | 88 | 119 |
| Median reference spread | 0.93 bps | 2.28 bps |
| Median target spread | 96.28 bps | 0.0258 bps |
| Median raw midpoint difference | +1.67 bps | −166.15 bps |
| Samples where both quotes were fresh | 31 | 0 |
| Order proposals | 0 | 0 |

The differences use the explicit parity assumptions and available cached quotes, including old target quotes. They are diagnostic, not verified fair value or executable arbitrage. The median Nvidia difference restricted to31fresh-pair samples was+1.44bps. There is no fresh-pair Tesla comparison. Tesla's tiny top ask remained0.001token at388USDC while its reference ended394.4/394.5USD.

The parallel120second DXLink capture passed and delivered407Quote events and475Tradelast-state events. These are delivered state messages, not independently deduplicated executions. Stream quote-side timestamps still returnedzero; receipt times remain separately recorded.

## Behavior and limits

The REST adapter batches symbols, renews OAuth access with read scope, uses configurable nonoverlapping polling and bounded retry delays, clears quotes on failures/omissions/halts, and rejects malformed or backward timestamps. A stale provider updated-at field cannot be replaced by receipt time. Provider-record timestamps do not establish the exact exchange bid/ask-change time. Quote sizes use an explicit research multiplier1rather than importing Alpaca's lot conversion.

Inventory remains unverified. All default risk/freshness limits remain, and no live orders were submitted. Healthy source data alone does not make an old target book suitable for quoting. This sample establishes a working bounded research integration, not overnight robustness or pilot approval.

Run using `config/equity-shadow.tastytrade.example.json` and the authorized sibling env file, as documented in equity-shadow.md. Future runs require fresh output directories. The observed config was saved alongside the run and reconciled to its hash. A later descriptive sourceToken wording correction changes the example hash without changing conversion logic.

Evidence: `logs/equity-shadow/tastytrade-paired-2026-10-26/comparison-summary.json`, `observed-config.json`, atomicstatus andraw observations; parallelactivity under `logs/tastytrade-paired-activity-2026-10-26`. Local validation:57tests/202assertions; narrowTypeScriptcheck and Bunbuild passed.
