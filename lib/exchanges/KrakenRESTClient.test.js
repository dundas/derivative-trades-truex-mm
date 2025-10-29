const { KrakenRESTClient } = require('./KrakenRESTClient'); // Assuming .ts is resolved by Jest
// const crypto = require('crypto'); // crypto-js is used internally by client, not this

let MockedLoggerConstructor;
let mockFetch;

// Mock logger.js
jest.mock('../utils/logger.js', () => {
  // console.log('JEST_MOCK_FACTORY_FOR_LOGGER_JS_IS_RUNNING');
  const mockDebugFn = jest.fn();
  const mockErrorFn = jest.fn();
  const mockWarnFn = jest.fn();
  const mockInfoFn = jest.fn();

  const mockInstance = {
    debug: mockDebugFn,
    error: mockErrorFn,
    warn: mockWarnFn,
    info: mockInfoFn,
  };

  const MockConstructor = jest.fn().mockImplementation(() => mockInstance);

  MockConstructor._mockDebug = mockDebugFn;
  MockConstructor._mockError = mockErrorFn;
  MockConstructor._mockWarn = mockWarnFn;
  MockConstructor._mockInfo = mockInfoFn;

  return {
    __esModule: true,
    Logger: MockConstructor,
    LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  };
});

// Mock node-fetch
// Assuming KrakenRESTClient uses: const fetch = require('node-fetch');
// or: import fetch from 'node-fetch';
// mockFetch = jest.fn(); // This was for named import mock
// jest.mock('node-fetch', () => ({
//     __esModule: true, // if KrakenRESTClient uses ES6 import
//     default: mockFetch, // if KrakenRESTClient uses `import fetch from 'node-fetch'`
//     // If KrakenRESTClient uses `const { fetch } = require('node-fetch')` or `import { fetch } from 'node-fetch'`,
//     // then this should be: fetch: mockFetch
// }));

// Mock global.fetch as the client seems to use it directly
mockFetch = jest.fn();
global.fetch = mockFetch;

// Re-require Logger after the mock is set up
MockedLoggerConstructor = require('../utils/logger.js').Logger;

