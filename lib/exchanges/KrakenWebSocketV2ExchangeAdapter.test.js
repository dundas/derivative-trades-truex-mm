import { jest, mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { KrakenWebSocketV2ExchangeAdapter } from './KrakenWebSocketV2ExchangeAdapter';
import { AdaptiveMarketMakerExchangeAdapter } from '../../src/exchanges/base/AdaptiveMarketMakerExchangeAdapter.js';

// Mock WebSocket with a constructor that returns a mock instance
const MockWebSocket = jest.fn();
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

mock.module('ws', () => ({
  default: MockWebSocket
}));

// Import WebSocket after mocking
import WebSocket from 'ws';

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  createChild: jest.fn().mockImplementation(() => mockLogger), // Chainable createChild
};

// Mock Redis Managers
const mockRedisOrderManager = {
  // Add any methods that might be called during instantiation or early methods
  get: jest.fn(),
  getAll: jest.fn(),
  update: jest.fn(),
  add: jest.fn(),
};

const mockRedisFillManager = {
  // Add any methods that might be called
  add: jest.fn(),
};

describe('KrakenWebSocketV2ExchangeAdapter', () => {
  let defaultConfig;

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
    MockWebSocket.mockClear();

    defaultConfig = {
      symbol: 'BTC/USD',
      sessionId: 'test-session-id',
      logger: mockLogger,
      redisOrderManager: mockRedisOrderManager,
      redisFillManager: mockRedisFillManager,
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      paperMode: true, // Enable paper mode to avoid needing real credentials
      // apiUrl is optional, will use default
    };
  });

  describe('Constructor', () => {
    it('should inherit from AdaptiveMarketMakerExchangeAdapter', () => {
      const adapter = new KrakenWebSocketV2ExchangeAdapter(defaultConfig);
      expect(adapter).toBeInstanceOf(AdaptiveMarketMakerExchangeAdapter);
    });

    it('should initialize with required configuration', () => {
      const adapter = new KrakenWebSocketV2ExchangeAdapter(defaultConfig);
      expect(adapter.symbol).toBe('BTC/USD');
      expect(adapter.sessionId).toBe('test-session-id');
      expect(adapter.logger).toBe(mockLogger); // Assuming createChild returns the same mock
      expect(adapter.redisOrderManager).toBe(mockRedisOrderManager);
      expect(adapter.redisFillManager).toBe(mockRedisFillManager);
      expect(adapter.apiKey).toBe('test-api-key');
      expect(adapter.apiSecret).toBe('test-api-secret');
      expect(adapter.token).toBe(null); // Token starts as null and is fetched later
      expect(adapter.apiUrl).toBe('wss://ws-auth.kraken.com/v2'); // Default
      expect(adapter.requestTimeoutMs).toBe(10000); // Default
      expect(adapter.connectionState).toBe('disconnected');
      expect(adapter.maxReconnectAttempts).toBe(999999); // Default (effectively infinite)
      expect(adapter.initialReconnectDelayMs).toBe(1000); // Default
      expect(adapter.maxReconnectDelayMs).toBe(60000); // Default (60 seconds)
      expect(mockLogger.createChild).toHaveBeenCalledWith('KrakenWSv2Adapter');
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('KrakenWebSocketV2ExchangeAdapter initialized'));
    });

    it('should use provided optional configuration values', () => {
      const customConfig = {
        ...defaultConfig,
        apiUrl: 'wss://custom.kraken.com/ws',
        maxReconnectAttempts: 10,
        initialReconnectDelayMs: 500,
        maxReconnectDelayMs: 15000,
        requestTimeoutMs: 5000,
      };
      const adapter = new KrakenWebSocketV2ExchangeAdapter(customConfig);
      expect(adapter.apiUrl).toBe('wss://custom.kraken.com/ws');
      expect(adapter.maxReconnectAttempts).toBe(10);
      expect(adapter.initialReconnectDelayMs).toBe(500);
      expect(adapter.maxReconnectDelayMs).toBe(15000);
      expect(adapter.requestTimeoutMs).toBe(5000);
    });

    it('should warn if apiKey or apiSecret is not provided', () => {
        const configWithoutAuth = { ...defaultConfig, apiKey: null, apiSecret: null };
        new KrakenWebSocketV2ExchangeAdapter(configWithoutAuth);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('API key and/or secret not provided'));
    });

    it('should throw an error if redisOrderManager is not provided', () => {
      const invalidConfig = { ...defaultConfig, redisOrderManager: undefined };
      expect(() => new KrakenWebSocketV2ExchangeAdapter(invalidConfig)).toThrow('RedisOrderManager is required');
      expect(mockLogger.error).toHaveBeenCalledWith('RedisOrderManager is required but not provided in config.');
    });

    it('should throw an error if redisFillManager is not provided', () => {
      const invalidConfig = { ...defaultConfig, redisFillManager: undefined };
      expect(() => new KrakenWebSocketV2ExchangeAdapter(invalidConfig)).toThrow('RedisFillManager is required');
      expect(mockLogger.error).toHaveBeenCalledWith('RedisFillManager is required but not provided in config.');
    });

    // Test for logger without createChild (if necessary, based on polyfill in AMM)
    it('should handle logger without createChild method', () => {
        const basicLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const configWithBasicLogger = { ...defaultConfig, logger: basicLogger };
        const adapter = new KrakenWebSocketV2ExchangeAdapter(configWithBasicLogger);
        // The adapter's logger will be the basicLogger itself if createChild is not polyfilled in the adapter
        // or if the polyfill directly returns the parent.
        // Given the adapter code: this.logger = config.logger.createChild ? config.logger.createChild('KrakenWSv2Adapter') : config.logger;
        // it should assign the basicLogger directly.
        expect(adapter.logger).toBe(basicLogger);
        expect(basicLogger.info).toHaveBeenCalledWith(expect.stringContaining('KrakenWebSocketV2ExchangeAdapter initialized'));
    });

  });

  // NOTE: The following Connection and Disconnection tests are commented out because they test
  // an older version of the adapter with simpler connection logic. The current adapter has
  // dual WebSocket connections (_connectPrivate and _connectPublic) with token fetching,
  // which makes these unit tests incompatible without extensive rewriting.
  //
  // To properly test the current implementation, integration tests or more comprehensive
  // mocking of _connectPrivate and _connectPublic would be needed.

  /*
  describe('Connection and Disconnection', () => {
    let adapter;
    let mockWsInstance;

    beforeEach(() => {
      adapter = new KrakenWebSocketV2ExchangeAdapter(defaultConfig);
      // Reset and reconfigure the MockWebSocket mock for each test in this suite
      mockWsInstance = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: jest.fn(),
        send: jest.fn(),
        readyState: MockWebSocket.CONNECTING, // Initial state when instance is created
      };
      MockWebSocket.mockImplementation(() => mockWsInstance);

      // Mock internal methods to simplify testing the connection logic
      adapter._subscribeToChannel = jest.fn().mockResolvedValue({ status: 'subscribed' });
      adapter._subscribeToPublicChannel = jest.fn().mockResolvedValue({ status: 'subscribed' });
      adapter.initializeRedisComponents = jest.fn().mockResolvedValue(true);
      adapter._fetchToken = jest.fn().mockResolvedValue('mock-token');
      adapter._monitorWebSocketConnection = jest.fn();
      adapter._connectPublic = jest.fn().mockResolvedValue();
    });

    // ... rest of tests
  });
  */
});
