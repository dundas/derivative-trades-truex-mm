import { jest, mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';

// Mock global.fetch before importing the client
const originalFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch;

afterAll(() => {
  global.fetch = originalFetch;
});

// Import after mocking
const { KrakenRESTClient } = await import('./KrakenRESTClient.js');

describe('KrakenRESTClient', () => {
  let client;
  let mockLogger;
  const apiKey = 'testApiKey';
  const apiSecret = 'testApiSecret';
  const baseUrl = 'https://api.kraken.com';
  const base64ApiSecret = Buffer.from(apiSecret).toString('base64');

  const defaultOptions = { apiKey, apiSecret: base64ApiSecret, baseUrl };

  beforeEach(() => {
    // Create a mock logger
    mockLogger = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    // Reset fetch mock completely before each test to ensure isolation
    mockFetch.mockReset();

    // Default mock response for fetch for most tests
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ error: [], result: { message: "Default mock response" } }),
      status: 200,
      statusText: 'OK',
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
    }));

    client = new KrakenRESTClient({ ...defaultOptions, logger: mockLogger });
  });

  describe('Constructor', () => {
    it('should initialize with API key, secret, and base URL', () => {
      const testClient = new KrakenRESTClient({ apiKey: 'key', apiSecret: 'secret', baseUrl: 'url' });
      expect(testClient.apiKey).toBe('key');
      expect(testClient.apiSecret).toBe('secret');
      expect(testClient.baseUrl).toBe('url');
    });

    it('should use default baseUrl if not provided', () => {
      const testClient = new KrakenRESTClient({ apiKey, apiSecret: base64ApiSecret });
      expect(testClient.baseUrl).toBe('https://api.kraken.com');
    });

    it('should use provided logger', () => {
      const customLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const testClient = new KrakenRESTClient({ baseUrl, logger: customLogger });
      expect(testClient.logger).toBe(customLogger);
    });

    it('should use no-op logger if not provided', () => {
      const testClient = new KrakenRESTClient({ baseUrl });
      expect(typeof testClient.logger.debug).toBe('function');
      expect(typeof testClient.logger.info).toBe('function');
      expect(typeof testClient.logger.warn).toBe('function');
      expect(typeof testClient.logger.error).toBe('function');
    });

    it('should throw for missing apiKey/apiSecret when calling private methods', async () => {
      // Save and clear environment variables
      const originalApiKey = process.env.KRAKEN_API_KEY;
      const originalApiSecret = process.env.KRAKEN_API_SECRET;
      delete process.env.KRAKEN_API_KEY;
      delete process.env.KRAKEN_API_SECRET;

      try {
        expect(() => new KrakenRESTClient({ baseUrl })).not.toThrow();
        const clientWithoutCreds = new KrakenRESTClient({ baseUrl });
        // Attempting a private call should throw at the method level
        await expect(clientWithoutCreds.getAccountBalance()).rejects.toThrow('API key and secret are required for account balance');
      } finally {
        // Restore environment variables
        if (originalApiKey) process.env.KRAKEN_API_KEY = originalApiKey;
        if (originalApiSecret) process.env.KRAKEN_API_SECRET = originalApiSecret;
      }
    });
  });

  describe('request', () => {
    const path = '/0/public/Time';
    const privatePath = '/0/private/Balance';
    const params = { test: 'param' };

    it('should make a public GET request correctly (no API key/secret needed)', async () => {
      const publicLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const publicClient = new KrakenRESTClient({ baseUrl, logger: publicLogger });

      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ error: [], result: { unixtime: 123 } }),
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));

      const response = await publicClient.request(path, 'GET', params);

      expect(mockFetch).toHaveBeenCalled();
      const firstCall = mockFetch.mock.calls.find(call => call[0].includes(path));
      expect(firstCall[0]).toBe(`${baseUrl}${path}?test=param`);
      expect(firstCall[1]).toMatchObject({ method: 'GET' });
      expect(response).toEqual({ unixtime: 123 });
    });

    it('should make a public POST request correctly (no API key/secret needed)', async () => {
        const publicClient = new KrakenRESTClient({ baseUrl });
        const postData = { foo: 'bar' };
        mockFetch.mockImplementationOnce(() => Promise.resolve({
            ok: true,
            json: async () => ({ error: [], result: { success: true } }),
            status: 200,
            statusText: 'OK',
            headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
        }));
        const response = await publicClient.request(path, 'POST', postData);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toBe(`${baseUrl}${path}`);
        expect(fetchCall[1].method).toBe('POST');
        expect(fetchCall[1].headers).toEqual({
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'DecisiveTrades/1.0'
        });

        const requestBody = new URLSearchParams(fetchCall[1].body);
        // Public endpoints don't need nonce
        expect(requestBody.has('nonce')).toBe(false);
        expect(requestBody.get('foo')).toBe('bar');
        expect(response).toEqual({ success: true });
    });


    it('should make a private POST request correctly with signature headers', async () => {
      const postParams = { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '10000', volume: '1' };
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ error: [], result: { txid: ['TX123'] } }),
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      const response = await client.request(privatePath, 'POST', postParams);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe(`${baseUrl}${privatePath}`);
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers).toHaveProperty('API-Key', apiKey);
      expect(fetchCall[1].headers).toHaveProperty('API-Sign');
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
      const responseBody = { error: apiError, result: {} };
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => responseBody,
        status: 200,
        statusText: 'OK',
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      }));
      await expect(client.request(path, 'GET')).rejects.toThrow(apiError.join(', '));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Kraken API error for ${path}: ${apiError.join(', ')}`,
        responseBody
      );
    });

    it('should throw error if response body is not valid JSON', async () => {
      const nonJsonBody = 'Service Unavailable - HTML Page';
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => { throw new Error('Unexpected token S in JSON at position 0'); },
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html' : null },
      }));
      await expect(client.request(path, 'GET')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should return response body if no error and no result field', async () => {
        const weirdBody = { "unexpected": "data" };
        mockFetch.mockImplementationOnce(() => Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => weirdBody,
          headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
        }));
        const response = await client.request(path, 'GET');
        expect(response).toEqual(weirdBody);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          `Response for ${path} has no 'result' property, returning full response`
        );
    });

    it('should handle fetch itself throwing an error (e.g. network issue)', async () => {
      const networkError = new Error('Network Failure');
      mockFetch.mockImplementationOnce(() => Promise.reject(networkError));
      await expect(client.request(path, 'GET')).rejects.toThrow('Network Failure');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Request to ${path} failed:`,
        { error: 'Network Failure' }
      );
    });
  });

  // Method specific tests
  describe('getTicker', () => {
    it('should call request with correct parameters (formatted pair)', async () => {
      const pair = 'BTC/USD'; // Raw pair input
      const formattedPair = 'XXBTZUSD'; // Kraken formatted pair
      const mockResponse = { 'XXBTZUSD': { a: ['1'] } };
      const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

      const result = await client.getTicker(pair);

      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith('/0/public/Ticker', 'GET', { pair: formattedPair });
      // getTicker wraps the response
      expect(result).toEqual({ result: mockResponse, krakenPair: formattedPair });
      requestSpy.mockRestore();
    });
  });

  describe('getOrderBook', () => {
    it('should call request with correct parameters (formatted pair)', async () => {
        const pair = 'ETH/EUR'; // Raw pair input
        const formattedPair = 'XETHZEUR'; // Kraken formatted pair (from KRAKEN_SYMBOL_MAP)
        const count = 50;
        const pairData = { asks: [], bids: [] };
        const mockResponse = { 'XETHZEUR': pairData };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getOrderBook(pair, count);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/public/Depth', 'GET', { pair: formattedPair, count });
        // getOrderBook returns just the pair data
        expect(result).toEqual(pairData);
        requestSpy.mockRestore();
    });
  });

  describe('getRecentTrades', () => {
    it('should call request with correct parameters (formatted pair)', async () => {
        const pair = 'XBT/CAD'; // Raw pair input
        const formattedPair = 'XBTCAD'; // Kraken formatted pair (fallback: uppercase, no slash)
        const since = 1234567890; // Number for 'since'
        const mockResponse = { 'XBTCAD': [[]], last: 'timestamp' };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getRecentTrades(pair, since);

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/public/Trades', 'GET', { pair: formattedPair, since });
        // getRecentTrades wraps response if it doesn't have result field
        expect(result).toEqual({ result: mockResponse });
        requestSpy.mockRestore();
    });
  });

  describe('getAccountBalance', () => {
    it('should call request with correct parameters', async () => {
        const mockResponse = { ZUSD: '1000.00' };
        const requestSpy = jest.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

        const result = await client.getAccountBalance();

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('/0/private/Balance', 'POST');
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });

  describe('addOrder', () => {
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
        expect(requestSpy).toHaveBeenCalledWith('/0/private/GetWebSocketsToken', 'POST');
        expect(result).toEqual(mockResponse);
        requestSpy.mockRestore();
    });
  });
});
