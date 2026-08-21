# TrueX Market Maker - Architecture

> Generated from source code on 2026-06-18 (rev3). Source is the single source of truth.

## Overview

Automated BTC-PYUSD market maker on TrueX exchange using FIX protocol, with Coinbase price feed, additive TrueX EBBO and PYUSD/USD reference polling for shadow-take observation, balance-aware quoting, and a PostgreSQL data pipeline. Production runs on Hetzner-hosted Docker services and connects to TrueX over WireGuard-backed proxies.

---

## Component Diagram

```
+---------------------+       +---------------------+
|   Coinbase WS       |       |   Kraken REST       |
|  (BTC-USD ticker)   |       |  (hedge venue)      |
+--------+------------+       +--------+------------+
         |                              |
         v                              v
+--------+------------+       +--------+------------+
|  CoinbaseWsIngest   |       |   HedgeExecutor     |
|  (WebSocket feed)   |       |  limit-then-market   |
+--------+------------+       +--------+------------+
         |                              ^
         v                              |
+--------+------------+       +---------+-----------+
|  PriceAggregator    |       |  InventoryManager   |
|  weighted midpoint  +------>+  position, skew,    |
|  staleness, conf.   |       |  balance tracking   |
+--------+------------+       +---------+-----------+
         |                        ^     |
         v                        |     v
+--------+----------------------------+-+-----------+
|           MarketMakerOrchestrator                 |
|  - Wires all components                           |
|  - Routes FIX exec reports (35=8, 35=9)           |
|  - REST reconciliation (orphan/ghost detection)   |
|  - Periodic balance refresh                       |
+----+--------+---------+---------+-----------------+
     |        |         |         |
     v        v         v         v
+----+--+ +---+----+ +--+-----+ ++-----------+
|QuoteEn| |PnLTrack| |FIXConn | |DataPipeline|
|gine   | |er      | |ection  | |Manager     |
+---+---+ +--------+ +---+----+ +---+--------+
    |                     |          |
    |   FIX 35=D/35=F     |          |
    +---->  via rate   ----+          |
          limiter                     |
                                      v
                         +------------+-----------+
                         |  Memory -> Redis -> PG |
                         |  (3-tier pipeline)     |
                         +------------------------+
```

---

## Data Flow

```
Coinbase WS (BTC-USD)
    |
    v
CoinbaseWsIngest ---ticker---> PriceAggregator ---price event--->
    |
    v
QuoteEngine.onPriceUpdate(aggregatedPrice)
    |
    +-- confidence < threshold? --> cancelAllQuotes()
    +-- compute desired ladder (mid +/- spread +/- skew)
    +-- balance-aware size capping (_capSizeToBalance)
    +-- reconcileOrders (desired vs activeOrders)
    |       skip 'pending' and 'cancelling' orders
    +-- executeActions (rate-limited: cancels first, then replaces, then places)
            |
            +-- _sendNewOrder(quote) --> FIX 35=D (NewOrderSingle)
            +-- _sendCancel(origClOrdID) --> FIX 35=F (OrderCancelRequest)
                    |
                    v
            FIXConnection.sendMessage() --> TCP socket --> Hetzner proxy --> TrueX
                    |
                    v  (inbound)
            FIX 35=8 (ExecutionReport) --> Orchestrator._onFIXMessage()
                +-- ordStatus=A: pending_new
                +-- ordStatus=0: new (accepted) --> activeOrders status='active'
                +-- ordStatus=1: partial_fill --> emit 'fill'
                +-- ordStatus=2: filled --> emit 'fill', remove from activeOrders
                +-- ordStatus=4: cancelled --> remove from activeOrders
                +-- ordStatus=8: rejected --> consecutiveRejects++, backoff after 3
            FIX 35=9 (OrderCancelReject) --> QuoteEngine.onOrderCancelReject()
                +-- CxlRejReason=1: unknown order --> remove from tracking
                +-- else: restore original order to 'active'
                    |
                    v
            Orchestrator._onQuoteFill() -->
                +-- InventoryManager.onFill() (position + balance tracking)
                +-- PnLTracker.onFill() (FIFO spread PnL + cash-flow tracking, fee accounting)
                +-- DataPipelineManager.addFill() (audit + persistence)
                    |
                    v
            InventoryManager emits 'hedge-signal' if |position| >= hedgeThresholdBTC
                    |
                    v
            HedgeExecutor.executeHedge() --> Kraken REST API
```

---

## Deployment Topology

```
+---------------------------------------------+
|  Hetzner: truex-mm-prod (178.156.230.110)   |
|  Docker containers (network_mode: host)      |
|                                              |
|  +------------------+  +-----------------+  |
|  | truex-fix-proxy  |  | truex-md-proxy  |  |
|  | :3004 → WG →     |  | :3005 → WG →    |  |
|  | 10.20.6.11:19484 |  | 10.20.6.11:20484|  |
|  +------------------+  +-----------------+  |
|                                              |
|  +------------------+                        |
|  | truex-market-    |                        |
|  | maker            |  FIX → 127.0.0.1:3004 |
|  |                  |  REST → 10.20.6.11:9742| ---WireGuard VPN---> TrueX Production
|  |  Coinbase WS ----+---> coinbase.com       |                     (10.20.6.11)
|  +--------+---------+                        |
|           |  logs                            |
|  +--------+---------+  +----------------+   |
|  | truex-log-       |  | truex-redis    |   |
|  | exporter         |  | 127.0.0.1:6379 |   |
|  | → Mech Storage   |  | 256MB AOF      |   |
|  +------------------+  +----------------+   |
+---------------------------------------------+
          |
          | DATABASE_URL (postgresql://truex_mm@...)
          v
+---------------------------------------------+
|  Hetzner: truex-pg-analytics (178.156.247.87)|
|  PostgreSQL 14 — db: truex_analytics         |
|  tables: sessions, orders, fills, ohlc       |
|  access: whitelisted from 178.156.230.110    |
+---------------------------------------------+
```

