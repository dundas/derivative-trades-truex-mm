const crypto = require('crypto');

// FIX message constants
const SOH = String.fromCharCode(1); // Start of Header

// Standard FIX field order per TrueX FIXT.1.1 spec (excluding header fields 8, 9 and trailer 10)
// Header order: BeginString(8) -> BodyLength(9) -> MsgType(35) -> SenderCompID(49) -> TargetCompID(56) -> MsgSeqNum(34) -> SendingTime(52)
const BODY_FIELD_ORDER = ['35', '49', '56', '34', '52', '98', '108', '141', '553', '554', '1137'];

// Specific field order for New Order Single (35=D) messages per Spencer's correction
// Party ID fields: NoPartyIDs(453) FIRST -> PartyID(448) SECOND -> PartyRole(452) THIRD
const ORDER_FIELD_ORDER = ['35', '49', '56', '34', '52', '11', '18', '55', '54', '38', '40', '44', '59', '453', '448', '452'];

/**
 * Calculate FIX checksum
 */
function calculateChecksum(msg) {
  let sum = 0;
  for (let i = 0; i < msg.length; i++) {
    sum += msg.charCodeAt(i);
  }
  return String(sum % 256).padStart(3, '0');
}

/**
 * Create HMAC signature for TrueX authentication (CORRECT METHOD)
 * Based on Python client: sending_time + msg_type + msg_seq_num + sender_comp_id + target_comp_id + username
 */
function createTrueXSignature(sendingTime, msgType, msgSeqNum, senderCompID, targetCompID, username, apiSecret) {
  const message = sendingTime + msgType + msgSeqNum + senderCompID + targetCompID + username;

  if (process.env.TRUEX_DEBUG_MODE === 'true' && process.env.NODE_ENV === 'development') {
    // Security-safe debug output (credentials obfuscated) - development only
    console.log('🔐 DEBUG - Signature Input String (Development Mode Only):');
    console.log(`   sendingTime: "${sendingTime}"`);
    console.log(`   msgType: "${msgType}"`);
    console.log(`   msgSeqNum: "${msgSeqNum}"`);
    console.log(`   senderCompID: "${senderCompID}"`);
    console.log(`   targetCompID: "${targetCompID}"`);
    console.log(`   username: ${username ? '***CONFIGURED***' : 'MISSING'}`);
    console.log(`   Message components validated`);
  }

  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(message)
    .digest('base64');

  if (process.env.NODE_ENV !== 'development') {
    // Minimal confirmation outside development; do not leak internals
    console.log('🔐 HMAC signature generated successfully');
  }

  return signature;
}

/**
 * Create FIXT.1.1 + FIX.5.0SP2 message with proper field ordering
 */
function createFIXMessage(fields) {
  let msg = '';
  
  // Always start with BeginString and BodyLength
  msg += `8=${fields['8']}${SOH}`;
  msg += `9=${fields['9']}${SOH}`;
  
  // Add body fields in correct order
  for (const tag of BODY_FIELD_ORDER) {
    if (fields[tag]) {
      msg += `${tag}=${fields[tag]}${SOH}`;
    }
  }
  
  // Add any remaining fields not in the order list (excluding header/trailer)
  for (const [tag, value] of Object.entries(fields)) {
    if (!BODY_FIELD_ORDER.includes(tag) && tag !== '8' && tag !== '9' && tag !== '10') {
      msg += `${tag}=${value}${SOH}`;
    }
  }
  
  const checksum = calculateChecksum(msg);
  msg += `10=${checksum}${SOH}`;
  
  return msg;
}

/**
 * Create New Order Single (35=D) message with specific field ordering per Spencer's correction
 */
