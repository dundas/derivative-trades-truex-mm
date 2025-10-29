import { TrueXFIXExchangeAdapter } from './TrueXFIXExchangeAdapter.js';
import { LoggerFactory } from '../logger-factory.js';

/**
 * Example usage and test file for TrueXFIXExchangeAdapter
 * 
 * This demonstrates how to:
 * 1. Initialize the adapter with proper configuration
 * 2. Connect to TrueX FIX sessions using jspurefix
 * 3. Subscribe to market data
 * 4. Place, monitor, and cancel orders
 * 5. Handle various FIX protocol events
 * 
 * Note: Requires jspurefix library and FIX dictionary setup
 * Run ./truex-fix-setup.sh first to install dependencies
 */

async function testTrueXFIXAdapter() {
  // Create logger
  const logger = LoggerFactory.createLogger('TrueXFIXTest');
  
  // Initialize adapter with configuration
  const adapter = new TrueXFIXExchangeAdapter({
    // Connection settings
    orderEntryHost: process.env.TRUEX_ORDER_HOST || 'fix-order.truex.co',
    orderEntryPort: process.env.TRUEX_ORDER_PORT || 443,
    marketDataHost: process.env.TRUEX_MARKET_HOST || 'fix-market.truex.co',
    marketDataPort: process.env.TRUEX_MARKET_PORT || 443,
    
    // Authentication
    apiKey: process.env.TRUEX_API_KEY,
    apiSecret: process.env.TRUEX_API_SECRET,
    senderCompID: process.env.TRUEX_SENDER_COMP_ID || 'CLIENT',
    targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX',
    
    // Trading configuration
    tradingPair: 'BTC/USD',
    tradingMode: 'paper', // 'paper' or 'live'
    sessionId: `test-session-${Date.now()}`,
    strategyName: 'truex_fix_test',
    
    // Session configuration
    heartbeatInterval: 30, // seconds
    
    // Reconnection settings
    maxReconnectAttempts: 5,
    initialReconnectDelayMs: 1000,
    maxReconnectDelayMs: 30000,
    
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
      bestAsk: orderBook.asks[0]
    });
  });
  
  adapter.on('tradeUpdate', (trade) => {
    logger.info('Trade update:', trade);
  });
  
  adapter.on('error', (error) => {
    logger.error('Adapter error:', error);
  });
  
  try {
    // 1. Connect to TrueX
    logger.info('Connecting to TrueX FIX API...');
    await adapter.connect();
    logger.info('Successfully connected!');
    
    // 2. Get tradable pairs
    logger.info('Fetching tradable pairs...');
    const pairs = await adapter.getTradablePairs();
    logger.info('Tradable pairs:', pairs);
    
    // 3. Get pair details
    const pairDetails = await adapter.getPairDetails('BTC/USD');
    logger.info('BTC/USD details:', pairDetails);
    
    // 4. Subscribe to market data
    logger.info('Subscribing to BTC/USD market data...');
    await adapter.subscribeMarketData('BTC/USD', ['orderbook', 'trades']);
    
    // Wait a bit for market data to arrive
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 5. Place a limit buy order
    logger.info('Placing limit buy order...');
    const buyOrder = await adapter.createOrder({
      symbol: 'BTC/USD',
      side: 'buy',
      type: 'limit',
      price: 50000, // Well below market for safety
      amount: 0.001,
      params: {
        timeInForce: 'GTC', // Good Till Cancel
        execInst: 'ALO', // Add Liquidity Only (optional)
        selfMatchPreventionId: 'test-account', // Prevent self-trading
        selfMatchPreventionInstruction: 0 // Cancel resting order on self-match
      }
    });
    logger.info('Buy order placed:', buyOrder);
    
    // Wait for order confirmation
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 6. Check order status
    const orderStatus = await adapter.getOrderStatus(buyOrder.id);
    logger.info('Order status:', orderStatus);
    
    // 7. Place a market sell order (paper trading only)
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
    
    // 8. Cancel the buy order
    logger.info('Canceling buy order...');
    const cancelResult = await adapter.cancelOrder(buyOrder.id);
    logger.info('Cancel result:', cancelResult);
    
    // 9. Cancel all open orders
    logger.info('Canceling all open orders...');
    const cancelAllResult = await adapter.cancelAllManagedOrders('Test cleanup');
    logger.info('Cancel all result:', cancelAllResult);
    
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
class TrueXTradingStrategy {
  constructor(config) {
    this.adapter = new TrueXFIXExchangeAdapter(config);
    this.logger = config.logger;
    this.isRunning = false;
    this.orderBook = null;
    this.position = 0;
    this.pendingOrders = new Map();
  }
  
  async start() {
    // Connect to exchange
    await this.adapter.connect();
    
    // Set up event handlers
    this.adapter.on('orderBookUpdate', this.onOrderBookUpdate.bind(this));
    this.adapter.on('orderFilled', this.onOrderFilled.bind(this));
    this.adapter.on('error', this.onError.bind(this));
    
    // Subscribe to market data
    await this.adapter.subscribeMarketData(this.adapter.tradingPair);
    
    this.isRunning = true;
    this.logger.info('Strategy started');
  }
  
  async stop() {
    this.isRunning = false;
    
    // Cancel all pending orders
    await this.adapter.cancelAllManagedOrders('Strategy shutdown');
    
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
      
      // Place new buy order slightly above best bid
      const buyPrice = bestBid + 0.01;
      const buyOrder = await this.adapter.createOrder({
        side: 'buy',
        type: 'limit',
        price: buyPrice,
        amount: 0.001,
        params: {
          execInst: 'ALO' // Add Liquidity Only
        }
      });
      this.pendingOrders.set(buyOrder.id, buyOrder);
      
      // Place new sell order slightly below best ask
      const sellPrice = bestAsk - 0.01;
      const sellOrder = await this.adapter.createOrder({
        side: 'sell',
        type: 'limit',
        price: sellPrice,
        amount: 0.001,
        params: {
          execInst: 'ALO' // Add Liquidity Only
        }
      });
      this.pendingOrders.set(sellOrder.id, sellOrder);
      
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
  
  onError(error) {
    this.logger.error('Strategy error:', error);
    
    // Handle critical errors
    if (error.type === 'MAX_RECONNECT_ATTEMPTS') {
      this.stop();
    }
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testTrueXFIXAdapter().catch(console.error);
}

export { testTrueXFIXAdapter, TrueXTradingStrategy };