### Key Deployment Notes

- All production components run **on Hetzner** in Docker (`network_mode: host`)
- The market maker connects to TrueX FIX via `truex-fix-proxy` at `127.0.0.1:3004`, which forwards over **WireGuard VPN** to `10.20.6.11:19484`
- REST calls go **direct over WireGuard** to `http://10.20.6.11:9742` — no REST proxy needed from inside Hetzner
- Coinbase WebSocket connects **directly** from the market maker container
- Redis runs **locally** on `truex-mm-prod` at `127.0.0.1:6379` (not externally accessible)
- PostgreSQL runs on a **dedicated Hetzner server** `truex-pg-analytics` at `178.156.247.87:5432/truex_analytics`
- `truex-log-exporter` reads the log file via shared Docker volume and ships new lines to Mech Storage every 5 minutes
- Redis is **required** in production; pipeline falls back to direct PG flush every 5s if Redis is unavailable

---

## Core Components

### MarketMakerOrchestrator (`src/core/market-maker-orchestrator.js`)

Central coordinator that wires all components and manages the system lifecycle.

**Startup sequence:**
1. Wire event handlers (price, FIX, fills, hedges, emergencies)
2. Fetch account balances via REST (mandatory when REST client configured)
3. Reconcile exchange orders and capital via REST; fail startup before FIX if the snapshot or orphan cancellation fails
4. Connect FIX OE
5. Connect market data feed (optional, non-blocking)
6. Start data pipeline (optional, non-blocking)
7. Start PnL periodic logging
8. Start quote engine drain queue timer (every 200ms)
9. Start REST reconciliation timer (every 5 minutes)
10. Start balance refresh timer (every 60 seconds)

**Shutdown sequence:**
1. Cancel all active quotes
2. Hedge remaining position (if above minHedgeSizeBTC)
3. Stop all timers
4. Stop data pipeline (flush remaining data)
5. Disconnect market data feed
6. Disconnect FIX OE
7. Log final PnL session report

**Events emitted:** `started`, `stopped`, `fill`, `hedge`, `error`, `emergency`, `reconcile`

### QuoteEngine (`src/core/quote-engine.js`)

Computes bid/ask ladder quotes with inventory skew, manages order lifecycle through FIX, and enforces rate limits.

**Quote computation:**
- N levels per side (configurable, default 5 for UAT, 2 for prod — per TrueX exchange request)
- Half-spread from mid: `(baseSpreadBps / 10000) * mid / 2`
- Level offset: either tick-based (`level * levelSpacingTicks * tickSize`) or randomized bps ladder
- Inventory skew applied from InventoryManager: widens the side that would move inventory farther from its configured target and tightens the reducing side
- Balance-aware size capping: each level's size is capped to remaining available balance minus already-committed amounts from prior levels
- Prices snapped to tick grid (`Math.round(price / tickSize) * tickSize`)
- Price band filter: reject quotes outside +/- `priceBandPct` from mid

**Order reconciliation:**
- Match desired quotes against active orders by side + level
- Skip orders in `pending` or `cancelling` status (wait for confirmation)
- Reprice if price difference >= `repriceThresholdTicks`
- Cancel unmatched active orders (orphans in local state)
- Default replacement mode is `passive-safe`: cancel the old quote first, hold the replacement as pending, then release it only after the cancel ack. `replaceMode='place-before-cancel'` is available only as an explicit legacy override.
- Pending replacements expire after `pendingReplacementTimeoutMs` and are reported in quote status as suppressed levels.
- Rate limited: `maxOrdersPerSecond` (prod 6), overflow queued. Queued placements and pending replacement releases are rechecked immediately before FIX send.

**TrueX book and ALO safety:**
- Production maker sends use the REST-polled `truexEbbo` as their sole venue marketability
  authority. Coinbase remains the pricing anchor; it is not venue marketability evidence.
- Missing, stale, crossed, or invalid TrueX EBBO suppresses new and replacement `D` messages while
  pure cancels and acknowledged live quotes remain untouched.
- Freshness is measured from the locally stamped REST receipt time; the venue source timestamp is
  retained and must not be later than receipt. The max age is constrained to one-to-three EBBO
  poll intervals, so an unchanged but currently observed book stays usable and a stopped poll
  fails closed promptly.
- `TRUEX_MAKER_MARKETABLE_ACTION=skip` withholds a marketable ALO. `slide` moves it one tick away
  from the TrueX opposite touch and reruns self-cross and capital checks; use `slide` only after an
  evidence-backed canary because it changes quote economics.
- An unsolicited `ALO would trade` cancellation inhibits an identical side/price retry until the
  relevant TrueX touch changes or `TRUEX_ALO_RETRY_COOLDOWN_MS` expires. The cache is bounded by
  `TRUEX_ALO_RETRY_MAX_ENTRIES`.
  Cooldown is bounded to one-to-sixty poll intervals, and cache capacity must cover the configured
  maximum send rate for the full cooldown window.

**FIX messages sent:**
- New Order Single (`35=D`): tags 11, 18 (ALO, omitted only for intentional taker orders), 55, 54, 38, 44, 40=2 (Limit), 59=1 (GTC), Party ID block (453/448/452)
- Order Cancel Request (`35=F`): tags 11, 41, Party ID block. No tag 54 (Side).

**Optional taker path:**
- `allowTakerOrders=false` by default; no aggressive order is sent unless this is explicitly enabled.
- Taker-intent orders omit tag `18=6` and require explicit `fairValue` and execution price inputs.
- Post-fee edge is `grossEdgeBps - truexTakerFeeBps - takeSlippageBufferBps - takeHedgeBufferBps`; it must be at least `minTakeEdgeBps`.
- `maxTakerOrdersPerMinute` and `maxTakerNotionalPerMinute` enforce minute-window taker budgets when set to positive values.
- Active orders and fills carry `orderIntent`, `liquidityRoleExpected`, and final `isMaker`; orchestrator forwards `isMaker=false` taker fills to PnL and audit/data records.

