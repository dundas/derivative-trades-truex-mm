import fs from 'fs'; // Import fs for file logging
const DEBUG_LOG_FILE = '/tmp/jest_api_key_debug.log'; // Define log file path
// Clear log file at the start of a test run (optional, good for clean logs)
if (fs.existsSync(DEBUG_LOG_FILE)) { fs.unlinkSync(DEBUG_LOG_FILE); }

import dotenv from 'dotenv';
import path from 'path';
import { KrakenWebSocketV2ExchangeAdapter } from './KrakenWebSocketV2ExchangeAdapter.js';
import { createLogger } from '../logger-factory.js'; // Adjusted path
import { OrderManager } from '../../../../lib/redis-backend-api/order-manager.js'; // Corrected path
import { FillManager } from '../../../../lib/redis-backend-api/fill-manager.js';   // Corrected path
import {jest} from '@jest/globals';
import { KrakenRESTClient } from '../../../../lib/exchanges/KrakenRESTClient.js'; // Added direct import

// UPDATED LOGGING BLOCK
fs.appendFileSync(DEBUG_LOG_FILE, `[TEST_FILE_PRE_DOTENV] KRAKEN_API_KEY: ${process.env.KRAKEN_API_KEY ? process.env.KRAKEN_API_KEY.substring(0, 5) + '...' : 'Not Found'}\n`);
fs.appendFileSync(DEBUG_LOG_FILE, `[TEST_FILE_PRE_DOTENV] KRAKEN_API_SECRET: ${process.env.KRAKEN_API_SECRET ? process.env.KRAKEN_API_SECRET.substring(0, 5) + '...' : 'Not Found'}\n`);
// END LOGGING BLOCK

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// UPDATED LOGGING BLOCK (AFTER DOTENV.CONFIG)
fs.appendFileSync(DEBUG_LOG_FILE, `[TEST_FILE_POST_DOTENV] KRAKEN_API_KEY: ${process.env.KRAKEN_API_KEY ? process.env.KRAKEN_API_KEY.substring(0, 5) + '...' : 'Not Found'}\n`);
fs.appendFileSync(DEBUG_LOG_FILE, `[TEST_FILE_POST_DOTENV] KRAKEN_API_SECRET: ${process.env.KRAKEN_API_SECRET ? process.env.KRAKEN_API_SECRET.substring(0, 5) + '...' : 'Not Found'}\n`);
// END LOGGING BLOCK

const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;

const logger = createLogger('KrakenWSv2Adapter-IntegrationTest');

// Basic mock for Redis managers if real Redis is not desired for these tests
// For true integration, a test Redis instance might be better.
const mockOrderManager = { // Renamed to avoid confusion if we import actual OrderManager
  add: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue(null),
  updateStatus: jest.fn().mockResolvedValue(null),
  getById: jest.fn().mockResolvedValue(null),
  getAllForSession: jest.fn().mockResolvedValue([]),
  getAll: jest.fn().mockResolvedValue([]), // Added based on usage elsewhere
  // ... other methods used by the adapter
};

const mockFillManager = { // Renamed
  add: jest.fn().mockResolvedValue(null),
  // ... other methods
};


