import { TrueXRESTExchangeAdapter } from './TrueXRESTExchangeAdapter.js';
import { LoggerFactory } from '../logger-factory.js';

/**
 * Test file for TrueXRESTExchangeAdapter
 * 
 * This demonstrates how to:
 * 1. Initialize the adapter with proper configuration
 * 2. Connect to TrueX REST API
 * 3. Subscribe to market data (via WebSocket or REST polling)
 * 4. Place, monitor, and cancel orders
 * 5. Handle various events and errors
 */

async function testTrueXRESTAdapter() {
  // Create logger
  const logger = LoggerFactory.createLogger('TrueXRESTTest');
  
  // Initialize adapter with configuration
  const adapter = new TrueXRESTExchangeAdapter({
    // REST API settings
    baseURL: process.env.TRUEX_REST_URL || 'https://prod.truex.co/api/v1',
    
    // Authentication
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_API_SECRET,
    userId: process.env.TRUEX_USER_ID || process.env.TRUEX_API_KEY,
    
    // WebSocket settings (optional)
    wsUrl: process.env.TRUEX_WS_URL || 'wss://ws.truex.co',
    
    // Trading configuration
    tradingPair: 'BTC/USD',
    tradingMode: 'paper', // 'paper' or 'live'
    sessionId: `test-rest-session-${Date.now()}`,
    strategyName: 'truex_rest_test',
    
    // Polling intervals
    orderStatusPollIntervalMs: 1000,
    orderBookPollIntervalMs: 500,
    balancePollIntervalMs: 5000,
    
    // Timeout settings
    timeout: 30000,
    
    // Reconnection settings
    maxReconnectAttempts: 5,
    initialReconnectDelayMs: 1000,
    
    // Logger
    logger: logger
  });
  
  // Set up event listeners
  adapter.on('orderUpdate', (order) => {
    logger.info('Order update received:', order);
  });
  
  adapter.on('orderFilled', (fill) => {
    logger.info('Order filled:', fill);
  });
  
  adapter.on('orderBookUpdate', (orderBook) => {
    logger.info('Order book update:', {
      symbol: orderBook.symbol,
      bidCount: orderBook.bids.length,
      askCount: orderBook.asks.length,
      bestBid: orderBook.bids[0],
      bestAsk: orderBook.asks[0],
      timestamp: new Date(orderBook.timestamp).toISOString()
    });
  });
  
  adapter.on('tradeUpdate', (trade) => {
    logger.info('Trade update:', trade);
  });
  
  adapter.on('balancesUpdated', (balances) => {
    logger.info('Balances updated:', balances);
  });
  
  adapter.on('error', (error) => {
    logger.error('Adapter error:', error);
  });
  
  try {
    // 1. Connect to TrueX
    logger.info('Connecting to TrueX REST API...');
    await adapter.connect();
    logger.info('Successfully connected!');
    
    // 2. Fetch balances
    logger.info('Fetching account balances...');
    const balances = await adapter.fetchBalances();
    logger.info('Account balances:', balances);
    
    // 3. Get tradable pairs
    logger.info('Fetching tradable pairs...');
    const pairs = await adapter.getTradablePairs();
    logger.info(`Found ${pairs.length} tradable pairs`);
    
    // 4. Get pair details
    const pairDetails = await adapter.getPairDetails('BTC/USD');
    logger.info('BTC/USD details:', pairDetails);
    
    // 5. Subscribe to market data
    logger.info('Subscribing to BTC/USD market data...');
    await adapter.subscribeMarketData('BTC/USD');
    
    // Wait for market data to arrive
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 6. Place a limit buy order
    logger.info('Placing limit buy order...');
    const buyOrder = await adapter.createOrder({
      symbol: 'BTC/USD',
      side: 'buy',
      type: 'limit',
      price: 50000, // Well below market for safety
      amount: 0.001,
      params: {
        timeInForce: 'GTC', // Good Till Cancel
        postOnly: true // Maker-only order
      }
    });
    logger.info('Buy order placed:', buyOrder);
    
    // Wait for order confirmation
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 7. Check order status
    const orderStatus = await adapter.getOrderStatus(buyOrder.id);
    logger.info('Order status:', orderStatus);
    
    // 8. Place a market sell order (paper trading only)
    if (adapter.tradingMode === 'paper') {
      logger.info('Placing market sell order...');
      const sellOrder = await adapter.createOrder({
        symbol: 'BTC/USD',
        side: 'sell',
        type: 'market',
        amount: 0.001,
        params: {
          timeInForce: 'IOC' // Immediate Or Cancel
        }
      });
      logger.info('Sell order placed:', sellOrder);
    }
    
    // 9. Cancel the buy order
    logger.info('Canceling buy order...');
    const cancelResult = await adapter.cancelOrder(buyOrder.id);
    logger.info('Cancel result:', cancelResult);
    
    // 10. Cancel all open orders
    logger.info('Canceling all open orders...');
    const cancelAllResult = await adapter.cancelAllManagedOrders('Test cleanup');
    logger.info('Cancel all result:', cancelAllResult);
    
    // 11. Test REST client methods directly
    logger.info('\n--- Testing REST client methods ---');
    
    // Test ping
    const pingResult = await adapter.restClient.ping();
    logger.info('Ping result:', pingResult);
    
    // Test server time
    const serverTime = await adapter.restClient.getServerTime();
    logger.info('Server time:', serverTime);
    
    // Test get assets
    const assets = await adapter.restClient.getAssets({ page_size: 10 });
    logger.info(`Found ${assets.data?.length || 0} assets`);
    
    // Test get instruments
    const instruments = await adapter.restClient.getInstruments({ 
      symbol: '*BTC*', 
      page_size: 10 
    });
    logger.info(`Found ${instruments.data?.length || 0} BTC instruments`);
    
    // Test market quote
    if (pairDetails) {
      const quote = await adapter.restClient.getMarketQuoteBySymbol('BTC/USD');
      logger.info('Market quote:', {
        bestBid: quote.data?.bids?.[0],
        bestAsk: quote.data?.asks?.[0]
      });
    }
    
    // Wait a bit before disconnecting
    await new Promise(resolve => setTimeout(resolve, 5000));
    
  } catch (error) {
    logger.error('Test failed:', error);
  } finally {
    // Disconnect
    logger.info('Disconnecting...');
    await adapter.disconnect();
    logger.info('Disconnected');
  }
}

