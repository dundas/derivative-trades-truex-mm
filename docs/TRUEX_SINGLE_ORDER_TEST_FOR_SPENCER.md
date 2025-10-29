# TrueX Single Order Test - For Support Review

**Test Date:** October 10, 2025  
**Test Time:** 11:53:35 UTC  
**SenderCompID:** CLI_TEST_1760097215797  
**TargetCompID:** TRUEX_UAT_OE

---

## 📋 Test Configuration

```
SenderCompID:     CLI_TEST_1760097215797
TargetCompID:     TRUEX_UAT_OE
Proxy Host:       129.212.145.83
Proxy Port:       3004
API Key:          89720766-9b45-4407-93b8-1cbecb74c3d3
Symbol:           BTC-PYUSD
```

---

## 📤 Messages Sent to TrueX

### Message 1: Logon (35=A)
**Sequence Number:** 1  
**Timestamp:** 2025-10-10T11:53:37.848Z

**Raw FIX:**
```
8=FIXT.1.1|9=196|34=1|35=A|49=CLI_TEST_1760097215797|52=20251010-11:53:37.848|56=TRUEX_UAT_OE|98=0|108=30|141=Y|553=89720766-9b45-4407-93b8-1cbecb74c3d3|554=<HMAC_SIGNATURE>|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

**Parsed Fields:**
```
  8   BeginString          : FIXT.1.1
  34  MsgSeqNum            : 1
  35  MsgType              : A (Logon)
  49  SenderCompID         : CLI_TEST_1760097215797
  52  SendingTime          : 20251010-11:53:37.848
  56  TargetCompID         : TRUEX_UAT_OE
  98  EncryptMethod        : 0 (None)
  108 HeartBtInt           : 30
  141 ResetSeqNumFlag      : Y (Yes - reset sequence numbers)
  553 Username             : 89720766-9b45-4407-93b8-1cbecb74c3d3
  554 Password             : <HMAC_SIGNATURE>
  1137 DefaultApplVerID     : FIX.5.0SP2
```

---

### Message 2: New Order Single (35=D)
**Sequence Number:** 2  
**Timestamp:** 2025-10-10T11:53:39.850Z (approximately)

**Raw FIX:**
```
8=FIXT.1.1|9=151|34=2|35=D|49=CLI_TEST_1760097215797|52=20251010-11:53:39.850|56=TRUEX_UAT_OE|11=ORDER-1760097215797|38=0.01|40=2|44=100000|54=1|55=BTC-PYUSD|59=1|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

**Parsed Fields:**
```
  8   BeginString          : FIXT.1.1
  34  MsgSeqNum            : 2
  35  MsgType              : D (New Order Single)
  49  SenderCompID         : CLI_TEST_1760097215797
  52  SendingTime          : 20251010-11:53:39.850
  56  TargetCompID         : TRUEX_UAT_OE
  11  ClOrdID              : ORDER-1760097215797
  38  OrderQty             : 0.01
  40  OrdType              : 2 (Limit)
  44  Price                : 100000
  54  Side                 : 1 (Buy)
  55  Symbol               : BTC-PYUSD
  59  TimeInForce          : 1 (GTC - Good Till Cancel)
  1137 DefaultApplVerID     : FIX.5.0SP2
```

**Order Details:**
- **Symbol:** BTC-PYUSD
- **Side:** Buy
- **Quantity:** 0.01 BTC
- **Price:** $100,000 (intentionally far from market to prevent fill)
- **Order Type:** Limit
- **Time in Force:** Good Till Cancel

---

### Message 3: Heartbeat (35=0)
**Sequence Number:** 3  
**Timestamp:** 2025-10-10T11:54:07.906Z

**Raw FIX:**
```
8=FIXT.1.1|9=88|34=3|35=0|49=CLI_TEST_1760097215797|52=20251010-11:54:07.906|56=TRUEX_UAT_OE|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

**Note:** This was sent automatically as part of the heartbeat interval.

---

### Message 4: Heartbeat (35=0)
**Sequence Number:** 4  
**Timestamp:** 2025-10-10T11:54:37.908Z

**Raw FIX:**
```
8=FIXT.1.1|9=88|34=4|35=0|49=CLI_TEST_1760097215797|52=20251010-11:54:37.908|56=TRUEX_UAT_OE|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

---

### Message 5: Logout (35=5)
**Sequence Number:** 5  
**Timestamp:** 2025-10-10T11:54:39.908Z