**Shadow observe-only path:**
- `shadowTakeMode` defaults false in engine/orchestrator constructors, but production wiring enables it explicitly in `scripts/run-prod.js`.
- When `shadowTakeMode=true`, `evaluateShadowTake()` still runs, but `_prepareTakerQuote()` returns `null` before `allowTakerOrders` is checked, making the send path unreachable.
- Detection uses additive `truexEbbo`, Kraken `pyusdUsd`, and cached TrueX public trade tape; it logs `would-take`, `shadow-basis-sample`, and attribution records under `[SHADOW]`.
- **Tape-freshness gate is split detection vs send** (2026-07-23): the single `truexTapeMaxAgeMs` (5000ms) suppressed ~94% of evaluations as `truex-tape-stale` on the illiquid BTC-PYUSD book (trades print < every 5s), starving the Phase-2 analyzer of would-takes. Detection now uses a looser `shadowDetectionTapeMaxAgeMs` (30000ms) so edge-quality data is logged; `truexTapeMaxAgeMs` (5000ms) is reserved as the strict send-side re-check for when `allowTakerOrders` is enabled. Both are env-tunable in `scripts/run-prod.js`: `SHADOW_DETECTION_TAPE_MAX_AGE_MS` / `SHADOW_SEND_TAPE_MAX_AGE_MS`.
- **SuppressReason split** (2026-07-24): the trade-tape gate has two independent suppression origins, emitted as distinct `suppressReason` strings so prod logs can tell them apart: `truex-tape-missing` (tape null / `latestTradeTs` null — quiet book, `getMarketTrades` empty) vs `truex-tape-stale` (tape present but older than `shadowDetectionTapeMaxAgeMs`). A separate `truex-ebbo-stale` and `basis-stale` also suppress. `analyze-shadow-takes.js` treats all four as non-evaluable; the orchestrator treats them as non-detection-eligible for the zero-detection alert.
- `scripts/analyze-shadow-takes.js` consumes those logs and emits the pinned Phase-2 `GO | HOLD | ABORT` recommendation.

**Rejection handling:**
- `consecutiveRejects` counter, backoff for 5 seconds after 3+ consecutive rejects
- Cancel-reject with CxlRejReason=1 (unknown order): remove from tracking
- Cancel-reject with other reasons: restore original order to `active` status

**Cancel tracking:** `cancelToOrigMap` maps cancel ClOrdID to original ClOrdID for matching cancel acks back to active orders.

### InventoryManager (`src/core/inventory-manager.js`)

Tracks net position, computes quote skew, enforces position limits, and manages balance tracking.

**Position tracking:**
- `netPosition`: running net (+ for long, - for short)
- VWAP entry price: separate buy/sell cost tracking
- Fill counters: totalBought, totalSold, fillCount

**Balance tracking:**
- Initialized once at startup from REST API (`initializeFromBalances`)
- Updated on each fill (buy: +BTC/-PYUSD, sell: -BTC/+PYUSD)
- Periodic refresh from exchange every 60s (`refreshBalances`) -- does NOT reset netPosition/VWAP
- Negative balance clamped to 0 with warning (corrected on next refresh)

**Skew computation:**
- `targetInventoryBTC` is the BTC operating allocation, not a position limit. It defaults to `0`, preserving the historical neutral target when omitted.
- `inventoryDeviationBTC = netPosition - targetInventoryBTC`. Positive deviation (above target) widens bids and tightens asks, encouraging inventory reduction. Negative deviation (below target) tightens bids and widens asks, encouraging inventory rebuilding.
- `deviationUtilizationPct = min(1, |inventoryDeviationBTC| / maxPositionBTC)` and `rawSkew = deviationUtilizationPct^skewExponent * maxSkewTicks`. The clamp makes `maxSkewTicks` a true cap even when a nonzero target makes deviation exceed the absolute position band.
- Absolute position limits, emergency checks, hedge thresholds, and balance caps remain based on `netPosition`; changing the target does not change those guards.
- Startup balance initialization logs the configured target and initial deviation. Runtime status exposes `targetInventoryBTC`, `inventoryDeviationBTC`, and whether position is above, below, or at target. Quote lifecycle and reference mark-out telemetry are additive observability paths and do not alter inventory controls.

**Events emitted:** `fill`, `limit-warning` (at 80% utilization), `emergency` (at emergencyLimitBTC), `hedge-signal`

### PnLTracker (`src/core/pnl-tracker.js`)

FIFO-based PnL tracking with cash-flow accounting, mark-to-market, and per-venue fee tracking.

**FIFO spread PnL** (accurate for round-trip market making):
- `realizedPnL`: FIFO-matched spread on completed buy+sell round-trips. Shows $0 for sell-only accounts (no matched pairs).
- `unrealizedPnL`: mark-to-market of unmatched fills against current mid using cost-basis: `netPosition * (mid - avgCost)`

**Cash-flow tracking** (accurate for sell-heavy / inventory-liquidation accounts):
- `sellProceeds`: total quote received from all sells
- `buyCost`: total quote spent on all buys
- `netCashFlow = sellProceeds - buyCost`: net PYUSD generated from trading

**Other:**
- `buyCount` / `sellCount`: per-side fill counters
- Fill validation: `onFill` rejects any `side` value other than `buy` or `sell` (warns and skips)
- Fee tracking: per-venue (truex, hedge), maker vs taker, configurable via env vars in basis points
- Periodic logging: every `logIntervalMs` (default 30s)
- Significant change detection: emits `significantChange` when delta >= `significantPnlChange` (default $100)

