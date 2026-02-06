# PRD: Profitable Market Making Engine for TrueX

## 1. Overview

**Goal**: Build a production-ready market making engine that can profitably quote BTC-PYUSD on TrueX at exchange launch.

**Current State**: We have solid infrastructure (FIX connection, REST client, data pipeline, multi-exchange connectors, price aggregator) and a static 50-order ladder strategy. But the ladder doesn't react to market moves, has no risk management, no PnL tracking, and no hedge execution.

**Target State**: A dynamic market maker that:
- Reprices quotes in real-time based on Coinbase/Kraken/Gemini price feeds
- Manages inventory risk with position limits and quote skewing
- Tracks PnL in real-time (realized, unrealized, fees)
- Executes hedges on Kraken/Coinbase to flatten accumulated risk
- Provides a TrueX market data view to see the orderbook we're quoting into

## 2. Architecture

### System Diagram

```
External Price Feeds                    TrueX Exchange
┌─────────────────┐                    ┌──────────────┐
│ Coinbase WS L2  │──┐                │  FIX OE      │
│ Kraken WS       │──┼─→ PriceAggregator ──→ QuoteEngine ──→ FIXConnection ──→│  (Orders)    │
│ Gemini WS       │──┘       │              │    ↑          │  FIX MD      │
└─────────────────┘          │              │    │          │  (Market Data)│
                             │              │    │          └──────────────┘
                             ↓              │    │                │
                        InventoryManager ───┘    │                │
                             │                   │                ↓
                             ↓                   │          ExecutionReports
                        HedgeExecutor            │                │
                        (Kraken REST)            │                ↓
                             │                   │          PnLTracker
                             └───────────────────┘                │
                                                                  ↓
                                                         DataPipeline (existing)
                                                         Memory → Redis → PG
```

### Component Breakdown

| Component | File | Responsibility |
|-----------|------|---------------|
| QuoteEngine | `src/core/quote-engine.js` | Dynamic repricing, order lifecycle |
| InventoryManager | `src/core/inventory-manager.js` | Position tracking, risk limits, skew |
| PnLTracker | `src/core/pnl-tracker.js` | Real-time P&L, fee accounting |
| HedgeExecutor | `src/core/hedge-executor.js` | Flatten risk via external exchanges |
| TrueXMarketDataFeed | `src/core/truex-market-data.js` | FIX MD subscription for TrueX book |
| MarketMakerOrchestrator | `src/core/market-maker-orchestrator.js` | Wires all components together |

## 3. Component Specifications

### 3.1 QuoteEngine

**Purpose**: Decide what quotes to send to TrueX and when to cancel/replace them.

**Inputs**:
- `PriceAggregator` events → aggregated price with confidence
- `InventoryManager` → current position, skew direction/magnitude
- `TrueXMarketDataFeed` → TrueX orderbook (optional, enhances quality)

**Outputs**:
- New Order Single (35=D) via FIXConnection
- Order Cancel/Replace (35=G) via FIXConnection
- Order Cancel (35=F) via FIXConnection

**Behavior**:
1. On each price update from PriceAggregator:
   - Compute desired quote prices using midpoint + spread + inventory skew
   - Snap prices to TrueX $0.50 tick increment
   - Compare desired quotes vs active orders
   - If price moved > threshold (configurable, default $0.50): cancel-replace stale orders
   - If price barely moved: do nothing (avoid churning)
2. Maintain N orders per side (configurable, default 5-8 levels)
3. Size orders based on level distance from mid (larger near mid, smaller at edges)
4. Respect TrueX rate limits: max 10 orders/sec, 300/min, 500ms duplicate interval

**Configuration**:
```javascript
{
  levels: 5,                    // Price levels per side
  baseSpreadBps: 50,           // 50bps minimum spread (each side = 25bps from mid)
  levelSpacingTicks: 1,        // $0.50 between levels (1 TrueX tick)
  repriceThresholdTicks: 1,    // Reprice if mid moves by 1+ tick
  baseSizeBTC: 0.1,            // Base order size at level 1
  sizeDecayFactor: 0.8,        // Each level = 80% of previous
  maxOrdersPerSecond: 8,       // Stay under TrueX 10/sec limit
  tickSize: 0.50,              // TrueX price increment
  minNotional: 1.0,            // TrueX minimum (1 PYUSD)
  priceBandPct: 2.5,           // TrueX ±2.5% price band
  confidenceThreshold: 0.3,    // Min PriceAggregator confidence to quote
}
```

**Key Methods**:
- `onPriceUpdate(aggregatedPrice)` → evaluate repricing
- `computeDesiredQuotes(mid, skew)` → array of {side, price, size, level}
- `reconcileOrders(desired, active)` → {toCancel, toPlace, toReplace}
- `executeOrderActions(actions)` → rate-limited FIX operations
- `cancelAllQuotes()` → emergency pullback

### 3.2 InventoryManager

**Purpose**: Track net position, enforce limits, compute quote skew.

**Inputs**:
- Execution reports from FIXConnection (fills)
- Hedge fills from HedgeExecutor

