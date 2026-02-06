# Tasks: Profitable Market Making Engine

**PRD**: `tasks/1-prd-profitable-market-making-engine.md`
**Created**: 2026-02-06

---

## Parent Tasks

### Task 1: Build InventoryManager ✅
**Priority**: CRITICAL | **Estimate**: Medium | **Status**: COMPLETE (51 tests)
**File**: `src/core/inventory-manager.js`
**Why first**: QuoteEngine depends on skew from InventoryManager. PnLTracker depends on fill events routed through InventoryManager. This is the foundation.

**Acceptance Criteria**:
- Tracks net position from fills (buy increases, sell decreases)
- Computes VWAP entry price
- Computes bid/ask skew in ticks based on position vs limit
- Enforces hard position limits (pull quotes at 100%)
- Emits hedge signals when position exceeds threshold
- Unit tests: position tracking, skew math, limit enforcement

---

### Task 2: Build PnLTracker ✅
**Priority**: CRITICAL | **Estimate**: Medium | **Status**: COMPLETE (40 tests)
**File**: `src/core/pnl-tracker.js`
**Why second**: QuoteEngine needs PnL data for risk decisions. Can be built in parallel with InventoryManager since they have a clean interface.

**Acceptance Criteria**:
- FIFO-based realized PnL from fills
- Mark-to-market unrealized PnL from current price
- Fee accounting (maker/taker, per-venue)
- Session summary with trade count, avg spread capture, Sharpe estimate
- Periodic logging (30s interval)
- Unit tests: FIFO matching, fee calc, edge cases (partial fills)

---

### Task 3: Build QuoteEngine ✅
**Priority**: CRITICAL | **Estimate**: Large | **Status**: COMPLETE (62 tests)
**File**: `src/core/quote-engine.js`
**Depends on**: Task 1 (InventoryManager), Task 2 (PnLTracker)

**Acceptance Criteria**:
- Receives PriceAggregator price events
- Computes desired quotes: mid ± spread ± inventory skew, snapped to $0.50
- Reconciles desired vs active orders (cancel stale, place new, replace moved)
- Rate limits FIX operations (max 8/sec with 500ms dedup guard)
- Pulls all quotes when confidence < threshold or emergency
- Respects TrueX price band (±2.5%) and min notional ($1 PYUSD)
- Unit tests: price snapping, spread calc, reconciliation logic, rate limiting

---

### Task 4: Build TrueXMarketDataFeed ✅
**Priority**: HIGH | **Estimate**: Medium | **Status**: COMPLETE (43 tests)
**File**: `src/core/truex-market-data.js`
**Depends on**: None (independent, uses existing FIXConnection)

**Acceptance Criteria**:
- Creates separate FIXConnection to TRUEX_UAT_MD endpoint
- Sends Market Data Request (35=V) for BTC-PYUSD
- Parses Market Data Snapshot (35=W) and Incremental Refresh (35=X)
- Maintains local L2 orderbook state
- Exposes getOrderBook() and getBestBidAsk()
- Unit tests: snapshot parsing, incremental updates, book state

---

### Task 5: Build HedgeExecutor ✅
**Priority**: MEDIUM | **Estimate**: Medium | **Status**: COMPLETE (36 tests)
**File**: `src/core/hedge-executor.js`
**Depends on**: Task 1 (InventoryManager)

**Acceptance Criteria**:
- Receives hedge signals from InventoryManager
- Places limit order on Kraken via existing KrakenRestClient
- Falls back to market order after configurable timeout
- Reports fills back to InventoryManager and PnLTracker
- Respects min/max hedge sizes and Kraken rate limits
- Unit tests: order placement, timeout fallback, fill reporting

---

### Task 6: Build MarketMakerOrchestrator ✅
**Priority**: CRITICAL | **Estimate**: Large | **Status**: COMPLETE (67 tests)
**File**: `src/core/market-maker-orchestrator.js`
**Depends on**: Tasks 1-5

**Acceptance Criteria**:
- Wires all components with event handlers
- Start sequence: connect feeds → auth FIX → subscribe MD → start quoting
- Stop sequence: cancel quotes → hedge remaining → disconnect → final report
- Graceful shutdown on SIGINT/SIGTERM
- Unified config object (env-var-driven for secrets)
- Integration test: full lifecycle with mocked FIX and price feed

---

### Task 7: Integration Testing & Paper Trading ✅
**Priority**: HIGH | **Estimate**: Medium | **Status**: COMPLETE (19 tests)
**Depends on**: Task 6

**Acceptance Criteria**:
- End-to-end test: simulated price moves → quote updates → fills → PnL
- Paper trading script against TrueX UAT with real Coinbase prices
- Verify rate limit compliance under load
- Verify graceful degradation (kill a price feed, verify pullback)
- Performance: price-to-quote < 50ms measured

---

## Dependency Graph

```
Task 1 (InventoryManager) ──┐
                             ├──→ Task 3 (QuoteEngine) ──┐
Task 2 (PnLTracker) ────────┘                            │
                                                          ├──→ Task 6 (Orchestrator) ──→ Task 7 (Integration)
Task 4 (TrueX MD Feed) ──────────────────────────────────┤
                                                          │
Task 5 (HedgeExecutor) ──────────────────────────────────┘
```

**Parallel tracks**:
- Track A: Task 1 + Task 2 (parallel) → Task 3 → Task 6
- Track B: Task 4 (independent) → Task 6
- Track C: Task 5 (after Task 1) → Task 6

---

## Relevant Files

### Existing (read/integrate, don't modify)
- `src/fix-protocol/fix-connection.js` - FIX 5.0 SP2 connection (908 lines)
- `src/connectors/aggregator/PriceAggregator.ts` - Multi-exchange price aggregation
- `src/connectors/IExchangeConnector.ts` - Unified exchange interface
- `src/data-pipeline/coinbase-ws-ingest.js` - Coinbase L2/ticker/trades feed
- `src/data-pipeline/truex-data-manager.js` - In-memory cache layer
- `src/data-pipeline/truex-redis-manager.js` - Redis persistence
- `src/data-pipeline/truex-postgresql-manager.js` - PostgreSQL analytics
- `src/data-pipeline/audit-logger.js` - Append-only JSONL audit trail
- `src/data-pipeline/ohlc-builder.js` - OHLC candle aggregation
- `src/exchanges/truex/TrueXRESTClient.ts` - REST API client
- `src/connectors/kraken/KrakenRestClient.ts` - Kraken REST (for hedging)
- `src/proxy/fix-message-builder.cjs` - FIX message construction

### New (to create)
- `src/core/inventory-manager.js` - Task 1
- `src/core/pnl-tracker.js` - Task 2
- `src/core/quote-engine.js` - Task 3
- `src/core/truex-market-data.js` - Task 4
- `src/core/hedge-executor.js` - Task 5
- `src/core/market-maker-orchestrator.js` - Task 6
- `tests/inventory-manager.test.js` - Task 1 tests
- `tests/pnl-tracker.test.js` - Task 2 tests
- `tests/quote-engine.test.js` - Task 3 tests
- `tests/truex-market-data.test.js` - Task 4 tests
- `tests/hedge-executor.test.js` - Task 5 tests
- `tests/market-maker-orchestrator.test.js` - Task 6 tests
- `tests/integration-e2e.test.js` - Task 7 tests

### To deprecate (after Task 6 complete)
- `src/core/truex-coinbase-market-maker.js` - Static ladder (replaced by QuoteEngine)