**`getSummary()` fields:** `realizedPnL`, `unrealizedPnL`, `totalPnL`, `totalFees`, `sellProceeds`, `buyCost`, `netCashFlow`, `netPosition`, `numTrades`, `buyCount`, `sellCount`, `avgSpreadCapture`, `totalMatchedQuantity`, `feesByVenue`, `makerFees`, `takerFees`

### HedgeExecutor (`src/core/hedge-executor.js`)

Offloads excess inventory to Kraken using limit-then-market strategy.

- Limit order placed with aggressive pricing (crosses spread by `limitPriceOffsetBps`)
- Polls for fill within `limitTimeoutMs` (default 5s)
- Falls back to market order if limit times out
- Urgent hedges go straight to market
- Size clamped between `minHedgeSizeBTC` (0.001) and `maxHedgeSizeBTC` (1.0)
- Single concurrent hedge enforced

**Events emitted:** `hedge-placed`, `hedge-filled`, `hedge-timeout`, `hedge-failed`, `hedge-cancelled`

### PriceAggregator (`src/connectors/aggregator/PriceAggregator.ts`)

Combines price feeds from multiple exchanges with weighted averaging and staleness detection.

- Default weights: coinbase=0.5, kraken=0.3, gemini=0.2
- Production uses single source: coinbase=1.0
- Staleness threshold: 5s (10s in prod/UAT scripts)
- Confidence: `min(activeFeeds / 3, 1)` -- 3 non-stale feeds = 100%
- Best bid/ask tracked across all venues
- Emits `price` event on every ticker/orderbook update

### FIXConnection (`src/fix-protocol/fix-connection.js`)

FIX 5.0 SP2 over FIXT.1.1 transport layer.

- HMAC-SHA256 authentication (base64 signature)
- Signature payload: `sendingTime + msgType + msgSeqNum + senderCompID + targetCompID + username`
- ResetSeqNumFlag=Y on logon (fresh sequence numbers each session)
- Heartbeat interval: 30s (configurable)
- Automatic reconnection with exponential backoff (1s initial, 30s max, 10 attempts)
- Message storage for resend requests (max 10,000 messages, 1h retention)
- Periodic message cleanup every 5 minutes
- Strict FIX field ordering enforced (header fields first, then body fields)
- Sensitive tags (553/554) redacted in logs
- 2-second delay after TCP connect for proxy connection establishment
- Connection attempts are generation-guarded so stale socket callbacks, delayed logon setup, and timeout handlers cannot mutate a newer connection.
- Duplicate-logon rejects containing `Already authenticated` emit `duplicate-logon`, tear down only the attempted socket, and schedule reconnect through the normal lifecycle.
- Repeated unresolved sequence gaps force a session reset: local and Redis sequence counters are cleared, next logon uses `141=Y` with `34=1`, and reconnect is scheduled once.
- Inbound SequenceReset-GapFill (`35=4`, `123=Y`) advances `expectedSeqNum` without emitting application messages or looping resend requests.

### DataPipelineManager (`src/data-pipeline/data-pipeline-manager.js`)

3-tier data persistence pipeline.

**Tiers:**
| Layer | Component | Latency | Flush Interval |
|-------|-----------|---------|----------------|
| 0 | AuditLogger (append-only JSONL) | Synchronous | Immediate |
| 1 | TrueXDataManager (in-memory cache) | <1ms | N/A |
| 2 | TrueXRedisManager (Redis) | ~1ms | Every 1s |
| 3 | TrueXPostgreSQLManager (PostgreSQL) | ~5ms | Every 5min (via Redis) or 5s (direct) |

**Auto-failover:** If Redis becomes unreachable, automatically switches to direct Memory-to-PostgreSQL flush every 5 seconds. Session tracking (start/stop records) saved to PostgreSQL.

**Memory cleanup:** Old completed orders evicted every 30 minutes.

**Storage targets (production):**
- Redis: `127.0.0.1:6379` (local to `truex-mm-prod`)
- PostgreSQL: `178.156.247.87:5432/truex_analytics` (Hetzner `truex-pg-analytics` server)

### Quote lifecycle telemetry (`src/data-pipeline/quote-lifecycle-telemetry.js`)

The quote engine emits an immutable, versioned event for create/replace, cancel,
reject, partial fill, and full fill lifecycle transitions. Each event has a stable
quote ID; replacement creates use a new quote ID with `replacesQuoteId` pointing to
the prior quote. The orchestrator enriches events at decision time with policy ID,
target and deviation, committed exposure, and available Coinbase/TrueX EBBO,
fair-value, freshness, and volatility context. Unavailable values are explicit
`null`; credentials and account identifiers are allowlist-redacted.

When the optional data pipeline has initialized PostgreSQL, telemetry writes
append-only rows to `quote_lifecycle_events`. The table is additive (it does not
alter historical orders or fills), has time/session/quote indexes, bounded query
helpers, and an explicit prune helper for retention operations. A write failure is
non-fatal and releases the in-process dedupe marker for retry. This records inputs
for later markout, fill-probability, and P&L evaluation; it does not calculate or
change a live policy.

### Reference mark-out evidence (`src/data-pipeline/reference-markout-collector.js`)

The promotion path consumes an isolated, default-off Crypto.com `BTC_PYUSD` public-book
snapshot feed. It is wired only into `ReferenceMarkoutCollector`; pricing and execution continue
to consume Coinbase/TrueX paths unchanged. Durable direct-source provenance includes `t`, `tt`,
local receipt, sequence, connection generation, and process-session identity.

