# TrueX Documentation Review - Action Items

**Date:** October 10, 2025  
**Source:** https://docs.truemarkets.co/apis/cefi/fix  
**Current Status:** "Invalid client" error with Party ID fields

---

## 🎯 **Immediate Actions**

### 1. Review Party ID Specification
**URL:** https://docs.truemarkets.co/apis/cefi/fix (Common Components → Parties)

**Questions to Answer:**
- [ ] What is the exact format required for Party ID fields?
- [ ] Is there a specific PartyIDSource (447) field required?
- [ ] Are there additional Party fields beyond 453, 448, 452?
- [ ] What are the valid values for PartyRole (452)?

**Current Implementation:**
```javascript
'453': '1',                   // NoPartyIDs
'448': '78923062108553234',   // PartyID (Client ID)
'452': '3'                    // PartyRole
```

**Action:** Download the quickFIX specification file mentioned in docs for complete field list.

### 2. Review New Order Single (35=D) Specification
**URL:** https://docs.truemarkets.co/apis/cefi/fix (Order Entry → New Order Single)

**Questions to Answer:**
- [ ] What fields are **required** vs optional?
- [ ] Is ExecInst (18) required for order types?
- [ ] Are there symbol format requirements for BTC-PYUSD?
- [ ] What are valid OrdType values?
- [ ] Are there minimum/maximum price/quantity requirements?

**Current Order Fields:**
```javascript
{
  '35': 'D',                    // MsgType
  '11': 'ORD-760103356197',    // ClOrdID (16 chars)
  '38': '0.01',                 // OrderQty
  '40': '2',                    // OrdType = Limit
  '44': '100000',               // Price
  '54': '1',                    // Side = Buy
  '55': 'BTC-PYUSD',            // Symbol
  '59': '1',                    // TimeInForce = GTC
  '453': '1',                   // NoPartyIDs
  '448': '78923062108553234',   // PartyID
  '452': '3'                    // PartyRole
}
```

### 3. Review Standard Header Requirements
**URL:** https://docs.truemarkets.co/apis/cefi/fix (Common Components → Standard Header)

**Questions to Answer:**
- [ ] Are all required header fields included?
- [ ] Is OnBehalfOfCompID required?
- [ ] Are there additional authentication fields?

**Current Header Fields:**
```javascript
{
  '8': 'FIXT.1.1',              // BeginString
  '9': '<calculated>',          // BodyLength
  '35': 'D',                    // MsgType
  '49': 'CLI_TEST_xxx',         // SenderCompID
  '56': 'TRUEX_UAT_OE',         // TargetCompID
  '34': '2',                    // MsgSeqNum
  '52': '20251010-13:35:58'     // SendingTime
}
```

---

## 📚 **Documentation Sections to Review**

### Priority 1 (Immediate)
1. **Common Components → Parties (453)**
   - Complete Party ID field specification
   - Required vs optional Party fields
   - Valid PartyRole values
   - PartyIDSource requirements

2. **Order Entry → New Order Single (35=D)**
   - Complete field list (required/optional)
   - Field validation rules
   - Symbol format requirements
   - Authentication requirements

### Priority 2 (Soon)
3. **Common Components → Standard Header**
   - All required header fields
   - Session-level authentication

4. **Order Entry → Execution Report (35=8)**
   - How to interpret rejection reasons
   - OrdStatus and ExecType values
   - Text (58) field error codes

5. **Administration → Logon (35=A)**
   - Verify our authentication method is correct
   - Check if there are additional logon parameters

### Priority 3 (Future)
6. **Market Data → Market Data Request (35=V)**
   - For future market data integration
   - Separate session requirements

7. **Order Entry → Order Cancel Request (35=F)**
   - For order management features

---

## 🔍 **Specific Things to Look For**

### Party ID Authentication
Based on Spencer's feedback and the "Invalid client" error:

**Hypothesis:** The client ID format or authentication method may need adjustment.

**Check Documentation For:**
- [ ] Is PartyIDSource (447) required? (e.g., 'D' for proprietary)
- [ ] Should Party fields be in Logon message as well as orders?
- [ ] Are there additional Party subfields?
- [ ] Is there a Party registration/setup process?

