/**
 * Trading Error Manager
 * 
 * Manages trading operation error logging to Redis with focus on errors
 * that require future algorithmic handling (partial fills, budget issues).
 * Follows redis-backend-api patterns for consistent error tracking.
 * 
 * Key Features:
 * - Specialized error categorization for trading operations
 * - Partial fill tracking below minimum thresholds  
 * - Budget insufficiency detection and logging
 * - Take-profit order placement failures
 * - Time-based error tracking with TTL
 * - Session-level and system-level error aggregation
 */

import { SettlementKeyManager } from './settlement-key-manager.js';

export class TradingErrorManager {
  constructor(options = {}) {
    this.redis = options.redis;
    this.logger = options.logger || console;
    this.sessionId = options.sessionId;
    
    if (!this.redis) {
      throw new Error('Redis client is required for TradingErrorManager');
    }
    
    // Initialize settlement key manager for consistent key structure
    this.keyManager = new SettlementKeyManager({
      logger: this.logger,
      keyPrefix: options.keyPrefix || 'trading',
      environment: options.environment || 'prod'
    });
    
    // Error TTL settings (simplified for daily partitioned approach)
    this.TTL = {
      tradingErrors: 7 * 24 * 60 * 60  // 7 days for all trading errors
    };
    
    // Error categories focused on trading operations requiring future algorithmic handling
    this.ERROR_CATEGORIES = {
      // Critical trading operation errors
      PARTIAL_FILL: 'partial_fill',           // Partial fills below minimum threshold
      INSUFFICIENT_BUDGET: 'insufficient_budget', // Not enough capital for orders
      VOLUME_MINIMUM: 'volume_minimum',       // Order volume below exchange minimum
      
      // Take-profit specific errors
      TAKEPROFIT_PLACEMENT: 'takeprofit_placement', // Failed to place take-profit orders
      TAKEPROFIT_PRICING: 'takeprofit_pricing',     // Pricing issues for take-profit
      
      // Exchange and API errors
      EXCHANGE_API: 'exchange_api',           // Kraken/exchange API errors
      ORDER_REJECTION: 'order_rejection',     // Exchange rejected orders
      
      // System and operational errors
      VALIDATION: 'validation',               // Order validation failures
      RECONCILIATION: 'reconciliation',       // Position reconciliation issues
      REDIS: 'redis',                        // Redis/cache errors
      TIMEOUT: 'timeout',                    // Timeout errors
      CONFIGURATION: 'configuration',         // Configuration issues
      SYSTEM: 'system'                       // General system errors
    };
  }
  
  /**
   * Simple logging method consistent with other managers
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  log(level, message, data) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [TradingErrorManager] [${level.toUpperCase()}] ${message}`;
    
    if (this.logger[level]) {
      this.logger[level](logMessage, data || '');
    } else {
      console.log(logMessage, data || '');
    }
  }
  
  /**
   * Get the trading errors key (follows existing session key patterns)
   * @param {Date|number} [date] - Date for partitioning (defaults to today)
   * @returns {string} Redis key for trading errors
   */
  getTradingErrorsKey(date = new Date()) {
    const dateKey = this.keyManager.getDateKey(date);
    return `${this.keyManager.keyPrefix}:errors:${dateKey}`;
  }
  
