# Local equity reference and shadow quotes

This standalone module observes Kraken NVDAx/USD and TSLAx/USD alongside True Markets NVDAC-USDC and TSLAC-USDC. It does not import or start the live market maker. Both feeds are public; no account credentials are needed. The example uses the user-approved USD/USDC parity assumption (`fx.mode: "usd_parity"`). Its output is an observation or proposed quote record, never an exchange order.

## Run

From the feature worktree:

```bash
bun test tests/equity-shadow.test.ts tests/equity-feeds.test.ts tests/equity-recorder.test.ts tests/equity-review-loop.test.ts
bun scripts/run-equity-shadow.ts --config config/equity-shadow.example.json --duration-seconds 60 --out logs/equity-shadow/smoke
```

`--duration-seconds` defaults to 60 and accepts a positive value up to seven days. For a longer raw observation, use 86400 and a new output directory. SIGINT/SIGTERM stop the feeds, save status, and release the output lock. Concurrent collectors cannot share an output directory. Dead-owner lock recovery is serialized; an abandoned `collector.acquire` directory requires explicit inspection before removal.

The example uses explicit user-approved `mapping.mode: "market_parity"` and USD/USDC parity. It assumes one source unit equals one target token for research; this is not verified equivalence. Inventory remains unverified, so the example still suppresses proposals. Do not mark a mapping or inventory verified to make a smoke run pass. The sample tick/size/limit settings are illustrative research settings, not exchange-certified trading parameters.

## Enable research proposals with verified inputs

Copy the example to a separate configuration. For each symbol, document the source and target token contracts, underlying equity, dividend/split treatment and **the units in which the source price is quoted**. Set `sourceSharesPerToken` and `targetSharesPerToken` only after confirming those semantics. Populate `mapping.evidence`, `verifiedAt` (Unix milliseconds), and `verified:true`. These are operator attestations; the module does not independently validate the cited documents or refresh multipliers.

If a source quote is USD per source token, normalization is:

```text
ratio = target shares per token / source shares per token
target-token bid in USDC = source bid × ratio / USDC-USD ask
target-token ask in USDC = source ask × ratio / USDC-USD bid
In usd_parity mode both FX divisors are 1.
```

Some venues may present rebased/per-share prices. Verify that contract before choosing a multiplier. Kraken's `Assets` endpoint currently exposes `token_multiplier`; Coinbase's tokenized-stock endpoint exposes `multiplier`. Neither field alone proves price-unit equivalence or True Markets' exact contract mapping. Unknown values never default to one. Set `fx.mode` to `live` to use Kraken `USDC/USD` bid/ask rates. Missing FX configuration retains this live behavior for compatibility; live mode never falls back to parity. The example explicitly selects `usd_parity` at the user’s request: USD and USDC are treated as 1:1, no FX subscription or FX freshness check is required, and every evaluation records `currencyAssumption: "usd_parity"`. This is a research assumption, not a measured exchange rate.

Provide a verified, timestamped inventory snapshot. `availableQuote` is the capital allocated to **that symbol**, not a full account balance repeated for every symbol. Keep the sum of per-symbol allocations within the account's free quote balance. `availableBase` and `positionBase` limit selling to held tokens; there is no shorting or automatic balance refresh. An inventory snapshot expires according to `maxInventoryAgeMs`, so this version does not support unattended proposal generation from a static balance snapshot.

Use a new output directory when changing configuration; its hash prevents pooling evidence from different settings. The pure `evaluateShadow` API can also receive refreshed mappings/inventory from a future integration without changing network behavior.

## Safety and observations

- Both source and receive timestamps for the required market inputs must be fresh; transport heartbeats do not refresh a quote's age. Invalid, missing, crossed, out-of-order or disconnected data is invalidated or suppressed.
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

## Book observation and connection health

Each sample now retains `sourceHealth` and `targetHealth`: connection flag, last message time, `transportAlive`, quote problem, source quote age and receipt age. A heartbeat advances transport liveness only. It does not refresh a resting quote or change the existing freshness gate for proposals. These fields do not certify sequence-complete book synchronization.

The CLI additionally observes True Markets DEPTH and TRADE channels and appends raw `market_activity` events, including snapshot/update markers. Consumers must exclude trade snapshots from live execution counts. Depth updates are retained as received; this module does not assume undocumented replacement/deletion semantics or reconstruct an L2 book. Heartbeat receipt events are retained so connection activity can be inspected later.

`inputs.rawComparison` records numeric midpoint difference and spreads when both BBOs exist. It carries the currency assumption and freshness flag. These comparisons deliberately ignore unverified token conversion and are diagnostic only, never normalized fair value or executable arbitrage signals. `healthyMs` retains its stricter fresh-input definition; live-but-old quotes are visible separately rather than counted healthy.

## User-approved market parity

The user chose to assume the token tracks the underlying market 1:1 for research. `mapping.mode=market_parity` therefore uses ratio1 for price and size conversion and labels every evaluation `unitAssumption=market_parity`. Existing verification fields stay false. Omit the mode or set `verified` to require the prior documented, fresh unit mapping. This mode does not authorize live trading.

Market-parity research proposals still require verified current inventory, fresh/valid market inputs, active instruments, and all position/capital limits. `eligibleMs` excludes assumed-unit proposals so they cannot be presented as verified normalization evidence. Use a fresh output directory after changing configuration. Current Kraken source symbols remain in the example until a new stock data provider is selected and connected.