Reference collection is a separate, observability-only path gated by
`REFERENCE_MARKOUT_ENABLED` (default `false`). When enabled, create/replace decisions and
fills schedule durable 1/5/60-minute work. At the one-second cadence, the collector stores
point-in-time Crypto.com BTC_PYUSD full-book observations only while an unfinished horizon window
is open. Promotion-grade direct evidence requires the exact endpoint, channel, instrument, depth,
publication/receipt/observation ordering, canonical book hash, sequence, connection generation,
and process-session identity. Legacy Coinbase observations with Kraken PreTrade PYUSD/USD basis
remain readable diagnostic evidence but cannot satisfy the v4 direct selector. The earliest valid
observation at or after each horizon is claimed with an
overlap-safe lease and persisted as immutable evidence; missing or invalid evidence is terminally
classified after the configured lateness window.

PostgreSQL stores decisions, sampled observations, pending work, and terminal evidence in four
additive tables. Claims use `FOR UPDATE ... SKIP LOCKED`, expired leases are recoverable after
restart, and retention cannot delete samples needed by unfinished work. Selector and retention
indexes are aligned to observation and receipt time respectively. The bounded coverage audit is
available through `bun scripts/report-reference-markout-coverage.js`; full operating and rollout
instructions are in [REFERENCE_MARKOUTS.md](REFERENCE_MARKOUTS.md).

Reference writes use separate bounded FIFO decision and priority fill lanes and bounded PostgreSQL lock, statement, pool
acquisition, and protocol-step timeouts. Retention runs on an independent timer with bounded batch,
total-duration, and yield controls; it never runs in the due-work sampling/claim cycle.
Collector and persistence failures are logged and counted but never block, cancel, resize,
reprice, or dispatch an order. The feature changes no strategy parameters and cannot authorize a
candidate produced by the offline regime validator.

The authenticated `GET /api/status` snapshot exposes `referenceMarkouts` as `null` while disabled.
When enabled it exposes the collector's running state, safe source/horizon identity, cycle and
persisted-observation counters, open-window/sampling state, queue/pool pressure, query latency,
invalid-sample reasons, retention backlog, last cycle/observation timestamps, and a sanitized last
persistence error reason/time. Idle zero-observation state is healthy when no window is open. These
fields are observability only and do not participate in top-level health classification. Production
enablement remains a separate operational canary decision after source-soak, database-plan, and
maker-isolation gates; see [REFERENCE_MARKOUTS.md](REFERENCE_MARKOUTS.md).

### TrueXRESTClient (`src/exchanges/truex/TrueXRESTClient.ts`)

REST API client for TrueX with HMAC-SHA256 authentication.

**Authentication:**
- Headers: `x-truex-auth-token`, `x-truex-auth-signature`, `x-truex-auth-timestamp`, `x-truex-auth-userid`
- Signature: HMAC-SHA256 base64 of `${timestamp}${METHOD}/api/v1${path}${body}`
- Query strings excluded from signature
- Timeout: 30s (configurable)

**Endpoints used:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/asset` | Asset lookup (returns `{ id, status, fields: { name } }`) |
| GET | `/instrument` | Instrument resolution |
| GET | `/market/quote` | EBBO (best bid/offer) |
| GET | `/client` | Client details |
| PATCH | `/client` | Update settings (e.g., `cancel_on_disconnect`) |
| GET | `/balance` | Account balances (returns `{ balance, order_hold, transfer_hold, unsettled }`) |
| GET | `/order/active` | Active orders |
| GET | `/order/status/:refId` | Order status by ID |
| GET | `/order` | Historical orders (last 24h) |
| GET | `/order/trade` | Trade history |
| POST | `/order` | Create order |
| PATCH | `/order` | Modify order |
| DELETE | `/order/:refId` | Cancel order |

**Balance normalization:** Raw API returns `{ balance, order_hold, transfer_hold, unsettled }`. Client computes `available = balance - order_hold - transfer_hold` and `total = balance`.

**Asset name resolution:** Cached after first call. `/asset` endpoint returns `{ id, fields: { name } }`. Hardcoded fallback mapping for known production assets (USD, PYUSD, BTC).

**Order types supported:**
- TimeInForce: GTC (`59=1`), IOC (`59=3`). No GTD/TTL.
- Execution instruction: ALO (Add Liquidity Only / post-only)
- Self-trade protection: NONE, CANCEL_AGGRESSIVE, CANCEL_BOTH

### LogExporter (`scripts/log-exporter.js`)

Ships market-maker log lines to Mech Storage on a rolling cadence.

- Reads `LOG_FILE` (default `/app/logs/market-maker.log`) from shared Docker volume
- Tracks byte position via cursor file (`market-maker.log.cursor`) — never re-uploads
- Uploads new lines every `EXPORT_INTERVAL_MS` (default 5 minutes)
- Filename: `truex-mm-YYYY-MM-DD-HHmm.log` per export chunk
- Final flush on SIGTERM before exit

**Required env:** `MECH_APP_ID`, `MECH_API_KEY`
**Optional:** `MECH_STORAGE_URL` (default: `https://storage.mechdna.net`), `EXPORT_INTERVAL_MS`

---

### Analytics API (`src/api/server.js`)

PostgreSQL-backed analytics server using `Bun.serve()` on port 3100.

