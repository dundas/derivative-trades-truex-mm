# TrueX FIX New Order Single (35=D) Message Specification

**Protocol:** FIXT.1.1 / FIX.5.0SP2  
**Message Type:** D (New Order Single)  
**Source:** `src/services/market-maker/truex/proxy/fix-message-builder.cjs`

---

## 📋 Field Order (CRITICAL)

**The field order MUST be strictly followed per TrueX specification and Spencer's corrections.**

### Standard Header (Always First)
```
8   BeginString          FIXT.1.1
9   BodyLength           <calculated>
```

### Message Fields (In This Exact Order)
```
35  MsgType              D (New Order Single)
49  SenderCompID         CLI_TEST_1760097938370 (or your client ID)
56  TargetCompID         TRUEX_UAT_OE
34  MsgSeqNum            1, 2, 3, ... (incremental)
52  SendingTime          YYYYMMDD-HH:MM:SS.sss (UTC)
```

### Order-Specific Fields (In This Exact Order)
```
11  ClOrdID              Client Order ID (unique per order)
18  ExecInst             6 (Add Liquidity Only - for market making)
55  Symbol               BTC-PYUSD
54  Side                 1=Buy, 2=Sell
38  OrderQty             0.01 (quantity in base currency)
40  OrdType              1=Market, 2=Limit
44  Price                121704.0 (required for limit orders, omit for market)
59  TimeInForce          1=GTC, 3=IOC, 4=FOK
```

### Party ID Fields (CRITICAL ORDER - Per Spencer)
```
453 NoPartyIDs           1 (must be 1) - FIRST
448 PartyID              78923062108553234 (your client party ID) - SECOND
452 PartyRole            3 (Client ID) - THIRD
```

### Trailer (Always Last)
```
10  CheckSum             <calculated>
```

---

## 📝 Complete Example

### Formatted View
```
8=FIXT.1.1
9=152
35=D
49=CLI_TEST_1760097938370
56=TRUEX_UAT_OE
34=2
52=20251010-12:05:42.425
11=ORDER-1760097938370
18=6
55=BTC-PYUSD
54=1
38=0.01
40=2
44=121704.0
59=1
453=1
448=78923062108553234
452=3
10=171
```

### Raw FIX (Pipe-Delimited for Display)
```
8=FIXT.1.1|9=152|35=D|49=CLI_TEST_1760097938370|56=TRUEX_UAT_OE|34=2|52=20251010-12:05:42.425|11=ORDER-1760097938370|18=6|55=BTC-PYUSD|54=1|38=0.01|40=2|44=121704.0|59=1|453=1|448=78923062108553234|452=3|10=171|
```

**Note:** In actual FIX messages, `|` is replaced with SOH (Start of Header, ASCII 0x01)

---

## 🔍 Field Definitions

### Header Fields

| Tag | Name | Type | Description | Example |
|-----|------|------|-------------|---------|
| 8 | BeginString | String | FIX protocol version | FIXT.1.1 |
| 9 | BodyLength | int | Length of message body (excluding header 8,9 and trailer 10) | 152 |
| 35 | MsgType | char | Message type | D (New Order Single) |
| 49 | SenderCompID | String | Sender's unique identifier | CLI_TEST_1760097938370 |
| 56 | TargetCompID | String | Target system identifier | TRUEX_UAT_OE |
| 34 | MsgSeqNum | int | Message sequence number | 2 |
| 52 | SendingTime | UTCTimestamp | Time of message transmission | 20251010-12:05:42.425 |

### Order Fields

| Tag | Name | Type | Description | Values |
|-----|------|------|-------------|--------|
| 11 | ClOrdID | String | Client order ID (must be unique) | ORDER-1760097938370 |
| 18 | ExecInst | MultipleCharValue | Execution instructions | 6 = Add Liquidity Only |
| 55 | Symbol | String | Trading symbol | BTC-PYUSD |
| 54 | Side | char | Order side | 1=Buy, 2=Sell |
| 38 | OrderQty | Qty | Order quantity | 0.01 |
| 40 | OrdType | char | Order type | 1=Market, 2=Limit |
| 44 | Price | Price | Order price (required for limit) | 121704.0 |
| 59 | TimeInForce | char | Time in force | 1=GTC, 3=IOC, 4=FOK |

### Party ID Fields (CRITICAL)

| Tag | Name | Type | Description | Value |
|-----|------|------|-------------|-------|
| 453 | NoPartyIDs | NumInGroup | Number of party IDs | 1 (always 1) |
| 448 | PartyID | String | Party identifier | 78923062108553234 |
| 452 | PartyRole | int | Party role | 3 (Client ID) |

**⚠️ CRITICAL:** Fields 453, 448, 452 MUST appear in this exact order per TrueX specification.

### Trailer

| Tag | Name | Type | Description | Calculation |
|-----|------|------|-------------|-------------|
| 10 | CheckSum | String | Message checksum (3 digits, zero-padded) | Sum of all bytes % 256 |

---

## 🚨 Common Mistakes to Avoid