function createOrderMessage(fields) {
  let msg = '';
  
  // Always start with BeginString and BodyLength
  msg += `8=${fields['8']}${SOH}`;
  msg += `9=${fields['9']}${SOH}`;
  
  // Add order fields in the EXACT order specified by Spencer
  for (const tag of ORDER_FIELD_ORDER) {
    if (fields[tag]) {
      msg += `${tag}=${fields[tag]}${SOH}`;
    }
  }
  
  // Add any remaining fields not in the order list (excluding header/trailer)
  for (const [tag, value] of Object.entries(fields)) {
    if (!ORDER_FIELD_ORDER.includes(tag) && tag !== '8' && tag !== '9' && tag !== '10') {
      msg += `${tag}=${value}${SOH}`;
    }
  }
  
  const checksum = calculateChecksum(msg);
  msg += `10=${checksum}${SOH}`;
  
  return msg;
}

/**
 * Build TrueX FIX Logon message with all required fields
 */
function buildTrueXLogonMessage(apiKey, apiSecret, senderCompID = 'CLI_CLIENT', targetCompID = 'TRUEX_UAT_OE') {
  // Create proper FIX SendingTime format: YYYYMMDD-HH:MM:SS.sss
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
  const sendingTime = `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;

  // FIXT.1.1 Logon message fields per TrueX specification
  // Field order matters: BeginString, BodyLength, MsgType, then others
  const logonFields = {
    // FIXT.1.1 Standard Header (in correct order)
    8: 'FIXT.1.1',                        // BeginString
    9: '0',                               // BodyLength (calculated later)
    35: 'A',                              // MsgType (Logon) - MUST be 3rd field
    49: senderCompID,                     // SenderCompID (now parameterized)
    56: targetCompID,                     // TargetCompID (now parameterized)
    34: '1',                              // MsgSeqNum
    52: sendingTime,                      // SendingTime (now with proper format)
    
    // FIXT.1.1 Logon Message Body (per TrueX spec)
    98: '0',                              // EncryptMethod (0 = None/other)
    108: '30',                            // HeartBtInt (required)
    141: 'Y',                             // ResetSeqNumFlag (reset sequence numbers)
    1137: 'FIX.5.0SP2',                   // DefaultApplVerID (required)
    
    // TrueX Authentication
    553: apiKey,                          // Username (API Key)
    554: ''                               // Password (HMAC signature - calculated below)
  };
  
  // Calculate signature using correct TrueX method: sending_time + msg_type + msg_seq_num + sender_comp_id + target_comp_id + username
  const signature = createTrueXSignature(
    logonFields['52'],  // SendingTime
    logonFields['35'],  // MsgType
    logonFields['34'],  // MsgSeqNum  
    logonFields['49'],  // SenderCompID
    logonFields['56'],  // TargetCompID
    logonFields['553'], // Username (API Key)
    apiSecret
  );
  
  // Set the calculated signature
  logonFields['554'] = signature;
  
  // Calculate body length using the consistent field order
  let body = '';
  
  for (const tag of BODY_FIELD_ORDER) {
    if (logonFields[tag]) {
      body += `${tag}=${logonFields[tag]}${SOH}`;
    }
  }
  
  logonFields['9'] = body.length.toString();
  
  const finalMessage = createFIXMessage(logonFields);
  
  return {
    fields: logonFields,
    message: finalMessage,
    metadata: {
      sendingTime,
      signature,
      bodyLength: body.length,
      totalLength: finalMessage.length,
      // Diagnostic info for troubleshooting
      diagnostics: {
        hasCorrectSOH: finalMessage.includes(String.fromCharCode(1)),
        bodyLengthMatches: body.length.toString() === logonFields['9'],
        messageEndsWithChecksum: finalMessage.endsWith(String.fromCharCode(1)),
        totalSOHCount: (finalMessage.match(/\x01/g) || []).length
      }
    }
  };
}

/**
 * Get human-readable field descriptions
 */
function getFieldDescriptions() {
  return {
    8: 'BeginString - Transport Protocol',
    9: 'BodyLength - Message body size',
    35: 'MsgType - Logon (A)',
    49: 'SenderCompID - Our client ID', 
    56: 'TargetCompID - TrueX gateway',
    34: 'MsgSeqNum - Sequence number',
    52: 'SendingTime - Timestamp',
    98: 'EncryptMethod - Encryption method (0=None)',
    108: 'HeartBtInt - Heartbeat interval',
    1137: 'DefaultApplVerID - Application protocol',
    553: 'Username - API Key',
    554: 'Password - HMAC Signature',
    10: 'CheckSum - Message validation'
  };
}

/**
 * Build Market Data Request message for TrueX
 * Message Type: V (35=V)
 * Reference: TrueX FIX.5.0SP2 specification
 */
function buildMarketDataRequest(apiKey, apiSecret, mdReqId, symbol, msgSeqNum = '2', senderCompID = 'CLI_CLIENT', targetCompID = 'TRUEX_UAT_MD') {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
  const sendingTime = `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;

  // Market Data Request fields per FIX.5.0SP2 specification
  const mdRequestFields = {
    // FIXT.1.1 Standard Header
    8: 'FIXT.1.1',
    9: '0',                               // BodyLength (calculated later)
    35: 'V',                              // MsgType (Market Data Request)
    49: senderCompID,                     // SenderCompID (now parameterized)
    56: targetCompID,                     // TargetCompID (now parameterized, defaults to TRUEX_UAT_MD)
    34: msgSeqNum,                        // MsgSeqNum
    52: sendingTime,                      // SendingTime
    1137: 'FIX.5.0SP2',                   // DefaultApplVerID
    
    // Market Data Request Body
    262: mdReqId,                         // MDReqID - Market Data Request ID
    263: '1',                             // SubscriptionRequestType (1=Snapshot+Updates)  
    264: '0',                             // MarketDepth (0=Full Book) - Request full L2 order book
    267: '2',                             // NoMDEntryTypes - Number of MD Entry Types (Bid + Offer)
    146: '1',                             // NoRelatedSym - Number of symbols
    55: symbol,                           // Symbol
    
    // Authentication (if required for market data)
    553: apiKey,                          // Username
    554: ''                               // Password (signature)
  };
  
  // Calculate signature for market data request
  const signature = createTrueXSignature(
    mdRequestFields['52'],  // SendingTime
    mdRequestFields['35'],  // MsgType (V)
    mdRequestFields['34'],  // MsgSeqNum
    mdRequestFields['49'],  // SenderCompID
    mdRequestFields['56'],  // TargetCompID
    mdRequestFields['553'], // Username
    apiSecret
  );
  
  mdRequestFields['554'] = signature;
  
  // Calculate body length
  let body = '';
  const mdBodyOrder = ['35', '49', '56', '34', '52', '262', '263', '264', '267', '269', '146', '55', '553', '554', '1137'];
  
  for (const tag of mdBodyOrder) {
    if (mdRequestFields[tag] !== undefined) {
      body += `${tag}=${mdRequestFields[tag]}${SOH}`;
    }
  }
  
  mdRequestFields['9'] = body.length.toString();
  
  // Build message manually with correct field order for market data
  let finalMessage = `8=${mdRequestFields['8']}${SOH}9=${mdRequestFields['9']}${SOH}`;
  finalMessage += body;
  
  // Calculate and add checksum
  const checksum = calculateChecksum(finalMessage);
  finalMessage += `10=${checksum}${SOH}`;
  
  return {
    fields: mdRequestFields,
    message: finalMessage,
    metadata: {
      sendingTime,
      signature,
      bodyLength: body.length,
      totalLength: finalMessage.length,
      mdReqId,
      symbol
    }
  };
}

