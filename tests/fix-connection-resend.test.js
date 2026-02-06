/**
 * Unit tests for FIXConnection resend request handling
 * Tests message storage, resend logic, PossDupFlag, and memory management
 */

import { jest, describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { FIXConnection } from '../src/fix-protocol/fix-connection.js';
import { EventEmitter } from 'events';

// Use jest.fn() for bun:test compatibility with matchers
function createMockFn() {
  return jest.fn();
}

describe('FIXConnection - Message Storage', () => {
  let fixConnection;
  let mockSocket;
  let mockLogger;

  beforeEach(() => {
    // Create mock socket
    mockSocket = new EventEmitter();
    mockSocket.write = () => true; // Simulates successful write
    mockSocket.writeCallCount = 0;
    mockSocket.writtenMessages = [];
    mockSocket.write = (message) => {
      mockSocket.writeCallCount++;
      mockSocket.writtenMessages.push(message);
      return true;
    };
    mockSocket.connect = (port, host, cb) => {
      setTimeout(cb, 0);
      return mockSocket;
    };
    mockSocket.destroy = () => {
      mockSocket.destroyed = true;
    };
    mockSocket.destroyed = false;

    // Create mock logger
    mockLogger = {
      info: createMockFn(),
      warn: createMockFn(),
      error: createMockFn(),
      debug: createMockFn()
    };

    // Create FIXConnection instance
    fixConnection = new FIXConnection({
      host: 'localhost',
      port: 3004,
      senderCompID: 'TEST_CLIENT',
      targetCompID: 'TEST_SERVER',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: mockLogger,
      maxStoredMessages: 100,
      messageRetentionMs: 60000, // 1 minute for testing
      cleanupInterval: 10000 // 10 seconds for testing
    });
    
    // Attach mock socket directly
    fixConnection.socket = mockSocket;
  });

  afterEach(() => {
    if (fixConnection.cleanupTimer) {
      fixConnection.stopCleanupTimer();
    }
    
  });

  test('stores outbound messages with all required fields', async () => {
    // Arrange
    const fields = {
      '8': 'FIXT.1.1',
      '35': 'D', // New Order Single
      '49': 'TEST_CLIENT',
      '56': 'TEST_SERVER',
      '34': '1',
      '52': '20251009-10:30:00',
      '11': 'ORDER123',
      '55': 'BTC/USD',
      '54': '1', // Buy
      '38': '1.5',
      '40': '2', // Limit
      '44': '50000'
    };

    // Act
    await fixConnection.sendMessage(fields);

    // Assert
    expect(fixConnection.sentMessages.size).toBe(1);
    const stored = fixConnection.sentMessages.get(1);
    expect(stored).toBeDefined();
    expect(stored.seqNum).toBe(1);
    expect(stored.fields).toBeDefined();
    expect(stored.rawMessage).toBeDefined();
    expect(stored.sentAt).toBeDefined();
    expect(typeof stored.sentAt).toBe('number');
  });

  test('increments sequence number for each message', async () => {
    // Arrange & Act
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });

    // Assert
    expect(fixConnection.msgSeqNum).toBe(4); // Next seq num
    expect(fixConnection.sentMessages.size).toBe(3);
    expect(fixConnection.sentMessages.has(1)).toBe(true);
    expect(fixConnection.sentMessages.has(2)).toBe(true);
    expect(fixConnection.sentMessages.has(3)).toBe(true);
  });
});

