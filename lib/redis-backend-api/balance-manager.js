/**
 * BalanceManager
 * 
 * Handles balance tracking operations for market maker strategies.
 * Calculates balance dynamically based on initial budget, orders and fills
 * or by fetching from the exchange for live mode.
 */

/**
 * BalanceManager class for handling balance tracking operations
 */
export class BalanceManager {
  /**
   * Create a new BalanceManager
   * 
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Trading session ID
   * @param {string} config.symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} config.logger - Logger instance
   * @param {Object} config.orderManager - Order manager instance
   * @param {Object} config.fillManager - Fill manager instance
   * @param {number} [config.initialBalance=0] - Initial balance for paper trading
   * @param {string} [config.tradingMode='paper'] - Trading mode ('paper' or 'live')
   * @param {Object} [config.exchangeApi] - Exchange API client for live balance checking
   * @param {boolean} [config.enableCaching=true] - Enable/disable caching
   */
  constructor(config) {
    this.redis = config.redis;
    this.sessionId = config.sessionId;
    this.symbol = config.symbol;
    this.logger = config.logger;
    this.orderManager = config.orderManager;
    this.fillManager = config.fillManager;
    this.tradingMode = config.tradingMode || 'paper';
    this.exchangeApi = config.exchangeApi; // For live mode
    
    const [base, quote] = (this.symbol || '').split('/');
    this.baseCurrency = base;
    this.quoteCurrency = quote;
    
    // Initialize initialBalances with the nested structure
    const initialQuoteAmount = parseFloat(config.initialBalance) || 0;
    const initialBaseAmount = parseFloat(config.initialBaseAmount) || 0; // Assuming a potential initial base amount
    
    this.initialBalances = {
      [this.quoteCurrency]: {
        total: initialQuoteAmount,
        available: initialQuoteAmount,
        reserved: 0,
      },
      [this.baseCurrency]: {
        total: initialBaseAmount,
        available: initialBaseAmount,
        reserved: 0,
      },
    };
    
    // Cache setup (simplified, direct property for now)
    this.balanceCache = null; // Will store the nested structure
    this.balanceCacheTimestamp = 0;
    this.CACHE_TTL = 500; // Cache TTL in ms, e.g., 0.5 second
    
    this.logger.debug(`[BalanceManager] Initialized for session ${this.sessionId}`, {
      mode: this.tradingMode,
      symbol: this.symbol,
      initialBalances: JSON.stringify(this.initialBalances)
    });
  }
  
  _getValidOrders(orders) {
    if (!Array.isArray(orders)) return [];
    return orders.filter(o => o && typeof o.status === 'string');
  }
  
  _getValidFills(fills) {
    if (!Array.isArray(fills)) return [];
    return fills.filter(f => f && typeof f.side === 'string' && f.symbol && f.size && f.price);
  }
  
  initialize() { // No longer async
    this.logger.info(`[BalanceManager] Initializing for session ${this.sessionId}, mode: ${this.tradingMode}`);
    if (this.tradingMode === 'paper') {
      this.logger.debug('[BalanceManager] Paper mode sync initialization complete.');
    } else if (this.tradingMode === 'live') {
      this.logger.info('[BalanceManager] Live mode: Sync initialization. Balance fetch will occur on getBalances.');
    }
    // No promise to return as it's sync
  }
  
  async getBalances(forceRecalculation = false) {
    const now = Date.now();
    if (!forceRecalculation && this.balanceCache && (now - this.balanceCacheTimestamp < this.CACHE_TTL)) {
      this.logger.debug(`[BalanceManager] Returning cached balances for session ${this.sessionId}`);
      return JSON.parse(JSON.stringify(this.balanceCache)); // Return a deep copy
    }
    
    this.logger.debug(`[BalanceManager] ${forceRecalculation ? 'Forcing recalculation' : 'Cache miss/stale'}, calculating balances for session ${this.sessionId}`);
    let calculatedBalances;
    try {
      if (this.tradingMode === 'live' && this.exchangeApi) {
        calculatedBalances = await this._fetchLiveBalances();
      } else {
        calculatedBalances = await this._calculatePaperBalances();
      }
      
      this.balanceCache = JSON.parse(JSON.stringify(calculatedBalances)); // Store a deep copy
      this.balanceCacheTimestamp = now;
      this.logger.info(`[BalanceManager] Calculated and cached balances for session ${this.sessionId}`, { balances: this.balanceCache });
      return calculatedBalances; // Return the original calculated (or fetched live) object
    } catch (error) {
      this.logger.error(`[BalanceManager] CRITICAL error in getBalances: ${error.message}`, { stack: error.stack });
      // Fallback to initial balances in case of critical error to prevent system halt
      return JSON.parse(JSON.stringify(this.initialBalances)); // Return a deep copy of initial
    }
  }
  
