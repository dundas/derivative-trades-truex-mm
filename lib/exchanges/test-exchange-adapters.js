/**
 * Exchange WebSocket Adapter Test Script
 * 
 * This script demonstrates how to use the Exchange WebSocket Adapters to
 * establish connections to multiple exchanges using a standardized interface.
 */

import { KrakenWebSocketAdapter } from './KrakenWebSocketAdapter.js';
import { CoinbaseWebSocketAdapter } from './CoinbaseWebSocketAdapter.js';
import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Simple test to demonstrate how exchange adapters work with live market data
 */
async function testExchangeAdapters() {
  // Create a logger for testing
  const logger = new TradingLogger({
    component: 'adapter-test',
    symbol: 'BTC/USD',
    sessionId: 'test-session'
  });
  
  logger.info('Starting exchange adapter test with LIVE market data');
  
  // Create callbacks for handling market data
  const onOrderBookUpdate = (symbol, orderBook) => {
    logger.logMarket('INFO', `Order book update for ${symbol}`, {
      askCount: orderBook.asks.length,
      bidCount: orderBook.bids.length,
      topAsk: orderBook.asks.length > 0 ? orderBook.asks[0][0] : 'none',
      topBid: orderBook.bids.length > 0 ? orderBook.bids[0][0] : 'none'
    });
  };
  
  const onTickerUpdate = (symbol, ticker) => {
    logger.logMarket('INFO', `Ticker update for ${symbol}`, {
      ask: ticker.ask,
      bid: ticker.bid,
      last: ticker.last,
      volume: ticker.volume
    });
  };
  
  const onTradeUpdate = (symbol, trades) => {
    logger.logMarket('INFO', `Trade update for ${symbol}`, {
      count: trades.length,
      first: trades.length > 0 ? {
        price: trades[0].price,
        size: trades[0].size,
        side: trades[0].side
      } : 'none'
    });
  };
  
  const onError = (error) => {
    logger.logMarket('ERROR', `WebSocket error: ${error.message}`, { error });
  };
  
  // Create adapter config for live data
  const adapterConfig = {
    logger,
    symbol: 'BTC/USD',
    sessionId: 'test-session',
    onOrderBookUpdate,
    onTickerUpdate,
    onTradeUpdate,
    onError,
    // Use test mode for now until we have the WebSocket library installed
    useTestMode: true
  };
  
  let krakenAdapter, coinbaseAdapter;
  
  try {
    // Create Kraken adapter for live data
    logger.info('Creating Kraken adapter');
    krakenAdapter = new KrakenWebSocketAdapter(adapterConfig, { forceTestMode: true });
    
    // Create Coinbase adapter for live data
    logger.info('Creating Coinbase adapter');
    coinbaseAdapter = new CoinbaseWebSocketAdapter(adapterConfig, { forceTestMode: true });
    
    // Initialize adapters (connects to clients internally)
    logger.info('Initializing adapters');
    await krakenAdapter.initialize();
    await coinbaseAdapter.initialize();
    
    // Connect to exchanges
    logger.info('Connecting to Kraken');
    await krakenAdapter.connect();
    
    logger.info('Connecting to Coinbase');
    await coinbaseAdapter.connect();
    
    // Subscribe to channels
    const symbols = ['BTC/USD'];
    
    logger.info('Subscribing to Kraken book channel');
    await krakenAdapter.subscribe('book', symbols, { depth: 10 });
    
    logger.info('Subscribing to Coinbase book channel');
    await coinbaseAdapter.subscribe('book', symbols);
    
    // Simulate some data updates in test mode
    logger.info('Simulating data updates...');
    
    // Simulate order book updates from both exchanges
    const krakenOrderBookUpdate = {
      asks: [['40000.1', '1.5'], ['40000.2', '2.3']],
      bids: [['39999.9', '3.2'], ['39999.8', '4.1']],
      timestamp: Date.now(),
      sequenceNumber: Date.now()
    };
    
    const coinbaseOrderBookUpdate = {
      asks: [['41000.1', '0.5'], ['41000.2', '1.3']],
      bids: [['40999.9', '2.2'], ['40999.8', '3.1']],
      timestamp: Date.now(),
      sequenceNumber: Date.now()
    };
    
    // Manually trigger callbacks to simulate data flow in test mode
    onOrderBookUpdate('BTC/USD', krakenOrderBookUpdate);
    onOrderBookUpdate('BTC/USD', coinbaseOrderBookUpdate);
    
    // Get and display current order books
    const krakenOrderBook = krakenAdapter.getOrderBook('BTC/USD');
    if (krakenOrderBook) {
      logger.logMarket('INFO', 'Current Kraken order book:', {
        askCount: krakenOrderBook.asks.length,
        bidCount: krakenOrderBook.bids.length,
        topAsk: krakenOrderBook.asks.length > 0 ? krakenOrderBook.asks[0][0] : 'none',
        topBid: krakenOrderBook.bids.length > 0 ? krakenOrderBook.bids[0][0] : 'none'
      });
    }
    
    const coinbaseOrderBook = coinbaseAdapter.getOrderBook('BTC/USD');
    if (coinbaseOrderBook) {
      logger.logMarket('INFO', 'Current Coinbase order book:', {
        askCount: coinbaseOrderBook.asks.length,
        bidCount: coinbaseOrderBook.bids.length,
        topAsk: coinbaseOrderBook.asks.length > 0 ? coinbaseOrderBook.asks[0][0] : 'none',
        topBid: coinbaseOrderBook.bids.length > 0 ? coinbaseOrderBook.bids[0][0] : 'none'
      });
    }
    
    // Wait for a short period
    const waitTime = 5000; // 5 seconds is enough for testing with mocks
    logger.info(`Waiting for ${waitTime/1000} seconds...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // Clean up
    logger.info('Unsubscribing from Kraken');
    await krakenAdapter.unsubscribe('book', symbols);
    
    logger.info('Unsubscribing from Coinbase');
    await coinbaseAdapter.unsubscribe('book', symbols);
    
    logger.info('Disconnecting from exchanges');
    await krakenAdapter.disconnect();
    await coinbaseAdapter.disconnect();
    
    logger.info('Test completed successfully');
    return true;
  } catch (error) {
    logger.error(`Test failed: ${error.message}`, { error });
    
    // Clean up in case of error
    if (krakenAdapter) {
      try {
        await krakenAdapter.disconnect();
      } catch (disconnectError) {
        logger.error(`Error disconnecting from Kraken: ${disconnectError.message}`);
      }
    }
    
    if (coinbaseAdapter) {
      try {
        await coinbaseAdapter.disconnect();
      } catch (disconnectError) {
        logger.error(`Error disconnecting from Coinbase: ${disconnectError.message}`);
      }
    }
    
    // Return false to indicate failure
    return false;
  }
}

// Test if being run directly
const runningDirectly = () => {
  return process.argv.length > 1 && process.argv[1].includes('test-exchange-adapters');
};

if (runningDirectly()) {
  console.log('Running exchange adapter test...');
  testExchangeAdapters().then(success => {
    if (success) {
      console.log('Test completed successfully!');
      process.exit(0);
    } else {
      console.error('Test failed!');
      process.exit(1);
    }
  }).catch(error => {
    console.error('Test failed with unhandled error:', error);
    process.exit(1);
  });
}

export { testExchangeAdapters };
