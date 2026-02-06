/**
 * TrueX Error Handling and Reject Message Tests
 * 
 * Tests error scenarios and reject message handling including:
 * - Order rejections (Invalid client, etc.)
 * - Connection failures
 * - Malformed messages
 * - Recovery mechanisms
 */

const { EventEmitter } = require('events');
const {
  buildTrueXLogonMessage,
  buildNewOrderSingle,
  buildOrderCancelRequest,
  SOH
} = require('../src/proxy/fix-message-builder.cjs');

// Mock market maker for testing error scenarios
class MockMarketMaker extends EventEmitter {
  constructor() {
    super();
    this.activeOrders = new Map();
    this.pendingCancellations = new Map();
    this.rejectedOrders = [];
    this.connectionErrors = [];
    this.isRunning = false;
    this.shouldExitOnInvalidClient = true;
  }
  
  handleOrderRejection(rejection) {
    console.log(`⚠️ Order rejected by TrueX: ${JSON.stringify(rejection)}`);
    
    // Check for "Invalid client" error - this is a fatal configuration issue
    if (rejection.reason && rejection.reason.toLowerCase().includes('invalid client')) {
      console.log('🚨 FATAL ERROR: Invalid client credentials detected');
      console.log('🚨 TrueX is rejecting all orders due to invalid client configuration');
      console.log('🚨 This indicates a client authorization/registration issue');
      console.log('🚨 Exiting to prevent further rejected orders...');
      
      if (this.shouldExitOnInvalidClient) {
        this.emit('fatalError', 'Invalid client credentials');
        return;
      }
    }
    
    // Track rejection
    this.rejectedOrders.push(rejection);
    
    // Remove from active tracking if present
    if (rejection.clOrdID && this.activeOrders.has(rejection.clOrdID)) {
      this.activeOrders.delete(rejection.clOrdID);
    }
    
    this.emit('orderRejected', rejection);
  }
  
  handleConnectionError(error) {
    this.connectionErrors.push(error);
    this.emit('connectionError', error);
  }
  
  addActiveOrder(orderId, orderData) {
    this.activeOrders.set(orderId, orderData);
  }
  
  getStats() {
    return {
      activeOrders: this.activeOrders.size,
      rejectedOrders: this.rejectedOrders.length,
      connectionErrors: this.connectionErrors.length
    };
  }
  
  reset() {
    this.activeOrders.clear();
    this.pendingCancellations.clear();
    this.rejectedOrders = [];
    this.connectionErrors = [];
  }
}

// Helper function to parse FIX messages
function parseFIXMessage(message) {
  const fields = {};
  const parts = message.split(SOH);
  
  for (const part of parts) {
    if (part.includes('=')) {
      const [tag, value] = part.split('=', 2);
      fields[tag] = value;
    }
  }
  
  return fields;
}

// Helper function to create reject messages
function createRejectMessage(clOrdID, reason, msgType = '8') {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').substring(0, 21);
  
  const fields = {
    8: 'FIXT.1.1',
    9: '0',
    35: msgType, // Execution Report or Reject
    49: 'TRUEX_UAT_OE',
    56: 'CLI_CLIENT',
    34: '1',
    52: timestamp,
    11: clOrdID, // ClOrdID
    39: '8', // OrdStatus (Rejected)
    150: '8', // ExecType (Rejected)
    103: '99', // OrdRejReason (Other)
    58: reason // Text
  };
  
  let body = '';
  for (const [tag, value] of Object.entries(fields)) {
    if (tag !== '8' && tag !== '9' && tag !== '10') {
      body += `${tag}=${value}${SOH}`;
    }
  }
  
  fields['9'] = body.length.toString();
  
  let message = `8=${fields['8']}${SOH}9=${fields['9']}${SOH}${body}`;
  
  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < message.length; i++) {
    checksum += message.charCodeAt(i);
  }
  checksum = (checksum % 256).toString().padStart(3, '0');
  
  message += `10=${checksum}${SOH}`;
  return message;
}

