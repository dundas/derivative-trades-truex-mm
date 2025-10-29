# TrueX Market Maker Strategy Review
**Original Code:** `live-truex-market-maker.cjs`  
**Status:** ✅ Working Coinbase integration, needs FIXConnection integration

---

## 📊 Original Strategy Overview

### Core Concept
**Adaptive Market Making** using live Coinbase BTC-USD data with:
- **Decaying mean pricing** for responsive price discovery
- **Ladder-based order placement** around fair value
- **Dynamic size allocation** based on capital and risk
- **Randomized cancellation/replacement** to appear natural

---

## 🔄 Order Generation Logic

### Configuration (Default)
```javascript
{
  totalCapital: 1500000,        // $1.5M deployment
  totalOrders: 50,              // 25 buys + 25 sells
  priceLevels: 8,               // 8 price levels per side
  ordersPerLevel: 6,            // ~6 orders per level (25/8 ≈ 3)
  truexIncrement: 0.50,         // $0.50 price grid
  maxExposurePerSide: 15,       // 15 BTC max per side
  maxNetExposure: 8,            // 8 BTC max net position
  
  // Timing
  mainLoopInterval: 50,         // 50ms main loop
  orderUpdateInterval: 200,     // 200ms order updates
  cancellationMinDelay: 3000,   // 3-5 seconds random cancel
  cancellationMaxDelay: 5000
}
```

---

## 📈 Order Ladder Generation

### Function: `generateOrderLadder(basePrice)`

**Inputs:**
- `basePrice`: Current Coinbase price (decaying mean)
- `currentSpread`: Current market spread from Coinbase

**Logic:**

```javascript
// Calculate orders per side
const ordersPerSide = Math.floor(totalOrders / 2);  // 25 buys, 25 sells
const baseSize = totalCapital / totalOrders / basePrice;  // Capital per order

const halfSpread = currentSpread / 2;

// BUY ORDERS (below market)
for (let level = 1; level <= priceLevels; level++) {
  const ordersAtLevel = Math.ceil(ordersPerSide / priceLevels);  // ~3 orders/level
  
  for (let i = 0; i < ordersAtLevel; i++) {
    // Calculate price offset from market
    const levelOffset = halfSpread + (level - 1) * truexIncrement;
    const price = Math.floor((basePrice - levelOffset) / truexIncrement) * truexIncrement;
    
    // Add random size variation (±10%)
    const sizeVariation = 1 + ((Math.random() - 0.5) * 0.1);
    const size = Math.round(baseSize * sizeVariation * 10000) / 10000;
    
    orders.push({
      side: 'buy',
      price: price,
      size: size,
      level: level,
      type: 'limit'
    });
  }
}

// SELL ORDERS (above market) - mirror logic
```

---

## 📊 Example Order Distribution

**Assumptions:**
- Current Price: $121,000
- Spread: $2.00
- Capital: $1,500,000
- Base Size: $30,000/order = 0.2479 BTC

### Buy Side (25 orders)
```
Level 1 (closest to market):
  Price: $120,999.00  Size: 0.2450 BTC
  Price: $120,998.50  Size: 0.2510 BTC
  Price: $120,998.00  Size: 0.2470 BTC

Level 2:
  Price: $120,998.50  Size: 0.2490 BTC
  Price: $120,998.00  Size: 0.2460 BTC
  Price: $120,997.50  Size: 0.2505 BTC

... (8 levels total)
```

### Sell Side (25 orders)
```
Level 1 (closest to market):
  Price: $121,001.00  Size: 0.2480 BTC
  Price: $121,001.50  Size: 0.2495 BTC
  Price: $121,002.00  Size: 0.2465 BTC

... (8 levels total)
```

---

## 🔄 Continuous Management

### Main Loop (50ms intervals)
```javascript
while (isRunning) {
  1. Update prices from Coinbase
  2. Calculate decaying mean
  3. Check position limits
  4. Evaluate order placements
  5. Manage active orders
  
  await sleep(50);
}
```

