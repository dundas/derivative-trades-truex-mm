/**
 * TrueX FIX Authentication Flow Integration Tests
 * 
 * Tests the complete authentication flow including:
 * - Connection establishment
 * - Logon message exchange
 * - Session management
 * - Authentication failure scenarios
 */

const net = require('net');
const { EventEmitter } = require('events');
const {
  buildTrueXLogonMessage,
  buildMarketDataRequest,
  SOH
} = require('../src/proxy/fix-message-builder.cjs');

// Mock TrueX server for testing
class MockTrueXServer extends EventEmitter {
  constructor(port = 19484) {
    super();
    this.port = port;
    this.server = null;
    this.clients = new Set();
    this.messageLog = [];
    this.shouldRejectAuth = false;
    this.responseDelay = 0;
  }
  
  start() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this.clients.add(socket);
        
        socket.on('data', (data) => {
          this.handleClientMessage(socket, data);
        });
        
        socket.on('close', () => {
          this.clients.delete(socket);
        });
        
        socket.on('error', (error) => {
          console.log('Mock server socket error:', error.message);
        });
      });
      
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }
  
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.clients.forEach(client => client.destroy());
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
  
  handleClientMessage(socket, data) {
    const message = data.toString();
    this.messageLog.push({ direction: 'received', message, timestamp: Date.now() });
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([A-Z0-9])/);
    if (!msgTypeMatch) return;
    
    const msgType = msgTypeMatch[1];
    
    setTimeout(() => {
      switch (msgType) {
        case 'A': // Logon
          this.handleLogonRequest(socket, message);
          break;
        case 'V': // Market Data Request
          this.handleMarketDataRequest(socket, message);
          break;
        case '0': // Heartbeat
          this.handleHeartbeat(socket, message);
          break;
        default:
          console.log(`Mock server: Unknown message type ${msgType}`);
      }
    }, this.responseDelay);
  }
  
  handleLogonRequest(socket, message) {
    if (this.shouldRejectAuth) {
      // Send reject message
      const rejectMessage = this.buildRejectMessage('Invalid credentials');
      socket.write(rejectMessage);
      this.messageLog.push({ direction: 'sent', message: rejectMessage, timestamp: Date.now() });
    } else {
      // Send successful logon response
      const logonResponse = this.buildLogonResponse();
      socket.write(logonResponse);
      this.messageLog.push({ direction: 'sent', message: logonResponse, timestamp: Date.now() });
    }
  }
  
  handleMarketDataRequest(socket, message) {
    // Send market data snapshot
    const mdSnapshot = this.buildMarketDataSnapshot();
    socket.write(mdSnapshot);
    this.messageLog.push({ direction: 'sent', message: mdSnapshot, timestamp: Date.now() });
  }
  
  handleHeartbeat(socket, message) {
    // Echo heartbeat
    socket.write(message);
    this.messageLog.push({ direction: 'sent', message, timestamp: Date.now() });
  }
  
  buildLogonResponse() {
    const fields = {
      8: 'FIXT.1.1',
      9: '0',
      35: 'A', // Logon
      49: 'TRUEX_UAT_OE',
      56: 'CLI_CLIENT',
      34: '1',
      52: this.getCurrentTimestamp(),
      98: '0', // EncryptMethod (None)
      108: '30', // HeartBtInt
      1137: 'FIX.5.0SP2'
    };
    
    return this.buildFIXMessage(fields);
  }
  
  buildRejectMessage(reason) {
    const fields = {
      8: 'FIXT.1.1',
      9: '0',
      35: '3', // Reject
      49: 'TRUEX_UAT_OE',
      56: 'CLI_CLIENT',
      34: '1',
      52: this.getCurrentTimestamp(),
      45: '1', // RefSeqNum
      371: '1', // RefTagID
      372: 'A', // RefMsgType
      373: '5', // SessionRejectReason (Other)
      58: reason // Text
    };
    
    return this.buildFIXMessage(fields);
  }
  
  buildMarketDataSnapshot() {
    const fields = {
      8: 'FIXT.1.1',
      9: '0',
      35: 'W', // Market Data Snapshot
      49: 'TRUEX_UAT_OE',
      56: 'CLI_CLIENT',
      34: '2',
      52: this.getCurrentTimestamp(),
      262: 'MDR001', // MDReqID
      55: 'BTC-PYUSD', // Symbol
      268: '2', // NoMDEntries
      269: '0', // MDEntryType (Bid)
      270: '50000.00', // MDEntryPx
      271: '1.0', // MDEntrySize
      269: '1', // MDEntryType (Offer)
      270: '50001.00', // MDEntryPx
      271: '1.0' // MDEntrySize
    };
    
    return this.buildFIXMessage(fields);
  }
  
  buildFIXMessage(fields) {
    let body = '';
    const fieldOrder = Object.keys(fields).sort((a, b) => {
      const order = ['8', '9', '35', '49', '56', '34', '52'];
      const aIndex = order.indexOf(a);
      const bIndex = order.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return parseInt(a) - parseInt(b);
    });
    
    for (const tag of fieldOrder) {
      if (tag !== '8' && tag !== '9' && tag !== '10') {
        body += `${tag}=${fields[tag]}${SOH}`;
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
  
  getCurrentTimestamp() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
    return `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;
  }
  
  getMessageLog() {
    return [...this.messageLog];
  }
  
  clearMessageLog() {
    this.messageLog = [];
  }
}

// Test client for authentication flow
class TestFIXClient extends EventEmitter {
  constructor(host = '127.0.0.1', port = 19484) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.messageLog = [];
    this.seqNum = 1;
  }
  
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      this.socket.connect(this.port, this.host, () => {
        this.connected = true;
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.handleMessage(data);
      });
      
      this.socket.on('error', reject);
      this.socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
      });
    });
  }
  
  disconnect() {
    if (this.socket) {
      this.socket.destroy();
    }
  }
  
  handleMessage(data) {
    const message = data.toString();
    this.messageLog.push({ direction: 'received', message, timestamp: Date.now() });
    
    // Parse message type
    const msgTypeMatch = message.match(/35=([A-Z0-9])/);
    if (!msgTypeMatch) return;
    
    const msgType = msgTypeMatch[1];
    
    switch (msgType) {
      case 'A': // Logon response
        this.authenticated = true;
        this.emit('authenticated');
        break;
      case '3': // Reject
        this.emit('rejected', message);
        break;
      case 'W': // Market Data Snapshot
        this.emit('marketData', message);
        break;
    }
  }
  
  sendLogon(apiKey, apiSecret) {
    const logonMessage = buildTrueXLogonMessage(apiKey, apiSecret);
    this.socket.write(logonMessage.message);
    this.messageLog.push({ direction: 'sent', message: logonMessage.message, timestamp: Date.now() });
    this.seqNum++;
  }
  
  sendMarketDataRequest(apiKey, apiSecret, symbol = 'BTC-PYUSD') {
    const mdRequest = buildMarketDataRequest(apiKey, apiSecret, 'MDR001', symbol, this.seqNum.toString());
    this.socket.write(mdRequest.message);
    this.messageLog.push({ direction: 'sent', message: mdRequest.message, timestamp: Date.now() });
    this.seqNum++;
  }
  
  getMessageLog() {
    return [...this.messageLog];
  }
}

describe('TrueX FIX Authentication Flow', () => {
  let mockServer;
  let testClient;
  const testPort = 19485; // Use different port to avoid conflicts
  
  beforeAll(async () => {
    mockServer = new MockTrueXServer(testPort);
    await mockServer.start();
  });
  
  afterAll(async () => {
    if (mockServer) {
      await mockServer.stop();
    }
  });
  
  beforeEach(() => {
    testClient = new TestFIXClient('127.0.0.1', testPort);
    mockServer.clearMessageLog();
    mockServer.shouldRejectAuth = false;
    mockServer.responseDelay = 0;
  });
  
  afterEach(() => {
    if (testClient) {
      testClient.disconnect();
    }
  });
  
  describe('Successful Authentication Flow', () => {
    test('should establish connection and authenticate successfully', async () => {
      await testClient.connect();
      expect(testClient.connected).toBe(true);
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      
      await authPromise;
      expect(testClient.authenticated).toBe(true);
    });
    
    test('should exchange proper FIX messages during authentication', async () => {
      await testClient.connect();
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      await authPromise;
      
      const clientMessages = testClient.getMessageLog();
      const sentClientMessages = clientMessages.filter(m => m.direction === 'sent');
      const serverMessages = mockServer.getMessageLog();
      
      // Client should have sent only one logon message
      expect(sentClientMessages.length).toBe(1);
      expect(sentClientMessages[0].message).toContain('35=A'); // Logon message
      
      // Server should have received logon and sent response
      expect(serverMessages.length).toBe(2);
      expect(serverMessages[0].message).toContain('35=A'); // Received logon
      expect(serverMessages[1].message).toContain('35=A'); // Sent logon response
    });
    
    test('should handle market data request after authentication', async () => {
      await testClient.connect();
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      await authPromise;
      
      const mdPromise = new Promise((resolve) => {
        testClient.on('marketData', resolve);
      });
      
      testClient.sendMarketDataRequest('test_api_key', 'test_secret_key');
      await mdPromise;
      
      const serverMessages = mockServer.getMessageLog();
      const mdMessages = serverMessages.filter(msg => msg.message.includes('35=W'));
      expect(mdMessages.length).toBe(1);
    });
  });
  
  describe('Authentication Failure Scenarios', () => {
    test('should handle authentication rejection', async () => {
      mockServer.shouldRejectAuth = true;
      
      await testClient.connect();
      expect(testClient.connected).toBe(true);
      
      const rejectPromise = new Promise((resolve) => {
        testClient.on('rejected', resolve);
      });
      
      testClient.sendLogon('invalid_key', 'invalid_secret');
      
      const rejectMessage = await rejectPromise;
      expect(rejectMessage).toContain('35=3'); // Reject message
      expect(testClient.authenticated).toBe(false);
    });
    
    test('should handle connection timeout', async () => {
      mockServer.responseDelay = 100; // Add delay to simulate timeout
      
      await testClient.connect();
      
      const timeoutPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve('timeout');
        }, 50); // Shorter than server delay
        
        testClient.on('authenticated', () => {
          clearTimeout(timeout);
          reject(new Error('Should not authenticate'));
        });
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      
      const result = await timeoutPromise;
      expect(result).toBe('timeout');
    });
    
    test('should handle network disconnection during auth', async () => {
      await testClient.connect();
      
      const disconnectPromise = new Promise((resolve) => {
        testClient.socket.on('close', resolve);
      });
      
      // Disconnect immediately after sending logon
      testClient.sendLogon('test_api_key', 'test_secret_key');
      testClient.socket.destroy();
      
      await disconnectPromise;
      expect(testClient.connected).toBe(false);
      expect(testClient.authenticated).toBe(false);
    });
  });
  
  describe('Message Format Validation', () => {
    test('should send properly formatted logon message', async () => {
      await testClient.connect();
      testClient.sendLogon('test_api_key', 'test_secret_key');
      
      const clientMessages = testClient.getMessageLog();
      const logonMessage = clientMessages[0].message;
      
      // Should start with proper header
      expect(logonMessage).toMatch(/^8=FIXT\.1\.1\x01/);
      
      // Should contain required fields
      expect(logonMessage).toContain('35=A'); // MsgType
      expect(logonMessage).toContain('49=CLI_CLIENT'); // SenderCompID
      expect(logonMessage).toContain('56=TRUEX_UAT_OE'); // TargetCompID
      expect(logonMessage).toContain('553=test_api_key'); // Username
      expect(logonMessage).toContain('554='); // Password (signature)
      
      // Should end with checksum
      expect(logonMessage).toMatch(/10=\d{3}\x01$/);
    });
    
    test('should handle malformed server responses gracefully', async () => {
      // Override server to send malformed response
      const originalHandler = mockServer.handleLogonRequest;
      mockServer.handleLogonRequest = (socket) => {
        socket.write('INVALID_FIX_MESSAGE');
      };
      
      await testClient.connect();
      testClient.sendLogon('test_api_key', 'test_secret_key');
      
      // Should not crash, just not authenticate
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(testClient.authenticated).toBe(false);
      
      // Restore original handler
      mockServer.handleLogonRequest = originalHandler;
    });
  });
  
  describe('Performance and Reliability', () => {
    test('should authenticate within reasonable time', async () => {
      const start = Date.now();
      
      await testClient.connect();
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      await authPromise;
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should authenticate in under 1 second
    });
    
    test('should handle multiple rapid authentication attempts', async () => {
      const promises = [];
      
      for (let i = 0; i < 5; i++) {
        const client = new TestFIXClient('127.0.0.1', testPort);
        const promise = (async () => {
          await client.connect();
          
          const authPromise = new Promise((resolve) => {
            client.on('authenticated', resolve);
          });
          
          client.sendLogon('test_api_key', 'test_secret_key');
          await authPromise;
          
          client.disconnect();
          return true;
        })();
        
        promises.push(promise);
      }
      
      const results = await Promise.all(promises);
      expect(results.every(result => result === true)).toBe(true);
    });
  });
  
  describe('Session Management', () => {
    test('should maintain session state after authentication', async () => {
      await testClient.connect();
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      await authPromise;
      
      expect(testClient.connected).toBe(true);
      expect(testClient.authenticated).toBe(true);
      
      // Should maintain state for subsequent operations
      testClient.sendMarketDataRequest('test_api_key', 'test_secret_key');
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(testClient.connected).toBe(true);
      expect(testClient.authenticated).toBe(true);
    });
    
    test('should reset session state on disconnection', async () => {
      await testClient.connect();
      
      const authPromise = new Promise((resolve) => {
        testClient.on('authenticated', resolve);
      });
      
      testClient.sendLogon('test_api_key', 'test_secret_key');
      await authPromise;
      
      expect(testClient.authenticated).toBe(true);
      
      // Disconnect
      testClient.disconnect();
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(testClient.connected).toBe(false);
      expect(testClient.authenticated).toBe(false);
    });
  });
});