// Example of using the adapter in a trading strategy
class TrueXRESTTradingStrategy {
  constructor(config) {
    this.adapter = new TrueXRESTExchangeAdapter(config);
    this.logger = config.logger;
    this.isRunning = false;
    this.orderBook = null;
    this.position = 0;
    this.pendingOrders = new Map();
    this.balances = {};
  }
  
  async start() {
    // Connect to exchange
    await this.adapter.connect();
    
    // Set up event handlers
    this.adapter.on('orderBookUpdate', this.onOrderBookUpdate.bind(this));
    this.adapter.on('orderFilled', this.onOrderFilled.bind(this));
    this.adapter.on('balancesUpdated', this.onBalancesUpdated.bind(this));
    this.adapter.on('error', this.onError.bind(this));
    
    // Subscribe to market data
    await this.adapter.subscribeMarketData(this.adapter.tradingPair);
    
    // Get initial balances
    this.balances = await this.adapter.fetchBalances();
    
    this.isRunning = true;
    this.logger.info('Strategy started');
  }
  
  async stop() {
    this.isRunning = false;
    
    // Cancel all pending orders
    await this.adapter.cancelAllManagedOrders('Strategy shutdown');
    
    // Unsubscribe from market data
    await this.adapter.unsubscribeMarketData(this.adapter.tradingPair);
    
    // Disconnect
    await this.adapter.disconnect();
    
    this.logger.info('Strategy stopped');
  }
  
  onOrderBookUpdate(orderBook) {
    this.orderBook = orderBook;
    
    if (!this.isRunning) return;
    
    // Simple market making logic
    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];
    
    if (!bestBid || !bestAsk) return;
    
    const spread = bestAsk[0] - bestBid[0];
    const midPrice = (bestBid[0] + bestAsk[0]) / 2;
    