### Order Updates (200ms intervals)
```javascript
setInterval(() => {
  1. Check if prices moved significantly
  2. Cancel out-of-range orders
  3. Replace with new orders at better prices
  4. Maintain 50 active orders
}, 200);
```

### Randomized Cancellation
```javascript
// For each order placed
setTimeout(() => {
  cancelOrder(orderId);
  replaceOrder(orderId);
}, randomDelay(3000, 5000));  // 3-5 seconds
```

---

## 🎯 Integration with FIXConnection

### Current Status
✅ **Working:** `live-truex-market-maker.cjs` with `TrueXFIXSocketClient`  
✅ **Working:** `truex-market-maker.js` with `FIXConnection` (proper protocol)  
🔄 **Need:** Combine strategy + proper FIX protocol

### Integration Approach

**Option 1: Hybrid (Recommended)**
Use `live-truex-market-maker.cjs` strategy with `FIXConnection`:

```javascript
const { FIXConnection } = require('./fix-protocol/fix-connection.js');
const LiveCoinbaseDataManager = require('./live-coinbase-data-manager.cjs');

class EnhancedLiveTrueXMarketMaker extends LiveTrueXMarketMaker {
  initializeComponents(options) {
    // Keep Coinbase data manager
    this.dataManager = new LiveCoinbaseDataManager({...});
    
    // Replace TrueXFIXSocketClient with FIXConnection
    this.truexFIX = new FIXConnection({
      host: options.truexHost || '129.212.145.83',
      port: options.truexPort || 3004,
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_SECRET_KEY,
      senderCompID: 'CLI_CLIENT',
      targetCompID: 'TRUEX_UAT_OE',
      heartbeatInterval: 30
    });
    
    // Setup event handlers
    this.setupEventHandlers();
  }
}
```

**Option 2: Wrapper**
Wrap the strategy layer around the working orchestrator:

```javascript
const { TrueXMarketMaker } = require('./truex-market-maker.js');

class StrategyMarketMaker {
  constructor() {
    this.orchestrator = new TrueXMarketMaker({...});
    this.dataManager = new LiveCoinbaseDataManager({...});
    this.strategy = new OrderLadderStrategy({...});
  }
  
  async start() {
    await this.orchestrator.start();
    await this.dataManager.connect();
    this.startStrategyLoop();
  }
  
  async startStrategyLoop() {
    setInterval(async () => {
      const price = this.dataManager.getDecayingMean();
      const orders = this.strategy.generateOrderLadder(price);
      
      for (const order of orders) {
        await this.orchestrator.placeOrder({
          side: order.side === 'buy' ? '1' : '2',  // FIX sides
          size: order.size.toString(),
          price: order.price.toString(),
          type: '2',  // Limit order
          clientOrderId: `MM-${Date.now()}`
        });
      }
    }, 200);
  }
}
```

---

## 🔧 Key Modifications Needed

### 1. Side Format Conversion
**Current:** `side: 'buy'` / `'sell'`  
**FIX Needs:** `side: '1'` / `'2'`

```javascript
function convertSideToFIX(side) {
  return side === 'buy' ? '1' : '2';
}
```

### 2. Order Structure Mapping
**Strategy Output:**
```javascript
{
  side: 'buy',
  price: 121000,
  size: 0.2479,
  level: 1,
  type: 'limit'
}
```

**FIX Input:**
```javascript
{
  '35': 'D',           // New Order
  '11': 'ORDER-123',   // ClOrdID
  '55': 'BTC-PYUSD',   // Symbol
  '54': '1',           // Side (1=Buy)
  '38': '0.2479',      // OrderQty
  '40': '2',           // OrdType (2=Limit)
  '44': '121000',      // Price
  '59': '1'            // TimeInForce (1=GTC)
}
```