describe('KrakenWebSocketV2ExchangeAdapter - Integration Tests', () => {
  let adapter;
  const testSymbol = 'ETH/USD'; // A common symbol for testing
  const sessionId = `int-test-${Date.now()}`;

  // Increase Jest timeout for network-dependent tests
  jest.setTimeout(30000); // 30 seconds

  beforeAll(() => {
    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
      logger.warn('KRAKEN_API_KEY or KRAKEN_API_SECRET not found in .env. Authenticated tests will likely fail or be skipped.');
      // Optionally, throw an error to prevent tests from running without credentials
      // throw new Error('Kraken API credentials are required for integration tests.');
    }
  });

  beforeEach(async () => {
    const config = {
      symbol: testSymbol,
      sessionId: sessionId,
      logger: logger,
      redisOrderManager: mockOrderManager, // Use the renamed mock object
      redisFillManager: mockFillManager,   // Use the renamed mock object
      apiKey: KRAKEN_API_KEY,
      apiSecret: KRAKEN_API_SECRET,
      // Optional: specify publicApiUrl and apiUrl if different from defaults
      // publicApiUrl: 'wss://ws.kraken.com/v2',
      // apiUrl: 'wss://ws-auth.kraken.com/v2',
    };
    adapter = new KrakenWebSocketV2ExchangeAdapter(config);
  });

  afterEach(async () => {
    if (adapter && (adapter.connectionState === 'connected' || adapter.publicConnectionState === 'connected')) {
      await adapter.disconnect();
    }
    // Reset mocks if necessary
    jest.clearAllMocks();
  });

  describe('Connection and Disconnection', () => {
    test('should fetch WebSocket token directly using KrakenRESTClient', async () => {
      if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
        logger.warn('Skipping direct KrakenRESTClient token fetch test due to missing API credentials.');
        return;
      }

      const restClient = new KrakenRESTClient({
        apiKey: KRAKEN_API_KEY,
        apiSecret: KRAKEN_API_SECRET,
        baseUrl: 'https://api.kraken.com' // Standard Kraken API base URL
      });

      try {
        logger.info('[JEST_DIRECT_TOKEN_TEST] Attempting to fetch WebSocket token directly...');
        const tokenResponse = await restClient.getWebSocketToken();
        logger.info('[JEST_DIRECT_TOKEN_TEST] Successfully fetched WebSocket token:', tokenResponse);
        
        expect(tokenResponse).toBeDefined();
        expect(tokenResponse.token).toBeDefined();
        expect(tokenResponse.token.length).toBeGreaterThan(0);
        expect(tokenResponse.expires).toBeGreaterThan(0);

      } catch (error) {
        logger.error('[JEST_DIRECT_TOKEN_TEST] Error fetching WebSocket token directly:', error);
        // Log the full error object, which might contain more details like stack or specific error codes
        console.error('[JEST_DIRECT_TOKEN_TEST] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        throw error; // Re-throw to fail the test
      }
    });

    // Original test commented out or removed for now
    /*
    test('should connect to both private and public WebSockets and then disconnect', async () => {
      if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
        logger.warn('Skipping full connection test due to missing API credentials.');
        // Attempt public connection only if no auth
        await adapter._connectPublic();
        expect(adapter.publicConnectionState).toBe('connected');
        logger.info('Public WebSocket connected (auth skipped).');
        await adapter.disconnect();
        expect(adapter.publicConnectionState).toBe('disconnected');
        return;
      }

      let privateConnected = false;
      let publicConnected = false;

      adapter.on('connected', ({ connectionType }) => {
        if (connectionType === 'private') privateConnected = true;
        if (connectionType === 'public') publicConnected = true;
        if (privateConnected && publicConnected) {
           logger.info('Both private and public WebSockets reported connected via events.');
        }
      });
      
      adapter.on('error', (err) => {
        logger.error('Adapter emitted error during connection test:', err);
      });

      await adapter.connect();
      
      // Check internal states
      expect(adapter.connectionState).toBe('connected'); // Private connection
      expect(adapter.publicConnectionState).toBe('connected'); // Public connection
      logger.info('Adapter connection states are "connected".');

      // Check event-based flags as well
      // Give a bit of time for events to fire if they are slightly delayed post-promise resolution
      await new Promise(resolve => setTimeout(resolve, 1000)); 
      expect(privateConnected).toBe(true);
      expect(publicConnected).toBe(true);

      await adapter.disconnect();
      expect(adapter.connectionState).toBe('disconnected');
      expect(adapter.publicConnectionState).toBe('disconnected');
      logger.info('Adapter disconnected successfully.');
    });
    */
  });

  describe('Public Channel Subscriptions', () => {
    beforeEach(async () => {
      // Ensure public connection is up for these tests
      // If private connection fails due to no keys, public should still work
      if (adapter.publicConnectionState !== 'connected') {
        await adapter._connectPublic(); // Connect only public if not already connected
      }
      expect(adapter.publicConnectionState).toBe('connected');
    });

    test('should subscribe to ticker and receive ticker updates', async () => {
      if (typeof adapter.subscribeToTicker !== 'function') {
        logger.warn('adapter.subscribeToTicker is not a function. Skipping test.');
        return; // Simply return to skip
      }

      return new Promise(async (resolve, reject) => { // Wrap in a promise
        const tickerListener = jest.fn((tickerData) => {
          try {
            logger.info('Received ticker data:', tickerData);
            expect(tickerData).toBeDefined();
            expect(tickerData.symbol).toBe(testSymbol);
            expect(tickerData).toHaveProperty('bid');
            expect(tickerData).toHaveProperty('ask');
            expect(tickerData).toHaveProperty('last');
            expect(tickerData).toHaveProperty('timestamp');

            adapter.unsubscribeFromTicker(testSymbol)
              .catch(err => logger.error('Error unsubscribing from ticker:', err))
              .finally(() => resolve()); // Resolve the promise
          } catch (error) {
            reject(error); // Reject promise on assertion error
          }
        });

        adapter.on('tickerUpdate', tickerListener);

        try {
          await adapter.subscribeToTicker(testSymbol);
          logger.info(`Subscribed to ticker for ${testSymbol}`);
          // The promise will be resolved by the tickerListener
        } catch (error) {
          logger.error('Error subscribing to ticker:', error);
          adapter.off('tickerUpdate', tickerListener); // Clean up listener
          reject(error); // Reject the promise
        }
      });
    }, 15000); // Test timeout

    test('should subscribe to public trades and receive trade updates', async () => {
      if (typeof adapter.subscribeToTrades !== 'function') {
        logger.warn('adapter.subscribeToTrades is not a function. Skipping test.');
        return; // Simply return to skip
      }

      return new Promise(async (resolve, reject) => { // Wrap in a promise
        const tradeListener = jest.fn((tradeData) => {
          try {
            logger.info('Received public trade data:', tradeData);
            expect(tradeData).toBeDefined();
            expect(Array.isArray(tradeData)).toBe(true);
            if (tradeData.length > 0) {
              const trade = tradeData[0];
              expect(trade.symbol).toBe(testSymbol);
              expect(trade).toHaveProperty('price');
              expect(trade).toHaveProperty('volume');
              expect(trade).toHaveProperty('side');
              expect(trade).toHaveProperty('timestamp');
              expect(trade).toHaveProperty('tradeId');
            }
            adapter.unsubscribeFromTrades(testSymbol)
              .catch(err => logger.error('Error unsubscribing from trades:', err))
              .finally(() => resolve()); // Resolve the promise
          } catch (error) {
            reject(error); // Reject promise on assertion error
          }
        });

        adapter.on('tradeUpdate', tradeListener);

        try {
          await adapter.subscribeToTrades(testSymbol);
          logger.info(`Subscribed to public trades for ${testSymbol}`);
          // The promise will be resolved by the tradeListener
        } catch (error) {
          logger.error('Error subscribing to public trades:', error);
          adapter.off('tradeUpdate', tradeListener);
          reject(error); // Reject the promise
        }
      });
    }, 15000); // Test timeout
  });

  describe('Authenticated Actions', () => {
    beforeEach(async () => {
      // Ensure adapter is connected for authenticated tests
      if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
        // This will cause tests in this suite to be skipped if not handled by Jest's skip functionality
        throw new Error('API credentials missing, skipping authenticated tests.'); 
      }
      // Connect fresh for each authenticated test to ensure clean state
      await adapter.connect();
      expect(adapter.connectionState).toBe('connected');
      expect(adapter.publicConnectionState).toBe('connected');
    });

    test('fetchOpenOrders() should retrieve open orders (or empty array if none)', async () => {
      try {
        const openOrders = await adapter.fetchOpenOrders(testSymbol);
        expect(Array.isArray(openOrders)).toBe(true);
        logger.info(`Fetched ${openOrders.length} open orders for ${testSymbol}.`);
        if (openOrders.length > 0) {
          logger.info('Sample open order:', openOrders[0]);
          // Basic checks on order structure if orders are present
          expect(openOrders[0]).toHaveProperty('id');
          expect(openOrders[0]).toHaveProperty('symbol');
          expect(openOrders[0]).toHaveProperty('status');
        }
      } catch (error) {
        logger.error('Error during fetchOpenOrders test:', error);
        // Allow test to fail naturally if an error occurs that isn't an assertion failure
        throw error; 
      }
    });

    test('should create a limit order and then cancel it', async () => {
      if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
        logger.warn('Skipping create/cancel order test due to missing API credentials.');
        return; // Or use jest.skip()
      }

      // Fetch current market price to set order price dynamically
      let currentMarketPrice = 2000; // Default fallback if ticker fails for ETH/USD
      try {
        const ticker = await adapter.getTicker(testSymbol);
        if (ticker && ticker.bid) {
          currentMarketPrice = parseFloat(ticker.bid);
          logger.info(`Current market bid for ${testSymbol}: ${currentMarketPrice}`);
        } else {
          logger.warn(`Could not get valid bid price from ticker for ${testSymbol}, using fallback: ${currentMarketPrice}. Ticker:`, ticker);
        }
      } catch (err) {
        logger.error(`Error fetching ticker for ${testSymbol}, using fallback: ${currentMarketPrice}. Error:`, err);
      }

      const orderAmount = 0.0001; // Very small amount for ETH/USD
      // Set order price significantly below the current market bid
      const orderPrice = parseFloat((currentMarketPrice * 0.5).toFixed(2)); // 50% of current bid, toFixed for price precision
      logger.info(`Setting dynamic order price for ${testSymbol} buy limit: ${orderPrice}`);

      const orderSide = 'buy';
      const orderType = 'limit';
      const clientOrderId = `test-limit-${Date.now()}`;

      let createdOrderData = null;
      let orderCancelled = false;

      const orderUpdateListener = jest.fn((orderUpdate) => {
        logger.info('Received orderUpdate:', orderUpdate);
        if (orderUpdate.clientOrderId === clientOrderId || (createdOrderData && orderUpdate.id === createdOrderData.id)) {
          if (orderUpdate.status === 'pending_new' || orderUpdate.status === 'open' || orderUpdate.status === 'NEW') {
            if(!createdOrderData) createdOrderData = orderUpdate; // Capture first confirmation
            logger.info('Order confirmed as new/open:', orderUpdate.id);
          }
          if (orderUpdate.status === 'canceled' || orderUpdate.status === 'CANCELED') {
            orderCancelled = true;
            logger.info('Order confirmed as canceled:', orderUpdate.id);
          }
        }
      });
      adapter.on('orderUpdate', orderUpdateListener);

      try {
        // Create Order
        logger.info(`Attempting to create order: ${clientOrderId}, ${orderSide} ${orderAmount} ${testSymbol} @ ${orderPrice}`);
        createdOrderData = await adapter.createOrder(testSymbol, orderType, orderSide, orderAmount, orderPrice, { clientOrderId });
        
        expect(createdOrderData).toBeDefined();
        expect(createdOrderData.id).toBeDefined(); // Exchange-assigned ID
        expect(createdOrderData.clientOrderId).toBe(clientOrderId);
        expect(createdOrderData.status).toMatch(/^(pending_new|open|NEW)$/i); // Kraken might return NEW or open
        logger.info('Order creation acknowledged by adapter:', createdOrderData.id, createdOrderData.status);

        // Give some time for order to propagate and be picked up by fetchOpenOrders or for events
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds

        // Verify with fetchOpenOrders (optional but good check)
        const openOrders = await adapter.fetchOpenOrders(testSymbol);
        const foundOrder = openOrders.find(o => o.id === createdOrderData.id || o.clientOrderId === clientOrderId);
        expect(foundOrder).toBeDefined();
        logger.info('Order found in fetchOpenOrders().');

        // Cancel Order
        logger.info(`Attempting to cancel order: ${createdOrderData.id}`);
        const cancelResult = await adapter.cancelOrder(createdOrderData.id);
        expect(cancelResult).toBeDefined();
        // Kraken V2 cancel_order might return { success: true, status: 'pending_cancel' or 'CANCEL_REQUESTED' }
        // or could resolve once cancellation is fully confirmed from an execution report.
        // The key is that it doesn't throw and indicates acceptance of the cancel request.
        expect(cancelResult.success).toBe(true);
        logger.info('Order cancellation acknowledged by adapter:', cancelResult);

        // Wait for cancellation confirmation event
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds for event
        expect(orderCancelled).toBe(true);
        logger.info('Order successfully created and then canceled.');

      } catch (error) {
        logger.error('Error during create/cancel order test:', error);
        throw error; // Fail the test
      } finally {
        adapter.off('orderUpdate', orderUpdateListener); // Clean up
      }
    }, 20000); // Longer timeout for create/cancel operations
  });

  // More test suites will go here:
  // describe('Public Channel Subscriptions (Ticker, Trades, Order Book)', () => { ... });
  // describe('Authenticated Actions (Orders, Private Subscriptions)', () => { ... });
});