**Raw FIX:**
```
8=FIXT.1.1|9=88|34=5|35=5|49=CLI_TEST_1760097215797|52=20251010-11:54:39.908|56=TRUEX_UAT_OE|1137=FIX.5.0SP2|10=<CHECKSUM>|
```

---

## 📥 Messages Received from TrueX

### Message 1: Logon Accept (35=A)
**Sequence Number:** 1  
**Timestamp:** 2025-10-10T11:53:37.912159Z

**Raw FIX:**
```
8=FIXT.1.1|9=94|35=A|49=TRUEX_UAT_OE|56=CLI_TEST_1760097215797|34=1|52=20251010-11:53:37.912159|108=30|1137=9|10=166|
```

**Parsed Fields:**
```
  8   BeginString          : FIXT.1.1
  9   BodyLength           : 94
  34  MsgSeqNum            : 1
  35  MsgType              : A (Logon)
  49  SenderCompID         : TRUEX_UAT_OE
  52  SendingTime          : 20251010-11:53:37.912159
  56  TargetCompID         : CLI_TEST_1760097215797
  108 HeartBtInt           : 30
  1137 DefaultApplVerID     : 9
  10  CheckSum             : 166
```

**Status:** ✅ Authentication successful

---

## ⚠️ Missing Response

### Expected: Execution Report (35=8)

After sending the New Order Single (Message 2), we expected to receive an Execution Report with:

**Expected Response:**
```
35=8                          // MsgType = Execution Report
39=0 or 8                     // OrdStatus = New or Rejected
150=0 or 8                    // ExecType = New or Rejected
11=ORDER-1760097215797        // ClOrdID (echo back)
```

**Actual Response:** **NONE**

---

## 🔍 Additional Observations

### Resend Request Received

Our client logged that TrueX sent a **Resend Request (35=2)** asking for messages 2 to ∞ (all messages after the logon).

This suggests:
- TrueX never received our Message 2 (New Order Single), OR
- TrueX received it but there's a sequence number mismatch

### Duplicate "Business Message Reject" Seen

Our client also logged receiving duplicate **Business Message Reject (35=j)** messages with sequence number 1, containing:
```
35=j                          // Business Message Reject
45=0                          // RefSeqNum
58=Invalid session ID         // Text (reason)
49=                           // SenderCompID (EMPTY!)
56=                           // TargetCompID (EMPTY!)
380=0                         // BusinessRejectReason
```

**Note:** The empty SenderCompID and TargetCompID suggest this reject is coming from a proxy/gateway layer rather than the FIX session itself.

---

## 📊 Summary

| Metric | Value |
|--------|-------|
| **Messages Sent** | 5 |
| **Messages Received** | 1 (only Logon Accept) |
| **Execution Reports** | 0 ❌ |
| **Order Acknowledgments** | 0 ❌ |
| **Resend Requests from TrueX** | 1 (for seq 2-∞) |
| **Connection Duration** | ~60 seconds |
| **Authentication** | ✅ Successful |

---

## ❓ Questions for TrueX Support

1. **Did our order (Message 2) arrive at your Order Entry gateway?**
   - ClOrdID: `ORDER-1760097215797`
   - SenderCompID: `CLI_TEST_1760097215797`
   - Sent at: 2025-10-10T11:53:39.850Z

2. **If the order arrived, why was no Execution Report sent?**
   - Was it rejected for validation reasons?
   - If rejected, what was the rejection reason?

3. **What caused TrueX to send a Resend Request for seq 2?**
   - Did you not receive it, or was there a sequence number issue?

4. **What is the "Invalid session ID" Business Message Reject?**
   - It has empty SenderCompID/TargetCompID
   - Is this coming from a different layer than the FIX session?

5. **Are there any silent validation failures?**
   - Symbol format (should it be BTC-PYUSD, BTC/PYUSD, or something else)?
   - Price format (is 100000 acceptable)?
   - Any missing required fields?

---

## 📝 Notes

- **All FIX messages include proper header fields:** MsgSeqNum, SenderCompID, SendingTime, TargetCompID, DefaultApplVerID
- **HMAC signature is correctly generated** using: `sendingTime + msgType + msgSeqNum + senderCompID + targetCompID + username`
- **Authentication is successful** (Logon Accept received)
- **Connection is stable** (Heartbeats working)
- **No execution reports received** for any orders

---

**Test conducted by:** Decisive Trades Development Team  
**Client Software:** Custom FIX 5.0 SP2 implementation (FIXConnection)  
**Full test log available upon request**



