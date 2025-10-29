const TrueXMarketMaker = require('./TrueXMarketMaker');

/**
 * Example TrueX Market Maker Implementation
 * 
 * This demonstrates how to use the TrueXMarketMaker with real market data.
 * When FIX connectivity is fully working, this will create live quotes.
 */

async function runMarketMaker() {
  console.log('🎯 TrueX Market Maker Example');
  console.log('============================');
  console.log('');
  
  // Create market maker with configuration
  const marketMaker = new TrueXMarketMaker({
    symbol: 'BTC-PYUSD',
    strategy: 'basic_spread',
    baseSpread: 0.001,        // 0.1% spread
    maxPositionSize: 0.5,     // Max 0.5 BTC position
    orderSize: 0.05,          // 0.05 BTC per order
    riskLimits: {
      maxDailyLoss: 50,       // $50 max daily loss
      maxDrawdown: 0.02,      // 2% max drawdown
      positionLimit: 0.5      // 0.5 BTC max position
    }
  });

  // Setup event listeners
  marketMaker.on('started', () => {
    console.log('✅ Market maker started successfully');
  });

  marketMaker.on('market_update', (update) => {
    console.log('📊 Market Update:', {
      symbol: update.symbol,
      type: update.type,
      position: update.position,
      pnl: `$${update.pnl.toFixed(2)}`
    });
  });

  marketMaker.on('quotes_updated', (quotes) => {
    console.log('💰 New Quotes:', {
      bid: `$${quotes.bid.toFixed(2)}`,
      ask: `$${quotes.ask.toFixed(2)}`,
      spread: `${(quotes.spread * 100).toFixed(3)}%`,
      size: quotes.size
    });
  });

  marketMaker.on('error', (error) => {
    console.error('💥 Market maker error:', error.message);
  });

  // Start the market maker
  try {
    await marketMaker.start();
    
    // Run for demonstration (in production this would run indefinitely)
    console.log('🔄 Running market maker for 30 seconds...');
    
    // Display status every 5 seconds
    const statusInterval = setInterval(() => {
      const status = marketMaker.getStatus();
      const metrics = marketMaker.getMetrics();
      
      console.log('📋 Status Update:');
      console.log(`   Active: ${status.isActive}`);
      console.log(`   Position: ${status.position} ${status.symbol.split('-')[0]}`);
      console.log(`   Daily PnL: $${status.dailyPnL.toFixed(2)}`);
      console.log(`   Last Price: $${status.lastPrice?.toFixed(2) || 'N/A'}`);
      console.log(`   Volatility: ${(status.volatility * 100).toFixed(2)}%`);
      console.log(`   Trend: ${status.trend}`);
      console.log(`   Total Trades: ${metrics.totalTrades}`);
      console.log('');
    }, 5000);
    
    // Stop after 30 seconds
    setTimeout(async () => {
      clearInterval(statusInterval);
      
      console.log('🛑 Stopping market maker...');
      await marketMaker.stop();
      
      // Final statistics
      const finalMetrics = marketMaker.getMetrics();
      console.log('📊 Final Performance:');
      console.log(`   Uptime: ${(finalMetrics.uptime / 1000).toFixed(1)}s`);
      console.log(`   Total Volume: ${finalMetrics.totalVolume.toFixed(4)} BTC`);
      console.log(`   Total Trades: ${finalMetrics.totalTrades}`);
      console.log(`   Daily PnL: $${finalMetrics.dailyPnL.toFixed(2)}`);
      console.log(`   Win Rate: ${finalMetrics.winRate.toFixed(1)}%`);
      console.log('');
      console.log('✅ Market maker example completed');
      
      process.exit(0);
    }, 30000);
    
  } catch (error) {
    console.error('💥 Failed to start market maker:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\\n🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Run the example
runMarketMaker();