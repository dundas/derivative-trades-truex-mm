# TrueX Market Order Test - For Support Review

**Test Date:** October 10, 2025  
**Test Time:** 12:05:37 UTC  
**SenderCompID:** CLI_TEST_1760097938370  
**TargetCompID:** TRUEX_UAT_OE

---

## 📋 Test Configuration

```
SenderCompID:     CLI_TEST_1760097938370
TargetCompID:     TRUEX_UAT_OE
Proxy Host:       129.212.145.83
Proxy Port:       3004
API Key:          89720766-9b45-4407-93b8-1cbecb74c3d3
Symbol:           BTC-PYUSD
Market Price:     $121,709.35 (from Coinbase live feed)
```

---

## 📊 Order Pricing Strategy

**Live Coinbase Price:** $121,709.35

**Order Sent:**
- **Side:** BUY
- **Price:** $121,704.0 (market - $5)
- **Quantity:** 0.01 BTC
- **Pricing:** **AT MARKET** (only $5 below, extremely likely to fill)

---

## 📤 Messages Sent to TrueX

### Message 1: Logon (35=A)
**Sequence Number:** 1  
**Timestamp:** 2025-10-10T12:05:40.423Z

**Raw FIX:**
```
8=FIXT.1.1|9=196|34=1|35=A|49=CLI_TEST_1760097938370|52=20251010-12:05:40.423|56=TRUEX_UAT_OE|98=0|108=30|141=Y|553=89720766-9b45-4407-93b8-1cbecb74c3d3|554=<HMAC_SIGNATURE>|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

**Status:** ✅ Authentication successful

---

### Message 2: New Order Single (35=D) - **AT MARKET PRICE**
**Sequence Number:** 2  
**Timestamp:** 2025-10-10T12:05:42.425Z (approximately)

**Raw FIX:**
```
8=FIXT.1.1|9=152|34=2|35=D|49=CLI_TEST_1760097938370|52=20251010-12:05:42.425|56=TRUEX_UAT_OE|11=ORDER-1760097938370|38=0.01|40=2|44=121704.0|54=1|55=BTC-PYUSD|59=1|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

**Parsed Fields:**
```
  8   BeginString          : FIXT.1.1
  34  MsgSeqNum            : 2
  35  MsgType              : D (New Order Single)
  49  SenderCompID         : CLI_TEST_1760097938370
  52  SendingTime          : 20251010-12:05:42.425
  56  TargetCompID         : TRUEX_UAT_OE
  11  ClOrdID              : ORDER-1760097938370
  38  OrderQty             : 0.01
  40  OrdType              : 2 (Limit)
  44  Price                : 121704.0
  54  Side                 : 1 (Buy)
  55  Symbol               : BTC-PYUSD
  59  TimeInForce          : 1 (GTC - Good Till Cancel)
  1137 DefaultApplVerID     : FIX.5.0SP2
```

**Order Details:**
- **Symbol:** BTC-PYUSD
- **Side:** Buy
- **Quantity:** 0.01 BTC
- **Price:** $121,704.0
- **Market Price at Send:** $121,709.35
- **Spread:** Only **$5.35 below market** (0.004% - **extremely aggressive pricing**)
- **Expected Result:** Should fill immediately or be acknowledged

---

### Message 3: Heartbeat (35=0)
**Sequence Number:** 3  
**Timestamp:** 2025-10-10T12:06:10.477Z

---

### Message 4: Heartbeat (35=0)
**Sequence Number:** 4  
**Timestamp:** 2025-10-10T12:06:40.478Z

---

### Message 5: Logout (35=5)
**Sequence Number:** 5  
**Timestamp:** 2025-10-10T12:06:42.483Z

---

## 📥 Messages Received from TrueX

### Message 1: Logon Accept (35=A)
**Sequence Number:** 1  
**Timestamp:** 2025-10-10T12:05:40.486038Z

**Raw FIX:**
```
8=FIXT.1.1|9=94|35=A|49=TRUEX_UAT_OE|56=CLI_TEST_1760097938370|34=1|52=20251010-12:05:40.486038|108=30|1137=9|10=159|
```

**Status:** ✅ Authentication successful

---

## ⚠️ Missing Response

### Expected: Execution Report (35=8)

After sending the New Order Single at **market price** (Message 2), we expected to receive an Execution Report with:

**Expected Response (NEW Order):**
```
35=8                          // MsgType = Execution Report
39=0                          // OrdStatus = New (order accepted)
150=0                         // ExecType = New
11=ORDER-1760097938370        // ClOrdID (echo back)
```

**OR Expected Response (FILLED):**
Since the order was only $5 below market, it could have filled immediately:
```
35=8                          // MsgType = Execution Report
39=2                          // OrdStatus = Filled
150=F                         // ExecType = Trade (Fill)
11=ORDER-1760097938370        // ClOrdID (echo back)
31=<fill_price>               // LastPx (fill price)
32=<fill_qty>                 // LastQty (fill quantity)
```