    // Place orders if spread is wide enough
    if (spread > midPrice * 0.002) { // 0.2% spread
      this.placeMarketMakingOrders(bestBid[0], bestAsk[0]);
    }
  }
  
  async placeMarketMakingOrders(bestBid, bestAsk) {
    try {
      // Cancel existing orders
      for (const [orderId, order] of this.pendingOrders) {
        await this.adapter.cancelOrder(orderId);
      }
      this.pendingOrders.clear();
      
      // Check available balance
      const baseAsset = 'BTC';
      const quoteAsset = 'USD';
      const availableBase = this.balances[baseAsset]?.free || 0;
      const availableQuote = this.balances[quoteAsset]?.free || 0;
      
      // Place new buy order if we have quote currency
      if (availableQuote > 100) { // At least $100
        const buyPrice = bestBid + 0.01;
        const buyAmount = Math.min(0.001, availableQuote / buyPrice);
        
        const buyOrder = await this.adapter.createOrder({
          side: 'buy',
          type: 'limit',
          price: buyPrice,
          amount: buyAmount,
          params: {
            postOnly: true // Maker order
          }
        });
        this.pendingOrders.set(buyOrder.id, buyOrder);
      }
      
      // Place new sell order if we have base currency
      if (availableBase > 0.001) {
        const sellPrice = bestAsk - 0.01;
        const sellAmount = Math.min(0.001, availableBase);
        
        const sellOrder = await this.adapter.createOrder({
          side: 'sell',
          type: 'limit',
          price: sellPrice,
          amount: sellAmount,
          params: {
            postOnly: true // Maker order
          }
        });
        this.pendingOrders.set(sellOrder.id, sellOrder);
      }
      
    } catch (error) {
      this.logger.error('Failed to place market making orders:', error);
    }
  }
  
  onOrderFilled(fill) {
    // Update position
    if (fill.side === 'buy') {
      this.position += fill.amount;
    } else {
      this.position -= fill.amount;
    }
    
    this.logger.info('Position updated:', {
      position: this.position,
      fill: fill
    });
    
    // Remove from pending orders
    this.pendingOrders.delete(fill.orderId);
  }
  
  onBalancesUpdated(balances) {
    this.balances = balances;
    this.logger.info('Balances updated:', {
      BTC: balances.BTC,
      USD: balances.USD
    });
  }
  
  onError(error) {
    this.logger.error('Strategy error:', error);
    
    // Handle critical errors
    if (error.type === 'MAX_RECONNECT_ATTEMPTS' || 
        error.type === 'CONNECTION_ERROR') {
      this.stop();
    }
  }
}

// Additional test functions for specific features
async function testWebSocketFallback(adapter) {
  const logger = adapter.logger;
  
  logger.info('\n--- Testing WebSocket fallback ---');
  
  // Force WebSocket disconnection to test REST polling
  if (adapter.ws) {
    logger.info('Closing WebSocket to test REST polling fallback...');
    adapter.ws.close();
    adapter.wsConnected = false;
  }
  
  // Market data should continue via REST polling
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  logger.info('REST polling should be active now');
}

async function testErrorHandling(adapter) {
  const logger = adapter.logger;
  
  logger.info('\n--- Testing error handling ---');
  
  try {
    // Test invalid order
    await adapter.createOrder({
      symbol: 'INVALID/PAIR',
      side: 'buy',
      type: 'limit',
      price: 100,
      amount: 0.001
    });
  } catch (error) {
    logger.info('Expected error for invalid pair:', error.message);
  }
  
  try {
    // Test order without required fields
    await adapter.createOrder({
      symbol: 'BTC/USD',
      type: 'limit'
      // Missing side, price, amount
    });
  } catch (error) {
    logger.info('Expected error for missing fields:', error.message);
  }
  
  try {
    // Test cancel non-existent order
    await adapter.cancelOrder('non-existent-order-id');
  } catch (error) {
    logger.info('Expected error for non-existent order:', error.message);
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testTrueXRESTAdapter().catch(console.error);
}

export { testTrueXRESTAdapter, TrueXRESTTradingStrategy, testWebSocketFallback, testErrorHandling };