/**
 * Parse Market Data Snapshot message (MsgType=W)
 */
function parseMarketDataSnapshot(message) {
  const fields = {};
  const groups = [];
  
  // Split message by SOH and parse fields
  const parts = message.split(SOH);
  
  for (const part of parts) {
    if (part.includes('=')) {
      const [tag, value] = part.split('=', 2);
      fields[tag] = value;
    }
  }
  
  return {
    msgType: fields['35'],
    symbol: fields['55'],
    noMDEntries: parseInt(fields['268']) || 0,
    sendingTime: fields['52'],
    fields,
    // TODO: Parse NoMDEntries groups for bid/offer data
    parsed: {
      isSnapshot: fields['35'] === 'W',
      isIncremental: fields['35'] === 'X',
      symbol: fields['55']
    }
  };
}

/**
 * Parse Market Data Incremental message (MsgType=X) 
 */
function parseMarketDataIncremental(message) {
  return parseMarketDataSnapshot(message); // Same parsing logic for now
}

/**
 * Build New Order Single message for TrueX
 * Message Type: D (35=D)
 * Reference: FIX.5.0SP2 specification
 */
function buildNewOrderSingle(apiKey, apiSecret, orderData, msgSeqNum, partyID = '78922880101777426', senderCompID = 'CLI_CLIENT', targetCompID = 'TRUEX_UAT_OE') {
  const {
    clOrdID = 'MISSING_CL_ORD_ID',
    symbol = 'UNKNOWN',
    side = '1',        // '1'=Buy, '2'=Sell
    orderQty = 0,
    ordType = '1',     // '1'=Market, '2'=Limit
    price,             // Required for limit orders
    timeInForce = '1'  // '1'=GTC, '3'=IOC, '4'=FOK
  } = orderData || {};
  
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
  const sendingTime = `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;
  
  // New Order Single fields per FIX.5.0SP2
  const orderFields = {
    // FIXT.1.1 Standard Header
    8: 'FIXT.1.1',
    9: '0',                               // BodyLength (calculated later)
    35: 'D',                              // MsgType (New Order Single)
    49: senderCompID,                     // SenderCompID (now parameterized)
    56: targetCompID,                     // TargetCompID (now parameterized)
    34: msgSeqNum,                        // MsgSeqNum
    52: sendingTime,                      // SendingTime
    
    // Order fields
    11: clOrdID,                          // ClOrdID - Client Order ID
    18: '6',                              // ExecInst - Add Liquidity Only (ALO) for market making
    55: symbol,                           // Symbol
    54: side,                             // Side
    38: String(orderQty),                 // OrderQty (safe default)
    40: ordType,                          // OrdType
    44: price ? price.toString() : undefined, // Price - Required for limit orders
    59: timeInForce,                      // TimeInForce
    
    // Party ID fields - CRITICAL: Order must be 453 FIRST, then 448, then 452 (per Spencer)
    453: '1',                             // NoPartyIDs (must be 1) - FIRST
    448: partyID,                         // PartyID (configurable client ID) - SECOND  
    452: '3',                             // PartyRole (3 = Client ID) - THIRD
    
    // NOTE: Removed authentication tags (553/554) as they cause order rejection
    // Party ID authentication with correct field ordering is required
  };
  
  // Price is now handled in the main orderFields object above
  
  // NOTE: No signature needed for orders - using Party ID authentication instead
  
  // Calculate body length using the same field order as createOrderMessage
  let body = '';
  for (const tag of ORDER_FIELD_ORDER) {
    if (orderFields[tag]) {
      body += `${tag}=${orderFields[tag]}${SOH}`;
    }
  }
  
  orderFields['9'] = body.length.toString();
  
  const finalMessage = createOrderMessage(orderFields);
  
  return {
    fields: orderFields,
    message: finalMessage,
    metadata: {
      sendingTime,
      bodyLength: body.length,
      totalLength: finalMessage.length,
      clOrdID,
      symbol,
      side: side === '1' ? 'BUY' : 'SELL',
      orderQty,
      ordType: ordType === '1' ? 'MARKET' : 'LIMIT',
      price,
      partyID: orderFields['448'], // Client ID used for order authentication
      partyRole: orderFields['452'] // Party role (3 = Client ID)
    }
  };
}

/**
 * Build Order Cancel Replace Request message (TrueX uses 35=G for cancellation)
 * Message Type: G (35=G) - OrderCancelReplaceRequest with zero quantity = cancellation
 */
function buildOrderCancelRequest(apiKey, apiSecret, cancelData, msgSeqNum, partyID = '78923062108553234', senderCompID = 'CLI_CLIENT', targetCompID = 'TRUEX_UAT_OE') {
  const {
    clOrdID,           // New ClOrdID for cancel request
    origClOrdID,       // Original ClOrdID to cancel
    symbol,
    side,
    orderQty
  } = cancelData;
  
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
  const sendingTime = `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;
  
  // Order Cancel Replace Request fields (TrueX method for cancellation)
  const cancelFields = {
    // FIXT.1.1 Standard Header
    8: 'FIXT.1.1',
    9: '0',                               // BodyLength (calculated later)
    35: 'G',                              // MsgType (OrderCancelReplaceRequest - TrueX cancellation method)
    49: senderCompID,                     // SenderCompID (now parameterized)
    56: targetCompID,                     // TargetCompID (now parameterized)
    34: msgSeqNum,                        // MsgSeqNum
    52: sendingTime,                      // SendingTime
    1137: 'FIX.5.0SP2',                   // DefaultApplVerID
    
    // Cancel replace request fields (zero quantity = cancellation)
    11: clOrdID,                          // ClOrdID (new ID for cancel request)
    41: origClOrdID,                      // OrigClOrdID (ID of order to cancel)
    38: '0',                              // OrderQty (ZERO quantity = cancellation per TrueX spec)
    
    // Party ID fields - REQUIRED per TrueX documentation
    453: '1',                             // NoPartyIDs (must be 1)
    448: partyID,                         // PartyID (client ID)
    452: '3',                             // PartyRole (3 = Client ID)
    
    // Authentication
    553: apiKey,                          // Username
    554: ''                               // Password (signature)
  };
  
  // Calculate signature
  const signature = createTrueXSignature(
    cancelFields['52'],  // SendingTime
    cancelFields['35'],  // MsgType (G - OrderCancelReplaceRequest)
    cancelFields['34'],  // MsgSeqNum
    cancelFields['49'],  // SenderCompID
    cancelFields['56'],  // TargetCompID
    cancelFields['553'], // Username
    apiSecret
  );
  
  cancelFields['554'] = signature;
  
  // Calculate body length
  let body = '';
  const cancelBodyOrder = ['35', '49', '56', '34', '52', '1137', '11', '41', '38', '453', '448', '452', '553', '554'];
  
  for (const tag of cancelBodyOrder) {
    if (cancelFields[tag]) {
      body += `${tag}=${cancelFields[tag]}${SOH}`;
    }
  }
  
  cancelFields['9'] = body.length.toString();
  
  const finalMessage = createFIXMessage(cancelFields);
  
  return {
    fields: cancelFields,
    message: finalMessage,
    metadata: {
      sendingTime,
      signature,
      bodyLength: body.length,
      totalLength: finalMessage.length,
      clOrdID,
      origClOrdID,
      symbol
    }
  };
}

