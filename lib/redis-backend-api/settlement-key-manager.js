/**
 * SettlementKeyManager - Manages Redis keys for settlement reconciliation
 * 
 * Designed for 3-day maximum settlement period with automatic cleanup
 * and optimized key structures for fast settlement lookups.
 * 
 * Key Features:
 * - Time-based key partitioning (daily buckets)
 * - Automatic TTL management (4-day retention + 1 day buffer)
 * - Settlement session tracking
 * - Memory optimization with cleanup policies
 */
export class SettlementKeyManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // TTL settings optimized for 3-day settlement window
    this.TTL = {
      // Core trading data: 4 days (3 days settlement + 1 buffer)
      trades: options.tradesTTL || (4 * 24 * 60 * 60),
      openOrders: options.ordersTTL || (4 * 24 * 60 * 60),  
      closedOrders: options.ordersTTL || (4 * 24 * 60 * 60),
      
      // Reconciliation results: 7 days (audit trail)
      reconciliation: options.reconciliationTTL || (7 * 24 * 60 * 60),
      
      // Session tracking: 1 day (active sessions only)
      activeSessions: options.sessionsTTL || (24 * 60 * 60),
      
      // Settlement status: 4 days
      settlementStatus: options.statusTTL || (4 * 24 * 60 * 60)
    };
    
    this.keyPrefix = options.keyPrefix || 'settlement';
    this.environment = options.environment || 'prod';
  }

  /**
   * Simple logging method consistent with TradeLedgerManager
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  log(level, message, data) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [SettlementKeyManager] [${level.toUpperCase()}] ${message}`;
    
    if (this.logger[level]) {
      this.logger[level](logMessage, data || '');
    } else {
      console.log(logMessage, data || '');
    }
  }

  /**
   * Get date string in YYYY-MM-DD format for key partitioning
   * @param {Date|number} [date] Date object or timestamp (defaults to now)
   * @returns {string} Date string for key partitioning
   */
  getDateKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Generate trade cache key for specific session and date
   * @param {string} sessionId Session identifier
   * @param {Date|number} [date] Date for partitioning (defaults to today)
   * @returns {string} Redis key for trade data
   */
  getTradeKey(sessionId, date = new Date()) {
    const dateKey = this.getDateKey(date);
    return `${this.keyPrefix}:trades:${dateKey}:${sessionId}`;
  }

  /**
   * Generate open orders key for specific session and date
   * @param {string} sessionId Session identifier  
   * @param {Date|number} [date] Date for partitioning (defaults to today)
   * @returns {string} Redis key for open orders
   */
  getOpenOrdersKey(sessionId, date = new Date()) {
    const dateKey = this.getDateKey(date);
    return `${this.keyPrefix}:orders:open:${dateKey}:${sessionId}`;
  }

  /**
   * Generate closed orders key for specific session and date
   * @param {string} sessionId Session identifier
   * @param {Date|number} [date] Date for partitioning (defaults to today)  
   * @returns {string} Redis key for closed orders
   */
  getClosedOrdersKey(sessionId, date = new Date()) {
    const dateKey = this.getDateKey(date);
    return `${this.keyPrefix}:orders:closed:${dateKey}:${sessionId}`;
  }

  /**
   * Generate settlement reconciliation key for specific session and date
   * @param {string} sessionId Session identifier
   * @param {Date|number} [date] Date for partitioning (defaults to today)
   * @returns {string} Redis key for reconciliation results
   */
  getReconciliationKey(sessionId, date = new Date()) {
    const dateKey = this.getDateKey(date);
    return `${this.keyPrefix}:reconciled:${dateKey}:${sessionId}`;
  }

  /**
   * Generate active sessions tracking key for specific date
   * @param {Date|number} [date] Date for partitioning (defaults to today)
   * @returns {string} Redis key for active sessions set
   */
  getActiveSessionsKey(date = new Date()) {
    const dateKey = this.getDateKey(date);
    return `${this.keyPrefix}:active:${dateKey}`;
  }

  /**
   * Generate settlement status key for specific session
   * @param {string} sessionId Session identifier
   * @returns {string} Redis key for settlement status
   */
  getSettlementStatusKey(sessionId) {
    return `${this.keyPrefix}:status:${sessionId}`;
  }

  /**
   * Get all relevant keys for a session across the 3-day settlement window
   * @param {string} sessionId Session identifier
   * @param {Date} [startDate] Start date (defaults to 3 days ago)
   * @param {Date} [endDate] End date (defaults to today)
   * @returns {Object} Object containing arrays of keys for each data type
   */
  getSessionKeysForSettlementWindow(sessionId, startDate, endDate) {
    // Default to 3-day window + today
    const end = endDate || new Date();
    const start = startDate || new Date(end.getTime() - (3 * 24 * 60 * 60 * 1000));
    
    const keys = {
      trades: [],
      openOrders: [],
      closedOrders: [],
      reconciliation: []
    };

    // Generate keys for each day in the settlement window
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      keys.trades.push(this.getTradeKey(sessionId, date));
      keys.openOrders.push(this.getOpenOrdersKey(sessionId, date));
      keys.closedOrders.push(this.getClosedOrdersKey(sessionId, date));
      keys.reconciliation.push(this.getReconciliationKey(sessionId, date));
    }

    return keys;
  }

  /**
   * Get cleanup keys for dates older than retention period
   * @param {Date} [cutoffDate] Date before which keys should be cleaned up
   * @returns {string[]} Array of key patterns for cleanup
   */
  getExpiredKeyPatterns(cutoffDate) {
    const cutoff = cutoffDate || new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)); // 5 days ago
    const cutoffKey = this.getDateKey(cutoff);
    
    return [
      `${this.keyPrefix}:trades:*:*`,
      `${this.keyPrefix}:orders:*:*:*`,
      `${this.keyPrefix}:reconciled:*:*`,
      `${this.keyPrefix}:active:*`
    ].map(pattern => ({ 
      pattern,
      cutoffDate: cutoffKey,
      description: `Keys older than ${cutoffKey}`
    }));
  }

  /**
   * Get TTL value for specific key type
   * @param {string} keyType Type of key ('trades', 'orders', 'reconciliation', etc.)
   * @returns {number} TTL in seconds
   */
  getTTL(keyType) {
    return this.TTL[keyType] || this.TTL.trades; // Default to trades TTL
  }

  /**
   * Generate session summary key for settlement reporting
   * @param {string} sessionId Session identifier
   * @returns {string} Redis key for session summary
   */
  getSessionSummaryKey(sessionId) {
    return `${this.keyPrefix}:summary:${sessionId}`;
  }

  /**
   * Generate batch operation keys for multiple sessions
   * @param {string[]} sessionIds Array of session identifiers
   * @param {Date} [date] Date for partitioning (defaults to today)
   * @returns {Object} Object containing batched keys for each data type
   */
  getBatchKeys(sessionIds, date = new Date()) {
    return {
      trades: sessionIds.map(id => this.getTradeKey(id, date)),
      openOrders: sessionIds.map(id => this.getOpenOrdersKey(id, date)),
      closedOrders: sessionIds.map(id => this.getClosedOrdersKey(id, date)),
      reconciliation: sessionIds.map(id => this.getReconciliationKey(id, date))
    };
  }

  /**
   * Log key usage statistics for monitoring
   * @param {Object} keyStats Statistics object with key counts
   */
  logKeyStatistics(keyStats) {
    this.log('info', 'Settlement key usage statistics', {
      totalKeys: keyStats.total || 0,
      tradeKeys: keyStats.trades || 0,
      orderKeys: keyStats.orders || 0,
      reconciliationKeys: keyStats.reconciliation || 0,
      oldestKey: keyStats.oldestDate,
      newestKey: keyStats.newestDate,
      memoryEstimate: keyStats.memoryMB ? `${keyStats.memoryMB}MB` : 'unknown'
    });
  }
} 