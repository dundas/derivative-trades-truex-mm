import { jest, mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TrueXWebSocketAdapter } from './TrueXWebSocketAdapter.js';
import crypto from 'crypto';

// Mock WebSocket globally
const mockWebSocketInstance = {
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    pong: jest.fn(),
    removeAllListeners: jest.fn(),
    readyState: 1 // WebSocket.OPEN
};

const MockWebSocket = jest.fn(() => mockWebSocketInstance);
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

// Mock the WebSocket module
mock.module('ws', () => ({ default: MockWebSocket }));

describe('TrueXWebSocketAdapter', () => {
    let adapter;
    let mockLogger;

    const defaultConfig = {
        symbol: 'BTC/USD',
        sessionId: 'test-session',
        apiKey: '123e4567-e89b-12d3-a456-426614174000',
        apiSecret: 'test-secret',
        organizationId: '987f6543-e21b-12d3-a456-426614174000',
        environment: 'uat',
        logger: null
    };

    beforeEach(() => {
        // Create mock logger
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };

        // Reset all mocks on the shared instance
        MockWebSocket.mockClear();
        mockWebSocketInstance.on.mockClear();
        mockWebSocketInstance.send.mockClear();
        mockWebSocketInstance.close.mockClear();
        mockWebSocketInstance.pong.mockClear();
        mockWebSocketInstance.removeAllListeners.mockClear();
        mockWebSocketInstance.readyState = 1; // WebSocket.OPEN

        // Create adapter with mocked logger
        adapter = new TrueXWebSocketAdapter({
            ...defaultConfig,
            logger: mockLogger
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
        if (adapter) {
            adapter.cleanup();
        }
    });

    describe('Constructor', () => {
        it('should initialize with correct configuration', () => {
            expect(adapter.symbol).toBe('BTC/USD');
            expect(adapter.sessionId).toBe('test-session');
            expect(adapter.apiKey).toBe('123e4567-e89b-12d3-a456-426614174000');
            expect(adapter.environment).toBe('uat');
            expect(adapter.wsUrl).toBe('wss://uat.truex.co/api/v1');
        });

        it('should use production URL when environment is production', () => {
            const prodAdapter = new TrueXWebSocketAdapter({
                ...defaultConfig,
                environment: 'production',
                logger: mockLogger
            });

            expect(prodAdapter.wsUrl).toBe('wss://prod.truex.co/api/v1');
            prodAdapter.cleanup();
        });

        it('should create WebSocket connection on construction', () => {
            // Constructor calls connect() which calls new WebSocket()
            expect(MockWebSocket).toHaveBeenCalled();
            expect(adapter.ws).toBe(mockWebSocketInstance);
        });
    });

    describe('Authentication', () => {
        it('should generate correct HMAC signature', () => {
            const timestamp = '1234567890';
            const path = '/api/v1';

            const expectedPayload = `${timestamp}TRUEXWS${adapter.apiKey}${path}`;
            const expectedSignature = crypto
                .createHmac('sha256', adapter.apiSecret)
                .update(expectedPayload)
                .digest('base64');

            const signature = adapter._generateSignature(timestamp, path);

            expect(signature).toBe(expectedSignature);
        });

        it('should send authenticated subscription with correct format', async () => {
            const channels = ['EBBO', 'TRADE'];
            const instruments = ['BTC/USD'];

            // Mock timestamp
            const mockTimestamp = 1234567890;
            jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp * 1000);

            // Clear send mock to only capture our call
            mockWebSocketInstance.send.mockClear();

            await adapter._sendAuthenticatedSubscription(channels, instruments);

            expect(mockWebSocketInstance.send).toHaveBeenCalled();

            const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
            expect(sentMessage).toMatchObject({
                type: 'SUBSCRIBE',
                channels: channels,
                item_names: instruments,
                timestamp: mockTimestamp.toString(),
                organization_id: adapter.organizationId,
                key: adapter.apiKey,
                signature: expect.any(String)
            });
        });

        it('should send unauthenticated subscription without credentials', async () => {
            const channels = ['EBBO'];
            const instruments = ['ETH/USD'];

            // Clear send mock
            mockWebSocketInstance.send.mockClear();

            await adapter._sendUnauthenticatedSubscription(channels, instruments);

            const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
            expect(sentMessage).toMatchObject({
                type: 'SUBSCRIBE_NO_AUTH',
                channels: channels,
                item_names: instruments,
                timestamp: expect.any(String)
            });

            expect(sentMessage).not.toHaveProperty('organization_id');
            expect(sentMessage).not.toHaveProperty('key');
            expect(sentMessage).not.toHaveProperty('signature');
        });
    });

    describe('Connection Management', () => {
        it('should handle connection open event', () => {
            const openHandler = mockWebSocketInstance.on.mock.calls.find(call => call[0] === 'open')[1];

            adapter.on('connect', jest.fn());
            openHandler();

            expect(adapter.isConnected).toBe(true);
            expect(adapter.reconnectAttempts).toBe(0);
        });

        it('should handle connection close and update state', () => {
            const closeHandler = mockWebSocketInstance.on.mock.calls.find(call => call[0] === 'close')[1];

            closeHandler(1006, 'Abnormal closure');

            expect(adapter.isConnected).toBe(false);
            expect(adapter.isAuthenticated).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'WebSocket connection closed',
                { code: 1006, reason: 'Abnormal closure' }
            );
        });

        it('should limit reconnection attempts', () => {
            adapter.maxReconnectAttempts = 2;
            adapter.reconnectAttempts = 2;

            adapter._scheduleReconnect();

            expect(mockLogger.error).toHaveBeenCalledWith('Max reconnection attempts reached');
        });
    });

    describe('Message Handling', () => {
        let messageHandler;

        beforeEach(() => {
            messageHandler = mockWebSocketInstance.on.mock.calls.find(call => call[0] === 'message')[1];
        });

        it('should handle welcome message', () => {
            const welcomeMessage = JSON.stringify({
                channel: 'WEBSOCKET',
                update: 'WELCOME',
                version: '1.0.0',
                connections: '1',
                message: 'Connected to TrueX WebSocket',
                datetime: '2024-01-01T00:00:00Z'
            });

            messageHandler(welcomeMessage);

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Received welcome message',
                expect.objectContaining({
                    version: '1.0.0',
                    connections: '1'
                })
            );
        });

        it('should handle confirmation message with authentication status', () => {
            const confirmationMessage = JSON.stringify({
                channel: 'WEBSOCKET',
                update: 'UPDATE',
                status: 'AUTHENTICATED',
                subscriptions: [
                    { channel: 'EBBO', item_names: ['BTC/USD'] }
                ]
            });

            adapter.on('authenticated', jest.fn());
            messageHandler(confirmationMessage);

            expect(adapter.isAuthenticated).toBe(true);
        });

        it('should handle instrument message', () => {
            const instrumentMessage = JSON.stringify({
                channel: 'INSTRUMENT',
                update: 'UPDATE',
                data: {
                    id: 'btc-usd',
                    status: 'ACTIVE',
                    info: {
                        symbol: 'BTC/USD',
                        base_asset_id: 'BTC',
                        quote_asset_id: 'USD',
                        reference_price: '50000',
                        price_limit_window_secs: '300',
                        price_limit_percent: '10',
                        price_bands_percent: '5'
                    },
                    stats: {
                        last_24hr_notional: '1000000',
                        last_24hr_quantity: '20'
                    }
                }
            });

            const instrumentListener = jest.fn();
            adapter.on('instrument', instrumentListener);

            messageHandler(instrumentMessage);

            expect(instrumentListener).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'btc-usd',
                    symbol: 'BTC/USD',
                    status: 'ACTIVE'
                })
            );
            expect(adapter.marketData.instruments.has('btc-usd')).toBe(true);
        });

        it('should handle trade message', () => {
            const tradeMessage = JSON.stringify({
                channel: 'TRADE',
                update: 'UPDATE',
                data: {
                    match_id: 'trade123',
                    trade_price: '50000',
                    trade_qty: '0.5',
                    liq_flag: 'TAKER'
                }
            });

            const tradeListener = jest.fn();
            adapter.on('trade', tradeListener);

            messageHandler(tradeMessage);

            expect(tradeListener).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'BTC/USD',
                    price: 50000,
                    quantity: 0.5,
                    side: 'TAKER'
                })
            );
        });

        it('should handle EBBO message', () => {
            const ebboMessage = JSON.stringify({
                channel: 'EBBO',
                update: 'UPDATE',
                data: {
                    id: 'ebbo123',
                    status: 'ENABLED',
                    info: {
                        best_bid: { price: '49900', qty: '1.5' },
                        best_ask: { price: '50100', qty: '2.0' },
                        last_trade: { price: '50000', qty: '0.5' },
                        last_update: '1234567890000000'
                    }
                }
            });

            const orderbookListener = jest.fn();
            const tickerListener = jest.fn();
            adapter.on('orderbook', orderbookListener);
            adapter.on('ticker', tickerListener);

            messageHandler(ebboMessage);

            expect(orderbookListener).toHaveBeenCalledWith(
                expect.objectContaining({
                    bids: [[49900, 1.5]],
                    asks: [[50100, 2.0]],
                    symbol: 'BTC/USD'
                })
            );

            expect(tickerListener).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'BTC/USD',
                    bid: 49900,
                    bidSize: 1.5,
                    ask: 50100,
                    askSize: 2.0,
                    last: 50000
                })
            );
        });
    });

    describe('Subscriptions', () => {
        it('should subscribe to channels and instruments', async () => {
            adapter.isConnected = true;
            adapter.apiKey = null; // Force unauthenticated

            // Clear send mock
            mockWebSocketInstance.send.mockClear();

            await adapter.subscribe(['INSTRUMENT'], ['ETH/USD']);

            expect(mockWebSocketInstance.send).toHaveBeenCalled();
            expect(adapter.subscriptions.channels.has('INSTRUMENT')).toBe(true);
            expect(adapter.subscriptions.instruments.has('ETH/USD')).toBe(true);
        });

        it('should unsubscribe from channels and instruments', async () => {
            adapter.isConnected = true;
            adapter.subscriptions.channels.add('TRADE');
            adapter.subscriptions.instruments.add('BTC/USD');

            // Clear send mock
            mockWebSocketInstance.send.mockClear();

            await adapter.unsubscribe(['TRADE'], ['BTC/USD']);

            const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
            expect(sentMessage.type).toBe('UNSUBSCRIBE');
            expect(adapter.subscriptions.channels.has('TRADE')).toBe(false);
            expect(adapter.subscriptions.instruments.has('BTC/USD')).toBe(false);
        });

        it('should throw error when subscribing without connection', async () => {
            adapter.isConnected = false;

            await expect(adapter.subscribe(['EBBO'], ['BTC/USD']))
                .rejects.toThrow('WebSocket not connected');
        });
    });

    describe('Market Data', () => {
        beforeEach(() => {
            // Set up some market data
            adapter.marketData.orderBook.set('BTC/USD', {
                bids: [[49900, 1.5]],
                asks: [[50100, 2.0]],
                timestamp: Date.now(),
                symbol: 'BTC/USD'
            });

            adapter.marketData.trades.set('BTC/USD', [
                { price: 50000, quantity: 0.5, timestamp: Date.now() }
            ]);
        });

        it('should fetch order book', async () => {
            const orderBook = await adapter.fetchOrderBook('BTC/USD');

            expect(orderBook).toMatchObject({
                bids: [[49900, 1.5]],
                asks: [[50100, 2.0]],
                symbol: 'BTC/USD'
            });
        });

        it('should throw error for missing order book', async () => {
            await expect(adapter.fetchOrderBook('ETH/USD'))
                .rejects.toThrow('No order book data for ETH/USD');
        });

        it('should fetch ticker data', async () => {
            const ticker = await adapter.fetchTicker('BTC/USD');

            expect(ticker).toMatchObject({
                symbol: 'BTC/USD',
                bid: 49900,
                bidVolume: 1.5,
                ask: 50100,
                askVolume: 2.0,
                last: 50000
            });
        });
    });

    describe('Error Handling', () => {
        it('should handle malformed messages', () => {
            const messageHandler = mockWebSocketInstance.on.mock.calls.find(call => call[0] === 'message')[1];

            messageHandler('invalid json');

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Failed to parse message',
                expect.objectContaining({
                    error: expect.any(String),
                    data: 'invalid json'
                })
            );
        });

        it('should handle WebSocket errors', () => {
            const errorHandler = mockWebSocketInstance.on.mock.calls.find(call => call[0] === 'error')[1];
            const error = new Error('Connection failed');

            const errorListener = jest.fn();
            adapter.on('error', errorListener);

            errorHandler(error);

            expect(mockLogger.error).toHaveBeenCalledWith(
                'WebSocket error',
                { error: 'Connection failed' }
            );
            expect(errorListener).toHaveBeenCalledWith(error);
        });

        it('should throw error for order operations in live mode', async () => {
            await expect(adapter.createOrder({ symbol: 'BTC/USD' }))
                .rejects.toThrow('Order placement not supported via WebSocket');

            await expect(adapter.cancelOrder('order123'))
                .rejects.toThrow('Order cancellation not supported via WebSocket');
        });
    });

    describe('Cleanup', () => {
        it('should clean up resources properly', async () => {
            adapter.subscriptions.channels.add('EBBO');
            adapter.marketData.orderBook.set('BTC/USD', {});
            adapter.activeOrders.set('order1', {});

            // Clear mocks before cleanup to isolate cleanup calls
            mockWebSocketInstance.removeAllListeners.mockClear();
            mockWebSocketInstance.close.mockClear();

            await adapter.cleanup();

            expect(mockWebSocketInstance.removeAllListeners).toHaveBeenCalled();
            expect(mockWebSocketInstance.close).toHaveBeenCalledWith(1000, 'Client disconnect');
            expect(adapter.marketData.orderBook.size).toBe(0);
            expect(adapter.activeOrders.size).toBe(0);
        });
    });
});