/**
 * Parse Execution Report message (MsgType=8)
 */
function parseExecutionReport(message) {
  const fields = {};
  
  // Split message by SOH and parse fields
  const parts = message.split(SOH);
  
  for (const part of parts) {
    if (part.includes('=')) {
      const [tag, value] = part.split('=', 2);
      fields[tag] = value;
    }
  }
  
  // Parse order status
  let orderStatus = 'UNKNOWN';
  if (fields['39']) {
    const statusCode = fields['39'];
    const statusMap = {
      '0': 'NEW',
      '1': 'PARTIALLY_FILLED',
      '2': 'FILLED',
      '4': 'CANCELED',
      '8': 'REJECTED',
      'A': 'PENDING_NEW',
      'C': 'EXPIRED'
    };
    orderStatus = statusMap[statusCode] || `UNKNOWN_${statusCode}`;
  }
  
  return {
    msgType: fields['35'],
    clOrdID: fields['11'],
    orderID: fields['37'],
    execID: fields['17'],
    orderStatus,
    symbol: fields['55'],
    side: fields['54'] === '1' ? 'BUY' : 'SELL',
    orderQty: parseFloat(fields['38']) || 0,
    price: parseFloat(fields['44']) || 0,
    lastQty: parseFloat(fields['32']) || 0,
    lastPx: parseFloat(fields['31']) || 0,
    leavesQty: parseFloat(fields['151']) || 0,
    cumQty: parseFloat(fields['14']) || 0,
    avgPx: parseFloat(fields['6']) || 0,
    text: fields['58'],
    sendingTime: fields['52'],
    fields,
    parsed: {
      isNew: orderStatus === 'NEW',
      isPartialFill: orderStatus === 'PARTIALLY_FILLED',
      isFilled: orderStatus === 'FILLED',
      isCanceled: orderStatus === 'CANCELED',
      isRejected: orderStatus === 'REJECTED'
    }
  };
}

