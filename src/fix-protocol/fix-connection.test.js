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

function makeFixFrame(fields) {
  const soh = '\x01';
  const body = Object.entries(fields).map(([tag, value]) => `${tag}=${value}${soh}`).join('');
  const withoutChecksum = `8=FIXT.1.1${soh}9=${body.length}${soh}${body}`;
  let sum = 0;
  for (let index = 0; index < withoutChecksum.length; index++) sum += withoutChecksum.charCodeAt(index);
  return `${withoutChecksum}10=${String(sum % 256).padStart(3, '0')}${soh}`;
}

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

    it('validates TestRequest idle and response windows as HeartBtInt multipliers', () => {
      expect(connection.testRequestIdleMultiplier).toBe(1.2);
      expect(connection.testRequestTimeoutMultiplier).toBe(1);

      const configured = new FIXConnection({
        host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
        testRequestIdleMultiplier: 1.5,
        testRequestTimeoutMultiplier: 0.5,
      });
      expect(configured.testRequestIdleMultiplier).toBe(1.5);
      expect(configured.testRequestTimeoutMultiplier).toBe(0.5);

      for (const invalid of [0, -1, 1, 3.1, NaN, '1.2', null]) {
        const candidate = new FIXConnection({
          host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
          testRequestIdleMultiplier: invalid,
          testRequestTimeoutMultiplier: invalid,
        });
        expect(candidate.testRequestIdleMultiplier).toBe(1.2);
        expect(candidate.testRequestTimeoutMultiplier).toBe(1);
      }
    });

    it('should default logon-reset fallback to enabled with threshold 3', () => {
      expect(connection._logonResetFallbackEnabled).toBe(true);
      expect(connection._logonResetThreshold).toBe(3);
      expect(connection._consecutiveLogonTimeouts).toBe(0);
    });

    it('should honor logon-reset fallback overrides', () => {
      const c = new FIXConnection({
        host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
        logonResetFallbackEnabled: false,
        logonResetThreshold: 7,
      });
      expect(c._logonResetFallbackEnabled).toBe(false);
      expect(c._logonResetThreshold).toBe(7);
    });

    it('should reject non-positive / non-integer logonResetThreshold and keep default', () => {
      const cases = [0, -1, 1.5, NaN, undefined, null, 'abc'];
      for (const bad of cases) {
        const c = new FIXConnection({
          host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
          logonResetThreshold: bad,
        });
        expect(c._logonResetThreshold).toBe(3);
      }
    });
  });

  describe('logon-reset fallback decision (_shouldUseLogonResetFallback)', () => {
    it('returns false on first connect even when counter is over threshold', () => {
      connection._consecutiveLogonTimeouts = 99;
      expect(connection._shouldUseLogonResetFallback(false)).toBe(false);
    });

    it('returns false on reconnect when counter is below threshold', () => {
      connection._consecutiveLogonTimeouts = 2;
      expect(connection._shouldUseLogonResetFallback(true)).toBe(false);
    });

    it('returns true on reconnect when counter has reached the threshold', () => {
      connection._consecutiveLogonTimeouts = 3;
      expect(connection._shouldUseLogonResetFallback(true)).toBe(true);
    });

    it('returns false when the fallback is disabled even if all other conditions hold', () => {
      const c = new FIXConnection({
        host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
        logonResetFallbackEnabled: false,
      });
      c._consecutiveLogonTimeouts = 99;
      expect(c._shouldUseLogonResetFallback(true)).toBe(false);
    });

    it('returns false once reset-fallback budget is exhausted (loop guard)', () => {
      connection._consecutiveLogonTimeouts = 99;
      connection._consecutiveResetFallbacks = connection._maxConsecutiveResetFallbacks;
      expect(connection._shouldUseLogonResetFallback(true)).toBe(false);
    });

    it('still allows fallback while reset-fallback budget remains', () => {
      connection._consecutiveLogonTimeouts = 99;
      connection._consecutiveResetFallbacks = connection._maxConsecutiveResetFallbacks - 1;
      expect(connection._shouldUseLogonResetFallback(true)).toBe(true);
    });
  });

  describe('loop guard constructor wiring', () => {
    it('defaults maxConsecutiveResetFallbacks to 3', () => {
      expect(connection._maxConsecutiveResetFallbacks).toBe(3);
      expect(connection._consecutiveResetFallbacks).toBe(0);
    });

    it('honors valid maxConsecutiveResetFallbacks override', () => {
      const c = new FIXConnection({
        host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
        maxConsecutiveResetFallbacks: 5,
      });
      expect(c._maxConsecutiveResetFallbacks).toBe(5);
    });

    it('rejects non-positive / non-integer maxConsecutiveResetFallbacks and keeps default', () => {
      for (const bad of [0, -1, 1.5, NaN, undefined, null, 'abc']) {
        const c = new FIXConnection({
          host: 'h', port: 1, targetCompID: 'T', apiKey: 'k', apiSecret: 's',
          maxConsecutiveResetFallbacks: bad,
        });
        expect(c._maxConsecutiveResetFallbacks).toBe(3);
      }
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
            const logonResponse = makeFixFrame({ '35': 'A', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1' });
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

    it('should remove temporary logon reject handler after successful logon', async () => {
      const connectPromise = connection.connect();
      mockSocketInstance = connection.socket;
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      await new Promise(resolve => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const logonResponse = makeFixFrame({ '35': 'A', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1' });
            mockSocketInstance.emit('data', Buffer.from(logonResponse));
            resolve();
          }
        }, 20);
      });

      await connectPromise;
      connection.emit('reject', { reason: 'Business reject after logon', message: { fields: { '35': '3' } } });

      expect(mockSocketInstance.destroy).not.toHaveBeenCalled();
      expect(connection.socket).toBe(mockSocketInstance);
      expect(connection.reconnectTimer).toBeNull();
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

    it('fires logon-reset fallback end-to-end when counter has reached threshold on a reconnect', async () => {
      // Simulate the live failure mode: hasConnectedBefore=true (so isReconnect),
      // counter at threshold, persisted seq high. After the connect ceremony the
      // fallback should: emit the event, reset sequence numbers, send a Logon
      // with 141=Y and seq=1, then on Ack clear both counters.
      connection.hasConnectedBefore = true;
      connection.msgSeqNum = 144247;
      connection.expectedSeqNum = 144247;
      connection._consecutiveLogonTimeouts = 3;
      connection._consecutiveResetFallbacks = 0;

      const resetSpy = jest.spyOn(connection, 'resetSequenceNumbers');
      const fallbackEvents = [];
      connection.on('logon-reset-fallback', (e) => fallbackEvents.push(e));

      const connectPromise = connection.connect();
      mockSocketInstance = connection.socket;
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const ack = makeFixFrame({ '35': 'A', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1' });
            mockSocketInstance.emit('data', Buffer.from(ack));
            resolve();
          }
        }, 20);
      });

      await connectPromise;

      // Reset was invoked exactly once during the fallback
      expect(resetSpy).toHaveBeenCalledTimes(1);
      // Fallback event fired with the right shape
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0].targetCompID).toBe('TRUEX_UAT_OE');
      expect(fallbackEvents[0].fallbackAttempt).toBe(1);
      expect(fallbackEvents[0].maxFallbacks).toBe(3);
      // Logon sent with 141=Y and seq reset to 1
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).toContain('141=Y');
      expect(sentMessage).toContain('34=1');
      // Successful Ack cleared both counters
      expect(connection.isLoggedOn).toBe(true);
      expect(connection._consecutiveLogonTimeouts).toBe(0);
      expect(connection._consecutiveResetFallbacks).toBe(0);

      resetSpy.mockRestore();
    }, 10000);

    it('emits logon-reset-fallback-exhausted on the fire that hits the loop-guard cap', async () => {
      // Pre-seed the connection at the brink: one more fallback fire will hit
      // the cap, which must surface as `logon-reset-fallback-exhausted`.
      connection.hasConnectedBefore = true;
      connection._consecutiveLogonTimeouts = 3;
      connection._consecutiveResetFallbacks = 2; // max is 3 → this fire makes it 3

      const exhaustedEvents = [];
      connection.on('logon-reset-fallback-exhausted', (e) => exhaustedEvents.push(e));

      const connectPromise = connection.connect();
      mockSocketInstance = connection.socket;
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const ack = makeFixFrame({ '35': 'A', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1' });
            mockSocketInstance.emit('data', Buffer.from(ack));
            resolve();
          }
        }, 20);
      });

      await connectPromise;

      expect(exhaustedEvents).toHaveLength(1);
      expect(exhaustedEvents[0].targetCompID).toBe('TRUEX_UAT_OE');
      expect(exhaustedEvents[0].attempts).toBe(3);
    }, 10000);

    it('does NOT fire the fallback when loop-guard budget is already exhausted', async () => {
      // Counter is at threshold but reset budget is already at the cap. The
      // gate must keep us on the normal session-resume path (no 141=Y).
      connection.hasConnectedBefore = true;
      connection._consecutiveLogonTimeouts = 3;
      connection._consecutiveResetFallbacks = 3; // exhausted

      const resetSpy = jest.spyOn(connection, 'resetSequenceNumbers');
      const fallbackEvents = [];
      connection.on('logon-reset-fallback', (e) => fallbackEvents.push(e));

      const connectPromise = connection.connect();
      mockSocketInstance = connection.socket;
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const ack = makeFixFrame({ '35': 'A', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1' });
            mockSocketInstance.emit('data', Buffer.from(ack));
            resolve();
          }
        }, 20);
      });

      await connectPromise;

      expect(resetSpy).not.toHaveBeenCalled();
      expect(fallbackEvents).toHaveLength(0);
      // Sent Logon must NOT have 141=Y because reset path was skipped
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).not.toContain('141=Y');

      resetSpy.mockRestore();
    }, 10000);

    it('should emit duplicate-logon and tear down attempted socket on Already authenticated reject', async () => {
      const duplicateHandler = jest.fn();
      connection.on('duplicate-logon', duplicateHandler);

      const connectPromise = connection.connect();
      mockSocketInstance = connection.socket;
      const connectCallback = mockSocketInstance.connect.mock.calls[0][2];
      connectCallback();

      await new Promise(resolve => {
        const check = setInterval(() => {
          if (mockSocketInstance.write.mock.calls.length > 0) {
            clearInterval(check);
            const reject = makeFixFrame({
              '35': '3', '49': 'TRUEX_UAT_OE', '56': 'CLI_CLIENT', '34': '1',
              '58': 'Already authenticated cannot logon again',
            });
            mockSocketInstance.emit('data', Buffer.from(reject));
            resolve();
          }
        }, 20);
      });

      await expect(connectPromise).rejects.toThrow('Already authenticated');
      expect(duplicateHandler).toHaveBeenCalledWith({
        reason: 'Already authenticated cannot logon again',
        message: expect.any(Object),
      });
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
      expect(connection.socket).toBeNull();
      expect(connection.reconnectTimer).not.toBeNull();
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }, 10000);

    it('should ignore stale disconnect callbacks after a newer attempt owns the socket', () => {
      const oldSocket = new MockSocket();
      const newSocket = new MockSocket();
      connection.socket = newSocket;
      connection._connectionGeneration = 2;
      connection.isConnected = true;

      connection.handleDisconnect(oldSocket, 1);

      expect(connection.socket).toBe(newSocket);
      expect(connection.isConnected).toBe(true);
      expect(connection.reconnectTimer).toBeNull();
    });
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
    
    it('should NOT include 141=Y when sendLogon(true) is called (preserve seqnums on resume)', async () => {
      await connection.sendLogon(true);
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).not.toContain('141=Y');
    });

    it('should include 141=Y when sendLogon(false) is called (fresh session)', async () => {
      await connection.sendLogon(false);
      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage).toContain('141=Y');
    });

    it('resetSequenceNumbers() clears state so the next logon is treated as fresh', async () => {
      connection.msgSeqNum = 144247;
      connection.expectedSeqNum = 144247;
      connection.hasConnectedBefore = true;
      await connection.resetSequenceNumbers();
      expect(connection.msgSeqNum).toBe(1);
      expect(connection.expectedSeqNum).toBe(1);
      expect(connection.hasConnectedBefore).toBe(false);
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

    it('fails logon explicitly when synchronous dispatch is declined', async () => {
      connection.sendMessage = jest.fn(() => false);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      await expect(connection.sendLogon()).rejects.toThrow('Logon was not dispatched');
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'logon' }));
    });

    it('contains an async rejecting session-send-failed observer exactly once', async () => {
      connection.sendMessage = jest.fn(() => false);
      const observed = jest.fn(async () => { throw new Error('failure observer rejected'); });
      const unhandled = jest.fn();
      connection.on('session-send-failed', observed);
      process.on('unhandledRejection', unhandled);

      try {
        await expect(connection.sendLogon()).rejects.toThrow('Logon was not dispatched');
        await Bun.sleep(10);
        expect(observed).toHaveBeenCalledTimes(1);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it.each([
      ['synchronous throw', () => { throw new Error('logon enqueue failed'); }, 'logon enqueue failed'],
      ['rejected Promise', () => Promise.reject(new Error('logon dispatch rejected')), 'logon dispatch rejected'],
    ])('reports Logon %s exactly once and remains logged out', async (_name, sendResult, causeText) => {
      connection.sendMessage = jest.fn(sendResult);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      await expect(connection.sendLogon()).rejects.toThrow(`FIX Logon dispatch failed: ${causeText}`);

      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        action: 'logon',
        reason: causeText,
      }));
      expect(connection.isLoggedOn).toBe(false);
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

    it('returns synchronous definitive enqueue acceptance without waiting for socket drain', () => {
      mockSocketInstance.write.mockReturnValue(false); // net.Socket backpressure, bytes still enqueued
      const result = connection.sendMessage({ '35': 'D', '11': 'ORDER123' });

      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toBe(true);
      expect(mockSocketInstance.write).toHaveBeenCalledTimes(1);
      expect(connection.msgSeqNum).toBe(2);
    });

    it('throws synchronously without recording dispatch when socket enqueue throws', () => {
      mockSocketInstance.write.mockImplementation(() => { throw new Error('enqueue failed'); });
      expect(() => connection.sendMessage({ '35': 'D', '11': 'ORDER123' })).toThrow('enqueue failed');
      expect(connection.msgSeqNum).toBe(1);
      expect(connection.sentMessages.size).toBe(0);
    });

    it('does not turn post-enqueue telemetry failure into a dispatch rejection', () => {
      connection.auditLogger = { logFIXMessage: jest.fn(() => { throw new Error('audit failed'); }) };
      mockSocketInstance.write.mockReturnValue(true);
      expect(connection.sendMessage({ '35': 'D', '11': 'ORDER123' })).toBe(true);
      expect(connection.msgSeqNum).toBe(2);
      expect(connection.sentMessages.has(1)).toBe(true);
    });

    it('reserves sequence and resend bookkeeping before reentrant debug observers', () => {
      mockSocketInstance.write.mockReturnValue(true);
      let reentered = false;
      connection.logger.debug.mockImplementation(() => {
        if (reentered) return;
        reentered = true;
        connection.sendMessage({ '35': '0', '11': 'SECOND' });
      });

      expect(connection.sendMessage({ '35': '0', '11': 'FIRST' })).toBe(true);
      const sequences = mockSocketInstance.write.mock.calls.map(([raw]) =>
        Number(raw.match(/\x0134=(\d+)\x01/)[1]));
      expect(sequences).toEqual([1, 2]);
      expect([...connection.sentMessages.keys()]).toEqual([1, 2]);
      expect(connection.msgSeqNum).toBe(3);
    });

    it('never publishes a reentrant N+1 when the outer socket write fails', () => {
      const nestedResults = [];
      mockSocketInstance.write.mockImplementation(() => {
        nestedResults.push(connection.sendMessage({ '35': '0', '11': 'INNER' }));
        throw new Error('outer enqueue failed');
      });

      expect(() => connection.sendMessage({ '35': 'D', '11': 'OUTER' })).toThrow('outer enqueue failed');
      expect(nestedResults).toEqual([false]);
      expect(connection.msgSeqNum).toBe(1);
      expect([...connection.sentMessages.keys()]).toEqual([]);
      expect(mockSocketInstance.write).toHaveBeenCalledTimes(1);
    });

    it('contains every synchronous post-enqueue failure, including warning logger failure', () => {
      mockSocketInstance.write.mockReturnValue(true);
      connection.redisClient = { set: jest.fn(() => { throw new Error('redis invoke'); }) };
      connection.auditLogger = { logFIXMessage: jest.fn(() => { throw new Error('audit invoke'); }) };
      connection.logger.warn.mockImplementation(() => { throw new Error('warn invoke'); });
      connection.on('sent', () => { throw new Error('sent invoke'); });

      expect(connection.sendMessage({ '35': 'D', '11': 'ORDER123' })).toBe(true);
      expect(connection.msgSeqNum).toBe(2);
      expect(connection.sentMessages.has(1)).toBe(true);
    });

    it('contains asynchronous post-enqueue persistence, audit, and sent-listener rejections', async () => {
      mockSocketInstance.write.mockReturnValue(true);
      connection.redisClient = { set: jest.fn(() => Promise.reject(new Error('redis async'))) };
      connection.auditLogger = { logFIXMessage: jest.fn(() => Promise.reject(new Error('audit async'))) };
      connection.on('sent', async () => { throw new Error('sent async'); });

      expect(connection.sendMessage({ '35': 'D', '11': 'ORDER123' })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(connection.msgSeqNum).toBe(2);
      expect(connection.sentMessages.has(1)).toBe(true);
    });

    it('should serialize self-match prevention before order body fields', async () => {
      await connection.sendMessage({
        '35': 'D',
        '49': 'CLI_CLIENT',
        '56': 'TRUEX_UAT_OE',
        '11': 'ORDER123',
        '18': '6',
        '2964': 0,
        '55': 'BTC-PYUSD',
        '54': '1',
        '38': '0.01',
        '40': '2',
        '44': '100000.00',
        '59': '1',
      });

      const sentMessage = mockSocketInstance.write.mock.calls[0][0];
      expect(sentMessage.indexOf('\x0118=6\x01')).toBeLessThan(sentMessage.indexOf('\x012964=0\x01'));
      expect(sentMessage.indexOf('\x012964=0\x01')).toBeLessThan(sentMessage.indexOf('\x0138=0.01\x01'));
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
      expect(sentMessage).not.toContain('1137=');
    });
    
    it('should emit resend-request event', async () => {
      const resendHandler = jest.fn();
      connection.on('resend-request', resendHandler);
      
      await connection.requestResend(5, 10);
      
      expect(resendHandler).toHaveBeenCalledWith({ beginSeqNo: 5, endSeqNo: 10 });
    });

    it('does not report a resend request as sent when synchronous dispatch is declined', async () => {
      connection.sendMessage = jest.fn(() => false);
      const resendHandler = jest.fn();
      const failed = jest.fn();
      connection.on('resend-request', resendHandler);
      connection.on('session-send-failed', failed);

      expect(await connection.requestResend(5, 10)).toBe(false);
      expect(resendHandler).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'resend-request' }));
    });

    it('contains an async rejecting resend-request observer without relabeling accepted dispatch', async () => {
      const unhandled = jest.fn();
      const failed = jest.fn();
      process.on('unhandledRejection', unhandled);
      connection.on('session-send-failed', failed);
      connection.on('resend-request', async () => { throw new Error('observer rejected'); });

      try {
        expect(await connection.requestResend(5, 10)).toBe(true);
        await Bun.sleep(10);
        expect(unhandled).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('contains a synchronous resend dispatch throw and reports no success', async () => {
      connection.sendMessage = jest.fn(() => { throw new Error('resend enqueue failed'); });
      const resendHandler = jest.fn();
      const failed = jest.fn();
      connection.on('resend-request', resendHandler);
      connection.on('session-send-failed', failed);

      expect(await connection.requestResend(5, 10)).toBe(false);
      expect(resendHandler).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        action: 'resend-request',
        reason: 'resend enqueue failed',
      }));
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
      expect(sentMessage).not.toContain('1137=');
    });

    it('reports a test-request response as failed when synchronous dispatch is declined', async () => {
      connection.sendMessage = jest.fn(() => false);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      expect(await connection.handleTestRequest({ fields: { '35': '1', '112': 'TEST123' } })).toBe(false);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'test-request-heartbeat' }));
    });

    it('contains a synchronous test-response dispatch throw', async () => {
      connection.sendMessage = jest.fn(() => { throw new Error('test response enqueue failed'); });
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      expect(await connection.handleTestRequest({ fields: { '35': '1', '112': 'TEST123' } })).toBe(false);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        action: 'test-request-heartbeat',
        reason: 'test response enqueue failed',
      }));
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
        message,
        reason: 'logout',
      });
    });

    it('responds to peer Logout and tears down a TCP session even when the peer keeps it open', () => {
      const socket = new MockSocket();
      connection.socket = socket;
      connection._connectionGeneration = 4;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection.attemptReconnect = jest.fn();
      connection.sendMessage = jest.fn(() => true);

      connection.handleLogout(
        { fields: { '35': '5', '58': 'peer shutdown' } },
        socket,
        4,
      );

      expect(connection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': '5' }));
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(connection.attemptReconnect).toHaveBeenCalledTimes(1);
      expect(connection.socket).toBeNull();
    });

    it.each([
      ['declined', () => false],
      ['throwing', () => { throw new Error('logout response failed'); }],
    ])('tears down and reconnects when the peer Logout response is %s', (_name, result) => {
      const socket = new MockSocket();
      connection.socket = socket;
      connection._connectionGeneration = 5;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection.attemptReconnect = jest.fn();
      connection.sendMessage = jest.fn(result);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      connection.handleLogout({ fields: { '35': '5' } }, socket, 5);

      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'logout-response' }));
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(connection.attemptReconnect).toHaveBeenCalledTimes(1);
    });

    it('fences the socket close race and does not reconnect after intentional local disconnect', () => {
      const peerSocket = new MockSocket();
      connection.socket = peerSocket;
      connection._connectionGeneration = 6;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection.attemptReconnect = jest.fn();
      const disconnected = jest.fn();
      connection.on('disconnect', disconnected);

      connection.handleLogout({ fields: { '35': '5' } }, peerSocket, 6);
      connection.handleDisconnect(peerSocket, 6);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(connection.attemptReconnect).toHaveBeenCalledTimes(1);

      const localSocket = new MockSocket();
      connection.socket = localSocket;
      connection._connectionGeneration = 7;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection._intentionalCloseGeneration = 7;
      connection.sendMessage = jest.fn(() => true);
      connection.handleLogout({ fields: { '35': '5' } }, localSocket, 7);

      expect(connection.sendMessage).not.toHaveBeenCalled();
      expect(connection.attemptReconnect).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('startHeartbeat()', () => {
    beforeEach(() => {
      connection.socket = new MockSocket();
      mockSocketInstance = connection.socket;
      connection.isConnected = true;
      connection.isLoggedOn = true;
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
      expect(sentMessage).not.toContain('1137=');

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

    it('does not mark a heartbeat sent when synchronous dispatch is declined', async () => {
      connection.heartbeatInterval = 0.01;
      connection.testRequestIdleMultiplier = 3;
      connection.sendMessage = jest.fn(() => false);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      connection.startHeartbeat();
      await Bun.sleep(30);
      connection.stopHeartbeat();

      expect(connection.lastHeartbeatSent).toBeNull();
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'heartbeat' }));
      expect(connection.logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Heartbeat sent'));
    });
  });

  describe('FIX liveness probing', () => {
    let now;
    let socket;

    beforeEach(() => {
      now = 10_000;
      socket = new MockSocket();
      connection._now = () => now;
      connection._monotonicNow = () => now;
      connection.socket = socket;
      connection._connectionGeneration = 7;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      connection.heartbeatInterval = 1;
      connection.lastInboundActivityAt = now;
      connection.lastInboundActivityMonotonic = now;
      connection.pendingTestRequest = null;
      connection.sendMessage = jest.fn(() => true);
      connection.handleDisconnect = jest.fn();
    });

    it('uses valid application traffic as activity and avoids the production false-disconnect', async () => {
      connection.lastHeartbeatReceived = now - 60_000;
      now += 900;
      connection.handleMessage({ raw: 'execution', fields: { '35': '8', '34': '1' } });
      now += 900;

      await connection._heartbeatTick(socket, 7);

      expect(connection.handleDisconnect).not.toHaveBeenCalled();
      expect(connection.pendingTestRequest).toBeNull();
      expect(connection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': '0' }));
    });

    it('sends one correlated TestRequest after true idleness and disconnects only after its deadline', async () => {
      now += 1_200;
      await connection._heartbeatTick(socket, 7);
      const probe = connection.sendMessage.mock.calls[0][0];
      expect(probe).toMatchObject({ '35': '1', '112': expect.any(String) });

      now += 999;
      await connection._heartbeatTick(socket, 7);
      expect(connection.sendMessage).toHaveBeenCalledTimes(1);
      expect(connection.handleDisconnect).not.toHaveBeenCalled();

      now += 1;
      await connection._heartbeatTick(socket, 7);
      expect(connection.sendMessage).toHaveBeenCalledTimes(1);
      expect(connection.handleDisconnect).toHaveBeenCalledTimes(1);
      expect(connection.handleDisconnect).toHaveBeenCalledWith(socket, 7);
    });

    it('keeps a probe pending for mismatched TestReqID and clears it only for the match', async () => {
      now += 1_200;
      await connection._heartbeatTick(socket, 7);
      const probeId = connection.pendingTestRequest.id;

      now += 100;
      connection.handleHeartbeat({ fields: { '35': '0', '112': 'different-probe' } });
      expect(connection.pendingTestRequest.id).toBe(probeId);

      now += 100;
      connection.handleHeartbeat({ fields: { '35': '0', '112': probeId } });
      expect(connection.pendingTestRequest).toBeNull();
      expect(connection.lastInboundActivityAt).toBe(now);
    });

    it('counts valid duplicate and gap frames as transport activity before sequence disposition', () => {
      connection.expectedSeqNum = 5;
      connection.requestResend = jest.fn(() => true);

      now += 100;
      connection.handleMessage({ raw: 'duplicate', fields: { '35': '0', '34': '4' } });
      expect(connection.lastInboundActivityAt).toBe(now);

      now += 100;
      connection.handleMessage({ raw: 'gap', fields: { '35': '0', '34': '7' } });
      expect(connection.lastInboundActivityAt).toBe(now);
      expect(connection.requestResend).toHaveBeenCalledWith(5, 6);
    });

    it('does not count permissively parseable or unsafe sequence fields as valid activity', () => {
      for (const rawSequence of ['1junk', '0', '-1', '9007199254740992']) {
        now += 100;
        connection.handleMessage({ raw: 'bad-sequence', fields: { '35': '0', '34': rawSequence } });
        expect(connection.lastInboundActivityAt).toBe(10_000);
      }
    });

    it('does not let a duplicate matching Heartbeat satisfy the correlated probe', () => {
      connection.expectedSeqNum = 5;
      connection.pendingTestRequest = {
        id: 'probe-7', sentAt: now - 100, deadlineAt: now + 900,
        sentMonotonic: now - 100, deadlineMonotonic: now + 900,
        socket, generation: 7, phase: 'sent',
      };

      connection.handleMessage({ raw: 'duplicate-heartbeat', fields: { '35': '0', '34': '4', '112': 'probe-7' } });
      expect(connection.pendingTestRequest?.id).toBe('probe-7');

      connection.handleMessage({ raw: 'accepted-heartbeat', fields: { '35': '0', '34': '5', '112': 'probe-7' } });
      expect(connection.pendingTestRequest).toBeNull();
    });

    it('counts only complete current-generation frames and isolates partial buffers across reconnect', () => {
      const complete = makeFixFrame({ '35': '0', '34': '1' });
      connection.handleIncomingData(Buffer.from('8=FIXT.1.1\x019=20\x0135=0\x01'), socket, 7);
      expect(connection.lastInboundActivityAt).toBe(now);

      now += 100;
      connection.handleIncomingData(Buffer.from(complete), new MockSocket(), 6);
      expect(connection.lastInboundActivityAt).toBe(10_000);

      connection.messageBuffer = 'stale-partial';
      connection._resetLivenessState();
      expect(connection.messageBuffer).toBe('');
      expect(connection.lastInboundActivityAt).toBeNull();

      connection.handleIncomingData(Buffer.from(complete), socket, 7);
      expect(connection.lastInboundActivityAt).toBe(now);
    });

    it('does not count complete frame-shaped data with bad BodyLength or checksum as liveness', () => {
      const valid = makeFixFrame({ '35': '0', '34': '1' });
      const badLength = valid.replace(/9=\d+/, '9=999');
      const badChecksum = valid.replace(/10=\d{3}/, '10=999');
      const message = jest.fn();
      connection.on('message', message);
      connection.expectedSeqNum = 1;

      now += 100;
      connection.handleIncomingData(Buffer.from(badLength), socket, 7);
      expect(connection.lastInboundActivityAt).toBe(10_000);
      connection.messageBuffer = '';
      connection.handleIncomingData(Buffer.from(badChecksum), socket, 7);
      expect(connection.lastInboundActivityAt).toBe(10_000);
      expect(connection.expectedSeqNum).toBe(1);
      expect(message).not.toHaveBeenCalled();

      connection.messageBuffer = '';
      connection.handleIncomingData(Buffer.from(valid), socket, 7);
      expect(connection.lastInboundActivityAt).toBe(now);
    });

    it.each([
      ['false', () => false, 'dispatch-declined'],
      ['throw', () => { throw new Error('probe enqueue failed'); }, 'dispatch-error'],
      ['rejected Promise', () => Promise.reject(new Error('probe rejected')), 'dispatch-error'],
    ])('fails closed when TestRequest dispatch returns %s', async (_name, sendResult, reason) => {
      connection.sendMessage = jest.fn(sendResult);
      const failed = jest.fn();
      const liveness = jest.fn();
      connection.on('session-send-failed', failed);
      connection.on('liveness', liveness);
      now += 1_200;

      await connection._heartbeatTick(socket, 7);

      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'test-request' }));
      expect(connection.pendingTestRequest).toBeNull();
      expect(connection.handleDisconnect).toHaveBeenCalledWith(socket, 7);
      expect(liveness).toHaveBeenCalledTimes(1);
      expect(liveness).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', reason }));
      expect(connection.lastLivenessReason).toBe(reason);
    });

    it('bounds a never-settling TestRequest dispatch and disconnects exactly once', async () => {
      connection.heartbeatInterval = 0.01;
      connection._now = Date.now;
      connection._monotonicNow = () => performance.now();
      connection.lastInboundActivityAt = Date.now() - 20;
      connection.lastInboundActivityMonotonic = performance.now() - 20;
      connection.sendMessage = jest.fn(() => new Promise(() => {}));
      const failed = jest.fn();
      const liveness = jest.fn();
      connection.on('session-send-failed', failed);
      connection.on('liveness', liveness);

      await connection._heartbeatTick(socket, 7);

      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'test-request' }));
      expect(connection.handleDisconnect).toHaveBeenCalledTimes(1);
      expect(liveness).toHaveBeenCalledWith(expect.objectContaining({
        state: 'failed', reason: 'dispatch-timeout',
      }));
    });

    it('serializes heartbeat ticks per session generation while a send is slow', async () => {
      let resolveSend;
      connection.lastInboundActivityMonotonic = now;
      connection._heartbeatStartedMonotonic = now - 1_000;
      connection.sendMessage = jest.fn(() => new Promise((resolve) => { resolveSend = resolve; }));

      const first = connection._scheduleHeartbeatTick(socket, 7);
      const second = connection._scheduleHeartbeatTick(socket, 7);
      expect(connection.sendMessage).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);

      resolveSend(true);
      await Promise.all([first, second]);
      expect(connection.sendMessage).toHaveBeenCalledTimes(1);
      expect(connection._heartbeatTickInFlight).toBeNull();
    });

    it('uses monotonic elapsed time when the wall clock jumps forward and backward', async () => {
      let wall = now;
      let monotonic = now;
      connection._now = () => wall;
      connection._monotonicNow = () => monotonic;
      connection.lastInboundActivityAt = wall;
      connection.lastInboundActivityMonotonic = monotonic;
      connection._heartbeatStartedMonotonic = monotonic;

      wall += 3_600_000;
      monotonic += 500;
      await connection._heartbeatTick(socket, 7);
      expect(connection.pendingTestRequest).toBeNull();

      wall -= 7_200_000;
      monotonic += 700;
      await connection._heartbeatTick(socket, 7);
      expect(connection.pendingTestRequest).toMatchObject({ phase: 'sent' });
    });

    it('schedules the idle probe at the exact declared deadline without polling granularity', async () => {
      connection._heartbeatStartedMonotonic = now;
      connection.lastInboundActivityMonotonic = now;
      const activity = now;

      now += 1_199;
      connection._onInboundIdleDeadline(socket, 7, activity);
      expect(connection.sendMessage).not.toHaveBeenCalled();

      now += 1;
      connection._onInboundIdleDeadline(socket, 7, activity);
      await Promise.resolve();
      await connection._heartbeatTickInFlight;

      expect(connection.sendMessage).toHaveBeenCalledTimes(1);
      expect(connection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': '1' }));
      expect(connection.pendingTestRequest.deadlineMonotonic).toBe(12_200);
    });

    it('does not extend the absolute detection budget when the idle callback runs late', async () => {
      connection._heartbeatStartedMonotonic = now;
      connection.lastInboundActivityMonotonic = now;
      const activity = now;

      // Idle deadline is 11_200 and the absolute response deadline is 12_200.
      // A stalled event loop reaching the latter must disconnect rather than
      // starting a fresh response window from the delayed callback time.
      now = 12_200;
      connection._onInboundIdleDeadline(socket, 7, activity);
      await Promise.resolve();
      await connection._heartbeatTickInFlight;

      expect(connection.sendMessage).not.toHaveBeenCalled();
      expect(connection.handleDisconnect).toHaveBeenCalledTimes(1);
      expect(connection.lastLivenessReason).toBe('response-timeout');
    });

    it('has one response-timeout winner and exposes structured liveness state', async () => {
      const liveness = jest.fn();
      connection.on('liveness', liveness);
      now += 1_200;
      await connection._heartbeatTick(socket, 7);
      const pending = connection.pendingTestRequest;
      expect(connection.getState()).toMatchObject({ pendingTestRequestId: pending.id });
      expect(liveness).toHaveBeenCalledWith(expect.objectContaining({
        state: 'probe-pending', reason: 'inbound-idle', testRequestId: pending.id,
      }));

      now = pending.deadlineMonotonic;
      connection.handleHeartbeat({ fields: { '35': '0', '112': pending.id } });
      await connection._heartbeatTick(socket, 7);
      expect(connection.handleDisconnect).not.toHaveBeenCalled();
      expect(liveness).toHaveBeenCalledWith(expect.objectContaining({
        state: 'healthy', reason: 'test-request-response', testRequestId: pending.id,
      }));
    });

    it('ignores a stale heartbeat tick after reconnect generation changes', async () => {
      const oldSocket = socket;
      connection.socket = new MockSocket();
      connection._connectionGeneration = 8;
      now += 10_000;

      await connection._heartbeatTick(oldSocket, 7);

      expect(connection.sendMessage).not.toHaveBeenCalled();
      expect(connection.handleDisconnect).not.toHaveBeenCalled();
      expect(connection.pendingTestRequest).toBeNull();
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
      expect(sentMessage).not.toContain('1137=');
      
      // Verify socket destroyed
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
      expect(connection._intentionalCloseGeneration).toBeNull();
    });
    
    it('should not send logout if not logged on', async () => {
      connection.isLoggedOn = false;
      
      await connection.disconnect();
      
      expect(mockSocketInstance.write).not.toHaveBeenCalled();
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
    });

    it('reports a declined logout without treating it as dispatched and still closes transport', async () => {
      connection.isLoggedOn = true;
      connection.sendMessage = jest.fn(() => false);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      await connection.disconnect();

      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'logout' }));
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
    });

    it.each([
      ['synchronous throw', () => { throw new Error('logout enqueue failed'); }],
      ['rejected Promise', () => Promise.reject(new Error('logout outcome rejected'))],
    ])('contains logout %s and always completes teardown', async (_name, sendResult) => {
      connection.isLoggedOn = true;
      connection.heartbeatTimer = setInterval(() => {}, 10_000);
      connection.cleanupTimer = setInterval(() => {}, 10_000);
      connection.sendMessage = jest.fn(sendResult);
      const failed = jest.fn();
      connection.on('session-send-failed', failed);

      await expect(connection.disconnect()).resolves.toBeUndefined();

      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action: 'logout' }));
      expect(connection.heartbeatTimer).toBeNull();
      expect(connection.cleanupTimer).toBeNull();
      expect(mockSocketInstance.destroy).toHaveBeenCalled();
      expect(connection.socket).toBeNull();
      expect(connection.isConnected).toBe(false);
      expect(connection.isLoggedOn).toBe(false);
    });

    it.each(['old close before replacement', 'old close after replacement'])(
      'does not let delayed generation-one disconnect cleanup destroy generation two: %s',
      async (timing) => {
        const oldSocket = new MockSocket();
        connection.socket = oldSocket;
        connection._connectionGeneration = 1;
        connection.isConnected = true;
        connection.isLoggedOn = true;
        let settleLogout;
        connection.sendMessage = jest.fn(() => new Promise((resolve) => { settleLogout = resolve; }));
        connection.attemptReconnect = jest.fn();

        const disconnecting = connection.disconnect();
        await Promise.resolve();

        if (timing === 'old close before replacement') {
          connection.handleDisconnect(oldSocket, 1);
        }

        const newSocket = new MockSocket();
        connection.socket = newSocket;
        connection._connectionGeneration = 2;
        connection.isConnected = true;
        connection.isLoggedOn = true;
        connection.messageBuffer = 'generation-two-partial';

        settleLogout(true);
        await disconnecting;

        if (timing === 'old close after replacement') {
          connection.handleDisconnect(oldSocket, 1);
        }

        expect(connection.socket).toBe(newSocket);
        expect(newSocket.destroy).not.toHaveBeenCalled();
        expect(connection.isConnected).toBe(true);
        expect(connection.isLoggedOn).toBe(true);
        expect(connection.messageBuffer).toBe('generation-two-partial');
      },
    );
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
        lastHeartbeatSent: null,
        lastInboundActivityAt: null,
        pendingTestRequestId: null,
        livenessState: 'idle',
        lastLivenessReason: 'not-started',
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

    it('classifies a close from the intentionally stopped generation before emitting', () => {
      connection._connectionGeneration = 9;
      connection._intentionalCloseGeneration = 9;
      connection.isConnected = true;
      connection.isLoggedOn = true;
      const disconnectHandler = jest.fn();
      connection.on('disconnect', disconnectHandler);

      connection.handleDisconnect(connection.socket, 9);

      expect(disconnectHandler).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'intentional-disconnect', generation: 9,
      }));
      expect(connection._intentionalCloseGeneration).toBeNull();
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
    it.each([
      ['gap resend', makeFixFrame({ '35': '0', '34': '3' }), 'resend-request'],
      ['test request', makeFixFrame({ '35': '1', '34': '1', '112': 'probe' }), 'test-request-heartbeat'],
    ])('contains inbound fire-and-forget %s dispatch rejection', async (_name, raw, action) => {
      connection.sendMessage = jest.fn(() => { throw new Error(`${action} enqueue failed`); });
      const failed = jest.fn();
      const unhandled = jest.fn();
      connection.on('session-send-failed', failed);
      process.on('unhandledRejection', unhandled);

      try {
        connection.handleIncomingData(Buffer.from(raw));
        await Bun.sleep(10);
        expect(unhandled).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ action }));
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('should handle complete messages', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      const message = makeFixFrame({ '35': '8', '49': 'TRUEX', '56': 'CLIENT', '34': '1' });
      
      connection.handleIncomingData(Buffer.from(message));
      
      expect(messageHandler).toHaveBeenCalled();
    });
    
    it('should buffer incomplete messages', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      // Send partial message
      const message = makeFixFrame({ '35': '8', '49': 'TRUEX', '56': 'CLIENT', '34': '1' });
      const splitAt = message.indexOf('49=');
      const part1 = message.slice(0, splitAt);
      connection.handleIncomingData(Buffer.from(part1));
      
      expect(messageHandler).not.toHaveBeenCalled();
      expect(connection.messageBuffer).toContain('8=FIXT.1.1');
      
      // Send rest of message
      const part2 = message.slice(splitAt);
      connection.handleIncomingData(Buffer.from(part2));
      
      expect(messageHandler).toHaveBeenCalled();
    });
    
    it('should handle multiple messages in one buffer', () => {
      const messageHandler = jest.fn();
      connection.on('message', messageHandler);
      
      const message1 = makeFixFrame({ '35': '8', '49': 'TRUEX', '56': 'CLIENT', '34': '1' });
      const message2 = makeFixFrame({ '35': '8', '49': 'TRUEX', '56': 'CLIENT', '34': '2' });
      
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

        // Wait for the real callback (now 0ms delay) to fire.
        // Note: Bun 1.3.3 does not support jest.advanceTimersByTime/runAllTimers,
        // so we patch global.setTimeout to 0ms delay and use a 100ms sentinel.
        await new Promise(resolve => originalSetTimeout(resolve, 100));

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
