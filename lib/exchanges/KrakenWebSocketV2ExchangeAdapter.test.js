import { KrakenWebSocketV2ExchangeAdapter } from './KrakenWebSocketV2ExchangeAdapter';
import { AdaptiveMarketMakerExchangeAdapter } from './AdaptiveMarketMakerExchangeAdapter'; // Assuming this is the base
import WebSocket from 'ws';

// Mock WebSocket
jest.mock('ws');

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
    WebSocket.mockClear();

    defaultConfig = {
      symbol: 'BTC/USD',
      sessionId: 'test-session-id',
      logger: mockLogger,
      redisOrderManager: mockRedisOrderManager,
      redisFillManager: mockRedisFillManager,
      token: 'test-token',
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
      expect(adapter.token).toBe('test-token');
      expect(adapter.apiUrl).toBe('wss://ws-auth.kraken.com/v2'); // Default
      expect(adapter.requestTimeoutMs).toBe(10000); // Default
      expect(adapter.connectionState).toBe('disconnected');
      expect(adapter.maxReconnectAttempts).toBe(5); // Default
      expect(adapter.initialReconnectDelayMs).toBe(1000); // Default
      expect(adapter.maxReconnectDelayMs).toBe(30000); // Default
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

    it('should warn if token is not provided initially', () => {
        const configWithoutToken = { ...defaultConfig, token: null };
        new KrakenWebSocketV2ExchangeAdapter(configWithoutToken);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial WebSocket API token not provided'));
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

  // More test suites for connect, disconnect, _sendRequest, etc. will go here

  describe('Connection and Disconnection', () => {
    let adapter;
    let mockWsInstance;

    beforeEach(() => {
      adapter = new KrakenWebSocketV2ExchangeAdapter(defaultConfig);
      // Reset and reconfigure the WebSocket mock for each test in this suite
      mockWsInstance = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: jest.fn(),
        send: jest.fn(),
        readyState: WebSocket.CONNECTING, // Initial state when instance is created
      };
      WebSocket.mockImplementation(() => mockWsInstance);
      
      // Mock methods for _subscribeToChannel to prevent errors during _onOpen
      adapter._subscribeToChannel = jest.fn().mockResolvedValue({ status: 'subscribed' });
    });

    describe('connect()', () => {
      it('should successfully connect and call _onOpen', async () => {
        const connectPromise = adapter.connect();
        expect(adapter.connectionState).toBe('connecting');
        expect(WebSocket).toHaveBeenCalledWith(adapter.apiUrl);

        mockWsInstance.readyState = WebSocket.OPEN;
        if (mockWsInstance.onopen) {
          mockWsInstance.onopen();
        }
        
        await expect(connectPromise).resolves.toBeUndefined();
        expect(adapter.connectionState).toBe('connected');
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('WebSocket connected'));
        expect(adapter.reconnectAttempts).toBe(0);
        expect(adapter.currentReconnectDelayMs).toBe(adapter.initialReconnectDelayMs);
        expect(adapter._subscribeToChannel).toHaveBeenCalledWith('executions', expect.any(Object));
      });

      it('should handle connection error and reject the promise', async () => {
        const mockErrorListener = jest.fn();
        adapter.on('error', mockErrorListener);

        const connectPromise = adapter.connect();
        expect(adapter.connectionState).toBe('connecting');

        const error = new Error('Connection failed');
        
        // Ensure the test waits for the promise to settle.
        // Simulating error and close should trigger the rejection.
        const testRejection = expect(connectPromise).rejects.toMatchObject({ message: 'Connection failed' });

        // Simulate the WebSocket error and close events
        // Ensure these are called after the promise has been initiated and we start expecting its rejection
        if (mockWsInstance.onerror) {
            mockWsInstance.onerror(error);
        }
        // Ensure readyState is CLOSED before onclose, as ws library might do.
        mockWsInstance.readyState = WebSocket.CLOSED; 
        if (mockWsInstance.onclose) {
            // Provide a close event object, as the ws library typically does
            mockWsInstance.onclose({ code: 1006, reason: 'Abnormal Closure', wasClean: false });
        }

        await testRejection; // Wait for the promise to actually reject

        expect(mockErrorListener).toHaveBeenCalledWith(error);
        // After error and close, _onError might set it to disconnected directly, 
        // or _onClose (if called after _onError) would also confirm/set to disconnected.
        expect(adapter.connectionState).toBe('disconnected'); 
        expect(mockLogger.error).toHaveBeenCalledWith('WebSocket error:', 'Connection failed');
        
        adapter.off('error', mockErrorListener);
      });

      it('should return existing promise if already connecting or connected', async () => {
        // Test when connecting
        adapter.connectionState = 'connecting';
        // Manually set a mock promise for _connectPromise to simulate it being in the process of connecting
        const mockConnectingPromise = new Promise(() => {}); // A non-resolving promise for this state
        adapter._connectPromise = mockConnectingPromise;
        
        const secondConnectPromise = adapter.connect();
        expect(secondConnectPromise).toBe(mockConnectingPromise); // Should return the existing promise
        expect(WebSocket).not.toHaveBeenCalled(); // Should not create a new WebSocket

        // Reset for the next part of the test
        WebSocket.mockClear();
        adapter._connectPromise = null; // Clear it before setting to 'connected'

        // Test when connected
        adapter.connectionState = 'connected';
        // Simulate that a previous connection was successful and its promise was stored
        const mockConnectedPromise = Promise.resolve();
        adapter._connectPromise = mockConnectedPromise;

        const thirdConnectPromise = adapter.connect();
        expect(thirdConnectPromise).toBe(mockConnectedPromise); // Should return the resolved promise
        expect(WebSocket).not.toHaveBeenCalled(); // Should not create a new WebSocket
      });
      
      it('should clear reconnect timer if active when connect is called', () => {
        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
        const mockTimerId = 12345; 
        adapter.reconnectTimer = mockTimerId; 
        
        adapter.connect(); 
        
        expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimerId);
        expect(adapter.reconnectTimer).toBeNull();
        clearTimeoutSpy.mockRestore();
      });
    });

    describe('disconnect()', () => {
      it('should close the WebSocket if open and set state correctly', () => {
        adapter.connect();
        if (mockWsInstance.onopen) mockWsInstance.onopen(); 
        expect(adapter.connectionState).toBe('connected');
        mockWsInstance.readyState = WebSocket.OPEN;

        // Check _isManualDisconnect immediately after calling disconnect, before _onClose resets it.
        adapter.disconnect(); 
        expect(adapter._isManualDisconnect).toBe(true); // Set by disconnect()
        expect(mockWsInstance.close).toHaveBeenCalled();
        // At this point, the state should be 'disconnecting' as _onClose hasn't fired yet.
        expect(adapter.connectionState).toBe('disconnecting');
                
        // Now simulate the close event
        if (mockWsInstance.onclose) {
            mockWsInstance.onclose({ code: 1000, reason: 'Normal closure', wasClean: true });
        }
        // After _onClose, state should be 'disconnected' and _isManualDisconnect reset.
        expect(adapter.connectionState).toBe('disconnected');
        expect(adapter._isManualDisconnect).toBe(false); // Reset by _onClose
      });

      it('should handle disconnect if WebSocket is already closed', () => {
        mockWsInstance.readyState = WebSocket.CLOSED;
        adapter.ws = mockWsInstance; 
        adapter.connectionState = 'disconnected'; // Start in a consistent disconnected state
        const scheduleReconnectSpy = jest.spyOn(adapter, '_scheduleReconnect');

        adapter.disconnect(); 
        
        expect(mockWsInstance.close).not.toHaveBeenCalled();
        // disconnect() sets _isManualDisconnect=true. 
        // It then calls _onClose(), which should see _isManualDisconnect as true,
        // prevent reconnection, set state to disconnected, and reset _isManualDisconnect to false.
        expect(adapter.connectionState).toBe('disconnected'); 
        expect(mockLogger.info).toHaveBeenCalledWith('WebSocket already closed or closing.');
        expect(adapter._isManualDisconnect).toBe(false); 
        expect(scheduleReconnectSpy).not.toHaveBeenCalled(); // Ensure no reconnection is scheduled

        scheduleReconnectSpy.mockRestore();
      });
      
      it('should handle disconnect if no active WebSocket instance', () => {
        adapter.ws = null;
        adapter.disconnect();
        expect(adapter.connectionState).toBe('disconnected');
        expect(mockLogger.info).toHaveBeenCalledWith('No active WebSocket instance to disconnect.');
      });

      it('should clear reconnect timer if active during disconnect', () => {
        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
        const mockTimerId = 56789;
        adapter.reconnectTimer = mockTimerId; 
        
        adapter.connect(); 
        if (mockWsInstance.onopen) mockWsInstance.onopen();

        adapter.disconnect();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimerId);
        expect(adapter.reconnectTimer).toBeNull();
        clearTimeoutSpy.mockRestore();
      });
    });

    describe('_onOpen()', () => {
        it('should set connectionState to connected and reset reconnect attempts', () => {
            adapter.connectionState = 'connecting';
            adapter.reconnectAttempts = 3;
            adapter.currentReconnectDelayMs = 4000;
            
            adapter._onOpen(); 

            expect(adapter.connectionState).toBe('connected');
            expect(adapter.reconnectAttempts).toBe(0);
            expect(adapter.currentReconnectDelayMs).toBe(adapter.initialReconnectDelayMs);
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('WebSocket connected'));
            expect(adapter._subscribeToChannel).toHaveBeenCalled(); 
        });

        it('should emit "connected" event', () => {
            const emitSpy = jest.spyOn(adapter, 'emit');
            adapter._onOpen();
            expect(emitSpy).toHaveBeenCalledWith('connected');
            emitSpy.mockRestore();
        });
    });

    describe('_onError()', () => {
        it('should log the error and emit "error" event', () => {
            const emitSpy = jest.spyOn(adapter, 'emit');
            const mockErrorListener = jest.fn(); 
            adapter.on('error', mockErrorListener);
            const testError = new Error('Test WS Error');
            
            adapter._onError(testError);

            expect(mockLogger.error).toHaveBeenCalledWith('WebSocket error:', 'Test WS Error');
            expect(emitSpy).toHaveBeenCalledWith('error', testError);
            expect(mockErrorListener).toHaveBeenCalledWith(testError);
            emitSpy.mockRestore();
            adapter.off('error', mockErrorListener);
        });

        it('should set connectionState to disconnected if in certain states', () => {
            const mockErrorListener = jest.fn(); // Avoid unhandled error emissions
            adapter.on('error', mockErrorListener);

            adapter.connectionState = 'connecting';
            adapter._onError(new Error('Test Error'));
            expect(adapter.connectionState).toBe('disconnected');

            adapter.connectionState = 'disconnected'; // Already disconnected, should stay
            adapter._onError(new Error('Test Error 2'));
            expect(adapter.connectionState).toBe('disconnected');
            adapter.off('error', mockErrorListener);
        });

        it('should NOT change connectionState if connected or reconnecting', () => {
            const mockErrorListener = jest.fn();
            adapter.on('error', mockErrorListener);
            adapter.connectionState = 'connected';
            adapter._onError(new Error('Test Error'));
            expect(adapter.connectionState).toBe('connected');

            adapter.connectionState = 'reconnecting';
            adapter._onError(new Error('Test Error 2'));
            expect(adapter.connectionState).toBe('reconnecting');
            adapter.off('error', mockErrorListener);
        });
    });
    
    describe('_onClose() and Reconnection', () => {
        let setTimeoutSpy;
        let connectSpy; 

        beforeEach(() => {
            jest.useFakeTimers(); 
            setTimeoutSpy = jest.spyOn(global, 'setTimeout');
            connectSpy = jest.spyOn(adapter, 'connect'); 

            // Manually wire up the adapter's instance methods to the mockWsInstance event handlers
            // This ensures that when the test calls mockWsInstance.onclose(), it's adapter._onClose() that executes.
            if (mockWsInstance) { // mockWsInstance is defined in the parent describe's beforeEach
                mockWsInstance.onclose = (event) => adapter._onClose(event);
                mockWsInstance.onerror = (event) => adapter._onError(event); // For completeness if needed by close sequences
                mockWsInstance.onopen = () => adapter._onOpen(); // For completeness
            }
            // Ensure adapter.ws is set to the mock instance for these tests if connect() isn't explicitly called
            // However, most _onClose tests set adapter.ws directly if needed.
            // The critical part is that adapter._onClose is correctly bound if the test simulates ws.onclose()
        });

        afterEach(() => {
            setTimeoutSpy.mockRestore();
            connectSpy.mockRestore(); // Restore the spy on adapter.connect
            jest.clearAllTimers(); 
            jest.useRealTimers(); 
        });

        it('should schedule reconnect if disconnect was not manual and prev state was connected', () => {
            adapter.connectionState = 'connected'; // This will be the previousConnectionState for _onClose
            adapter._isManualDisconnect = false;
            adapter.ws = mockWsInstance; // Ensure ws is set so _onClose is triggered by event
            const scheduleReconnectSpy = jest.spyOn(adapter, '_scheduleReconnect');

            // Simulate the ws library triggering the onclose handler
            // The _onClose method in the adapter will capture the current connectionState as previousConnectionState
            if (adapter.ws && typeof adapter.ws.onclose === 'function') {
                adapter.ws.onclose({ code: 1006, reason: 'Network error', wasClean: false });
            }

            expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
            scheduleReconnectSpy.mockRestore();
        });

        it('should NOT schedule reconnect if disconnect was manual', () => {
            adapter.connectionState = 'connected'; // Or any state from which _onClose might be called
            adapter.ws = mockWsInstance;
            adapter._isManualDisconnect = true; // Key: This is a manual disconnect
            const scheduleReconnectSpy = jest.spyOn(adapter, '_scheduleReconnect');
            
            // Simulate the ws library triggering the onclose handler
            if (adapter.ws && typeof adapter.ws.onclose === 'function') {
                adapter.ws.onclose({ code: 1000, reason: 'Manual disconnect', wasClean: true });
            }

            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
            expect(adapter.connectionState).toBe('disconnected'); // _onClose sets this
            expect(adapter._isManualDisconnect).toBe(false); // _onClose resets this
            scheduleReconnectSpy.mockRestore();
        });

        it('should NOT schedule reconnect if previous state was disconnecting', () => {
            adapter.connectionState = 'disconnecting'; // This will be previousConnectionState in _onClose
            adapter.ws = mockWsInstance;
            // _isManualDisconnect might be true if disconnect() led to 'disconnecting' state, 
            // or false if an error occurred during active disconnection. 
            // For this test, let's assume it's part of a normal disconnect flow.
            adapter._isManualDisconnect = true; 
            const scheduleReconnectSpy = jest.spyOn(adapter, '_scheduleReconnect');
            
            if (adapter.ws && typeof adapter.ws.onclose === 'function') {
                adapter.ws.onclose({ code: 1000, reason: 'Normal closure during disconnect', wasClean: true });
            }

            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
            expect(adapter.connectionState).toBe('disconnected');
            expect(adapter._isManualDisconnect).toBe(false); // _onClose should reset it
            scheduleReconnectSpy.mockRestore();
        });

        it('should emit "disconnected" event with correct payload', () => {
            adapter.connectionState = 'connected'; // Simulate it was connected
            adapter.ws = mockWsInstance;
            const emitSpy = jest.spyOn(adapter, 'emit');
            const closeEvent = { code: 1001, reason: 'Going Away', wasClean: false }; 

            // Simulate conditions for _onClose to be called, e.g., as part of a manual disconnect or unexpected close.
            // Let's ensure it's a scenario where the event *should* be emitted.
            // If it's a manual disconnect, _isManualDisconnect would be true initially.
            adapter._isManualDisconnect = true; 
            
            // The previous state for the event payload is captured at the start of _onClose
            // So, adapter.connectionState being 'connected' here is correct for wasConnected: true
            if (adapter.ws && typeof adapter.ws.onclose === 'function') { 
                adapter.ws.onclose(closeEvent); 
            }

            // The emit in _onClose should have { ...closeEventFromWS, wasConnected: true }
            // The 'wasClean' property might not be in the original closeEvent if it came from the 'ws' library like that
            // but the adapter should pass through code and reason. wasConnected is added by the adapter.
            expect(emitSpy).toHaveBeenCalledWith('disconnected', { 
                code: closeEvent.code, 
                reason: closeEvent.reason, 
                wasClean: closeEvent.wasClean, // Ensure to check what the actual _onClose passes
                wasConnected: true 
            });
            emitSpy.mockRestore();
            adapter._isManualDisconnect = false; // Reset for hygiene, though _onClose should do it.
        });

        describe('_scheduleReconnect()', () => {
            beforeEach(() => {
                // Ensure connect spy is reset for each _scheduleReconnect test
                connectSpy.mockClear();
                 // Default mock for connect during these tests to simulate success to simplify backoff tests
                connectSpy.mockImplementation(async () => {
                    mockWsInstance.readyState = WebSocket.OPEN;
                    if (adapter.ws && adapter.ws.onopen) { // adapter.ws might be null if connect wasn't called yet
                        adapter.ws.onopen();
                    } else if (mockWsInstance.onopen) { // Fallback for initial call
                        mockWsInstance.onopen();
                    }
                });
            });

            it('should increment attempts, set state, log, and call connect after delay', () => {
                adapter.reconnectAttempts = 0;
                adapter.currentReconnectDelayMs = adapter.initialReconnectDelayMs;

                adapter._scheduleReconnect();

                expect(adapter.reconnectAttempts).toBe(1);
                expect(adapter.connectionState).toBe('reconnecting');
                expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining(`Attempting to reconnect in ${adapter.initialReconnectDelayMs / 1000}s`));
                expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
                expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), adapter.initialReconnectDelayMs);

                jest.runOnlyPendingTimers();
                expect(connectSpy).toHaveBeenCalledTimes(1);
            });

            it('should use exponential backoff, capped at maxReconnectDelayMs', () => {
                adapter.reconnectAttempts = 0;
                adapter.initialReconnectDelayMs = 100;
                adapter.currentReconnectDelayMs = 100; 
                adapter.maxReconnectDelayMs = 500;
                adapter.maxReconnectAttempts = 5; 

                // Attempt 1
                adapter._scheduleReconnect(); 
                expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 100);
                expect(adapter.currentReconnectDelayMs).toBe(200); 

                // Mock how connect() should behave for the *first* reconnection attempt (it should fail)
                connectSpy.mockImplementationOnce(async () => { 
                    adapter.ws = mockWsInstance; 
                    // Force the state that _onClose expects for a non-manual reconnect from 'reconnecting' state
                    adapter.connectionState = 'reconnecting';
                    adapter._isManualDisconnect = false;
                    
                    if(mockWsInstance.onerror) mockWsInstance.onerror(new Error('Simulated failed connect for attempt 2'));
                    if(mockWsInstance.onclose) mockWsInstance.onclose({code: 1006, reason: 'Simulated failed connect for attempt 2'}); 
                    throw new Error('Simulated failed connect for backoff test attempt 2'); 
                });

                jest.runOnlyPendingTimers(); // Run the timer for the first _scheduleReconnect
                // This should have triggered adapter.connect() (mocked above),
                // which should have failed, calling _onClose, which should call _scheduleReconnect again.

                expect(setTimeoutSpy).toHaveBeenCalledTimes(2); 
                expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 200); 
                expect(adapter.currentReconnectDelayMs).toBe(400); 
                // adapter.reconnectAttempts should be 2 at this point
                expect(adapter.reconnectAttempts).toBe(2);
                connectSpy.mockClear();

                // Attempt 3 - Simulating the second reconnection attempt failing
                // Mock connect() for the failure of the second reconnection attempt
                connectSpy.mockImplementationOnce(async () => { 
                    adapter.ws = mockWsInstance;
                    // Force the state again for the next iteration if needed, though less critical if the first works
                    adapter.connectionState = 'reconnecting';
                    adapter._isManualDisconnect = false;  
                    if(mockWsInstance.onerror) mockWsInstance.onerror(new Error('Simulated failed connect for attempt 3'));
                    if(mockWsInstance.onclose) mockWsInstance.onclose({code: 1006, reason: 'Simulated failed connect for attempt 3'}); 
                    throw new Error('Simulated failed connect for backoff test attempt 3'); 
                });

                // jest.runOnlyPendingTimers(); // Run the timer for the second _scheduleReconnect

                // _scheduleReconnect has been called a third time by _onClose.
                expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
                expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 400);
                expect(adapter.currentReconnectDelayMs).toBe(500); // Capped at max (500ms in test setup)
                expect(adapter.reconnectAttempts).toBe(3);
            });

            it('should stop reconnecting after maxReconnectAttempts', () => {
                adapter.maxReconnectAttempts = 2;
                adapter.reconnectAttempts = 0; // Start from 0
                adapter.currentReconnectDelayMs = adapter.initialReconnectDelayMs;

                // Call 1: Attempt 1
                adapter._scheduleReconnect(); 
                expect(adapter.reconnectAttempts).toBe(1);
                expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
                // Current delay would have been used, then doubled for next potential attempt

                // Call 2: Attempt 2
                adapter._scheduleReconnect(); 
                expect(adapter.reconnectAttempts).toBe(2);
                expect(setTimeoutSpy).toHaveBeenCalledTimes(2);

                // Call 3: Attempt 3 - This should exceed maxReconnectAttempts (2)
                // Inside _scheduleReconnect: attempts becomes 3. 3 > 2 is true.
                // Resets attempts to 0 and returns.
                adapter._scheduleReconnect();
                expect(adapter.reconnectAttempts).toBe(0); // Should be reset
                expect(adapter.currentReconnectDelayMs).toBe(adapter.initialReconnectDelayMs); // Delay reset
                expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining(`Max reconnection attempts (${adapter.maxReconnectAttempts}) reached`));
                // setTimeoutSpy should NOT have been called a 3rd time for a *scheduled connection*,
                // as _scheduleReconnect should have returned early. So, still 2 successful schedules.
                expect(setTimeoutSpy).toHaveBeenCalledTimes(2); 
            });

            it('should clear the timer ID (this.reconnectTimer) once the callback executes', () => {
                adapter._scheduleReconnect();
                expect(adapter.reconnectTimer).not.toBeNull(); 

                jest.runOnlyPendingTimers();
                expect(connectSpy).toHaveBeenCalled();
                expect(adapter.reconnectTimer).toBeNull(); 
            });
        });
    });
  });
});

// Helper to ensure critical dependencies are mocked if not already
if (typeof WebSocket.OPEN === 'undefined') {
    WebSocket.CONNECTING = 0;
    WebSocket.OPEN = 1;
    WebSocket.CLOSING = 2;
    WebSocket.CLOSED = 3;
} 