/**
 * Get Order field descriptions
 */
function getOrderFieldDescriptions() {
  return {
    11: 'ClOrdID - Client Order ID',
    37: 'OrderID - Exchange Order ID',
    17: 'ExecID - Execution ID',
    39: 'OrdStatus - Order Status',
    54: 'Side - (1=Buy, 2=Sell)',
    38: 'OrderQty - Order Quantity',
    40: 'OrdType - (1=Market, 2=Limit)',
    44: 'Price - Limit Price',
    59: 'TimeInForce - (1=GTC, 3=IOC, 4=FOK)',
    32: 'LastQty - Last executed quantity',
    31: 'LastPx - Last executed price',
    151: 'LeavesQty - Remaining quantity',
    14: 'CumQty - Cumulative quantity',
    6: 'AvgPx - Average executed price',
    41: 'OrigClOrdID - Original Client Order ID'
  };
}

/**
 * Get Market Data field descriptions
 */
function getMarketDataFieldDescriptions() {
  return {
    262: 'MDReqID - Market Data Request ID',
    263: 'SubscriptionRequestType - (1=Snapshot+Updates)',
    264: 'MarketDepth - (0=Full Book)',
    267: 'NoMDEntryTypes - Number of MD Entry Types',
    269: 'MDEntryType - (0=Bid, 1=Offer, 2=Trade)',
    146: 'NoRelatedSym - Number of symbols',
    55: 'Symbol - Trading symbol',
    268: 'NoMDEntries - Number of Market Data entries',
    270: 'MDEntryPx - Market Data Entry Price',
    271: 'MDEntrySize - Market Data Entry Size',
    272: 'MDEntryDate - Market Data Entry Date',
    273: 'MDEntryTime - Market Data Entry Time'
  };
}

/**
 * Obfuscate sensitive data for logging
 */
function obfuscate(value) {
  if (!value) return 'NOT_SET';
  if (value.length <= 8) return '***';
  return value.substring(0, 4) + '***' + value.substring(value.length - 4);
}

module.exports = {
  SOH,
  calculateChecksum,
  createTrueXSignature,
  createFIXMessage,
  buildTrueXLogonMessage,
  buildMarketDataRequest,
  parseMarketDataSnapshot,
  parseMarketDataIncremental,
  buildNewOrderSingle,
  buildOrderCancelRequest,
  parseExecutionReport,
  getFieldDescriptions,
  getMarketDataFieldDescriptions,
  getOrderFieldDescriptions,
  obfuscate
};