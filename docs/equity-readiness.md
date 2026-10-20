# Equity module readiness for Patrick

Assessment as of 2026-10-20: **local collection and shadow-evaluation module validated; NO-GO for a live trading pilot.** Representative observation is in progress, not complete. No live trading authorization is implied by this assessment.

## Verified implementation and operations

- The public Kraken and True Markets feeds ran locally for both target symbols. The module also subscribes to live USDC/USD rather than assuming parity.
- The focused suite passed 37 tests/117 assertions. TypeScript checking and Bun builds passed. A separate local same-provider reviewer found two persistence/exclusivity bugs; fixes and regressions passed the follow-up review.
- The default configuration suppresses proposals when mappings or inventory are unverified, and on stale, invalid or disconnected inputs. Live smoke runs produced zero proposals. Some valid connections carried stale prices; these intervals did not count as healthy coverage.
- A bounded local collector is running under `com.dundas.truex-equity-observer`. `logs/equity-shadow/current/status.json` is the current coverage authority. A running process does not prove a completed observation.
- A 15-minute progress pairing is registered separately. Its last outcome, raw voices and evidence snapshot are under `logs/equity-pairing/latest.json`. It does not authorize trading or complete tasks automatically.

## Acceptance audit

| Requirement | Current evidence and limit | Result |
| --- | --- | --- |
| Reconnect, resubscribe and freshness safeguards | `tests/equity-feeds.test.ts` exercises socket closure, malformed live frames, silence and consecutive delayed updates; shadow tests reject stale/future/crossed data. Live collector receives both venues. | Locally validated |
| Verified normalization | Fixture tests prove ratio, depth and conservative FX arithmetic. Target token identities are corroborated. Actual source price/quantity units remain unverified, so configuration suppresses output. | Incomplete |
| Bounded shadow quotes | Fixture tests exercise capital/position caps, held inventory, outward rounding and target crossing checks. No live normalized proposals have been validated. | Logic validated; live evidence pending |
| Durable collector and coverage | Restart/lock regression tests plus retained raw records and run-ID cutover evidence. Coverage excludes unhealthy intervals and restart gaps. | Locally validated |
| Representative observation | Current collector is live, but open/close/overnight and a full 24-hour span have not been collected. | In progress |
| Recurring scope review | Live local daemon; first scheduled two-voice review completed and facilitator synthesis saved. Reviews cannot mark implementation tasks complete. | Schedule verified; ongoing |
| Readiness decision | Preliminary NO-GO with unit, coverage and operational questions below. This is a provisional assessment, not a completed evidence review. | Provisional |

The runnable module and automated tests are available now. The full goal remains active until the incomplete evidence requirements are resolved; passing local tests alone does not satisfy them.

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

## Coverage interpretation

The collector reports healthy time separately from elapsed observation time. Its configured completion flags require 24 healthy hours per symbol; a 25-hour process window can end before this threshold is met. A representative 24-hour wall-clock span is also incomplete until open, close and overnight observations actually exist. Preserve both facts rather than lowering thresholds or treating raw records as verified normalized evidence.

The 19:33Z checkpoint matched 539 append-only samples per symbol to the status counters over about nine elapsed minutes. Complete BBO inputs existed for 531 Nvidia and 510 Tesla samples; early missing inputs and stale quotes remained recorded. This verifies persistence at that checkpoint, not price-unit equivalence or observation completion. Evidence: `logs/equity-shadow/raw-checkpoint.json`.

A separate 45-second Kraken capture received 98 ticker messages and 44 heartbeats and reproduced four backward source timestamps (206–3921 ms). The adapter now retains its last accepted timestamp even after clearing a rejected quote, preventing a second delayed message from restoring an older quote. The collector was gracefully restarted with retained observations; distinguish adapter versions by the run IDs in `logs/equity-shadow/timestamp-fix-cutover.json`. The first diagnostic attempt failed its handshake and received no data; it is retained separately rather than counted as a successful sample. [Kraken ticker timestamp and event trigger documentation](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker).

## Remaining gates and questions

1. Complete and inspect the representative observation across market open, close and overnight. Assess actual per-symbol healthy coverage and outages, not elapsed process time. Holiday handling is not implemented; current session labels are weekday time bands.
2. Verify source price/quantity units and corporate-action handling, record the supporting evidence, and provide fresh inventory allocations before expecting shadow proposals.
3. Resolve the documented WebSocket DROPCOPY request rejecting a client-ID string with `Invalid DROPCOPY topic pattern`.
4. Resolve FIX TestRequest responses omitting tag 112 on both tested sessions. Logon, market data and clean logout succeeded, but strict echo checks failed.
5. Review configured instrument ticks/sizes, quote risk limits, inventory disposition, feed degradation and order reconciliation before a separately authorized pilot. Kraken data access alone does not establish trading or hedging access there.

No messages have been sent to Patrick. This file provides the evidence and questions for that conversation. The separate external Claude source review was not performed after automatic approval rejected private-source transmission; local same-provider review must not be represented as a cross-family release gate.