**State**:
- `netPosition`: Current BTC holdings from market making
- `avgEntryPrice`: Volume-weighted average entry
- `maxPosition`: Hard limit (configurable, default 5 BTC)
- `skewMultiplier`: How aggressively to skew (configurable)

**Behavior**:
1. On every fill: update net position and avg entry price
2. Compute quote skew based on inventory:
   - Long 2 BTC → widen ask spread, tighten bid spread (encourage sells)
   - Short 2 BTC → widen bid spread, tighten ask spread (encourage buys)
   - Skew formula: `skewTicks = position / maxPosition * maxSkewTicks`
3. Hard position limits:
   - At 80% of max: widen quotes on accumulating side
   - At 100% of max: pull quotes on accumulating side entirely
   - Emergency: cancel all if exposure > 120% (shouldn't happen)
4. Signal HedgeExecutor when position exceeds hedge threshold

**Configuration**:
```javascript
{
  maxPositionBTC: 5.0,         // Maximum net position either direction
  hedgeThresholdBTC: 2.0,      // Start hedging above this
  maxSkewTicks: 3,             // Maximum skew = 3 ticks = $1.50
  skewExponent: 1.5,           // Non-linear skew (accelerates near limits)
  emergencyLimitBTC: 6.0,      // Cancel everything above this
  positionDecayTarget: 0.0,    // Target zero inventory over time
}
```

**Key Methods**:
- `onFill(fill)` → update position state
- `getSkew()` → { bidSkewTicks, askSkewTicks }
- `canQuote(side)` → boolean (false if at position limit for that side)
- `shouldHedge()` → { shouldHedge, side, size }
- `getPositionSummary()` → { netPosition, avgEntry, unrealizedPnl, utilizationPct }

### 3.3 PnLTracker

**Purpose**: Real-time profit/loss tracking with fee accounting.

**Inputs**:
- Fills from TrueX (via execution reports)
- Fills from hedge venues (Kraken/Coinbase)
- Current market price from PriceAggregator
- Fee schedule (TrueX maker/taker fees)

**State**:
- Realized PnL (from completed round-trips)
- Unrealized PnL (mark-to-market on open position)
- Fee totals (maker, taker, exchange-specific)
- Per-session and cumulative tracking

**Behavior**:
1. On every fill: compute realized PnL using FIFO matching
2. On every price update: recompute unrealized PnL
3. Track fees separately (TrueX vs hedge venue)
4. Emit events for significant PnL changes (>$100, new high/low)
5. Periodic summary logging (every 30s)
6. Persist to data pipeline (via DataManager)

**Configuration**:
```javascript
{
  truexMakerFeeBps: 0,         // TrueX maker fee (check actual)
  truexTakerFeeBps: 10,        // TrueX taker fee (check actual)
  hedgeMakerFeeBps: 16,        // Kraken maker fee
  hedgeTakerFeeBps: 26,        // Kraken taker fee
  logIntervalMs: 30000,        // PnL summary every 30s
  significantPnlChange: 100,   // Emit event on $100+ change
}
```

**Key Methods**:
- `onTrueXFill(fill)` → update realized PnL, fees
- `onHedgeFill(fill)` → update hedge PnL, fees
- `markToMarket(currentMid)` → update unrealized PnL
- `getSummary()` → { realized, unrealized, total, fees, numTrades, avgSpreadCapture }
- `getSessionReport()` → detailed session summary for logging

### 3.4 HedgeExecutor

**Purpose**: Flatten accumulated inventory risk on external exchanges.

**Inputs**:
- Hedge signals from InventoryManager
- Available balances on hedge venue

**Behavior**:
1. When InventoryManager says `shouldHedge()`:
   - Check available balance on Kraken
   - Place market or aggressive limit order to flatten position
   - Track hedge order until filled
   - Report fill back to InventoryManager and PnLTracker
2. Smart hedging:
   - Use limit orders when possible (save fees)
   - Fall back to market orders if limit not filling within timeout
   - Respect hedge venue rate limits
3. Initially: Kraken only (via existing KrakenRestClient)
4. Future: Add Coinbase, Gemini as hedge venues

**Configuration**:
```javascript
{
  hedgeVenue: 'kraken',        // Primary hedge exchange
  hedgeSymbol: 'XBTUSDT',     // Kraken symbol
  hedgeOrderType: 'limit',    // Start with limit, fall back to market
  limitTimeoutMs: 5000,       // If limit not filled in 5s, go market
  minHedgeSizeBTC: 0.001,     // Don't bother hedging tiny amounts
  maxHedgeSizeBTC: 1.0,       // Max single hedge order
}
```

**Key Methods**:
- `executeHedge(side, size)` → place and track hedge order
- `checkHedgeStatus()` → poll open hedge orders
- `getHedgePosition()` → net position on hedge venue

### 3.5 TrueXMarketDataFeed

**Purpose**: Subscribe to TrueX's own orderbook via FIX Market Data (35=V).

**Inputs**: FIX Market Data connection (separate from Order Entry)

**Behavior**:
1. Connect to TRUEX_UAT_MD endpoint via FIXConnection
2. Send Market Data Request (35=V) for BTC-PYUSD
3. Parse Market Data Snapshot (35=W) and Incremental Refresh (35=X)
4. Maintain local TrueX orderbook state
5. Emit events for orderbook changes
6. Feed back to QuoteEngine for position awareness

**Configuration**:
```javascript
{
  mdHost: process.env.TRUEX_MD_HOST,
  mdPort: process.env.TRUEX_MD_PORT,
  targetCompID: 'TRUEX_UAT_MD',
  subscriptionType: '1',      // Snapshot + Updates
  marketDepth: '0',           // Full book
  mdEntryTypes: ['0', '1'],   // Bids and Offers
}
```

**Key Methods**:
- `connect()` → establish FIX MD session
- `subscribe(symbol)` → send market data request
- `getOrderBook()` → current TrueX L2 book
- `getBestBidAsk()` → top of book

### 3.6 MarketMakerOrchestrator

**Purpose**: Wire all components together and manage lifecycle.

**Replaces/Extends**: Current `TrueXMarketMaker` and `TrueXCoinbaseMarketMaker`

**Behavior**:
1. Initialize all components with configuration
2. Wire event handlers:
   - PriceAggregator.price → QuoteEngine.onPriceUpdate
   - FIXConnection.message (execReport) → InventoryManager.onFill + PnLTracker.onTrueXFill
   - InventoryManager.shouldHedge → HedgeExecutor.executeHedge
   - HedgeExecutor.fill → InventoryManager.onFill + PnLTracker.onHedgeFill
3. Start sequence: Connect feeds → Authenticate FIX → Subscribe MD → Start quoting
4. Stop sequence: Cancel all quotes → Hedge remaining → Disconnect → Report
5. Graceful shutdown on SIGINT/SIGTERM

**Configuration**: Unified config object that passes through to sub-components. Environment-variable-driven for secrets.

## 4. Non-Functional Requirements

### Performance
- Price-to-quote latency: < 50ms (data arrival to order submitted)
- Quote update throughput: 10 updates/second (TrueX max)
- Memory footprint: < 512MB RSS

### Reliability
- Auto-reconnect for all connections (FIX, WebSocket, REST)
- Graceful degradation: if Coinbase dies, use Kraken/Gemini alone
- Kill switch: cancel all if PriceAggregator confidence < threshold
- Audit trail: all orders, fills, and hedges logged to audit logger

### Observability
- Structured logging via existing Logger.ts
- PnL summary every 30s
- Risk summary every 5s
- Data pipeline: Memory → Redis → PostgreSQL (existing)

## 5. Constraints

### TrueX Exchange Rules
- Price increment: $0.50
- Min notional: 1 PYUSD per order
- Price band: ±2.5% from midpoint
- Rate limits: 10 orders/sec, 300/min
- Duplicate order interval: 500ms minimum
- ClOrdID: ≤18 chars
- FIX auth: HMAC-SHA256 (tags 553/554)
- TrueX rejects FIX tag 122 (OrigSendingTime)

### Existing Code to Preserve
- `FIXConnection` (fix-connection.js) - keep as-is, proven and tested
- `TrueXDataManager` (truex-data-manager.js) - keep as-is
- `TrueXRedisManager` (truex-redis-manager.js) - keep as-is
- `TrueXPostgreSQLManager` (truex-postgresql-manager.js) - keep as-is
- `PriceAggregator` (PriceAggregator.ts) - keep as-is, feed into QuoteEngine
- `CoinbaseWsIngest` (coinbase-ws-ingest.js) - keep as-is
- `AuditLogger` (audit-logger.js) - keep as-is

### Existing Code to Deprecate
- `TrueXCoinbaseMarketMaker` - replaced by MarketMakerOrchestrator + QuoteEngine
- `TrueXMarketMaker` - data pipeline logic moves to orchestrator

## 6. Testing Strategy

### Unit Tests (bun:test)
- QuoteEngine: price snapping, spread calculation, skew application, rate limiting
- InventoryManager: position tracking, skew computation, limit enforcement
- PnLTracker: FIFO matching, fee calculation, mark-to-market
- HedgeExecutor: order placement, timeout handling

### Integration Tests
- QuoteEngine + InventoryManager: end-to-end quote generation with skew
- Full pipeline: price update → quote → fill → inventory → hedge

### Simulation
- Paper trading mode against TrueX UAT with real Coinbase prices
- Backtest using recorded Coinbase L2 data

## 7. Rollout Plan

1. **Phase 1 - Core Engine** (QuoteEngine + InventoryManager + PnLTracker)
   - Build and test with mocks
   - Paper trade against UAT
2. **Phase 2 - Market Data** (TrueXMarketDataFeed)
   - Add TrueX book visibility
   - Enhance QuoteEngine with book awareness
3. **Phase 3 - Hedging** (HedgeExecutor)
   - Wire Kraken REST client for hedge execution
   - Test with small sizes
4. **Phase 4 - Production** (MarketMakerOrchestrator)
   - Full integration
   - Monitoring and alerting
   - Go-live at TrueX launch