**Endpoints:**
| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/health` | Database connectivity + latency |
| `GET /api/v1/stats` | Aggregate counts (sessions, orders, fills) |
| `GET /api/v1/sessions` | List sessions (pagination, time range, status filter) |
| `GET /api/v1/sessions/:id` | Single session detail |
| `GET /api/v1/sessions/:id/orders` | Orders for session |
| `GET /api/v1/sessions/:id/fills` | Fills for session |
| `GET /api/v1/orders` | All orders (pagination, filters) |
| `GET /api/v1/fills` | All fills (pagination, filters) |
| `GET /api/v1/analytics/pnl` | Time-bucketed PnL (intervals: 1m, 5m, 15m, 1h, 1d) |
| `GET /api/v1/analytics/fill-rate` | Fill rate by session/side |
| `GET /api/v1/analytics/spread-capture` | FIFO-matched spread capture per pair |
| `GET /api/v1/analytics/adverse-selection` | Post-fill price impact (1s, 5s, 30s, 60s) |
| `GET /api/v1/analytics/inventory` | Position time series with running net |
| `GET /api/v1/analytics/parameters` | Session parameters + performance summary |

---

## Environment Variables

### Production

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TRUEX_PROD_API_KEY` | Yes | -- | TrueX production API key (FIX tag 553) |
| `TRUEX_PROD_SECRET_KEY` | Yes | -- | TrueX production secret for HMAC-SHA256 |
| `TRUEX_CLIENT_ID` | Yes | `78932725357888855` | Production client ID (FIX PartyID tag 448) |
| `TRUEX_FIX_HOST` | Yes | `178.156.230.110` | Hetzner FIX proxy host |
| `TRUEX_FIX_PORT` | Yes | `3004` | Hetzner FIX proxy port |
| `FIX_HEARTBEAT_INTERVAL` | No | `30` | FIX HeartBtInt seconds; validated integer in `[1,300]` |
| `FIX_TEST_REQUEST_IDLE_MULTIPLIER` | No | `1.2` | Send one correlated TestRequest after this multiple of HeartBtInt without a structurally valid inbound FIX frame; validated in `(1,3]` |
| `FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER` | No | `1` | Disconnect if the correlated Heartbeat is absent for this multiple of HeartBtInt after probe dispatch began; validated in `(0,3]` and the derived response window must be at least 1000ms |
| `FIX_LIVENESS_MAX_DETECTION_SECONDS` | No | `120` | Fail-closed absolute ceiling for `HeartBtInt × (idle multiplier + timeout multiplier)`; validated integer in `[2,120]` |
| `TRUEX_PROD_HOST` | No | `10.20.6.11` | TrueX production internal IP (reachable via WireGuard tunnel). Substituted into `TRUEX_UPSTREAM_HOST` for both FIX proxies and `TRUEX_REST_URL` in `docker-compose.prod.yml`. WireGuard `AllowedIPs` must include this `/32`. If TrueX migrates the endpoint, update this var **and** add the new `/32` to `/etc/wireguard/truemarkets.conf`. Empty string does not fall back to default — keep populated or unset. |
| `TRUEX_REST_URL` | No | `http://10.20.6.11:9742` | TrueX REST URL — derived from `TRUEX_PROD_HOST` by `docker-compose.prod.yml`. Override only when accessing from outside Hetzner (e.g. `http://178.156.230.110:3006` socat tunnel for local development). |
| `TRUEX_TARGET_COMP_ID` | No | `TRUEX_PROD_OE` | FIX TargetCompID |
| `TRUEX_INSTRUMENT_ID` | Yes | -- | Exact TrueX REST `order_info.instrument_id`, commonly numeric—not the FIX symbol. Resolve it from the venue; clearly foreign instruments are ignored and never cancelled. |
| `TRUEX_ORDER_ID_NAMESPACE` | Yes | -- | Operator-chosen, stable, account-unique 4-6 character URL-safe maker namespace; there is deliberately no shared default. Keep it unchanged across restarts. Generated IDs add a random 5-character boot segment and 6-character monotonic sequence while retaining this recognizable namespace; same-instrument orders from other namespaces are ignored. |
| `TRUEX_SENDER_COMP_ID` | No | `DAVID1` | FIX SenderCompID |
| `TRUEX_STARTUP_CANCEL_VERIFY_TIMEOUT_MS` | No | `30000` | Maximum positive-integer milliseconds to wait for pre-existing `CANCEL_PENDING` orders to become terminal or disappear before startup fails |
| `TRUEX_STARTUP_CANCEL_VERIFY_INTERVAL_MS` | No | `500` | Positive-integer REST polling interval during strict startup cancel verification; must not exceed the timeout |
| `DATABASE_URL` | No | -- | PostgreSQL connection string (Hetzner truex-pg-analytics 178.156.247.87:5432/truex_analytics) |
| `REDIS_URL` | No | -- | Redis connection string (optional, auto-fallback) |
| `REFERENCE_MARKOUT_ENABLED` | No | `false` | Explicitly enable restart-safe 1/5/60-minute reference collection; keep false for the inert rollout stage |
| `REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST` | When enabled | -- | Explicit Kraken PreTrade venue identity/identities accepted for promotion-grade basis evidence; deliberately no shared MIC default |
| `REFERENCE_MARKOUT_MAX_BASIS_RTT_MS` | No | `1000` | Maximum PreTrade request-to-receipt duration; bounded by source freshness and poll timeout |
| `MM_MIN_ACTIVE_LEVELS_PER_SIDE` | Yes | -- | Minimum distinct acknowledged and funded quote levels required on each side; cannot exceed normal quote levels |
| `MM_MIN_FUNDED_QUOTE_SIZE_BTC` | Yes | -- | Smallest BTC quote size that counts toward maker presence |
| `MM_L1_RESERVE_BASE_BTC` | Yes | -- | Base-asset capital reserved for the sell-side L1 obligation |
| `MM_L1_RESERVE_QUOTE_PYUSD` | Yes | -- | Quote-asset capital reserved for the buy-side L1 obligation |
| `MM_MAX_SIDE_GAP_MS` | Yes | -- | Maximum permitted duration without the configured acknowledged levels on either side |
| `MM_SIDE_GAP_ALERT_THRESHOLD_MS` | Yes | -- | Side-gap duration that raises an alert; must not exceed `MM_MAX_SIDE_GAP_MS` |
| `MM_SIDE_GAP_ALERT_RATE_LIMIT_MS` | Yes | -- | Minimum interval between repeated side-gap alerts |
| `MM_DEGRADED_MAX_LEVELS` | Yes | -- | Maximum levels per side in degraded mode; must be below normal depth and at least the presence obligation |
| `MM_DEGRADED_SIZE_FACTOR` | Yes | -- | Degraded-mode size multiplier in `(0,1)`; scaled L1 must remain at least the funded minimum |
| `MM_DEFENSIVE_SPREAD_FLOOR_BPS` | Yes | -- | Minimum degraded-mode spread; must be wider than the normal base spread |
| `MM_PRESENCE_RECOVERY_ENABLED` | No | `false` | Opt in to bounded coherent REST reconciliation after a prolonged one-sided maker gap |
| `MM_PRESENCE_RECOVERY_COOLDOWN_MS` | No | `60000` | Minimum delay between recovery attempts |
| `MM_PRESENCE_RECOVERY_ATTEMPT_WINDOW_MS` | No | `3600000` | Rolling attempt-budget window |
| `MM_PRESENCE_RECOVERY_MAX_ATTEMPTS` | No | `3` | Maximum recovery attempts in the rolling window |
| `MM_PRESENCE_RECOVERY_REARM_TIMEOUT_MS` | No | `30000` | Time allowed for acknowledged two-sided presence to return after reconciliation |
| `INVENTORY_REBALANCE_SHADOW_ENABLED` | No | `true` | Emit observe-only bell-curve inventory guidance; never changes or sends orders |
| `INVENTORY_REBALANCE_SHADOW_INTERVAL_MS` | No | `5000` | Minimum interval between shadow policy samples |
| `INVENTORY_REBALANCE_TARGET_BTC` | No | `0.014` | Shadow policy inventory center |
| `INVENTORY_REBALANCE_SIGMA_BTC` | No | target / 3 | Shadow policy inventory standard deviation |
| `INVENTORY_REBALANCE_CENTER_BAND_SIGMA` | No | `0.5` | Boundary of the normal spread-capture zone |
| `INVENTORY_REBALANCE_SOFT_BAND_SIGMA` | No | `2` | Start of shadow external-rebalance intent |
| `INVENTORY_REBALANCE_HARD_BAND_SIGMA` | No | `3` | Full shadow external-rebalance intensity |
| `INVENTORY_REBALANCE_MAKER_FLOOR` | No | `0.25` | Minimum shadow maker-participation recommendation |
| `INVENTORY_REBALANCE_MAX_SIZE_ASYMMETRY` | No | `0.75` | Maximum shadow bid/ask size asymmetry |
| `INVENTORY_REBALANCE_MAX_QUOTE_SKEW_BPS` | No | `10` | Maximum shadow quote-skew recommendation |
| `TRUEX_MAKER_FEE_BPS` | No | `0` | TrueX maker fee in basis points |
| `TRUEX_TAKER_FEE_BPS` | No | `0` | TrueX taker fee in basis points |
| `HEDGE_MAKER_FEE_BPS` | No | `0` | Hedge venue maker fee in basis points |
| `HEDGE_TAKER_FEE_BPS` | No | `0` | Hedge venue taker fee in basis points |
| `LOG_LEVEL` | No | `info` | Log level (`info` or `debug`) |
| `TRUEX_DEBUG_MODE` | No | -- | Set to `true` to log raw FIX messages |