### 3. Position Tracking
The `FIXConnection` receives execution reports (35=8). Need to:
- Listen for execution reports
- Update position tracking
- Feed back into strategy

```javascript
this.truexFIX.on('executionReport', (report) => {
  const orderId = report.fields['11'];
  const execType = report.fields['150'];
  const ordStatus = report.fields['39'];
  
  if (execType === '2') {  // Fill
    this.handleFill(report);
    this.updatePosition(report);
    this.checkRiskLimits();
  }
});
```

---

## 📋 Implementation Checklist

### Phase 1: Basic Integration ✅
- [x] Fix authentication in FIXConnection
- [x] Verify connection works
- [x] Test single order placement
- [x] Confirm heartbeats working

### Phase 2: Strategy Integration (Next)
- [ ] Adapt `submitOrder()` to use FIXConnection format
- [ ] Add side conversion (buy/sell → 1/2)
- [ ] Test order ladder generation
- [ ] Verify 50 orders can be placed

### Phase 3: Execution Handling
- [ ] Listen for execution reports
- [ ] Parse fill messages
- [ ] Update position tracking
- [ ] Implement PnL calculation

### Phase 4: Order Management
- [ ] Implement random cancellation
- [ ] Implement order replacement
- [ ] Handle order rejections
- [ ] Maintain 50 active orders

### Phase 5: Risk Management
- [ ] Enforce position limits
- [ ] Implement max drawdown
- [ ] Add emergency stop
- [ ] Position reconciliation

---

## 🎯 Recommended Next Steps

### Immediate (Today)
1. **Create adapter for submitOrder()**
   - Convert `live-truex-market-maker.cjs` order format
   - To `FIXConnection.placeOrder()` format
   - Test with 1-2 orders first

2. **Test full ladder**
   - Generate 50 orders with `generateOrderLadder()`
   - Submit via FIXConnection
   - Monitor for execution reports

### Short Term (This Week)
3. **Add execution report handling**
   - Parse FIX 35=8 messages
   - Update active orders map
   - Track fills and positions

4. **Implement order lifecycle**
   - Place → Monitor → Cancel → Replace
   - Test cancellation logic
   - Verify replacement works

### Medium Term (Next Week)
5. **Full market maker**
   - Connect all components
   - Run continuous strategy
   - Monitor performance
   - Tune parameters

---

## 📊 Performance Expectations

Based on original code metrics:

### Target KPIs
- **Orders Maintained:** 50 active at all times
- **Fill Rate:** 5-10% (depends on spread)
- **Order Refresh:** 3-5 seconds per order
- **Spread Capture:** 80-90% of bid-ask spread
- **Max Position:** 15 BTC per side
- **Capital Efficiency:** ~$30K per order

### Monitoring
```javascript
{
  ordersPlaced: 1000,
  ordersFilled: 75,
  fillRate: 7.5%,
  avgLatency: 45ms,
  spreadCapture: 85%,
  realizedPnL: $2,450,
  unrealizedPnL: $340,
  currentPosition: { buy: 3.2 BTC, sell: 2.8 BTC }
}
```

---

## 🔗 Key Files Reference

**Strategy & Logic:**
- `src/services/market-maker/truex/live-truex-market-maker.cjs`
- `src/services/market-maker/truex/live-coinbase-data-manager.cjs`

**Working FIX Protocol:**
- `src/services/market-maker/truex/fix-protocol/fix-connection.js`
- `src/services/market-maker/truex/truex-market-maker.js`

**Old FIX Client (being replaced):**
- `src/services/market-maker/truex/truex-fix-socket-client.cjs`

**Test Scripts:**
- `src/services/market-maker/truex/test-order-placement.js` (working!)
- `src/services/market-maker/truex/run-live-truex-mm.cjs`

---

**Status:** ✅ Ready to integrate strategy with working FIX protocol  
**Next Action:** Create adapter to convert order format and test 50 orders



