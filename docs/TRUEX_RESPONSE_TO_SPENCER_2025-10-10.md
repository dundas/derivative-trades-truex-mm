# Response to Spencer - TrueX Market Data Request Issue

**Date:** October 10, 2025  
**Subject:** Market Data Request on Order Entry Gateway

---

## 📧 **Spencer's Feedback**

> "We getting a 35=V message on the order entry gateway which is causing all the other messages to get queued due to what appears to be a skipped message (seqnum 2), you'll need to send the market data messages to the MD FGP @ 10.10.20.11:20484"

---

## ✅ **Our Response**

Hi Spencer,

Thanks for the quick feedback! We've investigated the Market Data Request (35=V) issue and have clarified a few things:

### 1. Market Data Request Source

**The 35=V message is likely from an older test session that's still active on your side.**

We ran two separate tests today:
- **Test A**: Simple order placement test - sends ONLY orders, NO market data subscription
- **Test B**: Full market maker test - sends both orders AND market data subscription

**Test A (Order Only)** never sends 35=V:
```
Seq 1: Logon (35=A) ✅
Seq 2: New Order Single (35=D) ✅
Seq 3: Heartbeat (35=0) ✅
... more orders, NO 35=V sent
```

**Test B (Full Market Maker)** does send 35=V, but to the wrong endpoint:
```
Seq 1: Logon to TRUEX_UAT_OE (35=A) ✅
Seq 2: Market Data Request to TRUEX_UAT_MD (35=V) ❌ Wrong endpoint!
Seq 3-52: Orders to TRUEX_UAT_OE (35=D) ✅
```

### 2. The "Invalid Session ID" Issue

We're receiving this reject message:
```
35=j (Business Message Reject)
58=Invalid session ID
49= (EMPTY SenderCompID)
56= (EMPTY TargetCompID)
```

**Key observation:** The empty SenderCompID/TargetCompID suggests this reject is coming from a **proxy/gateway layer** rather than the FIX session itself.

This might be coming from:
- A stale session from previous tests
- The DigitalOcean proxy forwarding layer
- TrueX's gateway before it reaches the FIX session handler

### 3. Our Action Plan

We'll separate Market Data and Order Entry into **completely independent connections**:

**Connection 1: Order Entry ONLY**
- Host: DigitalOcean proxy → `10.10.20.11:19484` (OE FGP)
- TargetCompID: `TRUEX_UAT_OE`
- Purpose: Orders only (35=D, 35=F for amend, 35=G for cancel)
- **NO Market Data Requests on this connection**

**Connection 2: Market Data ONLY**
- Host: DigitalOcean proxy → `10.10.20.11:20484` (MD FGP)
- TargetCompID: `TRUEX_UAT_MD`
- Purpose: Market data subscription (35=V) and updates
- **NO Orders on this connection**

### 4. Request for Your Help

Could you please:

1. **Clear any stale sessions** for `CLI_CLIENT` SenderCompID?
2. **Confirm you see our orders arriving** at the OE gateway (seq 2-52 from recent test)?
3. **Verify our order format** - Are there any validation errors causing silent rejection?

We're not receiving execution reports (35=8) for any orders - neither accepts (ExecType=0) nor rejects (ExecType=8). The orders seem to disappear without acknowledgment.

### 5. What We've Fixed on Our Side

We discovered and fixed a critical bug in our new FIX client where non-logon messages were missing standard header fields:
- ✅ Added Field 34 (MsgSeqNum)
- ✅ Added Field 49 (SenderCompID)
- ✅ Added Field 52 (SendingTime)
- ✅ Added Field 56 (TargetCompID)
- ✅ Added Field 1137 (DefaultApplVerID)

All orders now have proper FIX formatting.

---

## 📋 **Example Order Message (After Fix)**

```
8=FIXT.1.1|9=151|11=TEST-ORDER-001|34=2|35=D|38=0.01|40=2|44=50000|
49=CLI_1760096240833|52=20251010-11:37:24.933|54=1|55=BTC-PYUSD|
56=TRUEX_UAT_OE|59=1|1137=FIX.5.0SP2|10=171|
```

All required fields are present:
- ✅ MsgSeqNum (34=2)
- ✅ SenderCompID (49=CLI_1760096240833)
- ✅ SendingTime (52=20251010-11:37:24.933)
- ✅ TargetCompID (56=TRUEX_UAT_OE)
- ✅ Symbol (55=BTC-PYUSD)
- ✅ Side (54=1 for Buy)
- ✅ Price (44=50000)
- ✅ Quantity (38=0.01)

---

## 🔄 **Next Test Plan**

We'll run a new test with:
1. **Fresh SenderCompID** (e.g., `CLI_TEST_20251010`)
2. **Order Entry connection ONLY** - No market data subscription
3. **Send 1-2 orders** instead of 50 to keep it simple
4. **Monitor for execution reports**

Once we confirm Order Entry works, we'll add the separate Market Data connection to `10.10.20.11:20484`.

---

## ❓ **Questions for TrueX Team**

1. **Are you seeing our orders arrive at your OE gateway?**
2. **Are orders being rejected for validation reasons?** (If so, what's the reason?)
3. **Is there a session limit or rate limit** we might be hitting?
4. **Should we use a different authentication method** for the MD endpoint vs OE endpoint?

---

## 📊 **Current Status**

- ✅ **FIX Client**: Working correctly, both old and new versions
- ✅ **Authentication**: Successful (Logon Accept received)
- ✅ **Order Format**: Proper FIX headers, all required fields
- ✅ **Connection Stability**: Heartbeats working, no disconnects
- ❌ **Execution Reports**: Not receiving any (neither accepts nor rejects)
- ⚠️ **Market Data**: Will move to separate endpoint as recommended

---

## 🙏 **Thank You**

Thanks for the guidance on separating Order Entry and Market Data endpoints. We'll implement the dual-connection setup and run a clean test with a fresh session.

Looking forward to your feedback on whether you're seeing our orders arrive!

Best regards,  
Decisive Trades Team



