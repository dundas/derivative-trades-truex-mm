# Equity module readiness for Patrick

Assessment as of 2026-10-20: **local collection and shadow-evaluation module validated; NO-GO for a live trading pilot.** Representative observation is in progress, not complete. No live trading authorization is implied by this assessment.

## Verified implementation and operations

- The public Kraken and True Markets feeds ran locally for both target symbols. The module also subscribes to live USDC/USD rather than assuming parity.
- The focused suite passed 35 tests/104 assertions. TypeScript checking and Bun builds passed. A local independent reviewer found two persistence/exclusivity bugs; fixes and regressions passed the follow-up review.
- The default configuration suppresses proposals when mappings or inventory are unverified, and on stale, invalid or disconnected inputs. Live smoke runs produced zero proposals. Some valid connections carried stale prices; these intervals did not count as healthy coverage.
- A bounded local collector is running under `com.dundas.truex-equity-observer`. `logs/equity-shadow/current/status.json` is the current coverage authority. A running process does not prove a completed observation.
- A 15-minute progress pairing is registered separately. Its last outcome, raw voices and evidence snapshot are under `logs/equity-pairing/latest.json`. It does not authorize trading or complete tasks automatically.

## Target identity evidence

True Markets' public asset catalog includes a CeFi listing and a Base listing with the same symbol and slug for each target. The Base addresses match Coinbase's public tokenized-stock catalog, ignoring address case:

| Target instrument | CeFi base asset ID | Matching Coinbase/Base token contract |
| --- | --- | --- |
| NVDAC-USDC | 79053264885836365 | 0xb20000000000000000000078ee7ce2fE4908108C |
| TSLAC-USDC | 79058372686856037 | 0xb2000000000000000000001e800a7f5189430cD0 |

These catalog matches corroborate target identity. They do not independently establish custody rights, cross-issuer fungibility or hedging access. Machine-readable evidence and fetch time: `logs/equity-shadow/normalization-evidence.json`.

Primary catalog sources: [True Markets stock assets](https://api.truemarkets.co/v1/gateway/assets?asset_class=stock&product_type=spot), [Coinbase tokenized stocks](https://api.coinbase.com/v1/tokenized-stocks?page_size=500).

## Why normalization remains disabled

Kraken distinguishes xStock equity/display units from raw onchain/SPV-token units. Corporate events change their relationship. Coinbase's c-token multiplier also changes with corporate actions, but its accounting is not interchangeable with the xStock display model. [Kraken multiplier explanation](https://support.kraken.com/articles/xstocks-faq), [xStocks developer multiplier guide](https://docs.xstocks.fi/developers/multipliers), [Coinbase B20 description](https://www.base.org/blog/b20-tokenized-stocks-on-base).

The live REST/WebSocket comparison in `logs/equity-shadow/kraken-unit-comparison.json` showed Nvidia's WebSocket and REST quotes near one another, while multiplying the REST price by `token_multiplier` introduced a material discrepancy. This is empirical evidence against blindly applying that multiplier. REST requests with `rebase_multiplier=base` and `rebased` returned identical ticker values; the current public ticker documentation does not specify that parameter. An ignored parameter is not evidence of supported unit selection.

Before enabling a mapping, confirm the exact **price and quantity units** of Kraken's v2 BBO, the unit used for each True Markets token, and the correct conversion of both prices and available sizes. Do not mark verification complete merely because a price looks plausible. The example remains unverified; no default values were changed based on the comparison.

## Remaining gates and questions

1. Complete and inspect the representative observation across market open, close and overnight. Assess actual per-symbol healthy coverage and outages, not elapsed process time. Holiday handling is not implemented; current session labels are weekday time bands.
2. Verify source price/quantity units and corporate-action handling, record the supporting evidence, and provide fresh inventory allocations before expecting shadow proposals.
3. Resolve the documented WebSocket DROPCOPY request rejecting a client-ID string with `Invalid DROPCOPY topic pattern`.
4. Resolve FIX TestRequest responses omitting tag 112 on both tested sessions. Logon, market data and clean logout succeeded, but strict echo checks failed.
5. Review configured instrument ticks/sizes, quote risk limits, inventory disposition, feed degradation and order reconciliation before a separately authorized pilot. Kraken data access alone does not establish trading or hedging access there.

No messages have been sent to Patrick. This file provides the evidence and questions for that conversation. The separate external Claude source review was not performed after automatic approval rejected private-source transmission; local same-provider review must not be represented as a cross-family release gate.
