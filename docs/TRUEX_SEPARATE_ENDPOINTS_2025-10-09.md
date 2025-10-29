# TrueX Separate Endpoints Configuration
**Date:** October 9, 2025  
**Status:** ✅ Updated for new UAT configuration

---

## 🔄 TrueX UAT Update

TrueX has updated their UAT environment to match production with **separate FIX endpoints**:

### Endpoint Configuration

```
Order Entry (Trading):
- Host: 38.32.101.229 (via DO Proxy: 129.212.145.83)
- Port: 19484
- TargetCompID: TRUEX_UAT_OE
- Purpose: Place, amend, cancel orders

Market Data (Quotes):
- Host: 38.32.101.229 (via DO Proxy: 129.212.145.83)  
- Port: 20484
- TargetCompID: TRUEX_UAT_MD
- Purpose: Subscribe to market data, order book updates
```

---

## 📋 Environment Variables

Add to your `.env`:

```bash
# TrueX Authentication (Same for both endpoints)
TRUEX_API_KEY=89720766-9b45-4407-93b8-1cbecb74c3d3
TRUEX_SECRET_KEY=1fba7f7a61fc5c31db51b2f2d2e540f03558f22583fb184569bd5eeeddd5d53c
TRUEX_CLIENT_ID=78923062108553234

# TrueX Separate Endpoints
TRUEX_FIX_HOST=129.212.145.83  # DigitalOcean proxy
TRUEX_ORDER_ENTRY_PORT=19484   # For trading
TRUEX_MARKET_DATA_PORT=20484   # For market data

# Legacy (if needed for backward compatibility)
TRUEX_FIX_PORT=19484  # Points to order entry by default
```

---

## 🔌 Connection Architecture

### Dual Connection Setup

```
┌─────────────────────┐
│  Market Maker App   │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────┐ ┌──────────┐
│  Order  │ │  Market  │
│  Entry  │ │   Data   │
│Connection│ │Connection│
└────┬────┘ └────┬─────┘
     │           │
     ▼           ▼
┌────────────────────────┐
│  DO Proxy (129.212)    │
│  - Port 19484 → OE     │
│  - Port 20484 → MD     │
└──────────┬─────────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────────────────────┐
│  TrueX UAT Gateway      │
│  38.32.101.229          │
│  - Order Entry: 19484   │
│  - Market Data: 20484   │
└─────────────────────────┘
```

---

## ✅ Heartbeat Support

Our `FIXConnection` fully supports FIX heartbeats:

### Implemented Features:
1. **Receive Heartbeats (35=0):** Tracks last heartbeat received
2. **Send Heartbeats (35=0):** Sends periodic heartbeats every 30 seconds
3. **Respond to Test Requests (35=1):** Automatically responds with heartbeat
4. **Monitor Connection:** Disconnects if no heartbeat received for 2x interval
5. **Auto-restart:** Starts heartbeat timer after successful logon

### Heartbeat Configuration:
```javascript
{
  heartbeatInterval: 30  // seconds (configurable)
}
```

---

## 🔧 Implementation Guide

### Option 1: Single Connection (Order Entry Only)

Use for placing orders without live market data:

```javascript
import { FIXConnection } from './fix-protocol/fix-connection.js';

const orderConnection = new FIXConnection({
  host: process.env.TRUEX_FIX_HOST,
  port: parseInt(process.env.TRUEX_ORDER_ENTRY_PORT),
  apiKey: process.env.TRUEX_API_KEY,
  apiSecret: process.env.TRUEX_SECRET_KEY,
  senderCompID: 'CLI_CLIENT',
  targetCompID: 'TRUEX_UAT_OE',  // Order Entry
  heartbeatInterval: 30
});

await orderConnection.connect();
```

### Option 2: Dual Connections (Full Market Maker)

Use for market making with live data:

```javascript
// Order Entry Connection
const orderConnection = new FIXConnection({
  host: process.env.TRUEX_FIX_HOST,
  port: parseInt(process.env.TRUEX_ORDER_ENTRY_PORT),
  targetCompID: 'TRUEX_UAT_OE',
  // ... other config
});

// Market Data Connection
const marketDataConnection = new FIXConnection({
  host: process.env.TRUEX_FIX_HOST,
  port: parseInt(process.env.TRUEX_MARKET_DATA_PORT),
  targetCompID: 'TRUEX_UAT_MD',
  // ... other config
});

await Promise.all([
  orderConnection.connect(),
  marketDataConnection.connect()
]);
```

---

## 📊 Message Routing

### Order Entry Connection (19484)
**Outbound Messages:**
- `35=D` - New Order Single
- `35=G` - Order Cancel/Replace Request
- `35=F` - Order Cancel Request

**Inbound Messages:**
- `35=8` - Execution Report
- `35=9` - Order Cancel Reject
- `35=3` - Reject

### Market Data Connection (20484)
**Outbound Messages:**
- `35=V` - Market Data Request
- `35=W` - Market Data - Snapshot/Full Refresh Request

**Inbound Messages:**
- `35=W` - Market Data - Snapshot/Full Refresh
- `35=X` - Market Data - Incremental Refresh
- `35=Y` - Market Data Request Reject

---

## 🧪 Testing

### Test Order Entry Connection
```bash
cd src/services/market-maker/truex
TRUEX_FIX_PORT=19484 node test-order-placement.js
```

### Test Market Data Connection
```bash
cd src/services/market-maker/truex/proxy
TRUEX_FIX_PORT=20484 TRUEX_TARGET_COMP_ID=TRUEX_UAT_MD node truex-heartbeat-test.cjs
```

### Test Both Connections
```bash
cd src/services/market-maker/truex
node run-truex-mm-with-fix.js  # Will use separate connections
```

---

## 🔍 Troubleshooting

### Connection Refused on Port 20484
```bash
# Test from DO proxy
ssh root@129.212.145.83
nc -zv 38.32.101.229 20484
# Should show: Connection succeeded
```

### Heartbeat Issues
```bash
# Check heartbeat logs
grep "Heartbeat" logs/truex-audit/*.jsonl | tail -20

# Verify heartbeat interval
# Should see heartbeats every 30 seconds
```

### Wrong TargetCompID
```bash
# Order Entry must use: TRUEX_UAT_OE
# Market Data must use: TRUEX_UAT_MD

# Check logs for:
grep "TargetCompID" logs/truex-audit/*.jsonl
```

---

## 📝 Migration Checklist

- [x] Update `.env` with new ports
- [x] Verify `FIXConnection` supports heartbeats
- [x] Test Order Entry connection (19484)
- [ ] Test Market Data connection (20484)
- [ ] Update market maker to use dual connections
- [ ] Test full market making cycle
- [ ] Update documentation
- [ ] Create new snapshot after verification

---

## 🎯 Benefits of Separate Endpoints

### Advantages:
1. **Isolation:** Market data failures don't affect order placement
2. **Scalability:** Can handle more market data without blocking orders
3. **Performance:** Dedicated connections for each function
4. **Reliability:** If one connection fails, other remains active
5. **Production-Like:** Matches production environment

### Considerations:
1. **Sequence Numbers:** Each connection has independent sequence tracking ✅
2. **Authentication:** Must authenticate on both connections ✅
3. **Heartbeats:** Each connection maintains its own heartbeat ✅
4. **Resource Usage:** Two connections vs one (minimal overhead)

---

## 🚀 Next Steps

1. **Test Market Data Connection:**
   ```bash
   # Update heartbeat test to use port 20484
   cd src/services/market-maker/truex/proxy
   TRUEX_FIX_PORT=20484 node truex-heartbeat-test.cjs
   ```

2. **Update Market Maker:**
   - Modify `run-truex-mm-with-fix.js` to create dual connections
   - Route order messages to Order Entry (19484)
   - Route market data requests to Market Data (20484)

3. **Test Full Cycle:**
   - Subscribe to market data on 20484
   - Place order on 19484
   - Verify execution report received on 19484
   - Verify market data updates on 20484

---

**Last Updated:** October 9, 2025  
**Configuration Status:** ✅ Ready for testing  
**Heartbeat Support:** ✅ Fully implemented