The ten `MM_*` continuity settings are deliberately required and have no runtime defaults. Copy
their non-secret examples from `.env.example`, then validate reserves and thresholds against the
funded account and current quote depth/size/spread. `docker-compose.prod.yml` fails during Compose
resolution when any setting is absent, before the market-maker container is recreated.

### UAT

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TRUEX_API_KEY` | Yes | -- | TrueX UAT API key |
| `TRUEX_SECRET_KEY` | Yes | -- | TrueX UAT secret |
| `TRUEX_CLIENT_ID` | No | `78972918929686546` | UAT client ID (DAVID1) |
| `TRUEX_FIX_HOST` | No | `38.32.101.229` | TrueX UAT host (direct) |
| `TRUEX_FIX_PORT` | No | `19484` | TrueX UAT FIX port |
| `TRUEX_REST_URL` | No | `http://38.32.101.229:9742` | TrueX UAT REST URL |
| `TRUEX_SENDER_COMP_ID` | No | `DAVID1` | FIX SenderCompID |
| `TRUEX_TARGET_COMP_ID` | No | `TRUEX_UAT_OE` | FIX TargetCompID |
| `DATABASE_URL` | No | -- | PostgreSQL connection string |
| `REDIS_URL` | No | -- | Redis connection string |
| `TRUEX_MAKER_FEE_BPS` | No | `0` | Maker fee bps (parsed via `parseFee()` with NaN guard, range 0-500) |
| `TRUEX_TAKER_FEE_BPS` | No | `0` | Taker fee bps |
| `HEDGE_MAKER_FEE_BPS` | No | `0` | Hedge maker fee bps |
| `HEDGE_TAKER_FEE_BPS` | No | `0` | Hedge taker fee bps |
| `LOG_LEVEL` | No | `info` | Log level |

### Analytics API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string |
| `API_PORT` | No | `3100` | Analytics API listen port |
| `CORS_ORIGIN` | No | `*` | CORS allowed origin |

---

## Security

### Authentication

- **FIX**: HMAC-SHA256 signature in Logon message (tag 554). Payload: `sendingTime + msgType + msgSeqNum + senderCompID + targetCompID + username`. Signature encoded as **base64**.
- **REST**: HMAC-SHA256 signature in `x-truex-auth-signature` header. Payload: `${timestamp}${METHOD}/api/v1${path}${body}`. Signature encoded as **base64**. Query strings are excluded from the signature.
- Credentials (API key, secret) loaded from environment variables, never hardcoded.
- FIX tags 553 (Username) and 554 (Password/signature) are redacted in all logs.

### Network Security