  async _fetchLiveBalances() {
    this.logger.debug('[BalanceManager] Fetching live balances from exchange...');
    try {
      const rawBalances = await this.exchangeApi.fetchBalance(); // CCXT-like method
      const liveBalances = {
        [this.quoteCurrency]: {
          total: parseFloat(rawBalances[this.quoteCurrency]?.total || 0),
          available: parseFloat(rawBalances[this.quoteCurrency]?.free || rawBalances[this.quoteCurrency]?.available || 0),
          reserved: parseFloat(rawBalances[this.quoteCurrency]?.used || rawBalances[this.quoteCurrency]?.reserved || 0),
        },
        [this.baseCurrency]: {
          total: parseFloat(rawBalances[this.baseCurrency]?.total || 0),
          available: parseFloat(rawBalances[this.baseCurrency]?.free || rawBalances[this.baseCurrency]?.available || 0),
          reserved: parseFloat(rawBalances[this.baseCurrency]?.used || rawBalances[this.baseCurrency]?.reserved || 0),
        },
      };
      this.logger.info('[BalanceManager] Fetched live balances', { liveBalances: JSON.stringify(liveBalances) });
      return liveBalances;
    } catch (error) {
      this.logger.error(`[BalanceManager] Error fetching live balances: ${error.message}`, { stack: error.stack });
      throw error; // Re-throw to be caught by getBalances and fallback to initial
    }
  }
  
  async _calculatePaperBalances() {
    this.logger.debug('[BalanceManager] Calculating paper balances from initial, orders, and fills...');
    let orders = [];
    let fills = [];
    
    try {
      if (this.orderManager) orders = this._getValidOrders(await this.orderManager.getAll());
      if (this.fillManager) fills = this._getValidFills(await this.fillManager.getAll());
    } catch (error) {
      this.logger.error(`[BalanceManager] Error fetching orders/fills for paper balance calculation: ${error.message}`);
      // In case of error fetching data, return a copy of initial balances as a safe fallback
      return JSON.parse(JSON.stringify(this.initialBalances));
    }
    
    // Start with deep copies of initial balances
    const currentQuote = { ...this.initialBalances[this.quoteCurrency] };
    const currentBase = { ...this.initialBalances[this.baseCurrency] };
    
    // Adjust totals based on fills
    for (const fill of fills) {
      const size = parseFloat(fill.size);
      const price = parseFloat(fill.price);
      const value = size * price;
      
      if (fill.side === 'buy') {
        if (fill.symbol.startsWith(this.baseCurrency)) { // Buying base with quote (e.g., BTC/USD)
          currentBase.total += size;
          currentQuote.total -= value;
        }
      } else if (fill.side === 'sell') {
        if (fill.symbol.startsWith(this.baseCurrency)) { // Selling base for quote
          currentBase.total -= size;
          currentQuote.total += value;
        }
      }
    }
    
    // Reset available and reserved, then recalculate based on open orders and new totals
    currentQuote.available = currentQuote.total;
    currentQuote.reserved = 0;
    currentBase.available = currentBase.total;
    currentBase.reserved = 0;
    
    const openOrders = orders.filter(o => 
        o.status === 'open' || o.status === 'NEW' || o.status === 'new' || 
        o.status === 'partially_filled' || o.status === 'PARTIALLY_FILLED'
    );
    
    for (const order of openOrders) {
      const orderSymbolBase = order.symbol.split('/')[0];
      const orderSymbolQuote = order.symbol.split('/')[1];
      // Ensure remaining is used, fallback to amount if not present or zero
      let remainingAmount = parseFloat(order.remaining);
      if (isNaN(remainingAmount) || remainingAmount <= 0) { // Also check for 0 as it implies no longer open quantity
        remainingAmount = parseFloat(order.amount);
      }
      const orderPrice = parseFloat(order.price);
      
      if (isNaN(remainingAmount) || isNaN(orderPrice) || remainingAmount <= 0) continue;
      
      if (order.side === 'buy') {
        if (orderSymbolQuote === this.quoteCurrency && orderSymbolBase === this.baseCurrency) { // Buying base with quote
          const reservedValue = remainingAmount * orderPrice;
          currentQuote.reserved += reservedValue;
          currentQuote.available -= reservedValue;
        }
      } else if (order.side === 'sell') {
        if (orderSymbolBase === this.baseCurrency && orderSymbolQuote === this.quoteCurrency) { // Selling base for quote
          currentBase.reserved += remainingAmount;
          currentBase.available -= remainingAmount;
        }
      }
    }
    
    const finalBalances = {
      [this.quoteCurrency]: currentQuote,
      [this.baseCurrency]: currentBase,
    };
    
    this.logger.debug('[BalanceManager] Calculated paper balances', { balances: JSON.stringify(finalBalances) });
    return finalBalances;
  }
  
