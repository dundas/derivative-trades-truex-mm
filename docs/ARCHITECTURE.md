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
3. Connect FIX OE
4. Connect market data feed (optional, non-blocking)
5. Start data pipeline (optional, non-blocking)
6. Start PnL periodic logging
7. Start quote engine drain queue timer (every 200ms)
8. Start REST reconciliation timer (every 5 minutes)
9. Start balance refresh timer (every 60 seconds)

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
- Inventory skew applied from InventoryManager: widens the accumulating side, tightens the reducing side
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
- The orchestrator injects the latest TrueX best bid/ask into QuoteEngine through `marketDataProvider` / `updateTrueXBook()`.
- `truexBookStaleThresholdMs` controls whether the book is fresh enough for marketability decisions.
- Post-only quotes use `18=6` and are checked at send time. A buy at or above fresh best ask, or a sell at or below fresh best bid, is suppressed by default with reason `marketable-post-only`.
- `marketablePostOnlyAction='skip'` is the default. `slide` can move a marketable ALO one tick away from the opposite side, but should be enabled only after venue behavior is confirmed.
- Missing or stale TrueX book means marketability is unknown; existing maker quoting remains allowed, but intentional taker orders require explicit fair value/execution inputs and remain disabled unless configured.

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
- `utilizationPct = |netPosition| / maxPositionBTC`
- `rawSkew = utilizationPct^skewExponent * maxSkewTicks`
- Long: widen asks (positive skew), tighten bids (negative skew)
- Short: widen bids (positive skew), tighten asks (negative skew)

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
| `TRUEX_PROD_HOST` | No | `10.20.6.11` | TrueX production internal IP (reachable via WireGuard tunnel). Substituted into `TRUEX_UPSTREAM_HOST` for both FIX proxies and `TRUEX_REST_URL` in `docker-compose.prod.yml`. WireGuard `AllowedIPs` must include this `/32`. If TrueX migrates the endpoint, update this var **and** add the new `/32` to `/etc/wireguard/truemarkets.conf`. Empty string does not fall back to default — keep populated or unset. |
| `TRUEX_REST_URL` | No | `http://10.20.6.11:9742` | TrueX REST URL — derived from `TRUEX_PROD_HOST` by `docker-compose.prod.yml`. Override only when accessing from outside Hetzner (e.g. `http://178.156.230.110:3006` socat tunnel for local development). |
| `TRUEX_TARGET_COMP_ID` | No | `TRUEX_PROD_OE` | FIX TargetCompID |
| `TRUEX_SENDER_COMP_ID` | No | `DAVID1` | FIX SenderCompID |
| `DATABASE_URL` | No | -- | PostgreSQL connection string (Hetzner truex-pg-analytics 178.156.247.87:5432/truex_analytics) |
| `REDIS_URL` | No | -- | Redis connection string (optional, auto-fallback) |
| `TRUEX_MAKER_FEE_BPS` | No | `0` | TrueX maker fee in basis points |
| `TRUEX_TAKER_FEE_BPS` | No | `0` | TrueX taker fee in basis points |
| `HEDGE_MAKER_FEE_BPS` | No | `0` | Hedge venue maker fee in basis points |
| `HEDGE_TAKER_FEE_BPS` | No | `0` | Hedge venue taker fee in basis points |
| `LOG_LEVEL` | No | `info` | Log level (`info` or `debug`) |
| `TRUEX_DEBUG_MODE` | No | -- | Set to `true` to log raw FIX messages |

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

- Base image: `oven/bun:1.1-alpine`
- Non-root user (`nodejs:1001`)
- Production dependencies only (`bun install --production`)
- Health check: `bun --version` every 30s

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