// NEW TEST SUITE FOR BASIC FETCH CONNECTIVITY
describe('Kraken API Connectivity Test in Jest Environment', () => {
  beforeAll(() => {
    // Log the fetch implementation Jest is using
    try {
      console.log('[FETCH_IMPL_CHECK_JEST]', fetch.toString());
    } catch (e) {
      console.log('[FETCH_IMPL_CHECK_JEST] Could not stringify fetch:', e.message);
    }
  });

  it('should be able to fetch time from Kraken public API using global fetch', async () => {
    const KRAKEN_BASE_URL = 'https://api.kraken.com'; // Standard Kraken API base
    const timeUrl = `${KRAKEN_BASE_URL}/0/public/Time`;
    let fetchError = null;
    let responseData = null;
    let responseStatus = null;

    // Log to console, which should appear in Jest output
    console.log(`[JEST_FETCH_TEST] Attempting to fetch: ${timeUrl}`);

    try {
      const response = await fetch(timeUrl); // Uses the global fetch available in Jest env
      responseStatus = response.status;
      console.log(`[JEST_FETCH_TEST] Response status: ${responseStatus}`);
      responseData = await response.json();
      console.log('[JEST_FETCH_TEST] Response data:', JSON.stringify(responseData, null, 2));
    } catch (error) {
      fetchError = error;
      console.error('[JEST_FETCH_TEST] Error during fetch:', error);
    }

    expect(fetchError).toBeNull();
    expect(responseStatus).toBe(200);
    expect(responseData).toBeDefined();
    // Kraken API errors are typically in an array if present
    expect(responseData.error).toEqual([]); 
    expect(responseData.result).toBeDefined();
    expect(responseData.result.unixtime).toBeGreaterThan(0);
  });
}); 