describe('FIXConnection - Resend Request Handling', () => {
  let fixConnection;
  let mockSocket;
  let mockLogger;

  beforeEach(() => {
    mockSocket = new EventEmitter();
    mockSocket.write = createMockFn();
    mockSocket.connect = (port, host, cb) => {
      setTimeout(cb, 0);
      return mockSocket;
    };
    mockSocket.destroy = createMockFn();
    mockSocket.destroyed = false;

    mockLogger = {
      info: createMockFn(),
      warn: createMockFn(),
      error: createMockFn(),
      debug: createMockFn()
    };

    fixConnection = new FIXConnection({
      host: 'localhost',
      port: 3004,
      senderCompID: 'TEST_CLIENT',
      targetCompID: 'TEST_SERVER',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: mockLogger
    });

    // Mock socket as writable
    fixConnection.socket = mockSocket;
  });

  afterEach(() => {
    
  });

  test('handles resend request for specific range (7=5, 16=10)', async () => {
    // Arrange - send 10 messages
    for (let i = 1; i <= 10; i++) {
      await fixConnection.sendMessage({
        '35': 'D',
        '49': 'TEST',
        '56': 'SERVER',
        '11': `ORDER${i}`
      });
    }

    const initialWriteCount = mockSocket.write.mock.calls.length;
    mockSocket.write.mockClear();

    // Act - simulate resend request for messages 5-10
    const resendRequest = {
      fields: {
        '35': '2', // Resend Request
        '7': '5',  // BeginSeqNo
        '16': '10' // EndSeqNo
      }
    };

    const resendCompletedPromise = new Promise(resolve => {
      fixConnection.once('resendCompleted', resolve);
    });

    fixConnection.handleResendRequest(resendRequest);
    const result = await resendCompletedPromise;

    // Assert
    expect(result.beginSeqNo).toBe(5);
    expect(result.endSeqNo).toBe(10);
    expect(result.count).toBe(6); // 5, 6, 7, 8, 9, 10
    expect(result.skipped).toBe(0);
    expect(mockSocket.write).toHaveBeenCalledTimes(6);
  });

  test('handles resend request for all messages (16=0)', async () => {
    // Arrange - send 5 messages
    for (let i = 1; i <= 5; i++) {
      await fixConnection.sendMessage({
        '35': 'D',
        '49': 'TEST',
        '56': 'SERVER'
      });
    }

    mockSocket.write.mockClear();

    // Act - simulate resend request with EndSeqNo=0 (all from 2 onwards)
    const resendRequest = {
      fields: {
        '35': '2',
        '7': '2',  // BeginSeqNo
        '16': '0'  // EndSeqNo = 0 means "all messages"
      }
    };

    const resendCompletedPromise = new Promise(resolve => {
      fixConnection.once('resendCompleted', resolve);
    });

    fixConnection.handleResendRequest(resendRequest);
    const result = await resendCompletedPromise;

    // Assert - should resend messages 2-5 (4 messages)
    expect(result.count).toBe(4);
    expect(mockSocket.write).toHaveBeenCalledTimes(4);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Server requested resend: 2 to ∞')
    );
  });

  test('handles missing messages gracefully (gaps in storage)', async () => {
    // Arrange - send messages 1, 2, 3, manually delete 2
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });
    await fixConnection.sendMessage({ '35': 'D', '49': 'TEST', '56': 'SERVER' });
    
    fixConnection.sentMessages.delete(2); // Simulate missing message
    mockSocket.write.mockClear();

    // Act
    const resendRequest = {
      fields: { '35': '2', '7': '1', '16': '3' }
    };

    const resendCompletedPromise = new Promise(resolve => {
      fixConnection.once('resendCompleted', resolve);
    });

    fixConnection.handleResendRequest(resendRequest);
    const result = await resendCompletedPromise;

    // Assert
    expect(result.count).toBe(2); // Only 1 and 3 resent
    expect(result.skipped).toBe(1); // Message 2 skipped
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Message seq 2 not in storage')
    );
  });

  test('validates invalid resend ranges', () => {
    // Act & Assert - beginSeqNo < 1
    const resendCompletedPromise1 = new Promise(resolve => {
      fixConnection.once('resend-request-received', resolve);
    });
    fixConnection.handleResendRequest({ fields: { '7': '0', '16': '10' } });
    
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid resend range')
    );

    mockLogger.error.mockClear();

    // Act & Assert - endSeqNo < beginSeqNo
    fixConnection.handleResendRequest({ fields: { '7': '10', '16': '5' } });
    
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid resend range')
    );
  });
});

