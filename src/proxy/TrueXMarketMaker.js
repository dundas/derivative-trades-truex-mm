const EventEmitter = require('events');
const TrueXMarketDataManager = require('./TrueXMarketDataManager');

/**
 * TrueX Market Maker Trading Engine
 * 
 * Implements market making strategies using real-time market data from TrueX.
 * Supports multiple algorithms and risk management features.
 */
class TrueXMarketMaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.symbol = options.symbol || 'BTC-PYUSD';
    this.strategy = options.strategy || 'basic_spread';
    this.baseSpread = options.baseSpread || 0.002; // 0.2% spread
    this.maxPositionSize = options.maxPositionSize || 1.0; // Max 1 BTC position
    this.orderSize = options.orderSize || 0.1; // 0.1 BTC per order
    this.riskLimits = options.riskLimits || {
      maxDailyLoss: 100, // $100 max daily loss
      maxDrawdown: 0.05, // 5% max drawdown
      positionLimit: 1.0 // 1 BTC max position
    };
    
    // Market data manager
    this.dataManager = new TrueXMarketDataManager(options);
    
    // Trading state
    this.isActive = false;
    this.currentPosition = 0;
    this.dailyPnL = 0;
    this.orders = new Map();
    this.lastPrice = null;
    this.bidPrice = null;
    this.askPrice = null;
    
    // Market data tracking
    this.priceHistory = [];
    this.volumeProfile = new Map();
    this.volatility = 0;
    this.trend = 'sideways'; // 'up', 'down', 'sideways'
    
    // Performance metrics
    this.startTime = Date.now();
    this.totalVolume = 0;
    this.totalTrades = 0;
    this.profits = 0;
    this.losses = 0;
    
    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for market data
   */
  setupEventHandlers() {
    this.dataManager.on('connected', () => {
      console.log('✅ Market data connected - starting market maker');
      this.onConnected();
    });
    
    this.dataManager.on('disconnected', () => {
      console.log('❌ Market data disconnected - pausing market maker');
      this.onDisconnected();
    });
    
    this.dataManager.on('market_data', (data) => {
      this.onMarketData(data);
    });
    
    this.dataManager.on('error', (error) => {
      console.error('💥 Market data error:', error.message);
      this.emit('error', error);
    });
  }

  /**
   * Start the market maker
   */
  async start() {
    console.log('🚀 Starting TrueX Market Maker');
    console.log(`   Symbol: ${this.symbol}`);
    console.log(`   Strategy: ${this.strategy}`);
    console.log(`   Base Spread: ${(this.baseSpread * 100).toFixed(2)}%`);
    console.log('');
    
    try {
      // Start market data feed
      await this.dataManager.start();
      
      this.emit('started');
      console.log('✅ Market maker started successfully');
      
    } catch (error) {
      console.error('💥 Failed to start market maker:', error.message);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the market maker
   */
  async stop() {
    console.log('🛑 Stopping TrueX Market Maker');
    
    this.isActive = false;
    
    // Cancel all open orders
    await this.cancelAllOrders();
    
    // Stop market data
    await this.dataManager.stop();
    
    this.emit('stopped');
    console.log('✅ Market maker stopped');
  }

  /**
   * Handle market data connection established
   */
  async onConnected() {
    try {
      // Subscribe to market data for our symbol
      await this.dataManager.subscribeToSymbol(this.symbol);
      
      // Wait a moment for initial market data
      setTimeout(() => {
        this.isActive = true;
        console.log(`📊 Market making active for ${this.symbol}`);
      }, 2000);
      
    } catch (error) {
      console.error('💥 Failed to subscribe to market data:', error.message);
      this.emit('error', error);
    }
  }

  /**
   * Handle market data disconnection
   */
  onDisconnected() {
    this.isActive = false;
    console.log('⏸️ Market making paused - no market data');
  }

  /**
   * Handle new market data
   */
  onMarketData(marketData) {
    if (!this.isActive) return;
    
    const { type, symbol, data } = marketData;
    
    if (symbol !== this.symbol) {
      return; // Only process our symbol
    }
    
    console.log(`📊 Market Data: ${type} for ${symbol}`);
    
    // Update market state
    this.updateMarketState(data);
    
    // Calculate new quotes
    const quotes = this.calculateQuotes();
    
    if (quotes) {
      // Update orders based on new market conditions
      this.updateOrders(quotes);
    }
    
    // Emit market update for external monitoring
    this.emit('market_update', {
      symbol,
      type,
      data,
      quotes,
      position: this.currentPosition,
      pnl: this.dailyPnL
    });
  }

  /**
   * Update market state from new data
   */
  updateMarketState(data) {
    // TODO: Parse actual bid/offer data from FIX NoMDEntries groups
    // For now, use mock data based on reference price
    const mockPrice = 50000; // Mock BTC price
    const spread = mockPrice * this.baseSpread;
    
    this.bidPrice = mockPrice - spread / 2;
    this.askPrice = mockPrice + spread / 2;
    this.lastPrice = mockPrice;
    
    // Update price history
    this.priceHistory.push({
      price: mockPrice,
      timestamp: Date.now()
    });
    
    // Keep only last 100 price points
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
    
    // Calculate volatility and trend
    this.updateMarketMetrics();
  }

  /**
   * Update market metrics (volatility, trend)
   */
  updateMarketMetrics() {
    if (this.priceHistory.length < 10) return;
    
    // Calculate simple volatility (standard deviation of returns)
    const prices = this.priceHistory.map(p => p.price);
    const returns = [];
    
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    this.volatility = Math.sqrt(variance);
    
    // Simple trend detection
    const recent = prices.slice(-10);
    const earlier = prices.slice(-20, -10);
    
    if (recent.length >= 10 && earlier.length >= 10) {
      const recentAvg = recent.reduce((sum, p) => sum + p, 0) / recent.length;
      const earlierAvg = earlier.reduce((sum, p) => sum + p, 0) / earlier.length;
      
      if (recentAvg > earlierAvg * 1.001) {
        this.trend = 'up';
      } else if (recentAvg < earlierAvg * 0.999) {
        this.trend = 'down';
      } else {
        this.trend = 'sideways';
      }
    }
  }

  /**
   * Calculate bid/ask quotes based on strategy
   */
  calculateQuotes() {
    if (!this.lastPrice || !this.bidPrice || !this.askPrice) {
      return null;
    }
    
    let adjustedSpread = this.baseSpread;
    
    // Strategy: Basic Spread
    if (this.strategy === 'basic_spread') {
      // Adjust spread based on volatility
      adjustedSpread = this.baseSpread * (1 + this.volatility * 10);
      
      // Adjust spread based on position
      if (Math.abs(this.currentPosition) > this.maxPositionSize * 0.5) {
        // Widen spread when position is large
        adjustedSpread *= 1.5;
      }
    }
    
    // Strategy: Trend Following
    else if (this.strategy === 'trend_following') {
      if (this.trend === 'up') {
        // Bias towards buying in uptrend
        adjustedSpread = this.baseSpread * 0.8;
      } else if (this.trend === 'down') {
        // Bias towards selling in downtrend  
        adjustedSpread = this.baseSpread * 0.8;
      }
    }
    
    // Calculate quote prices
    const halfSpread = this.lastPrice * adjustedSpread / 2;
    const bidPrice = this.lastPrice - halfSpread;
    const askPrice = this.lastPrice + halfSpread;
    
    // Risk management adjustments
    const riskAdjusted = this.applyRiskManagement(bidPrice, askPrice);
    
    return {
      bid: riskAdjusted.bid,
      ask: riskAdjusted.ask,
      size: this.orderSize,
      spread: adjustedSpread,
      timestamp: Date.now()
    };
  }

  /**
   * Apply risk management to quotes
   */
  applyRiskManagement(bidPrice, askPrice) {
    let adjustedBid = bidPrice;
    let adjustedAsk = askPrice;
    
    // Position limits
    if (this.currentPosition >= this.riskLimits.positionLimit) {
      // Max long position - only allow selling
      adjustedBid = 0;
    } else if (this.currentPosition <= -this.riskLimits.positionLimit) {
      // Max short position - only allow buying
      adjustedAsk = Infinity;
    }
    
    // Daily loss limits
    if (this.dailyPnL <= -this.riskLimits.maxDailyLoss) {
      // Stop trading if daily loss limit hit
      console.log('🚨 Daily loss limit reached - stopping quotes');
      adjustedBid = 0;
      adjustedAsk = Infinity;
    }
    
    return {
      bid: adjustedBid,
      ask: adjustedAsk
    };
  }

  /**
   * Update orders based on new quotes
   */
  async updateOrders(quotes) {
    // TODO: Implement actual order management
    // For now, just log the quotes that would be sent
    
    console.log('📈 Quote Update:');
    console.log(`   Bid: $${quotes.bid.toFixed(2)} x ${quotes.size}`);
    console.log(`   Ask: $${quotes.ask.toFixed(2)} x ${quotes.size}`);
    console.log(`   Spread: ${(quotes.spread * 100).toFixed(3)}%`);
    console.log(`   Position: ${this.currentPosition}`);
    console.log(`   PnL: $${this.dailyPnL.toFixed(2)}`);
    console.log('');
    
    // Emit quote update for monitoring
    this.emit('quotes_updated', quotes);
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders() {
    console.log('❌ Cancelling all open orders...');
    // TODO: Implement order cancellation
    this.orders.clear();
  }

  /**
   * Get current market maker status
   */
  getStatus() {
    const uptime = Date.now() - this.startTime;
    
    return {
      symbol: this.symbol,
      strategy: this.strategy,
      isActive: this.isActive,
      uptime: uptime,
      position: this.currentPosition,
      dailyPnL: this.dailyPnL,
      totalVolume: this.totalVolume,
      totalTrades: this.totalTrades,
      lastPrice: this.lastPrice,
      bidPrice: this.bidPrice,
      askPrice: this.askPrice,
      volatility: this.volatility,
      trend: this.trend,
      openOrders: this.orders.size
    };
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    const uptime = Date.now() - this.startTime;
    const winRate = this.totalTrades > 0 ? (this.profits / (this.profits + this.losses)) * 100 : 0;
    const avgVolumePerHour = this.totalVolume / (uptime / (1000 * 60 * 60));
    
    return {
      uptime: uptime,
      totalVolume: this.totalVolume,
      totalTrades: this.totalTrades,
      dailyPnL: this.dailyPnL,
      winRate: winRate,
      avgVolumePerHour: avgVolumePerHour,
      sharpe: 0, // TODO: Calculate Sharpe ratio
      maxDrawdown: 0 // TODO: Track max drawdown
    };
  }
}

module.exports = TrueXMarketMaker;