describe('KrakenRESTClient', () => {
  let client;
  const apiKey = 'testApiKey';
  const apiSecret = 'testApiSecret'; // Real client uses Base64 encoded secret for crypto-js
  const baseUrl = 'https://api.kraken.com';
  // For crypto-js, the secret is expected to be Base64. Let's use a valid one for testing signature logic.
  // The actual value doesn't matter for testing if fetch is called with headers, 
  // but if we were to try and VERIFY the signature, we'd need this.
  const base64ApiSecret = Buffer.from(apiSecret).toString('base64');

  const defaultOptions = { apiKey, apiSecret: base64ApiSecret, baseUrl };

  beforeEach(() => {
    // Clear logger mocks
    if (MockedLoggerConstructor) {
      MockedLoggerConstructor.mockClear();
      if (MockedLoggerConstructor._mockDebug) MockedLoggerConstructor._mockDebug.mockClear();
      if (MockedLoggerConstructor._mockError) MockedLoggerConstructor._mockError.mockClear();
      if (MockedLoggerConstructor._mockWarn) MockedLoggerConstructor._mockWarn.mockClear();
      if (MockedLoggerConstructor._mockInfo) MockedLoggerConstructor._mockInfo.mockClear();
    }
    // Reset fetch mock completely before each test to ensure isolation
    mockFetch.mockReset();

    // Default mock response for fetch for most tests, IF a test doesn't set its own mockImplementationOnce
    // This can be a fallback or baseline if needed, but most tests should define specific mock responses.
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      text: async () => JSON.stringify({ error: [], result: { message: "Default mock response"} }), 
      status: 200,
      statusText: 'OK',
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
    }));

    client = new KrakenRESTClient(defaultOptions);
  });

  describe('Constructor', () => {
    it('should initialize with API key, secret, and base URL', () => {
      // Note: The client stores the secret as passed (base64ApiSecret in this test setup)
      const testClient = new KrakenRESTClient({ apiKey: 'key', apiSecret: 'secret', baseUrl: 'url' });
      expect(testClient.apiKey).toBe('key');
      expect(testClient.apiSecret).toBe('secret');
      expect(testClient.baseUrl).toBe('url');
    });

    it('should instantiate Logger with correct context', () => {
      // client is already instantiated in beforeEach
      expect(MockedLoggerConstructor).toHaveBeenCalledTimes(1);
      expect(MockedLoggerConstructor).toHaveBeenCalledWith('KrakenRESTClient');
    });

    it('should log initialization details at debug level', () => {
       // client is already instantiated in beforeEach
      expect(MockedLoggerConstructor._mockDebug).toHaveBeenCalledTimes(1); // Once for the client in beforeEach
      expect(MockedLoggerConstructor._mockDebug).toHaveBeenCalledWith(
        'Initializing Kraken REST client',
        expect.objectContaining({
          baseUrl,
          apiKeyLength: apiKey.length,
          apiSecretLength: base64ApiSecret.length,
        })
      );
    });

    it('should throw error if baseUrl is missing', () => {
      expect(() => new KrakenRESTClient({ apiKey, apiSecret: base64ApiSecret })).toThrow('baseUrl is required');
    });

    it('should NOT throw for missing apiKey/apiSecret on construction, but on private method call', async () => {
      expect(() => new KrakenRESTClient({ baseUrl })).not.toThrow();
      const clientWithoutCreds = new KrakenRESTClient({ baseUrl });
      // Attempting a private call should throw
      mockFetch.mockResolvedValueOnce({ // Ensure fetch is mocked to avoid actual network call
        ok: true,
        json: async () => ({ error: ['EAPI:Invalid key'], result: {} }),
        status: 200,
      });
      await expect(clientWithoutCreds.getAccountBalance()).rejects.toThrow('API key and secret are required for account balance');
    });
  });

  describe('request', () => {
    const path = '/0/public/Time';
    const privatePath = '/0/private/Balance';
    const params = { test: 'param' };

    it('should make a public GET request correctly (no API key/secret needed)', async () => {
      const publicClient = new KrakenRESTClient({ baseUrl }); 
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        text: async () => JSON.stringify({ error: [], result: { unixtime: 123 } }),
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      const response = await publicClient.request(path, 'GET', params);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}${path}?test=param`,
        expect.objectContaining({ method: 'GET' })
      );
      
      // Second call in the same test, needs its own mock implementation
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        text: async () => JSON.stringify({ error: [], result: { unixtime: 124 } }),
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      await publicClient.request(path, 'GET', {}); 
       expect(mockFetch).toHaveBeenCalledTimes(2); // Total calls in this test
       expect(mockFetch).toHaveBeenLastCalledWith(
        `${baseUrl}${path}`, 
        expect.objectContaining({ method: 'GET' })
      );
      expect(response).toEqual({ unixtime: 123 }); // From the first call
    });
    
    it('should make a public POST request correctly (no API key/secret needed)', async () => {
        const publicClient = new KrakenRESTClient({ baseUrl });
        const postData = { foo: 'bar' };
        mockFetch.mockImplementationOnce(() => Promise.resolve({
            ok: true,
            text: async () => JSON.stringify({ error: [], result: { success: true } }),
            status: 200,
            statusText: 'OK',
            headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
        }));
        const response = await publicClient.request(path, 'POST', postData);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toBe(`${baseUrl}${path}`);
        expect(fetchCall[1].method).toBe('POST');
        expect(fetchCall[1].headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
        
        const requestBody = new URLSearchParams(fetchCall[1].body);
        expect(requestBody.has('nonce')).toBe(true); // Nonce is added for POST
        expect(requestBody.get('foo')).toBe('bar');
        expect(response).toEqual({ success: true });
    });


    it('should make a private POST request correctly with signature headers', async () => {
      const postParams = { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '10000', volume: '1' };
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        text: async () => JSON.stringify({ error: [], result: { txid: ['TX123'] } }),
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      const response = await client.request(privatePath, 'POST', postParams);
      
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe(`${baseUrl}${privatePath}`); // URL should not contain params for POST
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers).toHaveProperty('API-Key', apiKey);
      expect(fetchCall[1].headers).toHaveProperty('API-Sign'); // Check signature is present
      expect(fetchCall[1].headers['API-Sign'].length).toBeGreaterThan(0);
      expect(fetchCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      
      const requestBody = new URLSearchParams(fetchCall[1].body);
      expect(requestBody.has('nonce')).toBe(true);
      for (const key in postParams) {
        expect(requestBody.get(key)).toBe(postParams[key]);
      }
      expect(response).toEqual({ txid: ['TX123'] });
    });
    
    it('should throw an error if API response JSON contains errors array', async () => {
      const apiError = ['EGeneral:Invalid arguments'];
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true, 
        text: async () => JSON.stringify({ error: apiError, result: {} }),
        status: 200, 
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      await expect(client.request(path, 'GET')).rejects.toThrow(apiError.join(', '));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(MockedLoggerConstructor._mockError).toHaveBeenCalledWith(
        'Kraken API error', // This is the generic message from client's catch block
        expect.objectContaining({ 
            error: apiError.join(', '), // This is the specific error string
            status: 200,
            endpoint: path 
        })
      );
    });

    it('should throw error if response body is not valid JSON', async () => {
      const nonJsonBody = 'Service Unavailable - HTML Page';
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: false, 
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => nonJsonBody,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html' : null }, 
      }));
      await expect(client.request(path, 'GET')).rejects.toThrow(`Failed to parse response: ${nonJsonBody}`);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(MockedLoggerConstructor._mockError).toHaveBeenCalledWith(
        'Request failed',
        expect.objectContaining({
            error: new Error(`Failed to parse response: ${nonJsonBody}`), // Client re-throws the error
            endpoint: path,
            method: 'GET'
        })
      );
    });
    
    it('should throw error if response JSON is valid but has no error and no result field', async () => {
        const weirdBody = { "unexpected": "data" };
        mockFetch.mockImplementationOnce(() => Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify(weirdBody),
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null }, 
        }));
        await expect(client.request(path, 'GET')).rejects.toThrow(`Unexpected response format: ${JSON.stringify(weirdBody)}`);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle fetch itself throwing an error (e.g. network issue)', async () => {
      const networkError = new Error('Network Failure');
      mockFetch.mockImplementationOnce(() => Promise.reject(networkError));
      await expect(client.request(path, 'GET')).rejects.toThrow('Network Failure');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(MockedLoggerConstructor._mockError).toHaveBeenCalledWith(
        'Request failed',
        expect.objectContaining({
            error: networkError, // Client re-throws the original error
            endpoint: path,
            method: 'GET'
        })
      );
    });
  });

  // Method specific tests
  // These will now test that client.request is called with raw, unformatted pairs.

  describe('getTicker', () => {
    it('should call request with correct parameters (raw pair)', async () => {
      const pair = 'BTC/USD'; // Raw pair
      const mockResponse = { 'XBTUSD': { a: ['1'] } }; // Kraken might respond with formatted pair
      const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);
      
      const result = await client.getTicker(pair);
      
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith('/0/public/Ticker', 'GET', { pair }); // pair should be 'BTC/USD'
      expect(result).toEqual(mockResponse);
      requestSpy.mockRestore();
    });
  });

  describe('getOrderBook', () => {
    it('should call request with correct parameters (raw pair)', async () => {
        const pair = 'ETH/EUR'; // Raw pair
        const count = 50;
        const mockResponse = { 'ETHEUR': { asks: [], bids: [] } };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getOrderBook(pair, count);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/public/Depth', 'GET', { pair, count }); // pair should be 'ETH/EUR'
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });
  
  describe('getRecentTrades', () => {
    it('should call request with correct parameters (raw pair)', async () => {
        const pair = 'XBT/CAD'; // Raw pair
        const since = 1234567890; // Number for 'since'
        const mockResponse = { 'XBTCAD': [[]], last: 'timestamp' };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getRecentTrades(pair, since);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/public/Trades', 'GET', { pair, since }); // pair should be 'XBT/CAD'
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });

  describe('getAccountBalance', () => {
    it('should call request with correct parameters', async () => {
        const mockResponse = { ZUSD: '1000.00' };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getAccountBalance();

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/private/Balance', 'POST'); // No data needed beyond nonce
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });
  
  describe('addOrder', () => {
    // Client's addOrder method:
    // addOrder(pair: string, type: 'buy' | 'sell', ordertype: 'market' | 'limit', volume: string, price?: string, options: { [key: string]: any } = {})
    it('should call request with correct parameters (raw pair)', async () => {
        const pair = 'BTC/USD'; // Raw pair
        const type = 'buy';
        const ordertype = 'limit';
        const volume = '0.5';
        const price = '30000';
        const userref = 789;
        const options = { userref };

        const expectedPayloadToRequest = {
            pair, type, ordertype, volume, price, ...options
        };
        const mockResponse = { descr: { order: 'descr' }, txid: ['ORDERID123'] };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.addOrder(pair, type, ordertype, volume, price, options);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/private/AddOrder', 'POST', expectedPayloadToRequest);
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });

  describe('cancelOrder', () => {
    it('should call request with correct parameters', async () => {
        const orderId = 'ORDERIDTOBEREMOVED';
        const mockResponse = { count: 1 };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.cancelOrder(orderId);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/private/CancelOrder', 'POST', { txid: orderId });
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });
  
  describe('getWebSocketToken', () => {
    it('should call request with correct parameters', async () => {
        const mockResponse = { token: 'ws-token-string', expires: 1800 };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);
        const result = await client.getWebSocketToken();

        expect(requestSpy).toHaveBeenCalledTimes(1);
        // The client's getWebSocketToken method calls request with no data argument.
        // The request method itself adds nonce for POSTs.
        expect(requestSpy).toHaveBeenCalledWith('/0/private/GetWebSocketsToken', 'POST');
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });
});