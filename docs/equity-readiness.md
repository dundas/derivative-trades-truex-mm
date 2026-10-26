# Equity module readiness for Patrick

Assessment as of 2026-10-26: **local collection and shadow-evaluation module validated; NO-GO for a live trading pilot.** A representative 25.2-hour elapsed observation is collected; configured healthy coverage and verified normalization remain incomplete. No live trading authorization is implied by this assessment.

## Verified implementation and operations

- The public Kraken and True Markets feeds ran locally for both target symbols. The original observation used live USDC/USD. Following explicit user steering, the example now assumes USD/USDC parity; live FX remains configurable. The original tape is not relabeled as parity evidence.
- The focused suite passed 40 tests/130 assertions. TypeScript checking and Bun builds passed. A separate local same-provider reviewer found two persistence/exclusivity bugs; fixes and regressions passed the follow-up review.
- The default configuration suppresses proposals when mappings or inventory are unverified, and on stale, invalid or disconnected inputs. Live smoke runs produced zero proposals. Some valid connections carried stale prices; these intervals did not count as healthy coverage.
- A bounded local collector completed under `com.dundas.truex-equity-observer`. `logs/equity-shadow/current/status.json` is the current coverage authority. A running process does not prove a completed observation.
- A 15-minute progress pairing is registered separately. Its last outcome, raw voices and evidence snapshot are under `logs/equity-pairing/latest.json`. It does not authorize trading or complete tasks automatically.

## Acceptance audit

| Requirement | Current evidence and limit | Result |
| --- | --- | --- |
| Reconnect, resubscribe and freshness safeguards | `tests/equity-feeds.test.ts` exercises socket closure, malformed live frames, silence and consecutive delayed updates; shadow tests reject stale/future/crossed data. Completed live run received both venues. | Locally validated |
| Verified normalization | Fixture tests prove ratio, depth and conservative FX arithmetic. Target token identities are corroborated. Actual source price/quantity units remain unverified, so configuration suppresses output. | Incomplete |
| Bounded shadow quotes | Fixture tests exercise capital/position caps, held inventory, outward rounding and target crossing checks. No live normalized proposals have been validated. | Logic validated; live evidence pending |
| Durable collector and coverage | Restart/lock regression tests plus retained raw records and run-ID cutover evidence. Coverage excludes unhealthy intervals and restart gaps. | Locally validated |
| Representative observation | 25.2014 elapsed hours include open, close and overnight; configured 24 healthy hours unmet. | Elapsed observation complete; healthy gate unmet |
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

## Unit verification checkpoint — October 26