describe('FIXConnection - PossDupFlag Support', () => {
  let fixConnection;
  let mockSocket;
  let mockLogger;

  beforeEach(() => {
    mockSocket = new EventEmitter();
    mockSocket.write = createMockFn();
    mockSocket.connect = (port, host, cb) => {
      setTimeout(cb, 0);
      return mockSocket;
    };
    mockSocket.destroy = createMockFn();
    mockSocket.destroyed = false;

    mockLogger = {
      info: createMockFn(),
      warn: createMockFn(),
      error: createMockFn(),
      debug: createMockFn()
    };

    fixConnection = new FIXConnection({
      host: 'localhost',
      port: 3004,
      senderCompID: 'TEST_CLIENT',
      targetCompID: 'TEST_SERVER',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: mockLogger
    });

    fixConnection.socket = mockSocket;
  });

  afterEach(() => {
    
  });

  test('adds PossDupFlag to resent messages', async () => {
    // Arrange
    await fixConnection.sendMessage({
      '35': 'D',
      '49': 'TEST',
      '56': 'SERVER',
      '52': '20251009-10:30:00'
    });

    mockSocket.write.mockClear();

    // Act
    const resendRequest = { fields: { '35': '2', '7': '1', '16': '1' } };
    fixConnection.handleResendRequest(resendRequest);

    // Assert
    const resentMessage = mockSocket.write.mock.calls[0][0];
    expect(resentMessage).toContain('43=Y'); // PossDupFlag
  });

  test('preserves OrigSendingTime in resent messages', async () => {
    // Arrange
    const originalSendingTime = '20251009-10:30:00';
    await fixConnection.sendMessage({
      '35': 'D',
      '49': 'TEST',
      '56': 'SERVER',
      '52': originalSendingTime,
      '122': originalSendingTime // Already has OrigSendingTime
    });

    mockSocket.write.mockClear();

    // Act
    const resendRequest = { fields: { '35': '2', '7': '1', '16': '1' } };
    fixConnection.handleResendRequest(resendRequest);

    // Assert
    const resentMessage = mockSocket.write.mock.calls[0][0];
    expect(resentMessage).toContain(`122=${originalSendingTime}`);
  });

  test('omits OrigSendingTime if not present (TrueX rejects tag 122)', async () => {
    // Arrange
    const sendingTime = '20251009-10:30:00';
    await fixConnection.sendMessage({
      '35': 'D',
      '49': 'TEST',
      '56': 'SERVER',
      '52': sendingTime
      // No 122 field
    });

    mockSocket.write.mockClear();

    // Act
    const resendRequest = { fields: { '35': '2', '7': '1', '16': '1' } };
    fixConnection.handleResendRequest(resendRequest);

    // Assert - TrueX rejects messages with field 122, so it should NOT be added
    const resentMessage = mockSocket.write.mock.calls[0][0];
    expect(resentMessage).not.toContain('122=');
  });
});

describe('FIXConnection - Memory Management', () => {
  let fixConnection;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: createMockFn(),
      warn: createMockFn(),
      error: createMockFn(),
      debug: createMockFn()
    };

    fixConnection = new FIXConnection({
      host: 'localhost',
      port: 3004,
      senderCompID: 'TEST_CLIENT',
      targetCompID: 'TEST_SERVER',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: mockLogger,
      maxStoredMessages: 10,
      messageRetentionMs: 100 // 100ms for testing
    });
  });

  afterEach(() => {
    if (fixConnection.cleanupTimer) {
      fixConnection.stopCleanupTimer();
    }
    
  });

  test('cleans up old messages based on retention policy', async () => {
    // Arrange - add messages
    for (let i = 1; i <= 5; i++) {
      fixConnection.sentMessages.set(i, {
        seqNum: i,
        fields: {},
        rawMessage: '',
        sentAt: Date.now() - 200 // 200ms ago (older than 100ms retention)
      });
    }

    // Add one recent message
    fixConnection.sentMessages.set(6, {
      seqNum: 6,
      fields: {},
      rawMessage: '',
      sentAt: Date.now()
    });

    expect(fixConnection.sentMessages.size).toBe(6);

    // Act
    const result = fixConnection.cleanupOldMessages();

    // Assert
    expect(result.removedByAge).toBe(5);
    expect(result.currentSize).toBe(1);
    expect(fixConnection.sentMessages.has(6)).toBe(true);
  });

  test('caps stored messages at maxStoredMessages limit', async () => {
    // Arrange - add 15 messages (max is 10)
    for (let i = 1; i <= 15; i++) {
      fixConnection.sentMessages.set(i, {
        seqNum: i,
        fields: {},
        rawMessage: '',
        sentAt: Date.now()
      });
    }

    expect(fixConnection.sentMessages.size).toBe(15);

    // Act
    const result = fixConnection.cleanupOldMessages();

    // Assert
    expect(result.removedByCap).toBe(5); // 15 - 10 = 5
    expect(result.currentSize).toBe(10);
    // Should keep newest 10 (6-15)
    expect(fixConnection.sentMessages.has(1)).toBe(false);
    expect(fixConnection.sentMessages.has(5)).toBe(false);
    expect(fixConnection.sentMessages.has(6)).toBe(true);
    expect(fixConnection.sentMessages.has(15)).toBe(true);
  });

  test('starts and stops cleanup timer correctly', () => {
    // Act - start
    fixConnection.startCleanupTimer();

    // Assert
    expect(fixConnection.cleanupTimer).toBeDefined();
    expect(fixConnection.cleanupTimer).not.toBeNull();

    // Act - stop
    fixConnection.stopCleanupTimer();

    // Assert
    expect(fixConnection.cleanupTimer).toBeNull();
  });

  test('cleanup timer does not start twice', () => {
    // Act
    fixConnection.startCleanupTimer();
    const firstTimer = fixConnection.cleanupTimer;
    fixConnection.startCleanupTimer(); // Try to start again

    // Assert
    expect(fixConnection.cleanupTimer).toBe(firstTimer);
  });
});