  // --- Balance Update Methods (called after successful operations) ---
  
  async updateBalancesOnOrderCreate(order) {
    if (!order || this.tradingMode === 'live') return; // Live mode relies on exchange for actuals
    this.logger.debug(`[BalanceManager] Updating paper balances on order create: ${order.id}`);
    // For paper trading, creating an order reserves funds.
    // We'll force a full recalculation which considers open orders.
    // More granular updates can be complex to keep perfectly in sync with full recalc.
    await this.getBalances(true); 
  }
  
  async updateBalancesOnOrderCancel(order) {
    if (!order || this.tradingMode === 'live') return;
    this.logger.debug(`[BalanceManager] Updating paper balances on order cancel: ${order.id}`);
    // Cancelling an order frees reserved funds.
    await this.getBalances(true); 
  }
  
  async updateBalancesOnFill(fill) {
    if (!fill || this.tradingMode === 'live') return;
    this.logger.debug(`[BalanceManager] Updating paper balances on fill: ${fill.id}`);
    // A fill changes actual totals and potentially frees some reserved if order is fully/partially closed.
    await this.getBalances(true); 
  }
  
  // --- Utility / Check Methods ---
  
  async checkSufficientBalance(orderData) {
    if (!orderData || !orderData.side || isNaN(parseFloat(orderData.price)) || isNaN(parseFloat(orderData.size))) {
      this.logger.warn('[BalanceManager] Invalid orderData for checkSufficientBalance', { orderData });
      return false;
    }
    
    const currentBalances = await this.getBalances();
    const price = parseFloat(orderData.price);
    const size = parseFloat(orderData.size);
    
    if (orderData.side === 'buy') {
      const requiredQuoteAmount = price * size;
      const availableQuote = currentBalances[this.quoteCurrency]?.available || 0;
      if (availableQuote < requiredQuoteAmount) {
        this.logger.warn(`[BalanceManager] Insufficient ${this.quoteCurrency} for buy order ${orderData.id || 'new'}`, {
          required: requiredQuoteAmount,
          available: availableQuote,
          order: orderData,
        });
        return false;
      }
    } else if (orderData.side === 'sell') {
      const availableBase = currentBalances[this.baseCurrency]?.available || 0;
      if (availableBase < size) {
        this.logger.warn(`[BalanceManager] Insufficient ${this.baseCurrency} for sell order ${orderData.id || 'new'}`, {
          required: size,
          available: availableBase,
          order: orderData,
        });
        return false;
      }
    }
    return true;
  }
  
  clearCache() {
    this.balanceCache = null;
    this.balanceCacheTimestamp = 0;
    this.logger.debug(`[BalanceManager] Balance cache cleared for session ${this.sessionId}`);
  }
  
  // Deprecated methods / older structure - to be removed or refactored if still called externally.
  // The main getBalance() and _calculatePaperBalance() now handle the nested structure.
  
  // The getPositionData method might be useful if P&L or more detailed position info is needed separately.
  // For now, baseAmount is part of the main balance object.
  async getPositionData() {
    const balances = await this.getBalances(); // This will be the nested structure
    // Extract base currency total as net position for simplicity for now.
    // A more advanced position manager would track entry prices, P&L etc.
    return {
      netPosition: balances[this.baseCurrency]?.total || 0,
      baseCurrency: this.baseCurrency,
      quoteCurrency: this.quoteCurrency,
      // Average entry price & P&L would require more sophisticated tracking from fills
      averageEntryPrice: 0, 
      unrealizedPnl: 0,
      realizedPnl: 0, 
    };
  }
}