| Source | What the current primary documentation establishes | What remains unproven |
| --- | --- | --- |
| [Kraken public ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker) | BBO prices, quantities, timestamps and change-triggered publication are defined. | Whether xStock BBO prices and quantities use underlying-equity or SPV-token units. No public ticker rebasing selector is documented. |
| [Kraken private executions](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/executions) | An explicit rebased selector distinguishes equity from SPV-token display for account reports. | That account-report rule cannot establish public ticker semantics. |
| [xStocks multiplier guide](https://docs.xstocks.fi/developers/multipliers) | Raw and scaled quantities differ; chain implementations and corporate-action adjustments are described. | Which accounting convention Kraken applies to each public ticker field. |
| [True Markets WebSocket schema](https://docs.truemarkets.co/api/websocket/institutional.md) | EBBO price levels and aggregate resting quantities are documented. | A stock-specific token/share conversion for these CeFi instruments. |

A sufficient venue answer must identify the price denominator and size unit separately for both symbol pairs, state whether corporate actions rebase those fields, and provide the effective multiplier source/time. Target contract identity alone does not answer these questions. No external message was sent to obtain that answer.

## Coverage interpretation

The collector reports healthy time separately from elapsed observation time. Its configured completion flags require 24 healthy hours per symbol; a 25-hour process window can end before this threshold is met. A representative 24-hour wall-clock span is also incomplete until open, close and overnight observations actually exist. Preserve both facts rather than lowering thresholds or treating raw records as verified normalized evidence.

The 19:33Z checkpoint matched 539 append-only samples per symbol to the status counters over about nine elapsed minutes. Complete BBO inputs existed for 531 Nvidia and 510 Tesla samples; early missing inputs and stale quotes remained recorded. This verifies persistence at that checkpoint, not price-unit equivalence or observation completion. Evidence: `logs/equity-shadow/raw-checkpoint.json`.

A separate 45-second Kraken capture received 98 ticker messages and 44 heartbeats and reproduced four backward source timestamps (206–3921 ms). The adapter now retains its last accepted timestamp even after clearing a rejected quote, preventing a second delayed message from restoring an older quote. The collector was gracefully restarted with retained observations; distinguish adapter versions by the run IDs in `logs/equity-shadow/timestamp-fix-cutover.json`. The first diagnostic attempt failed its handshake and received no data; it is retained separately rather than counted as a successful sample. [Kraken ticker timestamp and event trigger documentation](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker).

## Completed observation audit — October 26

The user resumed the goal. The observer completed normally (launchd exit 0) on October 21; it is stopped, not collecting now. The retained window runs from October 20 19:24:12Z to October 21 20:36:17Z, **25.2014 elapsed hours**. All 90,562 append-only samples per symbol parse and match the status counters.

| Symbol | Healthy hours | Eligible normalized hours | Configured 24-healthy-hour gate |
| --- | --- | --- | --- |
| NVDAC-USDC | 6.5651 | 0 | Unmet |
| TSLAC-USDC | 10.1188 | 0 | Unmet |

Open, close, overnight, premarket, regular and afterhours samples exist. This completes the representative elapsed observation; it does not satisfy the stricter healthy-hour or normalized-evidence flags. Source quote ages explain many suppressions: Nvidia target median 20.26 seconds/p95 274.36 seconds; Tesla target median 7.81 seconds/p95 81.98 seconds; shared FX median 7.79 seconds/p95 40.42 seconds. The configured age limit remains 15 seconds.

Historic heartbeat/message receipts were not retained, so this tape cannot prove transport liveness throughout every stale interval. Heartbeats alone would not establish that an old BBO remains executable. No freshness threshold is relaxed. A new identical run is deferred while units remain unverified; the present NO-GO is supported by collected evidence.

Machine-readable audit: `logs/equity-shadow/completed-observation-audit.json`. The 15-minute review daemon is still active: 488 runs, 371 successes and 117 failures at this checkpoint. A successful review requires two voices; failed reviews are not counted as passes.

## Remaining gates and questions

1. The completed observation spans market open, close and overnight; assess its inadequate healthy coverage before considering a rerun. Assess actual per-symbol healthy coverage and outages, not elapsed process time. Holiday handling is not implemented; current session labels are weekday time bands.
2. Verify source price/quantity units and corporate-action handling, record the supporting evidence, and provide fresh inventory allocations before expecting shadow proposals.
3. Resolve the documented WebSocket DROPCOPY request rejecting a client-ID string with `Invalid DROPCOPY topic pattern`.
4. Resolve FIX TestRequest responses omitting tag 112 on both tested sessions. Logon, market data and clean logout succeeded, but strict echo checks failed.
5. Review configured instrument ticks/sizes, quote risk limits, inventory disposition, feed degradation and order reconciliation before a separately authorized pilot. Kraken data access alone does not establish trading or hedging access there.

No messages have been sent to Patrick. This file provides the evidence and questions for that conversation. The separate external Claude source review was not performed after automatic approval rejected private-source transmission; local same-provider review must not be represented as a cross-family release gate.

## Follow-up unit research requested by user

True Markets provides stronger evidence than the earlier summary: its [catalog schema](https://docs.truemarkets.co/api/gateway/list-assets.md) says stock assets quote and execute as ordinary listings, and its [quote schema](https://docs.truemarkets.co/api/gateway/compute-quote.md) defines price per unit of base asset. Combined with current explicit `cefi_instrument` fields, the supported base/quote interpretation is NVDAC quantity with USDC per NVDAC, and TSLAC quantity with USDC per TSLAC. This does not establish shares per token.

The refreshed NVDAC catalog description explicitly states an initial1:1beneficial interest and a share/token ratio that can change with reinvestment, taxes, fees and corporate actions. TSLAC has no description, so do not attribute that text to its record. Both CeFi listings report `settlement=defi`.

Kraken's [FAQ](https://support.kraken.com/articles/xstocks-faq) explicitly relates displayed order quantity to raw token quantity through the multiplier. The [private executions](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/executions) rebased option distinguishes equity and SPVtoken display. The [public ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker) still does not explicitly identify that convention for BBO price and size. Applying the multiplier blindly risks double conversion. Source-field convention and fresh target share/token conversion remain unresolved; normalization stays disabled. Full fetched metadata and evidence: `logs/equity-shadow/unit-research-followup.json`.

## User-approved USD/USDC simplification

The user explicitly chose USD≈USDC as the research default. The example sets `fx.mode=usd_parity`; the collector omits the FX subscription and evaluates only source/target market freshness in this mode. Evaluation and feed-status records label the currency assumption. Token/share mapping and inventory verification are unchanged. Live FX mode remains available, and old configurations without an FX policy retain live mode. The old25.2-hour tape retains its original configuration and cannot count as parity-mode coverage.
