# Local equity reference and shadow quotes

This standalone module observes Kraken NVDAx/USD and TSLAx/USD alongside True Markets NVDAC-USDC and TSLAC-USDC. It does not import or start the live market maker. Both feeds are public; no account credentials are needed. Its output is an observation or proposed quote record, never an exchange order.

## Run

From the feature worktree:

```bash
bun test tests/equity-shadow.test.ts tests/equity-feeds.test.ts tests/equity-recorder.test.ts tests/equity-review-loop.test.ts
bun scripts/run-equity-shadow.ts --config config/equity-shadow.example.json --duration-seconds 60 --out logs/equity-shadow/smoke
```

`--duration-seconds` defaults to 60 and accepts a positive value up to seven days. For a longer raw observation, use 86400 and a new output directory. SIGINT/SIGTERM stop the feeds, save status, and release the output lock. Concurrent collectors cannot share an output directory. Dead-owner lock recovery is serialized; an abandoned `collector.acquire` directory requires explicit inspection before removal.

The example is **unverified and suppression-only**. Do not mark a mapping verified to make a smoke run pass. The sample tick/size/limit settings are illustrative research settings, not exchange-certified trading parameters.

## Enable research proposals with verified inputs

Copy the example to a separate configuration. For each symbol, document the source and target token contracts, underlying equity, dividend/split treatment and **the units in which the source price is quoted**. Set `sourceSharesPerToken` and `targetSharesPerToken` only after confirming those semantics. Populate `mapping.evidence`, `verifiedAt` (Unix milliseconds), and `verified:true`. These are operator attestations; the module does not independently validate the cited documents or refresh multipliers.

If a source quote is USD per source token, normalization is:

```text
ratio = target shares per token / source shares per token
target-token bid in USDC = source bid × ratio / USDC-USD ask
target-token ask in USDC = source ask × ratio / USDC-USD bid
```

Some venues may present rebased/per-share prices. Verify that contract before choosing a multiplier. Kraken's `Assets` endpoint currently exposes `token_multiplier`; Coinbase's tokenized-stock endpoint exposes `multiplier`. Neither field alone proves price-unit equivalence or True Markets' exact contract mapping. Unknown values never default to one. Live Kraken `USDC/USD` supplies both FX sides; no fixed peg is assumed.

Provide a verified, timestamped inventory snapshot. `availableQuote` is the capital allocated to **that symbol**, not a full account balance repeated for every symbol. Keep the sum of per-symbol allocations within the account's free quote balance. `availableBase` and `positionBase` limit selling to held tokens; there is no shorting or automatic balance refresh. An inventory snapshot expires according to `maxInventoryAgeMs`, so this version does not support unattended proposal generation from a static balance snapshot.

Use a new output directory when changing configuration; its hash prevents pooling evidence from different settings. The pure `evaluateShadow` API can also receive refreshed mappings/inventory from a future integration without changing network behavior.

## Safety and observations

- Both source and receive timestamps must be fresh; transport heartbeats do not refresh a quote's age. Invalid, missing, crossed, out-of-order or disconnected data is invalidated or suppressed.
- True Markets instruments must report ACTIVE. Proposed buys stay below the target ask and sells above the target bid; prices round outward. Size is capped by reference liquidity participation, per-symbol capital and inventory limits.
- Each run appends `observations-<run-id>.jsonl`, retaining consumed BBO inputs, proposals and suppression reasons. `status.json` is atomically replaced.
- Coverage counts only intervals bounded by healthy samples within `maxSampleGapMs`. Restart downtime and unhealthy intervals are gaps. `eligibleMs` additionally requires proposals from verified inputs. Process uptime does not count as healthy coverage.
- Session buckets use America/New_York weekday time windows, including open, close and overnight, and account for DST. They do **not** implement an exchange holiday calendar. Inspect actual market-session coverage before a pilot decision.
- `pilotReady` always remains false. The module cannot authorize trading. Twenty-four hours, verified normalization, operational API issues and pilot risk limits require a separate evidence review.

The initial 60-second live smoke collected both symbols and observed stale inputs. It generated zero proposals, as expected with unverified mappings. Source silence and limited target updates are measured limitations, not reasons to weaken the age checks.

## Goal progress and pairing review

Task authority: `tasks/equity-reference-shadow.{md,json}`. `logs/equity-pairing/latest.json` records the last review and its two voice artifacts. The runtime summary comes from `logs/equity-shadow/current/status.json` when a collector is running there. Reviews read evidence and recommend the next smallest useful action. They do not edit implementation files, change credentials, place orders or send messages externally.

The local launchd service `com.dundas.truex-equity-progress` runs agent-process HeartbeatService every 900 seconds. Health/status is bound to `127.0.0.1:9167`; port, interval (minimum 15 minutes), participant timeout, output and dependency locations are CLI settings. Participants are Claude Code and the locally configured supported Codex model (`gpt-6.1-sol` at setup); private source-code review by a separate external provider remains unapproved. Pairing inputs contain the task/evidence snapshot and brief, not credential files. Only a run with both voice artifacts is recorded as a successful pairing review.

Inspect or stop the service:

```bash
curl -fsS http://127.0.0.1:9167/status
launchctl print gui/$(id -u)/com.dundas.truex-equity-progress
launchctl bootout gui/$(id -u)/com.dundas.truex-equity-progress
```

Setting the ledger's top-level status to `paused` or `complete` makes review ticks no-ops. It does not pause the Codex goal or stop a separate collector; manage those explicitly. Recommendations are retained for the implementation session to synthesize; no scheduler inference can mark tasks complete.

The current raw observer is registered as `com.dundas.truex-equity-observer`, with a bounded 25-hour run per process and crash restart. Its current status is `logs/equity-shadow/current/status.json`; errors are in `logs/equity-shadow/observer.err.log`. Stop it with `launchctl bootout gui/$(id -u)/com.dundas.truex-equity-observer`. Both services depend on this persistent worktree: retain it until the services are stopped. A crash restart begins another bounded process window, and the coverage report records the downtime rather than treating it as observations.

## Known external gaps

True Markets WebSocket DROPCOPY rejected the documented client-ID format. FIX sessions authenticated and delivered books but did not echo TestReqID in heartbeat responses. Those findings do not block this public collector; they remain unresolved for unattended trading. Token mapping/price-unit semantics also remain unverified. Do not treat this module or its local test results as a live-trading approval.

References: [Kraken ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), [Kraken instruments](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/instrument), [True Markets WebSocket](https://docs.truemarkets.co/api/websocket/institutional.md).