- All TrueX production traffic tunneled through WireGuard VPN via Hetzner proxy
- FIX proxy runs in Docker with `network_mode: host`
- REST connects directly to TrueX via WireGuard (no proxy needed inside Hetzner)
- Coinbase WebSocket uses public WSS endpoint (TLS)
- PostgreSQL connection via `DATABASE_URL` (Hetzner truex-pg-analytics, same private network)

### Operational Safety

- Production startup validates all required env vars and refuses to start with UAT TargetCompID
- Orphaned orders from previous sessions cancelled via REST before quoting begins
- Emergency position limit (`emergencyLimitBTC`) triggers immediate cancel-all
- Balance initialization is mandatory when REST client is configured -- system will not start without balance data
- `parseFee()` guards against NaN and out-of-range values (0-500 bps)
- Error responses from the Analytics API do not leak internal details

---

## Docker

### Dockerfile (`Dockerfile`)

- Base image: Bun 1.3.3 Alpine pinned to a reviewed multi-architecture digest
- Non-root user (`nodejs:1001`)
- Production JavaScript dependencies installed from checked-in `bun.lock` with frozen resolution (`bun install --production --frozen-lockfile`)
- Alpine packages remain resolved by `apk` at build time and are outside the JavaScript/base-image pinning guarantee
- Health check: `curl` against the local `/api/v1/health` endpoint every 30s

### Docker Compose — Production (`docker-compose.prod.yml`)

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| `redis` | `truex-redis` | 127.0.0.1:6379 | Pipeline Layer 2 — AOF persistence, 256MB |
| `fix-proxy` | `truex-fix-proxy` | 3004 | FIX OE proxy → WireGuard → 10.20.6.11:19484 |
| `md-proxy` | `truex-md-proxy` | 3005 | FIX MD proxy → WireGuard → 10.20.6.11:20484 |
| `market-maker` | `truex-market-maker` | 3100 (API) | Market maker + analytics API |
| `log-exporter` | `truex-log-exporter` | -- | Ships logs to Mech Storage every 5 min |

All services use `network_mode: host` for direct WireGuard access.

### Docker Compose — UAT/Dev (`docker-compose.yml`)

Targets UAT (`38.32.101.229:19484`). For local development only.

---

## TrueX FIX Protocol Reference

| Message | Tag 35 | Direction | Key Tags | Notes |
|---------|--------|-----------|----------|-------|
| Logon | A | Both | 553 (Username), 554 (HMAC sig), 108 (HeartBtInt), 141=Y (ResetSeqNum), 1137 (DefaultApplVerID) | FIXT.1.1 transport |
| Heartbeat | 0 | Both | 112 (TestReqID if responding to TestRequest) | Every 30s |
| Test Request | 1 | Inbound | 112 (TestReqID) | Respond with Heartbeat |
| Resend Request | 2 | Both | 7 (BeginSeqNo), 16 (EndSeqNo) | EndSeqNo=0 means "all" |
| Reject | 3 | Inbound | 58 (Text), 45 (RefSeqNum) | Session-level reject |
| Logout | 5 | Both | 58 (Text) | Graceful disconnect |
| New Order Single | D | Outbound | 11 (ClOrdID), 18=6 (ALO), 55 (Symbol), 54 (Side), 38 (OrderQty), 44 (Price), 40=2 (Limit), 59=1 (GTC), 453/448/452 (PartyID block) | |
| Execution Report | 8 | Inbound | 11 (ClOrdID), 17 (ExecID), 31 (LastPx), 32 (LastQty), 39 (OrdStatus), 54 (Side) | Status: A=PendingNew, 0=New, 1=PartialFill, 2=Filled, 4=Cancelled, 8=Rejected |
| Order Cancel Request | F | Outbound | 11 (ClOrdID), 41 (OrigClOrdID), 453/448/452 (PartyID block) | No tag 54 (Side) |
| Order Cancel Reject | 9 | Inbound | 11 (ClOrdID), 41 (OrigClOrdID), 58 (Text), 102 (CxlRejReason) | CxlRejReason=1 means order gone from exchange |

**Party ID block** (required on all orders and cancels):
- Tag 453 = `1` (NoPartyIDs)
- Tag 448 = clientId (PartyID)
- Tag 452 = `3` (PartyRole = Client ID)

**Key constraints:**
- 50 open order limit per client ID on UAT
- BTC quantity increment: 0.0001 (`sizeDecimalPlaces=4`)
- Price tick size: $0.50
- Minimum notional: $1.00
- Price band: +/- 2.5% from mid
- Rate limit: ~10 messages/second (engine defaults to 4-8/s for safety)
- TimeInForce: GTC (`59=1`) and IOC (`59=3`) supported. No GTD/TTL.

---

## Production vs UAT Configuration

| Parameter | Production | UAT |
|-----------|-----------|-----|
| Levels per side | 3 | 5 |
| Base spread | 80 bps | 50 bps |
| Base size | 0.01 BTC | 0.02 BTC |
| Max position | 0.05 BTC | 0.10 BTC |
| Emergency limit | 0.06 BTC | 0.12 BTC |
| Hedge threshold | 0.03 BTC | 0.05 BTC |
| Reprice threshold | 3 ticks ($1.50) | 3 ticks ($1.50) |
| Min reprice interval | 5000ms | 5000ms |
| Max orders/sec | 4 | 4 |
| FIX target | `TRUEX_PROD_OE` | `TRUEX_UAT_OE` |
| FIX host | `178.156.230.110:3004` (proxy) | `38.32.101.229:19484` (direct) |
| REST URL | `http://10.20.6.11:9742` (direct via WireGuard) | `http://38.32.101.229:9742` (direct) |
| Client ID | `78932725357888855` | `78972918929686546` (DAVID1) |
| Env validation | Strict (6 required vars, UAT safety check) | Minimal (2 required vars) |
| Orphan cancel failure | Fatal (process.exit) | Non-fatal (warning) |
