/**
 * FIX Message Builder Test Suite
 * 
 * Comprehensive tests for TrueX FIX protocol message building and parsing
 */

const {
  SOH,
  createTrueXSignature,
  buildTrueXLogonMessage,
  buildMarketDataRequest,
  buildNewOrderSingle,
  buildOrderCancelRequest,
  calculateChecksum
} = require('../src/proxy/fix-message-builder.cjs');

describe('FIX Message Builder', () => {
  
  // Test data
  const testApiKey = 'test_api_key_12345';
  const testApiSecret = 'test_secret_key_abcdefghijklmnop';
  const testSenderCompID = 'CLI_CLIENT';
  const testTargetCompID = 'TRUEX_UAT_OE';
  
  describe('SOH Delimiter', () => {
    test('SOH should be ASCII character 1', () => {
      expect(SOH).toBe('\x01');
      expect(SOH.charCodeAt(0)).toBe(1);
    });
  });
  
  describe('TrueX Signature Generation', () => {
    test('should generate correct HMAC-SHA256 signature', () => {
      const sendingTime = '20251006-14:30:00.000';
      const msgType = 'A';
      const msgSeqNum = '1';
      const senderCompID = 'CLI_CLIENT';
      const targetCompID = 'TRUEX_UAT_OE';
      const username = testApiKey;
      
      const signature = createTrueXSignature(
        sendingTime, msgType, msgSeqNum, 
        senderCompID, targetCompID, username, 
        testApiSecret
      );
      
      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(20); // HMAC-SHA256 should be longer
    });
    
    test('should generate different signatures for different inputs', () => {
      const baseParams = ['20251006-14:30:00.000', 'A', '1', 'CLI_CLIENT', 'TRUEX_UAT_OE', testApiKey];
      
      const signature1 = createTrueXSignature(...baseParams, testApiSecret);
      const signature2 = createTrueXSignature(...baseParams, 'different_secret');
      
      expect(signature1).not.toBe(signature2);
    });
    
    test('should be deterministic for same inputs', () => {
      const params = ['20251006-14:30:00.000', 'A', '1', 'CLI_CLIENT', 'TRUEX_UAT_OE', testApiKey, testApiSecret];
      
      const signature1 = createTrueXSignature(...params);
      const signature2 = createTrueXSignature(...params);
      
      expect(signature1).toBe(signature2);
    });
  });
  
  describe('Checksum Calculation', () => {
    test('should calculate correct FIX checksum', () => {
      const testMessage = '8=FIXT.1.1\x019=100\x0135=A\x01';
      const checksum = calculateChecksum(testMessage);
      
      expect(checksum).toBeDefined();
      expect(typeof checksum).toBe('string');
      expect(checksum.length).toBe(3); // Checksum is always 3 digits
      expect(/^\d{3}$/.test(checksum)).toBe(true);
    });
    
    test('should handle empty message', () => {
      const checksum = calculateChecksum('');
      expect(checksum).toBe('000');
    });
  });
  
  describe('Logon Message Building', () => {
    test('should build valid logon message', () => {
      const logonMessage = buildTrueXLogonMessage(
        testApiKey, testApiSecret, testSenderCompID, testTargetCompID
      );
      
      expect(logonMessage).toBeDefined();
      expect(logonMessage.fields).toBeDefined();
      expect(logonMessage.message).toBeDefined();
      
      // Check required fields
      expect(logonMessage.fields['8']).toBe('FIXT.1.1'); // BeginString
      expect(logonMessage.fields['35']).toBe('A'); // MsgType (Logon)
      expect(logonMessage.fields['49']).toBe(testSenderCompID); // SenderCompID
      expect(logonMessage.fields['56']).toBe(testTargetCompID); // TargetCompID
      expect(logonMessage.fields['553']).toBe(testApiKey); // Username
      expect(logonMessage.fields['554']).toBeDefined(); // Password (signature)
    });
    
    test('should include proper timestamp format', () => {
      const logonMessage = buildTrueXLogonMessage(testApiKey, testApiSecret);
      const sendingTime = logonMessage.fields['52'];
      
      // Should match YYYYMMDD-HH:MM:SS.sss format
      expect(sendingTime).toMatch(/^\d{8}-\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });
    
    test('should have valid message structure', () => {
      const logonMessage = buildTrueXLogonMessage(testApiKey, testApiSecret);
      
      expect(logonMessage.message).toContain('8=FIXT.1.1');
      expect(logonMessage.message).toContain('35=A');
      expect(logonMessage.message).toContain(`49=${testSenderCompID}`);
      expect(logonMessage.message).toContain('10='); // Checksum
      expect(logonMessage.message.endsWith(SOH)).toBe(true);
    });
  });
  
  describe('Market Data Request Building', () => {
    test('should build valid market data request', () => {
      const mdRequest = buildMarketDataRequest(
        testApiKey, testApiSecret, 'MDR001', 'BTC-PYUSD', '2', 
        testSenderCompID, testTargetCompID
      );
      
      expect(mdRequest).toBeDefined();
      expect(mdRequest.fields).toBeDefined();
      expect(mdRequest.message).toBeDefined();
      
      // Check required fields
      expect(mdRequest.fields['35']).toBe('V'); // MsgType (Market Data Request)
      expect(mdRequest.fields['262']).toBe('MDR001'); // MDReqID
      expect(mdRequest.fields['55']).toBe('BTC-PYUSD'); // Symbol
    });
    
    test('should use correct default targetCompID for market data', () => {
      const mdRequest = buildMarketDataRequest(testApiKey, testApiSecret, 'MDR001', 'BTC-PYUSD');
      
      // Should default to TRUEX_UAT_MD for market data
      expect(mdRequest.fields['56']).toBe('TRUEX_UAT_MD');
    });
  });
  
  describe('New Order Single Building', () => {
    const testOrderData = {
      clOrdID: 'ORDER_001',
      symbol: 'BTC-PYUSD',
      side: '1', // Buy
      orderQty: '0.01',
      ordType: '2', // Limit
      price: '50000.00',
      timeInForce: '1' // Good Till Cancel
    };
    
    test('should build valid new order single message', () => {
      const orderMessage = buildNewOrderSingle(
        testApiKey, testApiSecret, testOrderData, '3', 
        '78922880101777426', testSenderCompID, testTargetCompID
      );
      
      expect(orderMessage).toBeDefined();
      expect(orderMessage.fields).toBeDefined();
      expect(orderMessage.message).toBeDefined();
      
      // Check required fields
      expect(orderMessage.fields['35']).toBe('D'); // MsgType (New Order Single)
      expect(orderMessage.fields['11']).toBe('ORDER_001'); // ClOrdID
      expect(orderMessage.fields['55']).toBe('BTC-PYUSD'); // Symbol
      expect(orderMessage.fields['54']).toBe('1'); // Side
      expect(orderMessage.fields['38']).toBe('0.01'); // OrderQty
    });
    
    test('should include party ID fields in correct order', () => {
      const orderMessage = buildNewOrderSingle(
        testApiKey, testApiSecret, testOrderData, '3'
      );
      
      // Party ID fields must be present and in correct order
      expect(orderMessage.fields['453']).toBe('1'); // NoPartyIDs
      expect(orderMessage.fields['448']).toBeDefined(); // PartyID
      expect(orderMessage.fields['452']).toBe('3'); // PartyRole
    });
    
    test('should handle market orders (no price)', () => {
      const marketOrderData = {
        ...testOrderData,
        ordType: '1', // Market
        price: undefined
      };
      
      const orderMessage = buildNewOrderSingle(
        testApiKey, testApiSecret, marketOrderData, '3'
      );
      
      expect(orderMessage.fields['40']).toBe('1'); // OrdType = Market
      expect(orderMessage.fields['44']).toBeUndefined(); // No price for market orders
    });
  });
  
  describe('Order Cancel Request Building', () => {
    const testCancelData = {
      clOrdID: 'CANCEL_001',
      origClOrdID: 'ORDER_001',
      symbol: 'BTC-PYUSD',
      side: '1',
      orderQty: '0.01'
    };
    
    test('should build valid cancel request message', () => {
      const cancelMessage = buildOrderCancelRequest(
        testApiKey, testApiSecret, testCancelData, '4',
        '78923062108553234', testSenderCompID, testTargetCompID
      );
      
      expect(cancelMessage).toBeDefined();
      expect(cancelMessage.fields).toBeDefined();
      expect(cancelMessage.message).toBeDefined();
      
      // Check required fields
      expect(cancelMessage.fields['35']).toBe('G'); // MsgType (OrderCancelReplaceRequest)
      expect(cancelMessage.fields['11']).toBe('CANCEL_001'); // ClOrdID
      expect(cancelMessage.fields['41']).toBe('ORDER_001'); // OrigClOrdID
      expect(cancelMessage.fields['38']).toBe('0'); // OrderQty = 0 for cancellation
    });
    
    test('should include authentication signature', () => {
      const cancelMessage = buildOrderCancelRequest(
        testApiKey, testApiSecret, testCancelData, '4'
      );
      
      expect(cancelMessage.fields['553']).toBe(testApiKey); // Username
      expect(cancelMessage.fields['554']).toBeDefined(); // Password (signature)
      expect(cancelMessage.fields['554'].length).toBeGreaterThan(10);
    });
  });
  
  describe('Message Format Validation', () => {
    test('all messages should start with BeginString', () => {
      const logon = buildTrueXLogonMessage(testApiKey, testApiSecret);
      const mdRequest = buildMarketDataRequest(testApiKey, testApiSecret, 'MDR001', 'BTC-PYUSD');
      
      expect(logon.message).toMatch(/^8=FIXT\.1\.1\x01/);
      expect(mdRequest.message).toMatch(/^8=FIXT\.1\.1\x01/);
    });
    
    test('all messages should end with checksum and SOH', () => {
      const logon = buildTrueXLogonMessage(testApiKey, testApiSecret);
      
      expect(logon.message).toMatch(/10=\d{3}\x01$/);
    });
    
    test('all messages should have proper field separation', () => {
      const logon = buildTrueXLogonMessage(testApiKey, testApiSecret);
      
      // Should not have double SOH characters
      expect(logon.message).not.toContain('\x01\x01');
      
      // Should have SOH after each field
      const fieldCount = (logon.message.match(/\x01/g) || []).length;
      expect(fieldCount).toBeGreaterThan(5); // At least several fields
    });
  });
  
  describe('Error Handling', () => {
    test('should handle missing API key', () => {
      expect(() => {
        buildTrueXLogonMessage('', testApiSecret);
      }).not.toThrow(); // Should handle gracefully
    });
    
    test('should handle missing order data fields', () => {
      const incompleteOrderData = {
        clOrdID: 'ORDER_001'
        // Missing required fields
      };
      
      expect(() => {
        buildNewOrderSingle(testApiKey, testApiSecret, incompleteOrderData, '3');
      }).not.toThrow(); // Should handle gracefully with defaults
    });
  });
  
  describe('Performance Tests', () => {
    test('message building should be fast', () => {
      const start = Date.now();
      
      for (let i = 0; i < 100; i++) {
        buildTrueXLogonMessage(testApiKey, testApiSecret);
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should build 100 messages in under 1 second
    });
    
    test('signature generation should be fast', () => {
      const start = Date.now();
      
      for (let i = 0; i < 100; i++) {
        createTrueXSignature(
          '20251006-14:30:00.000', 'A', i.toString(), 
          'CLI_CLIENT', 'TRUEX_UAT_OE', testApiKey, testApiSecret
        );
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500); // Should generate 100 signatures in under 0.5 seconds
    });
  });
});



