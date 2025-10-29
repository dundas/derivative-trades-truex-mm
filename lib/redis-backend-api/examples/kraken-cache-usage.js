/**
 * Example: Using Kraken Cache Manager through Redis Backend API
 * 
 * This shows how to use the centralized Kraken API cache to eliminate
 * rate limiting and timeout issues in settlement services and other components.
 */

import { KrakenCacheManager } from '../index.js';
import logger from '../../../utils/logger.js';

async function demonstrateKrakenCacheUsage() {
  logger.info('🚀 Demonstrating Kraken Cache Manager through Redis Backend API');
  
  // Initialize the cache manager
  const krakenCache = new KrakenCacheManager({
    cacheTTL: 5, // 5 seconds for demo
    circuitBreakerThreshold: 3
  });

  try {
    // Initialize connection
    await krakenCache.initialize();
    logger.info('✅ Kraken Cache Manager initialized');

    // Example 1: Get balance (Redis Backend API style response)
    logger.info('\n📊 Example 1: Getting account balance');
    const balanceResult = await krakenCache.getBalance();
    
    if (balanceResult.success) {
      logger.info('✅ Balance retrieved successfully');
      logger.info('   From cache:', balanceResult.metadata.fromCache);
      logger.info('   Age:', balanceResult.metadata.age + 'ms');
      logger.info('   Source:', balanceResult.metadata.source);
      // logger.info('   Data:', JSON.stringify(balanceResult.balance, null, 2));
    } else {
      logger.error('❌ Failed to get balance:', balanceResult.error);
    }

    // Example 2: Get fees (should be cache miss)
    logger.info('\n💰 Example 2: Getting trading fees');
    const feesResult = await krakenCache.getFees();
    
    if (feesResult.success) {
      logger.info('✅ Fees retrieved successfully');
      logger.info('   From cache:', feesResult.metadata.fromCache);
      logger.info('   Age:', feesResult.metadata.age + 'ms');
    }

    // Example 3: Get balance again (should be cache hit)
    logger.info('\n⚡ Example 3: Getting balance again (cache hit)');
    const balanceResult2 = await krakenCache.getBalance();
    
    if (balanceResult2.success) {
      logger.info('✅ Balance retrieved from cache');
      logger.info('   From cache:', balanceResult2.metadata.fromCache);
      logger.info('   Age:', balanceResult2.metadata.age + 'ms');
      logger.info('   Performance: Much faster!');
    }

    // Example 4: Get open orders
    logger.info('\n📋 Example 4: Getting open orders');
    const ordersResult = await krakenCache.getOpenOrders();
    
    if (ordersResult.success) {
      logger.info('✅ Open orders retrieved successfully');
      logger.info('   Order count:', Object.keys(ordersResult.orders?.open || {}).length);
      logger.info('   From cache:', ordersResult.metadata.fromCache);
    }

    // Example 5: Get trade history
    logger.info('\n📈 Example 5: Getting trade history');
    const tradesResult = await krakenCache.getTradeHistory();
    
    if (tradesResult.success) {
      logger.info('✅ Trade history retrieved successfully');
      logger.info('   Trade count:', Object.keys(tradesResult.trades?.trades || {}).length);
      logger.info('   Window:', tradesResult.metadata.sinceWindow + 's');
      logger.info('   From cache:', tradesResult.metadata.fromCache);
    }

    // Example 6: Health check
    logger.info('\n💚 Example 6: Health status');
    const healthResult = await krakenCache.getHealth();
    
    if (healthResult.success) {
      logger.info('✅ Health check successful');
      logger.info('   Status:', healthResult.health.status);
      logger.info('   Circuit breaker:', healthResult.health.circuitBreakerOpen ? 'Open' : 'Closed');
    }

    // Example 7: Cache statistics
    logger.info('\n📊 Example 7: Cache statistics');
    const statsResult = await krakenCache.getCacheStats();
    
    if (statsResult.success) {
      logger.info('✅ Cache stats retrieved');
      logger.info('   TTL:', statsResult.stats.cacheTTL + 's');
      logger.info('   Active fetches:', statsResult.stats.activeFetches);
      logger.info('   Cache keys:');
      
      for (const [name, info] of Object.entries(statsResult.stats.cacheKeys)) {
        logger.info(`     ${name}: exists=${info.exists}, ttl=${info.ttl}s`);
      }
    }

    logger.info('\n✅ All examples completed successfully!');

  } catch (error) {
    logger.error('❌ Error during demonstration:', error.message);
  }
}

// Usage in settlement service or other components
async function settlementServiceExample() {
  logger.info('\n🔧 Settlement Service Integration Example');
  
  const krakenCache = new KrakenCacheManager();
  await krakenCache.initialize();

  // Instead of multiple direct Kraken API calls that cause rate limiting:
  
  // OLD WAY (causes rate limiting):
  // const balance = await kraken.getAccountBalance();
  // const fees = await kraken.getCurrentFees();
  // const openOrders = await kraken.getOpenOrders();
  
  // NEW WAY (uses cache, eliminates rate limiting):
  const [balanceResult, feesResult, ordersResult] = await Promise.all([
    krakenCache.getBalance(),
    krakenCache.getFees(),
    krakenCache.getOpenOrders()
  ]);

  logger.info('✅ Retrieved all data without rate limiting');
  logger.info('   Balance success:', balanceResult.success);
  logger.info('   Fees success:', feesResult.success);
  logger.info('   Orders success:', ordersResult.success);
  
  // Use the data with proper error handling
  if (balanceResult.success) {
    const balance = balanceResult.balance;
    logger.info('   Available balance keys:', Object.keys(balance));
  }

  if (feesResult.success) {
    const fees = feesResult.fees;
    logger.info('   Fee structure available');
  }

  if (ordersResult.success) {
    const orders = ordersResult.orders;
    logger.info('   Open orders count:', Object.keys(orders?.open || {}).length);
  }
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await demonstrateKrakenCacheUsage();
      await settlementServiceExample();
      logger.info('\n🎉 Demo completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('💥 Demo error:', error);
      process.exit(1);
    }
  })();
}

export { demonstrateKrakenCacheUsage, settlementServiceExample };