  /**
   * Log a trading error with proper categorization
   * @param {Object} errorInfo - Error information
   * @param {string} errorInfo.sessionId - Session ID (if session-specific)
   * @param {string} errorInfo.category - Error category
   * @param {string} errorInfo.phase - Trading phase (order_placement, take_profit, settlement)
   * @param {string} errorInfo.message - Error message
   * @param {Object} [errorInfo.details] - Additional error details
   * @param {Error} [errorInfo.originalError] - Original error object
   * @param {Object} [errorInfo.orderData] - Order data if applicable
   * @param {number} [errorInfo.remainingVolume] - Remaining volume for partial fills
   * @returns {Promise<string>} Error ID for tracking
   */
  async logError(errorInfo) {
    const timestamp = Date.now();
    const errorId = `err_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Structure error data with trading-specific fields
    const errorData = {
      id: errorId,
      timestamp,
      sessionId: errorInfo.sessionId || null,
      category: errorInfo.category || this.ERROR_CATEGORIES.SYSTEM,
      phase: errorInfo.phase || 'unknown',
      message: errorInfo.message,
      details: errorInfo.details || {},
      stack: errorInfo.originalError?.stack || null,
      severity: this._determineSeverity(errorInfo.category, errorInfo.message),
      
      // Trading-specific fields
      orderData: errorInfo.orderData || null,
      remainingVolume: errorInfo.remainingVolume || null,
      requiresAlgorithmicHandling: this._requiresAlgorithmicHandling(errorInfo.category)
    };
    
    try {
      // Store error in daily trading errors list
      const tradingErrorsKey = this.getTradingErrorsKey();
      await this.redis.lpush(tradingErrorsKey, JSON.stringify(errorData));
      await this.redis.expire(tradingErrorsKey, this.TTL.tradingErrors); // 7 days
      
      this.log('info', `Trading error logged: ${errorData.category}/${errorData.phase}`, {
        errorId,
        sessionId: errorInfo.sessionId,
        severity: errorData.severity,
        requiresHandling: errorData.requiresAlgorithmicHandling,
        key: tradingErrorsKey
      });
      
      return errorId;
      
    } catch (redisError) {
      this.log('error', 'Failed to log trading error to Redis', {
        errorId,
        redisError: redisError.message,
        originalError: errorInfo.message
      });
      throw redisError;
    }
  }
  
  /**
   * Log multiple errors from trading operations
   * @param {Array} errors - Array of error strings or objects
   * @param {string} phase - Trading phase
   * @param {string} [sessionId] - Session ID if session-specific
   * @returns {Promise<Array>} Array of error IDs
   */
  async logErrorBatch(errors, phase, sessionId = null) {
    const errorIds = [];
    
    for (const error of errors) {
      const errorInfo = {
        sessionId,
        phase,
        category: this._categorizeError(error),
        message: typeof error === 'string' ? error : error.message || String(error),
        details: typeof error === 'object' ? error : {},
        originalError: error instanceof Error ? error : null
      };
      
      try {
        const errorId = await this.logError(errorInfo);
        errorIds.push(errorId);
      } catch (logError) {
        this.log('warn', 'Failed to log individual error in batch', {
          error: errorInfo.message,
          logError: logError.message
        });
      }
    }
    
    return errorIds;
  }
  
  /**
   * Log partial fill error with specific volume details
   * @param {Object} partialFillInfo - Partial fill information
   * @param {string} partialFillInfo.sessionId - Session ID
   * @param {string} partialFillInfo.orderId - Order ID
   * @param {number} partialFillInfo.originalVolume - Original order volume
   * @param {number} partialFillInfo.filledVolume - Volume that was filled
   * @param {number} partialFillInfo.remainingVolume - Remaining volume
   * @param {number} partialFillInfo.minimumVolume - Exchange minimum volume
   * @param {string} partialFillInfo.symbol - Trading symbol
   * @returns {Promise<string>} Error ID
   */
  async logPartialFillError(partialFillInfo) {
    return await this.logError({
      sessionId: partialFillInfo.sessionId,
      category: this.ERROR_CATEGORIES.PARTIAL_FILL,
      phase: 'order_execution',
      message: `Partial fill left ${partialFillInfo.remainingVolume} volume below minimum ${partialFillInfo.minimumVolume}`,
      details: {
        orderId: partialFillInfo.orderId,
        symbol: partialFillInfo.symbol,
        originalVolume: partialFillInfo.originalVolume,
        filledVolume: partialFillInfo.filledVolume,
        minimumVolume: partialFillInfo.minimumVolume,
        belowMinimumBy: partialFillInfo.minimumVolume - partialFillInfo.remainingVolume
      },
      remainingVolume: partialFillInfo.remainingVolume,
      orderData: {
        orderId: partialFillInfo.orderId,
        symbol: partialFillInfo.symbol,
        originalVolume: partialFillInfo.originalVolume
      }
    });
  }
  
  /**
   * Log budget insufficiency error
   * @param {Object} budgetInfo - Budget information
   * @param {string} budgetInfo.sessionId - Session ID
   * @param {number} budgetInfo.requiredAmount - Required amount
   * @param {number} budgetInfo.availableAmount - Available amount
   * @param {string} budgetInfo.currency - Currency
   * @param {string} budgetInfo.operation - Operation type
   * @returns {Promise<string>} Error ID
   */
  async logBudgetError(budgetInfo) {
    return await this.logError({
      sessionId: budgetInfo.sessionId,
      category: this.ERROR_CATEGORIES.INSUFFICIENT_BUDGET,
      phase: 'order_placement',
      message: `Insufficient ${budgetInfo.currency} budget: need ${budgetInfo.requiredAmount}, have ${budgetInfo.availableAmount}`,
      details: {
        requiredAmount: budgetInfo.requiredAmount,
        availableAmount: budgetInfo.availableAmount,
        shortage: budgetInfo.requiredAmount - budgetInfo.availableAmount,
        currency: budgetInfo.currency,
        operation: budgetInfo.operation
      }
    });
  }
  
  /**
   * Get recent trading errors
   * @param {number} [limit=50] - Maximum number of errors to retrieve
   * @param {number} [daysBack=7] - Days to look back
   * @param {string} [sessionId] - Optional session ID filter
   * @returns {Promise<Array>} Array of error objects
   */
  async getTradingErrors(limit = 50, daysBack = 7, sessionId = null) {
    const errors = [];
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (daysBack * 24 * 60 * 60 * 1000));
    
    // Collect errors from each day in the range
    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
      const errorKey = this.getTradingErrorsKey(date);
      
      try {
        const errorStrings = await this.redis.lrange(errorKey, 0, limit - errors.length - 1);
        
        for (const errorString of errorStrings) {
          try {
            const errorData = JSON.parse(errorString);
            
            // Filter by sessionId if provided
            if (sessionId && errorData.sessionId !== sessionId) {
              continue;
            }
            
            errors.push(errorData);
          } catch (parseError) {
            this.log('warn', 'Failed to parse error data', { errorString, parseError: parseError.message });
          }
        }
        
        if (errors.length >= limit) break;
        
      } catch (redisError) {
        this.log('warn', 'Failed to retrieve errors for date', {
          date: this.keyManager.getDateKey(date),
          error: redisError.message
        });
      }
    }
    
    // Sort by timestamp (newest first)
    return errors.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  
  /**
   * Get recent errors for a specific session
   * @param {string} sessionId - Session identifier
   * @param {number} [limit=50] - Maximum number of errors to retrieve
   * @param {number} [daysBack=7] - Days to look back
   * @returns {Promise<Array>} Array of error objects
   */
  async getSessionErrors(sessionId, limit = 50, daysBack = 7) {
    return await this.getTradingErrors(limit, daysBack, sessionId);
  }
  
  /**
   * Get errors that require algorithmic handling
   * @param {string} [sessionId] - Optional session ID filter
   * @param {number} [daysBack=7] - Days to look back
   * @returns {Promise<Array>} Array of errors requiring algorithmic handling
   */
  async getErrorsRequiringHandling(sessionId = null, daysBack = 7) {
    const errors = await this.getTradingErrors(200, daysBack, sessionId);
    return errors.filter(error => error.requiresAlgorithmicHandling);
  }
  
  /**
   * Get error summary statistics (computed from stored errors)
   * @param {number} [daysBack=7] - Days to look back
   * @param {string} [sessionId] - Optional session ID filter
   * @returns {Promise<Object>} Error summary statistics
   */
  async getErrorSummary(daysBack = 7, sessionId = null) {
    const errors = await this.getTradingErrors(1000, daysBack, sessionId); // Get up to 1000 errors
    
    const summary = {
      totalErrors: errors.length,
      byCategory: {},
      byPhase: {},
      bySeverity: {},
      requiresHandling: 0,
      sessionFilter: sessionId || 'all'
    };
    
    // Compute statistics from actual errors
    for (const error of errors) {
      // Count by category
      summary.byCategory[error.category] = (summary.byCategory[error.category] || 0) + 1;
      
      // Count by phase
      summary.byPhase[error.phase] = (summary.byPhase[error.phase] || 0) + 1;
      
      // Count by severity
      summary.bySeverity[error.severity] = (summary.bySeverity[error.severity] || 0) + 1;
      
      // Count requiring handling
      if (error.requiresAlgorithmicHandling) {
        summary.requiresHandling++;
      }
    }
    
    return summary;
  }
  
  /**
   * Categorize error based on message content
   * @param {*} error - Error to categorize
   * @returns {string} Error category
   * @private
   */
  _categorizeError(error) {
    const message = typeof error === 'string' ? error : (error.message || String(error));
    const lowerMessage = message.toLowerCase();
    
    // Prioritize trading-specific errors
    if (lowerMessage.includes('partial') && lowerMessage.includes('fill')) {
      return this.ERROR_CATEGORIES.PARTIAL_FILL;
    }
    if (lowerMessage.includes('insufficient') && (lowerMessage.includes('budget') || lowerMessage.includes('balance') || lowerMessage.includes('funds'))) {
      return this.ERROR_CATEGORIES.INSUFFICIENT_BUDGET;
    }
    if (lowerMessage.includes('minimum') && (lowerMessage.includes('volume') || lowerMessage.includes('size'))) {
      return this.ERROR_CATEGORIES.VOLUME_MINIMUM;
    }
    if (lowerMessage.includes('take-profit') || lowerMessage.includes('takeprofit')) {
      return lowerMessage.includes('pricing') ? 
        this.ERROR_CATEGORIES.TAKEPROFIT_PRICING : 
        this.ERROR_CATEGORIES.TAKEPROFIT_PLACEMENT;
    }
    if (lowerMessage.includes('order') && lowerMessage.includes('reject')) {
      return this.ERROR_CATEGORIES.ORDER_REJECTION;
    }
    if (lowerMessage.includes('kraken') || lowerMessage.includes('exchange') || lowerMessage.includes('api')) {
      return this.ERROR_CATEGORIES.EXCHANGE_API;
    }
    if (lowerMessage.includes('validation') || lowerMessage.includes('invalid')) {
      return this.ERROR_CATEGORIES.VALIDATION;
    }
    if (lowerMessage.includes('reconciliation') || lowerMessage.includes('position')) {
      return this.ERROR_CATEGORIES.RECONCILIATION;
    }
    if (lowerMessage.includes('redis') || lowerMessage.includes('cache')) {
      return this.ERROR_CATEGORIES.REDIS;
    }
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return this.ERROR_CATEGORIES.TIMEOUT;
    }
    if (lowerMessage.includes('config') || lowerMessage.includes('configuration')) {
      return this.ERROR_CATEGORIES.CONFIGURATION;
    }
    
    return this.ERROR_CATEGORIES.SYSTEM;
  }
  
  /**
   * Determine if error requires algorithmic handling
   * @param {string} category - Error category
   * @returns {boolean} Whether error requires algorithmic handling
   * @private
   */
  _requiresAlgorithmicHandling(category) {
    return [
      this.ERROR_CATEGORIES.PARTIAL_FILL,
      this.ERROR_CATEGORIES.INSUFFICIENT_BUDGET,
      this.ERROR_CATEGORIES.VOLUME_MINIMUM,
      this.ERROR_CATEGORIES.TAKEPROFIT_PLACEMENT,
      this.ERROR_CATEGORIES.TAKEPROFIT_PRICING
    ].includes(category);
  }
  
  /**
   * Determine error severity based on category and message
   * @param {string} category - Error category
   * @param {string} message - Error message
   * @returns {string} Severity level
   * @private
   */
  _determineSeverity(category, message) {
    const lowerMessage = message.toLowerCase();
    
    // Critical errors that stop trading operations
    if (lowerMessage.includes('failed to connect') || 
        lowerMessage.includes('redis connection') ||
        lowerMessage.includes('authentication failed')) {
      return 'critical';
    }
    
    // High severity for trading operation errors
    if (category === this.ERROR_CATEGORIES.PARTIAL_FILL ||
        category === this.ERROR_CATEGORIES.INSUFFICIENT_BUDGET ||
        category === this.ERROR_CATEGORIES.VOLUME_MINIMUM ||
        category === this.ERROR_CATEGORIES.EXCHANGE_API ||
        category === this.ERROR_CATEGORIES.ORDER_REJECTION) {
      return 'high';
    }
    
    // Medium severity for take-profit and reconciliation issues
    if (category === this.ERROR_CATEGORIES.TAKEPROFIT_PLACEMENT ||
        category === this.ERROR_CATEGORIES.TAKEPROFIT_PRICING ||
        category === this.ERROR_CATEGORIES.RECONCILIATION ||
        lowerMessage.includes('timeout')) {
      return 'medium';
    }
    
    // Low severity for validation and configuration issues
    return 'low';
  }
  
  /**
   * Clean up old error data beyond retention period (optional - TTL handles automatic cleanup)
   * @param {number} [daysToKeep=7] - Days of data to retain
   * @returns {Promise<Object>} Cleanup results
   */
  async cleanupOldErrors(daysToKeep = 7) {
    const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
    const results = {
      keysScanned: 0,
      keysDeleted: 0,
      errors: []
    };
    
    try {
      // Scan for trading error keys older than cutoff
      const pattern = `${this.keyManager.keyPrefix}:errors:*`;
      const keys = await this.redis.keys(pattern);
      results.keysScanned = keys.length;
      
      for (const key of keys) {
        // Extract date from key: trading:errors:YYYY-MM-DD
        const keyParts = key.split(':');
        const dateStr = keyParts[keyParts.length - 1]; // Last part should be date
        
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const keyDate = new Date(dateStr);
          if (keyDate < cutoffDate) {
            await this.redis.del(key);
            results.keysDeleted++;
          }
        }
      }
      
      this.log('info', 'Trading error cleanup completed', results);
      
    } catch (error) {
      results.errors.push(error.message);
      this.log('error', 'Trading error cleanup failed', { error: error.message });
    }
    
    return results;
  }
} 