describe('FIXConnection - Integration Scenarios', () => {
  let fixConnection;
  let mockSocket;
  let mockLogger;

  beforeEach(() => {
    mockSocket = new EventEmitter();
    mockSocket.write = createMockFn();
    mockSocket.connect = (port, host, cb) => {
      setTimeout(cb, 0);
      return mockSocket;
    };
    mockSocket.destroy = createMockFn();
    mockSocket.destroyed = false;

    mockLogger = {
      info: createMockFn(),
      warn: createMockFn(),
      error: createMockFn(),
      debug: createMockFn()
    };

    fixConnection = new FIXConnection({
      host: 'localhost',
      port: 3004,
      senderCompID: 'TEST_CLIENT',
      targetCompID: 'TEST_SERVER',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      logger: mockLogger
    });

    fixConnection.socket = mockSocket;
  });

  afterEach(() => {
    if (fixConnection.cleanupTimer) {
      fixConnection.stopCleanupTimer();
    }
    
  });

  test('handles 50-order scenario with resend request', async () => {
    // Arrange - send 50 orders
    for (let i = 1; i <= 50; i++) {
      await fixConnection.sendMessage({
        '35': 'D',
        '49': 'TEST',
        '56': 'SERVER',
        '11': `ORDER${i}`,
        '55': 'BTC/USD',
        '54': i % 2 === 0 ? '1' : '2', // Alternate buy/sell
        '38': '1.0',
        '40': '2',
        '44': '50000'
      });
    }

    expect(fixConnection.sentMessages.size).toBe(50);
    mockSocket.write.mockClear();

    // Act - simulate resend request for all orders
    const resendRequest = {
      fields: { '35': '2', '7': '1', '16': '50' }
    };

    const resendCompletedPromise = new Promise(resolve => {
      fixConnection.once('resendCompleted', resolve);
    });

    fixConnection.handleResendRequest(resendRequest);
    const result = await resendCompletedPromise;

    // Assert
    expect(result.count).toBe(50);
    expect(result.skipped).toBe(0);
    expect(mockSocket.write).toHaveBeenCalledTimes(50);
    
    // Verify all resent messages have PossDupFlag
    const resentMessages = mockSocket.write.mock.calls.map(call => call[0]);
    resentMessages.forEach(msg => {
      expect(msg).toContain('43=Y'); // PossDupFlag
    });
  });

  test('emits resendCompleted event with correct statistics', async () => {
    // Arrange
    for (let i = 1; i <= 10; i++) {
      await fixConnection.sendMessage({
        '35': 'D',
        '49': 'TEST',
        '56': 'SERVER'
      });
    }

    // Act
    const resendCompletedPromise = new Promise(resolve => {
      fixConnection.once('resendCompleted', resolve);
    });

    fixConnection.handleResendRequest({
      fields: { '35': '2', '7': '3', '16': '7' }
    });

    const result = await resendCompletedPromise;

    // Assert
    expect(result).toEqual({
      beginSeqNo: 3,
      endSeqNo: 7,
      count: 5,
      skipped: 0,
      requested: 5
    });
  });
});