describe('TrueX Error Handling and Reject Messages', () => {
  let mockMarketMaker;
  
  beforeEach(() => {
    mockMarketMaker = new MockMarketMaker();
  });
  
  afterEach(() => {
    mockMarketMaker.reset();
  });
  
  describe('Order Rejection Handling', () => {
    test('should handle "Invalid client" rejection and emit fatal error', (done) => {
      const rejection = {
        clOrdID: 'ORDER_001',
        orderID: 'NONE',
        reason: 'Invalid client',
        removedFromActiveTracking: true
      };
      
      mockMarketMaker.on('fatalError', (error) => {
        expect(error).toBe('Invalid client credentials');
        done();
      });
      
      mockMarketMaker.handleOrderRejection(rejection);
    });
    
    test('should track rejected orders', () => {
      const rejection1 = {
        clOrdID: 'ORDER_001',
        reason: 'Insufficient funds'
      };
      
      const rejection2 = {
        clOrdID: 'ORDER_002',
        reason: 'Invalid price'
      };
      
      mockMarketMaker.handleOrderRejection(rejection1);
      mockMarketMaker.handleOrderRejection(rejection2);
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(2);
      expect(mockMarketMaker.rejectedOrders[0].reason).toBe('Insufficient funds');
      expect(mockMarketMaker.rejectedOrders[1].reason).toBe('Invalid price');
    });
    
    test('should remove rejected orders from active tracking', () => {
      const orderId = 'ORDER_001';
      const orderData = { symbol: 'BTC-PYUSD', side: '1', orderQty: '0.01' };
      
      mockMarketMaker.addActiveOrder(orderId, orderData);
      expect(mockMarketMaker.activeOrders.has(orderId)).toBe(true);
      
      const rejection = {
        clOrdID: orderId,
        reason: 'Invalid price'
      };
      
      mockMarketMaker.handleOrderRejection(rejection);
      expect(mockMarketMaker.activeOrders.has(orderId)).toBe(false);
    });
    
    test('should emit orderRejected event', (done) => {
      const rejection = {
        clOrdID: 'ORDER_001',
        reason: 'Test rejection'
      };
      
      mockMarketMaker.on('orderRejected', (rejectedOrder) => {
        expect(rejectedOrder).toEqual(rejection);
        done();
      });
      
      mockMarketMaker.handleOrderRejection(rejection);
    });
    
    test('should handle rejection without clOrdID gracefully', () => {
      const rejection = {
        reason: 'General error'
      };
      
      expect(() => {
        mockMarketMaker.handleOrderRejection(rejection);
      }).not.toThrow();
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(1);
    });
  });
  
  describe('FIX Reject Message Parsing', () => {
    test('should parse execution report reject message', () => {
      const rejectMessage = createRejectMessage('ORDER_001', 'Invalid client');
      const fields = parseFIXMessage(rejectMessage);
      
      expect(fields['35']).toBe('8'); // Execution Report
      expect(fields['11']).toBe('ORDER_001'); // ClOrdID
      expect(fields['39']).toBe('8'); // OrdStatus (Rejected)
      expect(fields['150']).toBe('8'); // ExecType (Rejected)
      expect(fields['58']).toBe('Invalid client'); // Text
    });
    
    test('should handle malformed reject messages', () => {
      const malformedMessage = '8=FIXT.1.1\x01INVALID_FORMAT\x01';
      const fields = parseFIXMessage(malformedMessage);
      
      expect(fields['8']).toBe('FIXT.1.1');
      expect(Object.keys(fields)).toHaveLength(1); // Only valid field parsed
    });
    
    test('should parse different rejection reasons', () => {
      const reasons = [
        'Invalid client',
        'Order outside book price bands',
        'Insufficient funds',
        'Invalid symbol',
        'Market closed'
      ];
      
      reasons.forEach((reason, index) => {
        const rejectMessage = createRejectMessage(`ORDER_${index}`, reason);
        const fields = parseFIXMessage(rejectMessage);
        
        expect(fields['58']).toBe(reason);
        expect(fields['11']).toBe(`ORDER_${index}`);
      });
    });
  });
  
  describe('Connection Error Handling', () => {
    test('should track connection errors', () => {
      const error1 = new Error('Connection timeout');
      const error2 = new Error('Network unreachable');
      
      mockMarketMaker.handleConnectionError(error1);
      mockMarketMaker.handleConnectionError(error2);
      
      expect(mockMarketMaker.connectionErrors).toHaveLength(2);
      expect(mockMarketMaker.connectionErrors[0].message).toBe('Connection timeout');
      expect(mockMarketMaker.connectionErrors[1].message).toBe('Network unreachable');
    });
    
    test('should emit connectionError event', (done) => {
      const error = new Error('Test connection error');
      
      mockMarketMaker.on('connectionError', (emittedError) => {
        expect(emittedError).toBe(error);
        done();
      });
      
      mockMarketMaker.handleConnectionError(error);
    });
  });
  
  describe('Error Recovery Scenarios', () => {
    test('should handle multiple rapid rejections', () => {
      const rejections = Array.from({ length: 10 }, (_, i) => ({
        clOrdID: `ORDER_${i}`,
        reason: 'Test rejection'
      }));
      
      rejections.forEach(rejection => {
        mockMarketMaker.handleOrderRejection(rejection);
      });
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(10);
    });
    
    test('should maintain state consistency during errors', () => {
      // Add some active orders
      for (let i = 0; i < 5; i++) {
        mockMarketMaker.addActiveOrder(`ORDER_${i}`, { symbol: 'BTC-PYUSD' });
      }
      
      expect(mockMarketMaker.activeOrders.size).toBe(5);
      
      // Reject some orders
      mockMarketMaker.handleOrderRejection({ clOrdID: 'ORDER_1', reason: 'Test' });
      mockMarketMaker.handleOrderRejection({ clOrdID: 'ORDER_3', reason: 'Test' });
      
      expect(mockMarketMaker.activeOrders.size).toBe(3);
      expect(mockMarketMaker.rejectedOrders).toHaveLength(2);
      
      // Remaining orders should still be tracked
      expect(mockMarketMaker.activeOrders.has('ORDER_0')).toBe(true);
      expect(mockMarketMaker.activeOrders.has('ORDER_2')).toBe(true);
      expect(mockMarketMaker.activeOrders.has('ORDER_4')).toBe(true);
    });
    
    test('should handle invalid client error without exiting in test mode', () => {
      mockMarketMaker.shouldExitOnInvalidClient = false;
      
      const rejection = {
        clOrdID: 'ORDER_001',
        reason: 'Invalid client'
      };
      
      expect(() => {
        mockMarketMaker.handleOrderRejection(rejection);
      }).not.toThrow();
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(1);
    });
  });
  
  describe('Message Validation Errors', () => {
    test('should handle missing required fields in order messages', () => {
      const incompleteOrderData = {
        clOrdID: 'ORDER_001'
        // Missing symbol, side, orderQty, etc.
      };
      
      expect(() => {
        buildNewOrderSingle('api_key', 'secret', incompleteOrderData, '1');
      }).not.toThrow(); // Should handle gracefully with defaults
    });
    
    test('should handle invalid order data types', () => {
      const invalidOrderData = {
        clOrdID: 123, // Should be string
        symbol: null,
        side: 'INVALID',
        orderQty: 'not_a_number',
        price: 'invalid_price'
      };
      
      expect(() => {
        buildNewOrderSingle('api_key', 'secret', invalidOrderData, '1');
      }).not.toThrow(); // Should handle gracefully
    });
    
    test('should handle empty or null API credentials', () => {
      const orderData = {
        clOrdID: 'ORDER_001',
        symbol: 'BTC-PYUSD',
        side: '1',
        orderQty: '0.01'
      };
      
      expect(() => {
        buildNewOrderSingle('', '', orderData, '1');
      }).not.toThrow();
      
      expect(() => {
        buildNewOrderSingle(null, null, orderData, '1');
      }).not.toThrow();
    });
  });
  
  describe('Performance Under Error Conditions', () => {
    test('should handle high volume of rejections efficiently', () => {
      const start = Date.now();
      
      // Simulate 1000 rapid rejections
      for (let i = 0; i < 1000; i++) {
        mockMarketMaker.handleOrderRejection({
          clOrdID: `ORDER_${i}`,
          reason: 'Test rejection'
        });
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should handle 1000 rejections in under 1 second
      expect(mockMarketMaker.rejectedOrders).toHaveLength(1000);
    });
    
    test('should maintain performance with large number of active orders during errors', () => {
      // Add 1000 active orders
      for (let i = 0; i < 1000; i++) {
        mockMarketMaker.addActiveOrder(`ORDER_${i}`, { symbol: 'BTC-PYUSD' });
      }
      
      const start = Date.now();
      
      // Reject every 10th order
      for (let i = 0; i < 1000; i += 10) {
        mockMarketMaker.handleOrderRejection({
          clOrdID: `ORDER_${i}`,
          reason: 'Test rejection'
        });
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500); // Should handle efficiently
      expect(mockMarketMaker.activeOrders.size).toBe(900); // 100 rejected
      expect(mockMarketMaker.rejectedOrders).toHaveLength(100);
    });
  });
  
  describe('Edge Cases and Boundary Conditions', () => {
    test('should handle rejection of non-existent order', () => {
      const rejection = {
        clOrdID: 'NON_EXISTENT_ORDER',
        reason: 'Order not found'
      };
      
      expect(() => {
        mockMarketMaker.handleOrderRejection(rejection);
      }).not.toThrow();
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(1);
    });
    
    test('should handle very long rejection reasons', () => {
      const longReason = 'A'.repeat(1000); // 1000 character reason
      const rejection = {
        clOrdID: 'ORDER_001',
        reason: longReason
      };
      
      expect(() => {
        mockMarketMaker.handleOrderRejection(rejection);
      }).not.toThrow();
      
      expect(mockMarketMaker.rejectedOrders[0].reason).toBe(longReason);
    });
    
    test('should handle special characters in rejection reasons', () => {
      const specialReason = 'Error: Invalid symbol "BTC/USD" - use "BTC-USD" instead! @#$%^&*()';
      const rejection = {
        clOrdID: 'ORDER_001',
        reason: specialReason
      };
      
      expect(() => {
        mockMarketMaker.handleOrderRejection(rejection);
      }).not.toThrow();
      
      expect(mockMarketMaker.rejectedOrders[0].reason).toBe(specialReason);
    });
    
    test('should handle concurrent error processing', async () => {
      const promises = [];
      
      // Simulate concurrent error handling
      for (let i = 0; i < 100; i++) {
        const promise = new Promise((resolve) => {
          setTimeout(() => {
            mockMarketMaker.handleOrderRejection({
              clOrdID: `CONCURRENT_ORDER_${i}`,
              reason: `Concurrent rejection ${i}`
            });
            resolve();
          }, Math.random() * 10);
        });
        promises.push(promise);
      }
      
      await Promise.all(promises);
      
      expect(mockMarketMaker.rejectedOrders).toHaveLength(100);
      
      // All orders should be unique
      const orderIds = mockMarketMaker.rejectedOrders.map(r => r.clOrdID);
      const uniqueOrderIds = new Set(orderIds);
      expect(uniqueOrderIds.size).toBe(100);
    });
  });
  
  describe('Statistics and Reporting', () => {
    test('should provide accurate error statistics', () => {
      // Add some active orders
      mockMarketMaker.addActiveOrder('ORDER_1', {});
      mockMarketMaker.addActiveOrder('ORDER_2', {});
      
      // Add some rejections
      mockMarketMaker.handleOrderRejection({ clOrdID: 'ORDER_3', reason: 'Test' });
      mockMarketMaker.handleOrderRejection({ clOrdID: 'ORDER_4', reason: 'Test' });
      
      // Add some connection errors
      mockMarketMaker.handleConnectionError(new Error('Error 1'));
      mockMarketMaker.handleConnectionError(new Error('Error 2'));
      
      const stats = mockMarketMaker.getStats();
      
      expect(stats.activeOrders).toBe(2);
      expect(stats.rejectedOrders).toBe(2);
      expect(stats.connectionErrors).toBe(2);
    });
    
    test('should reset statistics correctly', () => {
      // Add some data
      mockMarketMaker.addActiveOrder('ORDER_1', {});
      mockMarketMaker.handleOrderRejection({ clOrdID: 'ORDER_2', reason: 'Test' });
      mockMarketMaker.handleConnectionError(new Error('Test'));
      
      let stats = mockMarketMaker.getStats();
      expect(stats.activeOrders).toBe(1);
      expect(stats.rejectedOrders).toBe(1);
      expect(stats.connectionErrors).toBe(1);
      
      // Reset
      mockMarketMaker.reset();
      
      stats = mockMarketMaker.getStats();
      expect(stats.activeOrders).toBe(0);
      expect(stats.rejectedOrders).toBe(0);
      expect(stats.connectionErrors).toBe(0);
    });
  });
});