### 1. ❌ Wrong Field Order
**Problem:** Fields in wrong order (e.g., Party ID fields out of sequence)  
**Solution:** Follow `ORDER_FIELD_ORDER` constant exactly

### 2. ❌ Missing Standard Headers
**Problem:** Missing MsgSeqNum, SenderCompID, SendingTime  
**Solution:** Always include fields 34, 49, 52, 56

### 3. ❌ Wrong Party ID Ordering
**Problem:** Fields 448, 453, 452 in wrong order  
**Solution:** MUST be 453 → 448 → 452 (NoPartyIDs first, then PartyID, then PartyRole)

### 4. ❌ Including Authentication in Orders
**Problem:** Including Username (553) and Password (554) in order messages  
**Solution:** Authentication is ONLY for Logon (35=A), NOT for orders

### 5. ❌ Incorrect TimeInForce Values
**Problem:** Using TIF=0 (Day) when GTC is intended  
**Solution:** Use 1=GTC for Good Till Cancel orders

---

## 📚 Code Reference

### Building New Order Single
```javascript
// From: src/services/market-maker/truex/proxy/fix-message-builder.cjs

const ORDER_FIELD_ORDER = [
  '35', // MsgType
  '49', // SenderCompID
  '56', // TargetCompID
  '34', // MsgSeqNum
  '52', // SendingTime
  '11', // ClOrdID
  '18', // ExecInst
  '55', // Symbol
  '54', // Side
  '38', // OrderQty
  '40', // OrdType
  '44', // Price
  '59', // TimeInForce
  '453', // NoPartyIDs (FIRST)
  '448', // PartyID (SECOND)
  '452'  // PartyRole (THIRD)
];

function buildNewOrderSingle(apiKey, apiSecret, orderData, msgSeqNum, partyID, senderCompID, targetCompID) {
  const orderFields = {
    8: 'FIXT.1.1',
    35: 'D',
    49: senderCompID,
    56: targetCompID,
    34: msgSeqNum,
    52: getSendingTime(),
    11: orderData.clOrdID,
    18: '6',
    55: orderData.symbol,
    54: orderData.side,
    38: String(orderData.orderQty),
    40: orderData.ordType,
    44: orderData.price ? orderData.price.toString() : undefined,
    59: orderData.timeInForce,
    453: '1',
    448: partyID,
    452: '3'
  };
  
  // Build message in ORDER_FIELD_ORDER sequence
  let body = '';
  for (const tag of ORDER_FIELD_ORDER) {
    if (orderFields[tag]) {
      body += `${tag}=${orderFields[tag]}${SOH}`;
    }
  }
  
  orderFields['9'] = body.length.toString();
  
  return createOrderMessage(orderFields);
}
```

---

## 🔄 Side-by-Side Comparison: Our Order vs Expected

### What We Sent (Test 2)
```
8=FIXT.1.1|9=152|35=D|49=CLI_TEST_1760097938370|56=TRUEX_UAT_OE|
34=2|52=20251010-12:05:42.425|11=ORDER-1760097938370|38=0.01|
40=2|44=121704.0|54=1|55=BTC-PYUSD|59=1|1137=FIX.5.0SP2|10=171|
```

### Issues Found
1. ❌ **Missing ExecInst (18)** - Should be '6' for Add Liquidity Only
2. ❌ **Missing Party ID fields (453, 448, 452)** - Required for order authentication
3. ⚠️ **Field 1137 (DefaultApplVerID)** - Should be in header, not body

### Corrected Order (What It Should Be)
```
8=FIXT.1.1|9=192|35=D|49=CLI_TEST_1760097938370|56=TRUEX_UAT_OE|
34=2|52=20251010-12:05:42.425|11=ORDER-1760097938370|18=6|
55=BTC-PYUSD|54=1|38=0.01|40=2|44=121704.0|59=1|
453=1|448=78923062108553234|452=3|10=<CHECKSUM>|
```

---

## ✅ Validation Checklist

Before sending an order, verify:

- [ ] BeginString (8) = FIXT.1.1
- [ ] MsgType (35) = D
- [ ] SenderCompID (49) is set
- [ ] TargetCompID (56) = TRUEX_UAT_OE
- [ ] MsgSeqNum (34) is correct and incremental
- [ ] SendingTime (52) is in correct format
- [ ] ClOrdID (11) is unique
- [ ] **ExecInst (18) = 6** (if market making)
- [ ] Symbol (55) is valid (e.g., BTC-PYUSD)
- [ ] Side (54) is 1 or 2
- [ ] OrderQty (38) is valid
- [ ] OrdType (40) is set
- [ ] Price (44) is set for limit orders
- [ ] TimeInForce (59) is set
- [ ] **NoPartyIDs (453) = 1**
- [ ] **PartyID (448) is set**
- [ ] **PartyRole (452) = 3**
- [ ] BodyLength (9) is calculated correctly
- [ ] CheckSum (10) is calculated correctly
- [ ] Fields are in `ORDER_FIELD_ORDER` sequence

---

**Last Updated:** October 10, 2025  
**Based On:** Working TrueX FIX implementation in `fix-message-builder.cjs`