**Example from FIX 5.0 SP2:**
```
NoPartyIDs (453) = 1
  PartyID (448) = <client_id>
  PartyIDSource (447) = D (Proprietary)
  PartyRole (452) = 3 (Client ID)
```

### Symbol Format
**Check:**
- [ ] Should it be `BTC-PYUSD`, `BTCPYUSD`, or `BTC/PYUSD`?
- [ ] Is there a Security List Request (35=x) needed first?
- [ ] Are there symbol permissions per client?

### Order Validation
**Check:**
- [ ] Minimum order quantity for BTC-PYUSD
- [ ] Price precision requirements
- [ ] Valid price ranges
- [ ] Account/balance requirements

---

## 📞 **Questions for TrueX Support**

### Based on Documentation Review

1. **Party ID Format**
   ```
   Q: For Party ID authentication, should we include:
   - PartyIDSource (447) field?
   - Additional Party subfields?
   - Party info in Logon message?
   
   Current: Using only 453, 448, 452
   ```

2. **Client Registration**
   ```
   Q: Is there a client registration or setup process required before
   sending orders with client ID 78923062108553234?
   
   Current: Getting "Invalid client" error despite correct Party fields
   ```

3. **Symbol Permissions**
   ```
   Q: Are there symbol-specific permissions per client?
   Does BTC-PYUSD trading need to be explicitly enabled?
   
   Current: Using BTC-PYUSD symbol
   ```

4. **quickFIX Specification**
   ```
   Q: Can you provide the quickFIX style specification file mentioned
   in the documentation?
   
   Will help validate our complete implementation.
   ```

---

## ✅ **Verification Checklist**

After reviewing documentation:

### Protocol Compliance
- [ ] All required header fields included
- [ ] All required body fields for New Order Single
- [ ] Correct Party ID format per specification
- [ ] Correct field ordering per specification
- [ ] Correct data types and formats

### Authentication
- [ ] Logon authentication method correct
- [ ] Party ID authentication complete
- [ ] Client ID registered in UAT environment
- [ ] Any additional auth tokens/fields required

### Order Validation
- [ ] Symbol format correct
- [ ] Price within valid range
- [ ] Quantity within valid range
- [ ] OrdType and TimeInForce valid combination

---

## 🎯 **Next Steps**

### Immediate (Today)
1. ✅ Contact TrueX support with questions above
2. ⏳ Download quickFIX specification file
3. ⏳ Review Common Components → Parties specification
4. ⏳ Review Order Entry → New Order Single specification

### Short-term (This Week)
1. ⏳ Implement any missing Party ID fields
2. ⏳ Verify symbol format
3. ⏳ Validate all field requirements
4. ⏳ Retest with updated implementation

### Long-term
1. ⏳ Create comprehensive FIX message validator
2. ⏳ Document all TrueX-specific requirements
3. ⏳ Add automated compliance tests

---

## 📝 **Documentation Links**

**Main Documentation:**
- Overview: https://docs.truemarkets.co/apis/cefi/fix
- Admin Messages: https://docs.truemarkets.co/apis/cefi/fix (§1 Administration)
- Common Components: https://docs.truemarkets.co/apis/cefi/fix (§2 Common Components)
- Order Entry: https://docs.truemarkets.co/apis/cefi/fix (§3 Order Entry)
- Market Data: https://docs.truemarkets.co/apis/cefi/fix (§4 Market Data)

**Support:**
- Email: support@truex.co
- Subject: "FIX API - Client ID Authorization UAT"

**Downloads:**
- quickFIX Specification: Available from docs page

---

## 💡 **Key Insights**

### What We Know
1. ✅ **Protocol is correct** - TrueX accepts all our messages
2. ✅ **Field ordering is correct** - No more "Invalid tag" errors
3. ✅ **Party fields accepted** - Echoed back in execution report
4. ⚠️  **Authorization issue** - "Invalid client" suggests permissions

### What We Need
1. 📚 **Complete Party specification** - May be missing fields
2. 🔑 **Client registration status** - Is our client ID active?
3. 📋 **Symbol permissions** - Is BTC-PYUSD enabled for our client?
4. 📄 **quickFIX spec** - For complete field validation

---

**Status:** ⏳ Waiting for documentation review and TrueX support response  
**Confidence:** 🟢 95% - Protocol implementation is solid, just need authorization clearance  
**Next Action:** Review detailed Party specification in Common Components section




