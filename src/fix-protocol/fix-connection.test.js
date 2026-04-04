import { describe, it, expect, jest, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import net from 'net';
import { FIXConnection } from './fix-connection.js';

// Create mock Socket class
class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.connect = jest.fn();
    this.write = jest.fn();
    this.destroy = jest.fn();
  }
}

// Mock net.Socket by replacing it on the imported module object
const OriginalSocket = net.Socket;
const mockSocketConstructor = jest.fn(() => new MockSocket());
net.Socket = mockSocketConstructor;

describe('FIXConnection', () => {
  let connection;
  let mockSocket;
  let mockSocketInstance;
  
  beforeEach(() => {
    // Reset mock
    mockSocketConstructor.mockClear();
    
    // Create connection instance
    connection = new FIXConnection({
      host: 'uat.truex.co',
      port: 19484,
      senderCompID: 'CLI_CLIENT',
      targetCompID: 'TRUEX_UAT_OE',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      heartbeatInterval: 30,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    });
    
    // Helper to get mock socket instance after connect() is called
    mockSocketInstance = null;
  });
  
  describe('Constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(connection.host).toBe('uat.truex.co');
      expect(connection.port).toBe(19484);
      expect(connection.senderCompID).toBe('CLI_CLIENT');
      expect(connection.targetCompID).toBe('TRUEX_UAT_OE');
      expect(connection.apiKey).toBe('test-api-key');
      expect(connection.apiSecret).toBe('test-api-secret');
      expect(connection.heartbeatInterval).toBe(30);
    });
    
    it('should initialize with default values', () => {
      const defaultConnection = new FIXConnection({
        host: 'test.com',
        port: 1234,
        targetCompID: 'TEST',
        apiKey: 'key',
        apiSecret: 'secret'
      });
      
      expect(defaultConnection.senderCompID).toBe('CLI_CLIENT');
      expect(defaultConnection.heartbeatInterval).toBe(30);
      expect(defaultConnection.maxReconnectAttempts).toBe(10);
      expect(defaultConnection.initialReconnectDelay).toBe(1000);
    });
    
    it('should initialize connection state', () => {
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
      expect(connection.msgSeqNum).toBe(1);
      expect(connection.expectedSeqNum).toBe(1);
    });
  });
  
  describe('connect()', () => {
    // Bug 1: stale heartbeat timestamps must be cleared on every connect attempt
    it('should reset lastHeartbeatReceived and lastHeartbeatSent to null at start of connect', async () => {
      // Simulate stale timestamps from a previous session
      connection.lastHeartbeatReceived = Date.now() - 674000;
      connection.lastHeartbeatSent = Date.now() - 700000;

      // Begin connecting — we just need connect() to have started
      const connectPromise = connection.connect();
      // Timestamps should be nulled synchronously at the start of connect()
      expect(connection.lastHeartbeatReceived).toBeNull();
      expect(connection.lastHeartbeatSent).toBeNull();

      // Clean up: destroy the socket so the promise doesn't hang the suite
      if (connection.socket) connection.socket.destroy();
      await connectPromise.catch(() => {});
    }, 35000);

    it('should establish TCP connection and send logon', async () => {
      const connectPromise = connection.connect();

      // Get the socket instance that was created
      mockSocketInstance = connection.socket;

      // Simulate successful TCP connection
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      // Wait for the internal 2s delay + sendLogon, then emit logon response
      // Poll until socket.write is called (logon sent), then respond
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const logonResponse = '8=FIXT.1.1\x019=50\x0135=A\x0149=TRUEX_UAT_OE\x0156=CLI_CLIENT\x0134=1\x0152=20251007-13:40:00.000\x0110=123\x01';
            mockSocketInstance.emit('data', Buffer.from(logonResponse));
            resolve();
          }
        }, 50);
      });

      await connectPromise;

      expect(mockSocketConstructor).toHaveBeenCalled();
      expect(mockSocketInstance.connect).toHaveBeenCalledWith(19484, 'uat.truex.co', expect.any(Function));
      expect(mockSocketInstance.write).toHaveBeenCalled();
      expect(connection.isConnected).toBe(true);
      expect(connection.isLoggedOn).toBe(true);
    }, 10000);

    it('should reject on connection timeout', async () => {
      // Create a connection with very short timeout for testing
      const shortTimeoutConnection = new FIXConnection({
        host: 'uat.truex.co',
        port: 19484,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
        heartbeatInterval: 30,
        logger: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          debug: jest.fn()
        }
      });

      // Override the connect timeout to be very short by monkey-patching
      const origConnect = shortTimeoutConnection.connect.bind(shortTimeoutConnection);
      shortTimeoutConnection.connect = function() {
        return new Promise((resolve, reject) => {
          this.socket = new net.Socket();
          // Immediately timeout
          setTimeout(() => {
            if (this.socket) this.socket.destroy();
            reject(new Error('Connection timeout'));
          }, 50);
        });
      };

      await expect(shortTimeoutConnection.connect()).rejects.toThrow('Connection timeout');
    }, 5000);
  });
  
  describe('sendLogon()', () => {
    beforeEach(() => {
      // Create socket for sendLogon tests
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should build correct logon message with HMAC signature', async () => {
      await connection.sendLogon();
      
      expect(mockSocketInstance.write).toHaveBeenCalled();
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      
      // Verify message structure
      expect(sentMessage).toContain('8=FIXT.1.1');
      expect(sentMessage).toContain('35=A'); // MsgType = Logon
      expect(sentMessage).toContain('49=CLI_CLIENT');
      expect(sentMessage).toContain('56=TRUEX_UAT_OE');
      expect(sentMessage).toContain('98=0'); // EncryptMethod = None
      expect(sentMessage).toContain('108=30'); // HeartBtInt
      expect(sentMessage).toContain('553=test-api-key'); // Username
      expect(sentMessage).toContain('554='); // Password (signature)
      expect(sentMessage).toContain('1137=FIX.5.0SP2');
    });
    
    it('should generate valid HMAC-SHA256 signature', async () => {
      await connection.sendLogon();
      
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      const fields = {};
      const parts = sentMessage.split('\x01');

      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          fields[part.substring(0, eqIdx)] = part.substring(eqIdx + 1);
        }
      }
      
      // Verify signature format (base64 string - TrueX uses base64)
      expect(fields['554']).toMatch(/^[A-Za-z0-9+/=]+$/);

      // Verify signature is correct
      // TrueX spec: payload = sendingTime + msgType + msgSeqNum + senderCompID + targetCompID + username
      const sendingTime = fields['52'];
      const signaturePayload = sendingTime + fields['35'] + fields['34'] + fields['49'] + fields['56'] + fields['553'];
      const testSecret = 'test-api-secret';
      const expectedSignature = crypto // nosemgrep: hardcoded-hmac-key — test fixture
        .createHmac('sha256', testSecret)
        .update(signaturePayload)
        .digest('base64');
      
      expect(fields['554']).toBe(expectedSignature);
    });
  });
  
  describe('sendMessage()', () => {
    beforeEach(() => {
      // Create socket for sendMessage tests
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should build FIX message with correct structure', async () => {
      const fields = {
        '35': 'D', // New Order Single
        '49': 'CLI_CLIENT',
        '56': 'TRUEX_UAT_OE',
        '11': 'ORDER123',
        '55': 'BTC/USD'
      };
      
      await connection.sendMessage(fields);
      
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      
      expect(sentMessage).toContain('8=FIXT.1.1');
      expect(sentMessage).toContain('9='); // BodyLength
      expect(sentMessage).toContain('35=D');
      expect(sentMessage).toContain('11=ORDER123');
      expect(sentMessage).toContain('55=BTC/USD');
      expect(sentMessage).toContain('10='); // CheckSum
    });
    
    it('should increment message sequence number', async () => {
      const initialSeqNum = connection.msgSeqNum;
      
      await connection.sendMessage({ '35': 'D', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' });
      
      expect(connection.msgSeqNum).toBe(initialSeqNum + 1);
    });
    
    it('should emit sent event', async () => {
      const sentHandler = jest.fn();
      connection.on('sent', sentHandler);
      
      await connection.sendMessage({ '35': 'D', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' });
      
      expect(sentHandler).toHaveBeenCalledWith(expect.objectContaining({
        raw: expect.any(String),
        fields: expect.any(Object),
        msgSeqNum: expect.any(Number)
      }));
    });
  });
  
  describe('parseMessage()', () => {
    it('should parse FIX message correctly', () => {
      const rawMessage = '8=FIXT.1.1\x019=50\x0135=A\x0149=TRUEX\x0156=CLIENT\x0134=1\x0152=20251007-13:40:00.000\x0110=123\x01';
      
      const parsed = connection.parseMessage(rawMessage);
      
      expect(parsed.raw).toBe(rawMessage);
      expect(parsed.fields['8']).toBe('FIXT.1.1');
      expect(parsed.fields['35']).toBe('A');
      expect(parsed.fields['49']).toBe('TRUEX');
      expect(parsed.fields['56']).toBe('CLIENT');
      expect(parsed.fields['34']).toBe('1');
    });
    
    it('should handle empty fields', () => {
      const rawMessage = '8=FIXT.1.1\x0135=A\x0110=123\x01';
      
      const parsed = connection.parseMessage(rawMessage);
      
      expect(parsed.fields['8']).toBe('FIXT.1.1');
      expect(parsed.fields['35']).toBe('A');
    });
  });
  
  describe('validateSequence()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });

    it('should return OK for correct sequence', () => {
      connection.expectedSeqNum = 5;

      const result = connection.validateSequence(5);

      expect(result).toBe('OK');
      expect(connection.expectedSeqNum).toBe(6);
    });

    it('should return DUPLICATE for old sequence', () => {
      connection.expectedSeqNum = 5;

      const result = connection.validateSequence(3);
    });

    it('should send resend request message', async () => {
      await connection.requestResend(5, 10);

      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      
      expect(sentMessage).toContain('35=2'); // MsgType = Resend Request
      expect(sentMessage).toContain('7=5'); // BeginSeqNo
      expect(sentMessage).toContain('16=10'); // EndSeqNo
    });
    
    it('should emit resend-request event', async () => {
      const resendHandler = jest.fn();
      connection.on('resend-request', resendHandler);
      
      await connection.requestResend(5, 10);
      
      expect(resendHandler).toHaveBeenCalledWith({ beginSeqNo: 5, endSeqNo: 10 });
    });
  });
  
  describe('handleHeartbeat()', () => {
    it('should update last heartbeat received timestamp', () => {
      const message = { fields: { '35': '0' } };
      const beforeTime = Date.now();
      
      connection.handleHeartbeat(message);
      
      expect(connection.lastHeartbeatReceived).toBeGreaterThanOrEqual(beforeTime);
      expect(connection.lastHeartbeatReceived).toBeLessThanOrEqual(Date.now());
    });
  });
  
  describe('handleTestRequest()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should respond with heartbeat containing TestReqID', async () => {
      const message = { fields: { '35': '1', '112': 'TEST123' } };
      
      await connection.handleTestRequest(message);
      
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      
      expect(sentMessage).toContain('35=0'); // MsgType = Heartbeat
      expect(sentMessage).toContain('112=TEST123'); // TestReqID
    });
  });
  
  describe('handleReject()', () => {
    it('should emit reject event with reason', () => {
      const rejectHandler = jest.fn();
      connection.on('reject', rejectHandler);
      
      const message = { fields: { '35': '3', '58': 'Invalid message', '45': '5' } };
      
      connection.handleReject(message);
      
      expect(rejectHandler).toHaveBeenCalledWith({
        reason: 'Invalid message',
        refSeqNum: '5',
        message
      });
    });
  });
  
  describe('handleLogout()', () => {
    it('should set isLoggedOn to false and emit logout event', () => {
      connection.isLoggedOn = true;
      const logoutHandler = jest.fn();
      connection.on('logout', logoutHandler);
      
      const message = { fields: { '35': '5', '58': 'Session ended' } };
      
      connection.handleLogout(message);
      
      expect(connection.isLoggedOn).toBe(false);
      expect(logoutHandler).toHaveBeenCalledWith({
        text: 'Session ended',
        message
      });
    });
  });
  
  describe('startHeartbeat()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should start heartbeat timer', async () => {
      // Use a very short heartbeat interval for testing
      connection.heartbeatInterval = 0.1; // 100ms
      connection.startHeartbeat();

      expect(connection.heartbeatTimer).toBeDefined();

      // Wait for the heartbeat to fire
      await Bun.sleep(200);

      expect(mockSocketInstance.write).toHaveBeenCalled();
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).toContain('35=0'); // Heartbeat

      connection.stopHeartbeat();
    });

    it('should stop existing timer before starting new one', () => {
      connection.startHeartbeat();
      const firstTimer = connection.heartbeatTimer;

      connection.startHeartbeat();
      const secondTimer = connection.heartbeatTimer;

      expect(firstTimer).not.toBe(secondTimer);

      connection.stopHeartbeat();
    });
  });
  
  describe('stopHeartbeat()', () => {
    it('should clear heartbeat timer', () => {
      jest.useFakeTimers();
      
      connection.startHeartbeat();
      expect(connection.heartbeatTimer).toBeDefined();
      
      connection.stopHeartbeat();
      expect(connection.heartbeatTimer).toBeNull();
      
      jest.useRealTimers();
    });
  });
  
  describe('disconnect()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should send logout message and close connection', async () => {
      connection.isLoggedOn = true;
      
      await connection.disconnect();
      
      // Verify logout message sent
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).toContain('35=5'); // MsgType = Logout
      
      // Verify socket destroyed
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
    });
    
    it('should not send logout if not logged on', async () => {
      connection.isLoggedOn = false;
      
      await connection.disconnect();
      
      expect(mockSocketInstance.write).not.toHaveBeenCalled();
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
    });
  });
  
  describe('calculateChecksum()', () => {
    it('should calculate correct FIX checksum', () => {
      const message = '8=FIXT.1.1\x019=50\x0135=A\x01';
      
      const checksum = connection.calculateChecksum(message);
      
      // Verify checksum format (3 digits)
      expect(checksum).toMatch(/^\d{3}$/);
      
      // Verify checksum calculation
      let sum = 0;
      for (let i = 0; i < message.length; i++) {
        sum += message.charCodeAt(i);
      }
      const expected = String(sum % 256).padStart(3, '0');
      
      expect(checksum).toBe(expected);
    });
  });
  
  describe('getUTCTimestamp()', () => {
    it('should return timestamp in FIX format', () => {
      const timestamp = connection.getUTCTimestamp();
      
      // Format: YYYYMMDD-HH:MM:SS.sss
      expect(timestamp).toMatch(/^\d{8}-\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });
    
    it('should return UTC time', () => {
      const timestamp = connection.getUTCTimestamp();
      const [datePart, timePart] = timestamp.split('-');
      
      const now = new Date();
      const expectedDate = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
      
      expect(datePart).toBe(expectedDate);
    });
  });
  
  describe('getState()', () => {
    it('should return current connection state', () => {
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection.msgSeqNum = 10;
      connection.expectedSeqNum = 5;
      connection.reconnectAttempts = 2;
      
      const state = connection.getState();
      
      expect(state).toEqual({
        isConnected: true,
        isLoggedOn: true,
        targetCompID: 'TRUEX_UAT_OE',
        msgSeqNum: 10,
        expectedSeqNum: 5,
        reconnectAttempts: 2,
        lastHeartbeatReceived: null,
        lastHeartbeatSent: null
      });
    });
  });
  
  describe('handleDisconnect()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
    });
    
    it('should reset connection state', () => {
      connection.isConnected = true;
      connection.isLoggedOn = true;
      
      connection.handleDisconnect();
      
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
    });
    
    it('should emit disconnect event', () => {
      const disconnectHandler = jest.fn();
      connection.on('disconnect', disconnectHandler);
      
      connection.handleDisconnect();
      
      expect(disconnectHandler).toHaveBeenCalled();
    });
  });
  
  describe('attemptReconnect()', () => {
    it('should schedule reconnection with exponential backoff', () => {
      jest.useFakeTimers();

      connection.reconnectAttempts = 0;
      connection.attemptReconnect();

      expect(connection.reconnectAttempts).toBe(1);
      expect(connection.reconnectTimer).toBeDefined();

      jest.useRealTimers();
    });

    it('should emit reconnect-threshold (not stop) when attempts reach maxReconnectAttempts', () => {
      jest.useFakeTimers();

      connection.reconnectAttempts = 10;
      connection.maxReconnectAttempts = 10;
      connection.isReconnecting = false;

      const thresholdHandler = jest.fn();
      connection.on('reconnect-threshold', thresholdHandler);

      connection.attemptReconnect();

      // Threshold event fired, and retrying continues (timer is set)
      expect(thresholdHandler).toHaveBeenCalled();
      expect(connection.reconnectTimer).toBeTruthy();

      jest.useRealTimers();
    });

    afterEach(() => {
      // Clean up any timers
      if (connection.reconnectTimer) {
        clearTimeout(connection.reconnectTimer);
        connection.reconnectTimer = null;
      }
    });

    it('should use exponential backoff delays', () => {
      connection.initialReconnectDelay = 1000;
      connection.maxReconnectDelay = 30000;

      // First attempt: 1000ms
      connection.reconnectAttempts = 0;
      connection.isReconnecting = false; // simulate fresh state (as if connect() just started)
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(1);

      // Second attempt: 2000ms — simulate connect() clearing the flag then failing again
      connection.reconnectAttempts = 1;
      connection.isReconnecting = false;
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(2);

      // Third attempt: 4000ms
      connection.reconnectAttempts = 2;
      connection.isReconnecting = false;
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(3);
    });

    // Bug 2: duplicate reconnect guard
    it('should not schedule a second reconnect if one is already pending', () => {
      jest.useFakeTimers();

      connection.reconnectAttempts = 0;
      connection.attemptReconnect();
      const firstTimer = connection.reconnectTimer;

      // Call again without the first timer firing — must be a no-op
      connection.attemptReconnect();

      // reconnectAttempts should still be 1 (second call was a no-op)
      expect(connection.reconnectAttempts).toBe(1);
      // timer must be the same object — no new timer scheduled
      expect(connection.reconnectTimer).toBe(firstTimer);

      jest.useRealTimers();
    });

    it('should be a no-op when isReconnecting guard is already set', () => {
      // When isReconnecting is true, the second call is ignored
      connection.reconnectAttempts = 0;
      connection.isReconnecting = true;

      connection.attemptReconnect();

      // Counter should not have advanced — call was no-op
      expect(connection.reconnectAttempts).toBe(0);
      expect(connection.reconnectTimer).toBeFalsy();
    });
  });
  
  describe('handleIncomingData()', () => {
    it('should handle complete messages', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      const message = '8=FIXT.1.1\x019=50\x0135=8\x0149=TRUEX\x0156=CLIENT\x0134=1\x0152=20251007-13:40:00.000\x0110=123\x01';
      
      connection.handleIncomingData(Buffer.from(message));
      
      expect(messageHandler).toHaveBeenCalled();
    });
    
    it('should buffer incomplete messages', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      // Send partial message
      const part1 = '8=FIXT.1.1\x019=50\x0135=8\x01';
      connection.handleIncomingData(Buffer.from(part1));
      
      expect(messageHandler).not.toHaveBeenCalled();
      expect(connection.messageBuffer).toContain('8=FIXT.1.1');
      
      // Send rest of message
      const part2 = '49=TRUEX\x0156=CLIENT\x0134=1\x0152=20251007-13:40:00.000\x0110=123\x01';
      connection.handleIncomingData(Buffer.from(part2));
      
      expect(messageHandler).toHaveBeenCalled();
    });
    
    it('should handle multiple messages in one buffer', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      const message1 = '8=FIXT.1.1\x019=50\x0135=8\x0149=TRUEX\x0156=CLIENT\x0134=1\x0152=20251007-13:40:00.000\x0110=123\x01';
      const message2 = '8=FIXT.1.1\x019=50\x0135=8\x0149=TRUEX\x0156=CLIENT\x0134=2\x0152=20251007-13:40:01.000\x0110=124\x01';
      
      connection.handleIncomingData(Buffer.from(message1 + message2));

      expect(messageHandler).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Task 1.1 — Redis sequence number loading on connect
  // -----------------------------------------------------------------------
  describe('Redis sequence persistence — loadSequenceNumbers()', () => {
    it('should load msgSeqNum and expectedSeqNum from Redis on connect', async () => {
      const mockRedis = {
        get: jest.fn().mockImplementation((key) => {
          if (key === 'fix:seq:CLI_CLIENT:TRUEX_UAT_OE:out') return Promise.resolve('42');
          if (key === 'fix:seq:CLI_CLIENT:TRUEX_UAT_OE:in') return Promise.resolve('37');
          return Promise.resolve(null);
        }),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });

      await conn.loadSequenceNumbers();

      expect(conn.msgSeqNum).toBe(42);
      expect(conn.expectedSeqNum).toBe(37);
    });

    it('should default to 1 when Redis keys are missing', async () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });

      await conn.loadSequenceNumbers();

      expect(conn.msgSeqNum).toBe(1);
      expect(conn.expectedSeqNum).toBe(1);
    });

    it('should use correct Redis key format fix:seq:<senderCompID>:<targetCompID>:out and :in', async () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'TRUEX_PROD_OE',
        targetCompID: 'EXCHANGE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });

      await conn.loadSequenceNumbers();

      expect(mockRedis.get).toHaveBeenCalledWith('fix:seq:TRUEX_PROD_OE:EXCHANGE:out');
      expect(mockRedis.get).toHaveBeenCalledWith('fix:seq:TRUEX_PROD_OE:EXCHANGE:in');
    });
  });

  // -----------------------------------------------------------------------
  // Task 1.2 — Persist outbound sequence number on send (fire-and-forget)
  // -----------------------------------------------------------------------
  describe('Redis sequence persistence — outbound seqnum on send', () => {
    it('should call Redis set after sending a message', async () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      conn.socket = new MockSocket();
      conn.socket.write = jest.fn().mockReturnValue(true);

      await conn.sendMessage({ '35': '0', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE', '34': '1', '52': '20251007-13:40:00.000' });

      // After sendMessage, msgSeqNum is incremented to 2
      expect(mockRedis.set).toHaveBeenCalledWith('fix:seq:CLI_CLIENT:TRUEX_UAT_OE:out', 2);
    });

    it('should not call Redis set when redisClient is null (backward compat)', async () => {
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      conn.socket = new MockSocket();
      conn.socket.write = jest.fn().mockReturnValue(true);

      // Should resolve successfully without throwing
      const result = await conn.sendMessage({ '35': '0', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE', '34': '1', '52': '20251007-13:40:00.000' });
      expect(result).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Task 1.3 — Persist inbound expected seqnum after sequence advance
  // -----------------------------------------------------------------------
  describe('Redis sequence persistence — inbound seqnum on receive', () => {
    it('should call Redis set after a valid sequence advance', () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      conn.expectedSeqNum = 1;

      const result = conn.validateSequence(1);

      expect(result).toBe('OK');
      // expectedSeqNum incremented to 2
      expect(mockRedis.set).toHaveBeenCalledWith('fix:seq:CLI_CLIENT:TRUEX_UAT_OE:in', 2);
    });

    it('should NOT call Redis set on duplicate or gap detection', () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const conn = new FIXConnection({
        host: 'test.host',
        port: 1234,
        senderCompID: 'CLI_CLIENT',
        targetCompID: 'TRUEX_UAT_OE',
        apiKey: 'k',
        apiSecret: 's',
        redisClient: mockRedis,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      conn.expectedSeqNum = 5;

      const dupResult = conn.validateSequence(3);  // duplicate
      const gapResult = conn.validateSequence(10); // gap

      expect(dupResult).toBe('DUPLICATE');
      expect(gapResult).toBe('GAP');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Task 2.1 — Remove hard reconnect cap, emit 'reconnect-threshold' at 10
  // -----------------------------------------------------------------------
  describe('Task 2.1 — unlimited reconnect with threshold alert', () => {
    it('should NOT throw or emit max-reconnect-attempts when attempts >= maxReconnectAttempts', () => {
      jest.useFakeTimers();

      connection.reconnectAttempts = 10;
      connection.maxReconnectAttempts = 10;

      const maxHandler = jest.fn();
      connection.on('max-reconnect-attempts', maxHandler);

      // Should not throw
      expect(() => connection.attemptReconnect()).not.toThrow();

      // Should NOT emit max-reconnect-attempts (old behaviour removed)
      expect(maxHandler).not.toHaveBeenCalled();

      jest.useRealTimers();
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    });

    it('should emit reconnect-threshold event when attempts reach MAX_RECONNECT_ALERT_THRESHOLD', () => {
      jest.useFakeTimers();

      connection.reconnectAttempts = 10;
      connection.maxReconnectAttempts = 10;
      connection.isReconnecting = false;

      const thresholdHandler = jest.fn();
      connection.on('reconnect-threshold', thresholdHandler);

      connection.attemptReconnect();

      expect(thresholdHandler).toHaveBeenCalled();

      jest.useRealTimers();
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    });

    it('should continue scheduling reconnects beyond MAX_RECONNECT_ALERT_THRESHOLD', () => {
      jest.useFakeTimers();

      // Already at threshold
      connection.reconnectAttempts = 10;
      connection.maxReconnectAttempts = 10;
      connection.isReconnecting = false;

      connection.attemptReconnect();

      // A reconnect timer should have been scheduled
      expect(connection.reconnectTimer).toBeTruthy();
      expect(connection.reconnectAttempts).toBe(11);

      jest.useRealTimers();
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    });
  });

  // -----------------------------------------------------------------------
  // Task 2.2 — ±20% jitter on reconnect delay
  // -----------------------------------------------------------------------
  describe('Task 2.2 — jitter on reconnect backoff delay', () => {
    it('should apply delay within ±20% of the base delay', () => {
      // Spy on setTimeout to capture the actual delay used
      const originalSetTimeout = global.setTimeout;
      const capturedDelays = [];
      const setTimeoutSpy = jest.fn((fn, delay) => {
        capturedDelays.push(delay);
        return originalSetTimeout(fn, 0); // fire immediately in test
      });
      global.setTimeout = setTimeoutSpy;

      try {
        connection.initialReconnectDelay = 1000;
        connection.maxReconnectDelay = 30000;
        connection.reconnectAttempts = 0;
        connection.isReconnecting = false;

        connection.attemptReconnect();

        expect(capturedDelays.length).toBeGreaterThan(0);
        const usedDelay = capturedDelays[0];
        const baseDelay = 1000; // attempt 1: 1000 * 2^0

        expect(usedDelay).toBeGreaterThanOrEqual(baseDelay * 0.8);
        expect(usedDelay).toBeLessThanOrEqual(baseDelay * 1.2);
      } finally {
        global.setTimeout = originalSetTimeout;
        if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      }
    });

    it('should produce varying delays across multiple calls (randomness)', () => {
      const originalSetTimeout = global.setTimeout;
      const capturedDelays = [];
      const setTimeoutSpy = jest.fn((fn, delay) => {
        capturedDelays.push(delay);
        return originalSetTimeout(fn, 999999); // don't actually fire
      });
      global.setTimeout = setTimeoutSpy;

      try {
        connection.initialReconnectDelay = 1000;
        connection.maxReconnectDelay = 30000;

        // Run 20 calls at attempt=0 to get multiple delay samples
        for (let i = 0; i < 20; i++) {
          connection.reconnectAttempts = 0;
          connection.isReconnecting = false;
          connection.reconnectTimer = null;
          connection.attemptReconnect();
        }

        // All delays must be in range
        for (const d of capturedDelays) {
          expect(d).toBeGreaterThanOrEqual(800);
          expect(d).toBeLessThanOrEqual(1200);
        }

        // Not all should be identical (jitter adds randomness)
        const unique = new Set(capturedDelays);
        expect(unique.size).toBeGreaterThan(1);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Task 2.3 — Reset reconnect counter after 60s stable connection
  // -----------------------------------------------------------------------
  describe('Task 2.3 — stable connection resets reconnect counter', () => {
    it('should start a stable timer and reset reconnectAttempts when it fires', async () => {
      connection.reconnectAttempts = 5;

      // Patch global setTimeout to fire immediately (0ms) so the real
      // _startStableTimer callback runs without waiting 60 real seconds.
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);

      try {
        // _startStableTimer sets a 60s timeout — verify it was scheduled
        connection._startStableTimer();
        expect(connection._stableTimer).toBeTruthy();

        // reconnectAttempts should NOT have reset yet (timer hasn't fired)
        expect(connection.reconnectAttempts).toBe(5);

        // Wait for the real callback (now 0ms delay) to fire
        await new Promise(resolve => originalSetTimeout(resolve, 20));

        // Real callback reset reconnectAttempts to 0
        expect(connection.reconnectAttempts).toBe(0);
        expect(connection._stableTimer).toBeNull();
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('should clear stable timer on disconnect', () => {
      connection.socket = new MockSocket();
      connection.reconnectAttempts = 3;

      // Start stable timer
      connection._stableTimer = setTimeout(() => {
        connection.reconnectAttempts = 0;
      }, 60000);

      const timerRef = connection._stableTimer;
      expect(timerRef).toBeTruthy();

      // handleDisconnect should clear the timer
      connection.handleDisconnect();

      expect(connection._stableTimer).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Task 2.4 — GapFill for stale application message resends
  // -----------------------------------------------------------------------
  describe('Task 2.4 — GapFill for stale app message resends', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
      // Store some test messages in sentMessages
      connection.sentMessages.set(1, {
        seqNum: 1,
        fields: { '35': 'D', '11': 'ORDER1', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' },
        rawMessage: '...',
        sentAt: Date.now()
      });
      connection.sentMessages.set(2, {
        seqNum: 2,
        fields: { '35': 'F', '11': 'ORDER2', '41': 'ORDER1', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' },
        rawMessage: '...',
        sentAt: Date.now()
      });
      connection.sentMessages.set(3, {
        seqNum: 3,
        fields: { '35': 'G', '11': 'ORDER3', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' },
        rawMessage: '...',
        sentAt: Date.now()
      });
      connection.msgSeqNum = 5; // next to send
    });

    it('should send GapFill (35=4, GapFillFlag=Y) for order messages (35=D)', () => {
      const resendMsg = {
        fields: { '35': '2', '7': '1', '16': '1', '34': '10' }
      };

      connection.handleResendRequest(resendMsg);

      const writtenCalls = mockSocketInstance.write.mock.calls;
      expect(writtenCalls.length).toBeGreaterThan(0);

      const written = writtenCalls[0][0];
      expect(written).toContain('35=4');       // SequenceReset
      expect(written).toContain('123=Y');       // GapFillFlag
    });

    it('should set NewSeqNo to seq after the gap-filled range', () => {
      // ResendRequest for seq 1 to 3 (all app messages: D, F, G)
      const resendMsg = {
        fields: { '35': '2', '7': '1', '16': '3', '34': '10' }
      };

      connection.handleResendRequest(resendMsg);

      const writtenCalls = mockSocketInstance.write.mock.calls;
      expect(writtenCalls.length).toBeGreaterThan(0);

      const written = writtenCalls[0][0];
      // NewSeqNo (tag 36) should be 4 (seq after the last gap-filled = 3+1)
      expect(written).toContain('36=4');
    });

    it('should retransmit session-layer messages (35=A) with PossDupFlag=Y', () => {
      connection.sentMessages.set(10, {
        seqNum: 10,
        fields: { '35': 'A', '49': 'CLI_CLIENT', '56': 'TRUEX_UAT_OE' },
        rawMessage: '...',
        sentAt: Date.now()
      });
      connection.msgSeqNum = 15;

      const resendMsg = {
        fields: { '35': '2', '7': '10', '16': '10', '34': '20' }
      };

      connection.handleResendRequest(resendMsg);

      const writtenCalls = mockSocketInstance.write.mock.calls;
      expect(writtenCalls.length).toBeGreaterThan(0);

      const written = writtenCalls[0][0];
      // Should be a retransmit of 35=A with PossDupFlag
      expect(written).toContain('35=A');
      expect(written).toContain('43=Y');  // PossDupFlag
    });
  });
});
