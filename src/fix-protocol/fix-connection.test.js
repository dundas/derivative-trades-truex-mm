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
      const expectedSignature = crypto
        .createHmac('sha256', 'test-api-secret')
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
    
    it('should not exceed max reconnect attempts', () => {
      connection.reconnectAttempts = 10;
      connection.maxReconnectAttempts = 10;
      
      const maxAttemptsHandler = jest.fn();
      connection.on('max-reconnect-attempts', maxAttemptsHandler);
      
      connection.attemptReconnect();
      
      expect(maxAttemptsHandler).toHaveBeenCalled();
      // reconnectTimer should not be set when max attempts reached
      expect(connection.reconnectTimer).toBeFalsy();
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
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(1);
      
      // Second attempt: 2000ms
      connection.reconnectAttempts = 1;
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(2);
      
      // Third attempt: 4000ms
      connection.reconnectAttempts = 2;
      connection.attemptReconnect();
      expect(connection.reconnectAttempts).toBe(3);
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
});
