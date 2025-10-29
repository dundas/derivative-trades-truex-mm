export class UniversalBudgetLedger {
  constructor(options) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.exchange = options.exchange.toLowerCase(); // 'kraken', 'coinbase', etc.
    this.ttl = options.ttl || 3600; // 1 hour default
    
    // Simple: just one key per exchange
    this.balanceKey = `universal:${this.exchange}:budget:balance`;
    
    this.exchangeApi = options.exchangeApi; // For reconciliation
  }

  /**
   * Initialize with exchange balances (called once on startup)
   */
  async initialize(initialBalances = null) {
    try {
      // Check if already initialized
      const existing = await this.redis.hgetall(this.balanceKey);
      if (Object.keys(existing).length > 0) {
        this.logger.info('[UniversalBudgetLedger] Already initialized', { exchange: this.exchange });
        return true;
      }

      // Fetch from exchange if not provided
      let balances = initialBalances;
      if (!balances && this.exchangeApi) {
        this.logger.info('[UniversalBudgetLedger] Fetching initial balances from exchange', { exchange: this.exchange });
        balances = await this.exchangeApi.getAccountBalance();
      }

      if (!balances) {
        this.logger.warn('[UniversalBudgetLedger] No balances available for initialization');
        return false;
      }

      // Initialize balance key
      const balanceData = {
        ...balances,
        last_updated: Date.now(),
        reconciled_at: Date.now()
      };

      await this.redis.hset(this.balanceKey, balanceData);
      await this.redis.expire(this.balanceKey, this.ttl);

      this.logger.info('[UniversalBudgetLedger] Initialized successfully', {
        exchange: this.exchange,
        currencies: Object.keys(balances),
        balances
      });

      return true;
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Initialization failed', error);
      return false;
    }
  }

  /**
   * Get current balances (fast Redis lookup - the main benefit!)
   */
  async getCurrentBalances() {
    try {
      const balanceData = await this.redis.hgetall(this.balanceKey);
      const balances = {};
      const excludeFields = new Set(['last_updated', 'reconciled_at']);

      for (const [currency, amount] of Object.entries(balanceData)) {
        if (!excludeFields.has(currency)) {
          balances[currency] = parseFloat(amount) || 0;
        }
      }

      return balances;
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Failed to get balances', error);
      return {};
    }
  }

  /**
   * Update balances (called when fills occur)
   */
  async updateBalances(balanceChanges) {
    try {
      const timestamp = Date.now();
      
      // Get current balances
      const currentBalances = await this.getCurrentBalances();
      const updatedBalances = { ...currentBalances };

      // Apply balance changes
      for (const [currency, change] of Object.entries(balanceChanges)) {
        updatedBalances[currency] = (updatedBalances[currency] || 0) + change;
      }

      // Update balance key atomically
      await this.redis.hset(this.balanceKey, {
        ...updatedBalances,
        last_updated: timestamp
      });

      // Reset TTL
      await this.redis.expire(this.balanceKey, this.ttl);

      this.logger.debug('[UniversalBudgetLedger] Balances updated', {
        exchange: this.exchange,
        balanceChanges,
        newBalances: updatedBalances
      });

      return true;
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Failed to update balances', error);
      return false;
    }
  }

  /**
   * Validate balance for operation (the key performance benefit)
   */
  async validateBalance(currency, requiredAmount) {
    try {
      const balances = await this.getCurrentBalances();
      const available = balances[currency] || 0;
      const sufficient = available >= requiredAmount;

      return {
        exchange: this.exchange,
        currency,
        available,
        required: requiredAmount,
        sufficient,
        shortfall: sufficient ? 0 : requiredAmount - available,
        source: 'universal-ledger'
      };
    } catch (error) {
      return {
        exchange: this.exchange,
        currency,
        available: 0,
        required: requiredAmount,
        sufficient: false,
        shortfall: requiredAmount,
        error: error.message
      };
    }
  }

  /**
   * Reconcile with exchange API (called every minute)
   * This is the ONLY place we call the exchange API!
   */
  async reconcileWithExchange() {
    if (!this.exchangeApi) {
      return { success: false, reason: 'No exchange API' };
    }

    try {
      this.logger.debug('[UniversalBudgetLedger] Starting reconciliation', { exchange: this.exchange });
      
      // Fetch fresh balances from exchange
      const exchangeBalances = await this.exchangeApi.getAccountBalance();
      const ledgerBalances = await this.getCurrentBalances();
      
      // Compare balances
      const discrepancies = {};
      let hasDiscrepancies = false;

      for (const [currency, exchangeAmount] of Object.entries(exchangeBalances)) {
        const ledgerAmount = ledgerBalances[currency] || 0;
        const difference = Math.abs(exchangeAmount - ledgerAmount);
        
        if (difference > 0.0001) { // Threshold for floating point precision
          discrepancies[currency] = {
            ledger: ledgerAmount,
            exchange: exchangeAmount,
            difference: exchangeAmount - ledgerAmount
          };
          hasDiscrepancies = true;
        }
      }

      // Update balances to match exchange (source of truth)
      if (hasDiscrepancies) {
        this.logger.warn('[UniversalBudgetLedger] Discrepancies found, updating to exchange values', {
          exchange: this.exchange,
          discrepancies
        });
      }

      // Always update to latest exchange balances
      await this.redis.hset(this.balanceKey, {
        ...exchangeBalances,
        last_updated: Date.now(),
        reconciled_at: Date.now()
      });

      // Reset TTL
      await this.redis.expire(this.balanceKey, this.ttl);

      this.logger.debug('[UniversalBudgetLedger] Reconciliation completed', {
        exchange: this.exchange,
        hasDiscrepancies,
        exchangeBalances
      });

      return {
        success: true,
        hasDiscrepancies,
        discrepancies,
        exchangeBalances,
        ledgerBalances
      };
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Reconciliation failed', { exchange: this.exchange, error });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get balance summary
   */
  async getSummary() {
    try {
      const balances = await this.getCurrentBalances();
      const metadata = await this.redis.hgetall(this.balanceKey);

      return {
        exchange: this.exchange,
        balances,
        lastUpdated: metadata.last_updated ? new Date(parseInt(metadata.last_updated)).toISOString() : null,
        lastReconciled: metadata.reconciled_at ? new Date(parseInt(metadata.reconciled_at)).toISOString() : null
      };
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Failed to get summary', error);
      return { exchange: this.exchange, error: error.message };
    }
  }

  /**
   * Force refresh from exchange (useful for debugging)
   */
  async forceRefresh() {
    this.logger.info('[UniversalBudgetLedger] Force refreshing from exchange', { exchange: this.exchange });
    return await this.reconcileWithExchange();
  }

  /**
   * Clear cached balances (useful for testing)
   */
  async clearCache() {
    try {
      await this.redis.del(this.balanceKey);
      this.logger.info('[UniversalBudgetLedger] Cache cleared', { exchange: this.exchange });
      return true;
    } catch (error) {
      this.logger.error('[UniversalBudgetLedger] Failed to clear cache', error);
      return false;
    }
  }
} 