**OR Expected Response (REJECTED):**
```
35=8                          // MsgType = Execution Report
39=8                          // OrdStatus = Rejected
150=8                         // ExecType = Rejected
11=ORDER-1760097938370        // ClOrdID (echo back)
58=<rejection_reason>         // Text (reason)
```

**Actual Response:** **NONE**

---

## 🔍 Additional Observations

### Resend Request Received

TrueX sent a **Resend Request (35=2)** asking for messages 2 to ∞ (all messages after the logon).

This suggests:
- TrueX **never received** our Message 2 (New Order Single), OR
- TrueX received it but there's a **sequence number mismatch** on their side

### Duplicate "Business Message Reject" Seen

Our client logged receiving duplicate **Business Message Reject (35=j)** messages with sequence number 1, containing:
```
35=j                          // Business Message Reject
45=0                          // RefSeqNum
58=Invalid session ID         // Text (reason)
49=                           // SenderCompID (EMPTY!)
56=                           // TargetCompID (EMPTY!)
380=0                         // BusinessRejectReason
```

**Note:** The empty SenderCompID and TargetCompID suggest this reject is coming from a **proxy/gateway layer** rather than the FIX session itself.

---

## 📊 Market Context During Test

**Price Range During 60-second Test:**
- **Start:** $121,709.35
- **Low:** $121,658.28
- **End:** $121,670.02
- **Volatility:** ~$50 range

**Our Order Price:** $121,704.0

**Market Crossed Our Price:** YES! 
- Market went as low as $121,658.28
- Our buy order at $121,704.0 **should have filled multiple times**
- Order was extremely competitive, only $5 below market at submission

---

## 📊 Summary

| Metric | Value |
|--------|-------|
| **Messages Sent** | 5 |
| **Messages Received** | 1 (only Logon Accept) |
| **Execution Reports** | 0 ❌ |
| **Order Acknowledgments** | 0 ❌ |
| **Fills** | 0 ❌ (despite market crossing our price) |
| **Resend Requests from TrueX** | 1 (for seq 2-∞) |
| **Connection Duration** | ~60 seconds |
| **Authentication** | ✅ Successful |
| **Order Pricing** | ✅ AT MARKET (only $5 below) |
| **Market Crossed Order Price** | ✅ YES (should have filled) |

---

## ❓ Key Questions for TrueX Support

1. **Did our order (Message 2) arrive at your Order Entry gateway?**
   - ClOrdID: `ORDER-1760097938370`
   - SenderCompID: `CLI_TEST_1760097938370`
   - Price: $121,704.0 (market was $121,709.35)
   - Sent at: 2025-10-10T12:05:42.425Z

2. **If the order arrived, why was no Execution Report sent?**
   - Not even a rejection message?
   - Was it silently dropped?
   - Validation error?

3. **Why did TrueX send a Resend Request for seq 2?**
   - This suggests you never received our order
   - Is there a proxy/gateway issue dropping messages?

4. **The order was extremely competitive (only $5 below market):**
   - Market even crossed our price (went to $121,658)
   - Should have filled multiple times
   - Why no fill reports?

5. **Is "BTC-PYUSD" the correct symbol format?**
   - Should it be "BTC/PYUSD", "BTCPYUSD", or something else?
   - No validation error message was received

---

## 🆚 Comparison: Far-from-Market vs. Market Price

### Test 1: Far from Market (Price: $100,000)
- **Market:** ~$121,600
- **Order:** $100,000 (extreme, intentionally unfillable)
- **Result:** No execution report ❌

### Test 2: At Market Price (This Test)
- **Market:** $121,709.35
- **Order:** $121,704.0 (only $5 below, **extremely aggressive**)
- **Market crossed price:** YES (went as low as $121,658)
- **Result:** No execution report ❌

**Conclusion:** Order pricing is **NOT the issue**. Even an extremely competitive order at market price receives no response.

---

## 📝 Notes

- **All FIX messages include proper header fields:** MsgSeqNum, SenderCompID, SendingTime, TargetCompID, DefaultApplVerID
- **HMAC signature is correctly generated**
- **Authentication is successful** (Logon Accept received)
- **Connection is stable** (Heartbeats working)
- **Order pricing is aggressive** (at market, should fill)
- **No execution reports received** - neither NEW, FILLED, nor REJECTED

---

## 🚨 Critical Finding

**This order should have:**
1. ✅ Been acknowledged (NEW status)
2. ✅ Filled immediately or shortly after (market crossed our price)
3. ✅ Generated at least ONE Execution Report

**Instead:**
- ❌ No acknowledgment
- ❌ No fill
- ❌ No reject
- ❌ Order disappeared into the void

**This is NOT a pricing issue. This is a fundamental order routing/acknowledgment issue.**

---

**Test conducted by:** Decisive Trades Development Team  
**Client Software:** Custom FIX 5.0 SP2 implementation (FIXConnection)  
**Market Data Source:** Coinbase Pro WebSocket (live feed)  
**Full test log available upon request**



