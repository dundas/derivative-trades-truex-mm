**Here are some helpful links to get you set up on our UAT environment to test FIX integration**

1. **Helpful Links**  
   * UAT URL: 38.32.101.229  
     * No need to send us a source IP; to test from a terminal enter `$ telnet 38.32.101.229 19484`  
   * Production URL: [prod.truemarkets.co](http://prod.truemarkets.co)  
   * TrueX Documentation: [docs.truemarkets.co](http://docs.truemarkets.co)  
   * Sample Tools \+ Connectors: https://github.com/true-markets/tools/tree/develop  
2. **Environment**:  
   * Production Environment:  
     * Order Entry Target Comp ID: `TRUEX_PROD_OE`  
     * Market Data Target Comp ID: `TRUEX_PROD_MD`  
   * UAT Environment: Use the UAT credentials provided in the telegram message  
     * Order Entry Target Comp ID: `TRUEX_UAT_OE`  
     * Market Data Target Comp ID: `TRUEX_UAT_MD`  
   * Test Assets available: `BTC` and `PYUSD`  
   * Test Market: `BTC-PYUSD`  
3. **API Documentation**:  
   * FIX protocol uses 5.0SP2 which includes FIXT1.1 specification for the session protocol  
   * Documentation for our FIX API is available [here](https://docs.truemarkets.co/reference/overview)  
   * TrueX FIX XML for easy setup with QuickFIX clients  
     * [TrueX\_FIXT11](https://github.com/true-markets/specification/blob/develop/TrueX_FIXT11.xml)  
     * [TrueX\_FIX50SP2](https://github.com/true-markets/specification/blob/develop/TrueX_FIX50SP2.xml)  
4. **Retrieve Client IDs**:  
   * You will need to periodically retrieve client IDs as they expire  
   * Sample code for retrieving client IDs available [here](https://github.com/true-markets/tools/blob/develop/exchange/rest/get_client_ids.py)  
5. **Logon Configuration**:  
   * **SenderCompID**: Use a custom value instead of your API key.  
   * **Generating Tag 554 on logon**: Sample Python code for generating tag 554 can be found at \[COMING\_SOON\]  
   * Check your config against our example quickfix config:

`[DEFAULT]`  
`ConnectionType=initiator`  
`ReconnectInterval=30`  
`FileStorePath=store`  
`FileLogPath=log`  
`StartTime=00:00:00`  
`EndTime=23:59:59`  
`UseDataDictionary=Y`  
`BeginString=FIXT.1.1`  
`DefaultApplVerID=FIX.5.0SP2`  
`SocketConnectHost=uat.truex.co`  
`SocketConnectPort=19484`  
`HeartBtInt=30`  
`TransportDataDictionary=TrueX_FIXT11.xml`  
`AppDataDictionary=TrueX_FIX50SP2.xml`

`[SESSION]`  
`SenderCompID=[Your custom value]`  
`TargetCompID=TRUEX_UAT_OE`

`[SESSION]`  
`SenderCompID=[Your custom value]`  
`TargetCompID=TRUEX_UAT_MD`

6. **Troubleshooting Tips**:  
   * Ensure all password generation components are strings.  
   * **QuickFIX Requirements**: If you are getting a quickFIX rejection for logon, see our FIXT1.1 and FIX50SP2 XML files at:  
     * [TrueX\_FIXT11](https://github.com/true-markets/specification/blob/develop/TrueX_FIXT11.xml)  
     * [TrueX\_FIX50SP2](https://github.com/true-markets/specification/blob/develop/TrueX_FIX50SP2.xml)  
   * Example password generation:

| `class Application(fix.Application):     def toAdmin(self, message, sessionID):         msg_type = fix.MsgType()         message.getHeader().getField(msg_type)         # Check if the message is a Logon message         if msg_type.getValue() == fix.MsgType_Logon:             self.apiKeyId = os.getenv("TRUEX_KEY_ID")                          # Retrieve SendingTime from the header (Tag 52)             sending_time =  datetime.utcnow().strftime('%Y%m%d-%H:%M:%S.%f')[:-3]             # Retrieve other required fields             msg_type = message.getHeader().getField(fix.MsgType()).getString()  # MsgType (35)             msg_seq_num = message.getHeader().getField(fix.MsgSeqNum()).getString()  # MsgSeqNum (34)             sender_comp_id = message.getHeader().getField(fix.SenderCompID()).getString()  # SenderCompID (49)             target_comp_id = message.getHeader().getField(fix.TargetCompID()).getString()  # TargetCompID (56)             # Generate the HMAC-SHA-256 signature for the password             self.apiKeySecret = os.getenv("TRUEX_KEY_SECRET")             password = self.generate_password(self.apiKeySecret, sending_time, msg_type, msg_seq_num, sender_comp_id, target_comp_id, self.apiKeyId)                          message.getHeader().setField(52, sending_time)             # Set ResetSeqNum             message.setField(fix.ResetSeqNumFlag(True)) # Optional             # Set Username (Tag 553)             message.setField(fix.Username(self.apiKeyId))  # Set tag 553             # Set Password (Tag 554)             message.setField(fix.Password(password))  # Set tag 554     def generate_password(self, secret, sending_time, msg_type, msg_seq_num, sender_comp_id, target_comp_id, username):         # Step 1: Concatenate the fields to form the message         message = str(sending_time) + str(msg_type) + str(msg_seq_num) + str(sender_comp_id) + str(target_comp_id) + str(username)         print(f"Raw SendingTime: {repr(sending_time)}")         print(f"Raw MsgType: {repr(msg_type)}")         print(f"Raw MsgSeqNum: {repr(msg_seq_num)}")         print(f"Raw SenderCompID: {repr(sender_comp_id)}")         print(f"Raw TargetCompID: {repr(target_comp_id)}")         print(f"Raw Username: {repr(username)}")         # Step 2: Handle potential encoding issues         try:             message_bytes = message.encode('utf-8')         except UnicodeEncodeError as e:             print(f"Error encoding message: {e}")             # Optionally, remove invalid characters or log them             message_bytes = message.encode('utf-8', 'ignore')  # or 'replace'              # Step 3: Create the HMAC-SHA-256 signature         secret_bytes = secret.encode('utf-8')         hmac_sha256 = hmac.new(secret_bytes, message_bytes, hashlib.sha256)              # Step 4: Encode the HMAC in base64         signature = base64.b64encode(hmac_sha256.digest()).decode('utf-8')              return signature` |
| :---- |

7. **Notes**  
   * Currently, the fee currency is the quote currency  
   * Seqnums and client IDs are reset when the UAT environment is reset  
   * Self-match prevention defaults to canceling the new order  
   * UAT environment reboots early Saturday (ET) morning for updates

Let us know if any questions arise or if you need additional sample code\!

## Updates 10/1/2025

Updates in our 10/1 release include:

**FIX**

1. Order Entry  
   1. Tag 11 \- ClOrdID \- Only accepts alphanumeric and the following symbols: \_-.\~   
      1. See [RFC3986](https://datatracker.ietf.org/doc/html/rfc3986)  
   2. Tag 880 \- TrdMatchID \- Globally unique ID assigned to a trade  
   3. Tag 2946 \- SelMatchPreventionInstrument \- Set Per Order (Can also be set for all orders via the REST interface)  
      1. 1 \- Cancel Aggressive  
      2. 2 \- Cancel Both  
2. Market Data  
   1. Tag 264 \- MarketDepth \- Number of levels of market data to subscribe to, defaults to 1\.  
      1. 0 \= Full depth (Note: initial snapshot will only return 20 levels on each side).  
      2. 1 \= Top of book (exchange bbo)  
      3. 2+ \= specific book depth  
   2. Tag 273  \- MDEntryTime \- Made optionally returned by exchange, if not returned assume level was updated @ now.  
   3. Tag 1023 \- MDPriceLevel \- Exchange set value one-to-one with each price level in the book  
3. Individual gateways for order entry and market data

**REST**

1. /api/v1/order/trade \- get all trades within the last 28 days \- supports paginations  
2. /api/v1/order \- get all orders within the last 28 days \- supports paginations and advanced queries via mongodb like syntax  
3. /api/v1/market/increment \- get the current exchange’s increment setup

**WebSocket**

1. DEPTH \- Level 2 market data for each symbol trading on the exchange  
2. SUBSCRIBE\_NO\_AUTH \- batched subscription mechanism that does not require authentication and sends batched updates periodically.  Period depends on the channel.

