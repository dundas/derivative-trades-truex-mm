/**
 * Position Manager - Centralized Position State Management
 * 
 * Provides consistent APIs for identifying trading positions (filled buy orders)
 * and their associated take-profit coverage state across the entire system.
 */

import logger from '../../utils/logger.js';
import { KrakenRESTClient } from '../exchanges/KrakenRESTClient.js';

export class PositionManager {
  constructor(config = {}) {
    this.redis = config.redis;
    this.sessionId = config.sessionId;
    this.logger = config.logger || logger;
    this.keyGenerator = config.keyGenerator;
    this.validationUtils = config.validationUtils;
    
    // Import managers dynamically to avoid circular dependencies
    this.orderManager = null;
    this.fillManager = null;
    
    // Initialize Kraken REST client for getting actual minimum order volumes
    this.krakenClient = new KrakenRESTClient({
      apiKey: config.krakenApiKey || process.env.KRAKEN_API_KEY,
      apiSecret: config.krakenApiSecret || process.env.KRAKEN_API_SECRET,
      logger: this.logger
    });
    
    // Configuration
    this.config = {
      // Position identification criteria
      positionSides: ['buy', 'BUY'],
      sellSides: ['sell', 'SELL'],
      filledStatuses: ['FILLED', 'filled'],
      activeStatuses: ['OPEN', 'open', 'PENDING', 'pending', 'PARTIALLY_FILLED', 'partially_filled'],
      
      // Matching patterns for take-profit orders
      takeProfitPrefixes: ['tp', 'stp'], // tp = take-profit, stp = settlement take-profit
      
      ...config
    };
    
    this.stats = {
      positionsAnalyzed: 0,
      takeProfitsMatched: 0,
      uncoveredPositions: 0,
      errors: 0
    };
  }

  /**
   * Initialize the position manager with required dependencies
   */
  async initialize() {
    try {
      // Dynamic imports to avoid circular dependencies
      const { OrderManager, FillManager } = await import('./index.js');
      
      this.orderManager = new OrderManager({
        redis: this.redis,
        sessionId: this.sessionId,
        logger: this.logger,
        keyGenerator: this.keyGenerator,
        validationUtils: this.validationUtils,
        enableCaching: false
      });
      
      this.fillManager = new FillManager({
        redis: this.redis,
        sessionId: this.sessionId,
        logger: this.logger,
        keyGenerator: this.keyGenerator,
        validationUtils: this.validationUtils,
        enableCaching: false
      });
      
      this.logger.debug('PositionManager initialized successfully');
      
    } catch (error) {
      this.logger.error('Failed to initialize PositionManager:', error);
      throw error;
    }
  }

  /**
   * Get all orders for the session
   * 
   * @returns {Array} Array of order objects
   */
  async getOrders() {
    try {
      this.logger.debug(`Getting all orders for session ${this.sessionId}`);
      
      if (!this.orderManager) {
        await this.initialize();
      }
      
      const orders = await this.orderManager.getAll();
      this.logger.debug(`Found ${orders.length} orders for session ${this.sessionId}`);
      
      return orders;
      
    } catch (error) {
      this.logger.error('Error getting orders:', error);
      throw error;
    }
  }

  /**
   * Get all positions (filled buy orders) for a session
   * 
   * @returns {Array} Array of position objects with standardized format
   */
  async getPositions() {
    try {
      this.logger.debug(`Getting all positions for session ${this.sessionId}`);
      
      // Get fills data first (most reliable when available)
      const fills = await this.fillManager.getAll();
      
      let positions = [];
      
      if (fills && fills.length > 0) {
        this.logger.debug(`Using fills data exclusively: found ${fills.length} fills`);
        
        // Use fills data (most reliable source for actual positions)
        const buyFills = fills.filter(fill => 
          this.config.positionSides.includes(fill.side)
        );
        
        // Group fills by order ID to aggregate partial fills into single positions
        const fillsByOrderId = buyFills.reduce((groups, fill) => {
          const orderId = fill.orderId || fill.internalOrderId || fill.clientOrderId;
          if (!groups[orderId]) {
            groups[orderId] = [];
          }
          groups[orderId].push(fill);
          return groups;
        }, {});
        
        // Create aggregated positions from grouped fills
        positions = Object.entries(fillsByOrderId).map(([orderId, fillsForOrder]) => {
          return this._createAggregatedPositionFromFills(fillsForOrder);
        });
        
      } else {
        this.logger.debug('No fills data found - falling back to orders data');
        
        // FALLBACK: Use orders data to detect filled buy orders as positions
        const allOrders = await this.orderManager.getAll();
        
        // Find filled buy orders
        const filledBuyOrders = allOrders.filter(order => 
          this.config.positionSides.includes(order.side) &&
          this.config.filledStatuses.includes(order.status) &&
          (order.filled > 0 || order.amount > 0 || order.size > 0)
        );
        
        this.logger.debug(`Found ${filledBuyOrders.length} filled buy orders in orders data`);
        
        positions = filledBuyOrders.map(order => this._normalizePositionFromOrder(order));
      }
      
      this.stats.positionsAnalyzed += positions.length;
      
      this.logger.info(`Found ${positions.length} positions for session ${this.sessionId}`);
      
      return positions;
      
    } catch (error) {
      this.logger.error('Error getting positions:', error);
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Get all take-profit orders for the session
   * SIMPLIFIED: Only uses parentOrderId as the single source of truth
   * 
   * @returns {Promise<Array>} Array of take-profit orders
   */
  async getAllTakeProfitOrders() {
    try {
      // Get all orders for the session
      const allOrders = await this.orderManager.getAll();
      
      // SIMPLIFIED: Only use parentOrderId as the filter
      // Any sell order with a parentOrderId is considered a take-profit order
      const takeProfitOrders = allOrders.filter(order => {
        // Must be a sell order
        if (!this.config.sellSides.includes(order.side)) {
          return false;
        }
        
        // ONLY criteria: Must have a parentOrderId (the actual buy order ID)
        const parentId = order.parentOrderId || order.parent_order_id;
        return parentId && parentId !== '';
      });
      
      return takeProfitOrders;
      
    } catch (error) {
      this.logger.error('Failed to get all take-profit orders:', error);
      throw error;
    }
  }

  /**
   * Get take-profit orders for a specific position
   * 
   * @param {string} positionId - Position ID to get take-profits for
   * @returns {Promise<Object>} Take-profit orders categorized by status
   */
  async getPositionTakeProfits(positionId) {
    try {
      const allTakeProfitOrders = await this.getAllTakeProfitOrders();
      
      // Filter by position and categorize by status
      const positionTakeProfits = allTakeProfitOrders.filter(order => {
        const parentId = order.parentOrderId || order.parent_order_id;
        
        // CRITICAL FIX: Only accept orders with the actual buy order ID as parentOrderId
        // NEVER accept "settlement" or any generic identifier as parentOrderId
        return parentId === positionId;
      });
      
      // IMPORTANT: Use orders data for actual executions since sell fills aren't recorded
      const categorized = {
        active: positionTakeProfits.filter(order => 
          this.config.activeStatuses.includes(order.status) && 
          !this.config.filledStatuses.includes(order.status)
        ),
        filled: positionTakeProfits.filter(order => 
          this.config.filledStatuses.includes(order.status)
        ),
        expired: positionTakeProfits.filter(order => 
          ['EXPIRED', 'expired'].includes(order.status)
        ),
        cancelled: positionTakeProfits.filter(order => 
          ['CANCELLED', 'cancelled', 'CANCELED', 'canceled'].includes(order.status)
        )
      };
      
      // Calculate actual filled amounts from orders data (not fills)
      const totalFilledAmount = categorized.filled.reduce((sum, order) => {
        return sum + (order.filled || order.amount || order.size || 0);
      }, 0);
      
      return {
        positionId,
        categorized,
        summary: {
          total: positionTakeProfits.length,
          active: categorized.active.length,
          filled: categorized.filled.length,
          expired: categorized.expired.length,
          cancelled: categorized.cancelled.length,
          totalFilledAmount
        }
      };
      
    } catch (error) {
      this.logger.error(`Failed to get take-profits for position ${positionId}:`, error);
      throw error;
    }
  }

  /**
   * Get position states with hybrid data approach
   * UPDATED: Uses fills for positions, orders for take-profit executions
   */
  async getPositionStates() {
    try {
      const positions = await this.getPositions();
      this.logger.info(`[Position States] Processing ${positions.length} positions`);
      
      const positionStates = await Promise.all(
        positions.map(async (position) => {
          const takeProfits = await this.getPositionTakeProfits(position.id);
          
          // Calculate coverage using ACTUAL filled amounts from orders (not fills)
          const filledAmount = takeProfits.summary.totalFilledAmount;
          const positionSize = position.size || position.amount || 0;
          const remainingSize = Math.max(0, positionSize - filledAmount);
          const coveragePercentage = positionSize > 0 ? (filledAmount / positionSize) * 100 : 0;
          
          // Determine coverage status
          // A position needs coverage if it has no active take-profit orders
          const hasActiveTakeProfits = takeProfits.summary.active > 0;
          
          // Check if position is flagged to skip take-profit creation
          const skipTakeProfit = position.skipTakeProfit || false;
          
          // ENHANCED: Check if position needs additional coverage
          const needsAdditionalCoverage = coveragePercentage < 100 && !hasActiveTakeProfits && !skipTakeProfit;
          
          let coverageStatus = 'uncovered';
          if (skipTakeProfit) {
            coverageStatus = 'skipped_take_profit';
          } else if (coveragePercentage >= 100) {
            coverageStatus = 'fully_covered';
          } else if (coveragePercentage > 0 && hasActiveTakeProfits) {
            coverageStatus = 'partially_covered';
          } else if (hasActiveTakeProfits) {
            coverageStatus = 'partially_covered';
          } else if (coveragePercentage > 0 && needsAdditionalCoverage) {
            // NEW: Under-covered positions (have some coverage but need more)
            coverageStatus = 'under_covered';
          }
          // Position is uncovered only if: coveragePercentage == 0 AND no active take-profits AND not skipped
          
          return {
            position,
            takeProfits,
            coverage: {
              status: coverageStatus,
              filledAmount,
              remainingSize,
              percentage: coveragePercentage,
              needsCoverage: remainingSize > 0 && !hasActiveTakeProfits && !skipTakeProfit,
              hasActiveTakeProfits,
              skipTakeProfit,
              skipReason: skipTakeProfit ? position.skipTakeProfitReason : null
            }
          };
        })
      );
      
      // Generate summary stats
      const summary = {
        totalPositions: positionStates.length,
        fullyCovered: positionStates.filter(p => p.coverage.status === 'fully_covered').length,
        partiallyCovered: positionStates.filter(p => p.coverage.status === 'partially_covered').length,
        uncovered: positionStates.filter(p => p.coverage.status === 'uncovered').length,
        skippedTakeProfit: positionStates.filter(p => p.coverage.status === 'skipped_take_profit').length,
        totalNeedingCoverage: positionStates.filter(p => p.coverage.needsCoverage).length
      };
      
      this.logger.info('[Position States] Summary:', summary);
      
      return {
        positionStates,
        summary,
        dataInfo: {
          positionsSource: 'fills_data',
          takeProfitSource: 'orders_data',
          hybrid: true,
          warning: 'Using hybrid approach: sell fills missing from fills data'
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to get position states:', error);
      throw error;
    }
  }

  /**
   * Get positions that need take-profit coverage
   * 
   * @returns {Array} Array of uncovered position objects
   */
  async getUncoveredPositions() {
    try {
      this.logger.debug(`Finding uncovered positions for session ${this.sessionId}`);
      
      const positionStates = await this.getPositionStates();
      
      // Updated to include all positions that need coverage, not just 'uncovered' status
      // This includes:
      // - 'uncovered': 0% coverage, no active TPs
      // - 'under_covered': partial coverage but no active TPs
      // - Any position where needsCoverage is true
      const uncoveredPositions = positionStates.positionStates.filter(state => 
        state.coverage.needsCoverage === true
      );
      
      this.stats.uncoveredPositions += uncoveredPositions.length;
      
      this.logger.info(`Found ${uncoveredPositions.length} positions needing coverage (includes partial fills)`);
      
      // Log details for debugging
      if (uncoveredPositions.length > 0) {
        this.logger.info('Positions needing coverage:', uncoveredPositions.map(state => ({
          id: state.position.id,
          status: state.coverage.status,
          remainingSize: state.coverage.remainingSize,
          percentage: state.coverage.percentage
        })));
      }
      
      return uncoveredPositions.map(state => ({
        ...state.position,
        coverageState: state.coverage,
        takeProfitOrders: state.takeProfits.categorized
      }));
      
    } catch (error) {
      this.logger.error('Error finding uncovered positions:', error);
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Flag a position to skip take-profit order creation
   * 
   * @param {string} positionId - Position ID to flag
   * @param {string} reason - Reason for skipping take-profit
   * @returns {Promise<boolean>} Success status
   */
  async flagPositionSkipTakeProfit(positionId, reason) {
    try {
      this.logger.info(`Flagging position ${positionId} to skip take-profit: ${reason}`);
      
      // Get all fills using the same method as getPositions()
      const allFills = await this.fillManager.getAll();
      
      // Find the fill that represents this position
      for (const fill of allFills) {
        // Check if this fill matches the position ID
        if (fill.orderId === positionId || fill.id === positionId || fill.internalOrderId === positionId) {
          // Add the skip flags
          fill.skipTakeProfit = true;
          fill.skipTakeProfitReason = reason;
          fill.skipTakeProfitTimestamp = Date.now();
          
          // Save the updated fill back using fillManager
          await this.fillManager.update(fill);
          
          this.logger.info(`Successfully flagged position ${positionId} to skip take-profit`);
          return true;
        }
      }
      
      this.logger.warn(`Position ${positionId} not found in fills data, cannot flag for skip take-profit`);
      return false;
      
    } catch (error) {
      this.logger.error(`Failed to flag position ${positionId} for skip take-profit:`, error);
      return false;
    }
  }

  /**
   * Check if a position volume meets minimum order requirements
   * Uses actual Kraken API minimum order volume instead of hardcoded values
   * 
   * @param {Object} position - Position object with symbol/pair information
   * @param {number} [fallbackMinimum] - Fallback minimum if API call fails
   * @returns {Promise<Object>} Validation result with actual exchange requirements
   */
  async validatePositionVolume(position, fallbackMinimum = 0.002) {
    const positionSize = position.size || position.amount || 0;
    let minimumOrderVolume = fallbackMinimum;
    let dataSource = 'fallback';
    
    try {
      // Extract trading pair from position
      const symbol = position.symbol || position.pair;
      if (!symbol) {
        this.logger.warn('No symbol found in position, using fallback minimum', { position });
        throw new Error('No symbol found in position');
      }
      
      // Get actual minimum order volume from Kraken API
      const precisionData = await this.krakenClient.getPairPrecision(symbol);
      const pairInfo = precisionData[symbol];
      
      if (pairInfo && typeof pairInfo.orderMin === 'number' && pairInfo.orderMin > 0) {
        minimumOrderVolume = pairInfo.orderMin;
        dataSource = 'kraken_api';
        
        this.logger.debug(`Using live Kraken minimum order volume for ${symbol}:`, {
          symbol,
          minimumOrderVolume,
          positionSize,
          krakenPair: pairInfo.krakenPair
        });
      } else {
        this.logger.warn(`No valid minimum order volume found for ${symbol}, using fallback`, {
          symbol,
          pairInfo,
          fallbackMinimum
        });
        throw new Error(`No valid minimum order volume found for ${symbol}`);
      }
      
    } catch (error) {
      this.logger.warn(`Failed to get live minimum order volume, using fallback:`, {
        error: error.message,
        symbol: position.symbol || position.pair,
        fallbackMinimum,
        positionSize
      });
      minimumOrderVolume = fallbackMinimum;
      dataSource = 'fallback';
    }
    
    // Use exact comparison - no safety margins for precision trading
    if (positionSize <= minimumOrderVolume) {
      return {
        isValid: false,
        reason: 'position_size_below_or_equal_minimum',
        details: {
          positionSize,
          minimumRequired: minimumOrderVolume,
          deficit: minimumOrderVolume - positionSize,
          comparison: 'exact_minimum_required',
          dataSource,
          symbol: position.symbol || position.pair
        }
      };
    }
    
    return {
      isValid: true,
      reason: 'position_size_above_minimum',
      details: {
        positionSize,
        minimumRequired: minimumOrderVolume,
        excess: positionSize - minimumOrderVolume,
        dataSource,
        symbol: position.symbol || position.pair
      }
    };
  }

  /**
   * Get summary statistics with data source transparency
   * UPDATED: Documents hybrid approach and data limitations
   */
  async getPositionSummary() {
    try {
      const [positions, positionStates] = await Promise.all([
        this.getPositions(),
        this.getPositionStates()
      ]);
      
      const totalPositionValue = positions.reduce((sum, position) => {
        const size = position.size || position.amount || 0;
        const price = position.avgPrice || position.price || 0;
        return sum + (size * price);
      }, 0);
      
      // Calculate actual profit from executed take-profits (using orders data)
      let totalRealizedProfit = 0;
      for (const state of positionStates.positionStates) {
        const positionPrice = state.position.avgPrice || state.position.price || 0;
        const positionCost = (state.position.size || 0) * positionPrice;
        
        // Calculate profit from filled take-profits using orders data
        const filledTakeProfits = state.takeProfits.categorized.filled;
        const realizeedRevenue = filledTakeProfits.reduce((sum, order) => {
          const filledAmount = order.filled || order.amount || order.size || 0;
          const avgPrice = order.avgFillPrice || order.price || 0;
          return sum + (filledAmount * avgPrice);
        }, 0);
        
        // Calculate proportional cost for filled amount
        const filledAmount = state.takeProfits.summary.totalFilledAmount;
        const positionSize = state.position.size || state.position.amount || 0;
        const proportionalCost = positionSize > 0 ? (filledAmount / positionSize) * positionCost : 0;
        
        totalRealizedProfit += Math.max(0, realizeedRevenue - proportionalCost);
      }
      
      return {
        positions: {
          count: positions.length,
          totalValue: totalPositionValue,
          averageSize: positions.length > 0 ? 
            positions.reduce((sum, p) => sum + (p.size || p.amount || 0), 0) / positions.length : 0
        },
        coverage: positionStates.summary,
        profitability: {
          totalRealizedProfit,
          profitablePositions: positionStates.positionStates.filter(p => {
            const filled = p.takeProfits.categorized.filled;
            return filled.length > 0;
          }).length
        },
        dataIntegrity: {
          positionsFromFills: true,
          takeProfitsFromOrders: true,
          sellFillsMissing: true,
          hybridApproach: true,
          warning: 'Sell executions tracked via orders data due to missing sell fills'
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to generate position summary:', error);
      throw error;
    }
  }

  /**
   * Create aggregated position from multiple fills (handles partial fills)
   * 
   * @private
   */
  _createAggregatedPositionFromFills(fills) {
    if (!fills || fills.length === 0) {
      throw new Error('Cannot create position from empty fills array');
    }
    
    // CRITICAL FIX: Deduplicate fills by unique identifiers (execId or tradeId)
    // This prevents duplicate fills from inflating position sizes
    const uniqueFills = fills.reduce((unique, fill) => {
      const key = fill.execId || fill.tradeId || fill.id;
      if (!unique.has(key)) {
        unique.set(key, fill);
      } else {
        this.logger.warn(`Duplicate fill detected and skipped: ${key}`);
      }
      return unique;
    }, new Map());
    
    const deduplicatedFills = Array.from(uniqueFills.values());
    
    if (deduplicatedFills.length !== fills.length) {
      this.logger.warn(`Position deduplication: ${fills.length} fills reduced to ${deduplicatedFills.length} unique fills`);
    }
    
    // Use first fill as template
    const firstFill = deduplicatedFills[0];
    
    // Aggregate quantities and calculate weighted average price using deduplicated fills
    const totalQuantity = deduplicatedFills.reduce((sum, fill) => sum + (fill.size || fill.amount || 0), 0);
    const totalCost = deduplicatedFills.reduce((sum, fill) => sum + (fill.cost || (fill.size || fill.amount || 0) * fill.price), 0);
    const avgPrice = totalQuantity > 0 ? totalCost / totalQuantity : firstFill.price;
    
    // Aggregate fees
    const totalFeeAmount = deduplicatedFills.reduce((sum, fill) => sum + (fill.feeAmount || 0), 0);
    const allFees = deduplicatedFills.flatMap(fill => fill.fees || []);
    
    // Use earliest timestamp as position creation time
    const earliestTimestamp = Math.min(...deduplicatedFills.map(fill => fill.timestamp || Date.now()));
    
    return {
      id: firstFill.internalOrderId || firstFill.orderId || firstFill.clientOrderId,
      internalId: firstFill.internalOrderId,
      clientOrderId: firstFill.clientOrderId,
      exchangeOrderId: firstFill.exchangeOrderId,
      side: firstFill.side,
      price: avgPrice,
      avgPrice: avgPrice,
      avgFillPrice: avgPrice,
      amount: totalQuantity,
      size: totalQuantity,
      filled: totalQuantity,
      timestamp: earliestTimestamp,
      filledAt: earliestTimestamp,
      createdAt: earliestTimestamp,
      symbol: firstFill.symbol,
      fees: allFees,
      feeAmount: totalFeeAmount,
      status: 'FILLED',
      dataSource: 'fill',
      fillCount: fills.length,
      aggregatedFrom: fills.map(f => ({ id: f.id, quantity: f.size || f.amount, price: f.price }))
    };
  }

  /**
   * Normalize position data from fill object (preferred when available)
   * 
   * @private
   */
  _normalizePositionFromFill(fill) {
    return {
      id: fill.internalOrderId || fill.orderId || fill.id,
      internalId: fill.internalOrderId,
      clientOrderId: fill.clientOrderId,
      exchangeOrderId: fill.exchangeOrderId,
      side: fill.side,
      price: fill.price,
      avgPrice: fill.avgPrice || fill.avgFillPrice || fill.price,
      avgFillPrice: fill.avgFillPrice || fill.avgPrice || fill.price,
      amount: fill.amount || fill.size,
      size: fill.size || fill.amount,
      filled: fill.filled || fill.size || fill.amount,
      timestamp: fill.timestamp || fill.filledAt,
      filledAt: fill.filledAt || fill.timestamp,
      createdAt: fill.createdAt || fill.timestamp,
      symbol: fill.symbol,
      fees: fill.fees || [],
      feeAmount: fill.feeAmount || 0,
      status: 'FILLED', // Fills are by definition filled
      dataSource: 'fill'
    };
  }

  /**
   * Normalize position data from order object (fallback when fills missing)
   * 
   * @private
   */
  _normalizePositionFromOrder(order) {
    return {
      id: order.id,
      internalId: order.internalId,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      side: order.side,
      price: order.price,
      avgPrice: order.avgFillPrice || order.price,
      avgFillPrice: order.avgFillPrice || order.price,
      amount: order.filled || order.amount || order.size,
      size: order.filled || order.size || order.amount,
      filled: order.filled || order.amount || order.size,
      timestamp: order.timestamp || order.createdAt,
      filledAt: order.timestamp || order.createdAt,
      createdAt: order.createdAt || order.timestamp,
      symbol: order.symbol,
      fees: order.fees || [],
      feeAmount: order.feeAmount || 0,
      status: order.status,
      dataSource: 'order'
    };
  }

  /**
   * Get manager statistics
   */
  getStats() {
    return {
      ...this.stats,
      sessionId: this.sessionId
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      positionsAnalyzed: 0,
      takeProfitsMatched: 0,
      uncoveredPositions: 0,
      errors: 0
    };
  }

  /**
   * Get detailed information about a specific position
   * 
   * @param {string} positionId - Position ID to get details for
   * @returns {Promise<Object>} Position details object
   */
  async _getPositionDetails(positionId) {
    try {
      // Get all positions using the standard getPositions method
      const allPositions = await this.getPositions();
      
      // Find the specific position
      const position = allPositions.find(p => p.id === positionId);
      
      if (!position) {
        this.logger.warn(`Position ${positionId} not found in ${allPositions.length} positions`);
        return null;
      }
      
      // Return position with additional metadata
      return {
        ...position,
        detailsRetrievedAt: Date.now()
      };
      
    } catch (error) {
      this.logger.error(`Failed to get position details for ${positionId}:`, error);
      return null;
    }
  }

  /**
   * Create a fill record with order ID standardization compliance and duplicate prevention
   * 
   * @param {Object} fillData - Fill data from exchange or WebSocket
   * @param {Object} orderData - Associated order data
   * @param {Object} options - Additional options
   * @param {string} options.source - Source of fill: 'websocket', 'reconciliation', 'exchange_api'
   * @param {Array} options.krakenTrades - Kraken trade IDs (for reconciliation)
   * @param {number} options.krakenClosetm - Kraken close timestamp
   * @returns {Promise<Object>} Result object with success status and created fills
   */
  async createFillRecord(fillData, orderData, options = {}) {
    try {
      const { source = 'websocket', krakenTrades = [], krakenClosetm = null } = options;
      
      this.logger.debug(`Creating fill record for order ${orderData.id} from ${source}`);
      
      // VALIDATION: Verify order ID structure follows standardization
      const isStandardCompliant = orderData.id === orderData.exchangeOrderId;
      const isLegacyPattern = orderData.id === orderData.internalId || orderData.id === orderData.clientOrderId;
      
      this.logger.debug(`Order ID structure validation for ${orderData.id}:`, {
        primaryId: orderData.id,
        internalId: orderData.internalId,
        clientOrderId: orderData.clientOrderId,
        exchangeOrderId: orderData.exchangeOrderId,
        standardCompliant: isStandardCompliant,
        legacyPattern: isLegacyPattern,
        transitionPeriod: !isStandardCompliant && isLegacyPattern
      });

      // DUPLICATE PREVENTION: Check existing fills for this order
      // Handle both standardized and legacy order ID patterns during transition
      const existingFills = await this.fillManager.getAll();
      const orderFills = existingFills.filter(fill => {
        if (isStandardCompliant) {
          // NEW PATTERN: order.id is exchange ID, order.internalId is internal ID
          return fill.orderId === orderData.id ||                    // Match by exchange order ID (primary)
                 fill.internalOrderId === orderData.internalId ||    // Match by internal order ID
                 fill.orderId === orderData.exchangeOrderId ||       // Redundant but safe
                 fill.internalOrderId === orderData.clientOrderId;   // Additional fallback
        } else {
          // LEGACY PATTERN: order.id is internal ID, order.exchangeOrderId is exchange ID
          return fill.orderId === orderData.exchangeOrderId ||       // Match by exchange order ID 
                 fill.internalOrderId === orderData.id ||            // Match by internal order ID
                 fill.orderId === orderData.id ||                    // Match by legacy primary ID
                 fill.internalOrderId === orderData.clientOrderId;   // Additional fallback
        }
      });
      
      this.logger.debug(`Found ${orderFills.length} existing fills for order ${orderData.id} (transition-aware)`);

      // Determine fill timestamp - prefer exchange timestamp over local timestamp
      let fillTimestamp = fillData.timestamp || Date.now();
      if (krakenClosetm) {
        fillTimestamp = krakenClosetm * 1000; // Convert to milliseconds
        this.logger.debug(`Using Kraken closetm for fill timestamp: ${fillTimestamp} (${new Date(fillTimestamp).toISOString()})`);
      } else if (fillData.fillTimestamp) {
        fillTimestamp = fillData.fillTimestamp;
      } else if (fillData.timestamp) {
        fillTimestamp = fillData.timestamp;
      }

      // Handle both standardized and legacy order ID patterns for fill creation
      const fillOrderId = isStandardCompliant ? orderData.id : orderData.exchangeOrderId;
      const fillInternalOrderId = isStandardCompliant ? orderData.internalId : orderData.id;

      let fillsCreated = 0;
      let fillsSkipped = 0;
      const createdFills = [];

      // Handle different fill data sources
      if (source === 'reconciliation' && krakenTrades.length > 0) {
        // RECONCILIATION: Create fills from Kraken trade data
        const filledAmount = parseFloat(fillData.filledAmount || fillData.size || fillData.quantity) || 0;
        const totalCost = parseFloat(fillData.cost || fillData.totalCost) || 0;
        const fillPrice = filledAmount > 0 ? totalCost / filledAmount : (fillData.price || 0);
        const feeAmount = parseFloat(fillData.fee || fillData.feeAmount) || 0;

        // Create fill records for each trade ID
        for (let i = 0; i < krakenTrades.length; i++) {
          const tradeId = krakenTrades[i];

          // DUPLICATE CHECK: Skip if fill already exists for this trade
          const existingFillForTrade = orderFills.find(fill => 
            fill.tradeId === tradeId || 
            fill.id?.includes(tradeId)
          );
          
          if (existingFillForTrade) {
            this.logger.debug(`Skipping duplicate fill for trade ${tradeId} - already exists: ${existingFillForTrade.id}`);
            fillsSkipped++;
            continue;
          }

          // Calculate per-trade amounts (split evenly across trades)
          const tradeQuantity = filledAmount / krakenTrades.length;
          const tradeCost = totalCost / krakenTrades.length;
          const tradeFee = feeAmount / krakenTrades.length;

          // STABLE ID: Use deterministic ID instead of timestamp-based
          const fillId = `${orderData.id}-reconciled-${tradeId}`;
          
          const fillRecord = {
            id: fillId,
            orderId: fillOrderId, // Always use exchange order ID for proper linking
            internalOrderId: fillInternalOrderId, // Use appropriate internal ID based on pattern
            tradeId: tradeId,
            symbol: orderData.symbol,
            side: orderData.side,
            quantity: tradeQuantity,
            size: tradeQuantity, // Add size field for compatibility
            price: fillPrice,
            cost: tradeCost,
            fees: [{ currency: 'USD', amount: tradeFee }],
            feeAmount: tradeFee,
            timestamp: fillTimestamp,
            sessionId: this.sessionId,
            reconciled: true,
            source: 'reconciliation',
            // Add additional fields that settlement service might expect
            exchange: 'kraken',
            status: 'filled',
            // Store Kraken's original timestamp for reference
            krakenClosetm: krakenClosetm,
            // Add transition metadata for debugging
            orderIdPattern: isStandardCompliant ? 'standard' : 'legacy'
          };

          // Add the fill using FillManager
          const createdFill = await this.fillManager.add(fillRecord);
          createdFills.push(createdFill);
          fillsCreated++;
          
          this.logger.info(`Created reconciled fill record: ${fillRecord.id}`, {
            orderId: orderData.id,
            fillRecordOrderId: fillRecord.orderId,
            quantity: fillRecord.quantity,
            price: fillRecord.price,
            cost: fillRecord.cost,
            tradeId,
            orderIdPattern: fillRecord.orderIdPattern
          });
        }
        
      } else {
        // WEBSOCKET/EXCHANGE_API: Create single fill record
        const fillQuantity = parseFloat(fillData.quantity || fillData.size || fillData.amount) || 0;
        const fillPrice = parseFloat(fillData.price) || 0;
        const fillCost = fillQuantity * fillPrice;
        const fillFee = parseFloat(fillData.fee || fillData.feeAmount) || 0;
        
        // Generate deterministic fill ID
        const fillId = fillData.id || fillData.fillId || `${orderData.id}-${source}-${Date.now()}`;
        
        // DUPLICATE CHECK: Skip if fill already exists
        const existingFillForId = orderFills.find(fill => 
          fill.id === fillId || 
          fill.exchangeFillId === fillId ||
          (fillData.exchangeFillId && fill.exchangeFillId === fillData.exchangeFillId)
        );
        
        if (existingFillForId) {
          this.logger.debug(`Skipping duplicate fill ${fillId} - already exists: ${existingFillForId.id}`);
          fillsSkipped++;
        } else {
          const fillRecord = {
            id: fillId,
            orderId: fillOrderId, // Always use exchange order ID for proper linking
            internalOrderId: fillInternalOrderId, // Use appropriate internal ID based on pattern
            exchangeFillId: fillData.exchangeFillId || fillData.id,
            symbol: orderData.symbol,
            side: orderData.side,
            quantity: fillQuantity,
            size: fillQuantity,
            price: fillPrice,
            cost: fillCost,
            fees: fillData.fees || [{ currency: 'USD', amount: fillFee }],
            feeAmount: fillFee,
            timestamp: fillTimestamp,
            sessionId: this.sessionId,
            reconciled: false,
            source: source,
            exchange: 'kraken',
            status: 'filled',
            // Add transition metadata for debugging
            orderIdPattern: isStandardCompliant ? 'standard' : 'legacy'
          };

          // Add the fill using FillManager
          const createdFill = await this.fillManager.add(fillRecord);
          createdFills.push(createdFill);
          fillsCreated++;
          
          this.logger.info(`Created ${source} fill record: ${fillRecord.id}`, {
            orderId: orderData.id,
            fillRecordOrderId: fillRecord.orderId,
            quantity: fillRecord.quantity,
            price: fillRecord.price,
            cost: fillRecord.cost,
            source: source,
            orderIdPattern: fillRecord.orderIdPattern
          });
        }
      }
      
      // Log summary
      if (fillsCreated > 0 || fillsSkipped > 0) {
        this.logger.info(`Fill creation summary for order ${orderData.id}: Created ${fillsCreated}, Skipped ${fillsSkipped} duplicates`);
      }
      
      return {
        success: true,
        fillsCreated,
        fillsSkipped,
        createdFills,
        source,
        orderIdPattern: isStandardCompliant ? 'standard' : 'legacy'
      };
      
    } catch (error) {
      this.logger.error(`Failed to create fill record for order ${orderData?.id}:`, error);
      return {
        success: false,
        error: error.message,
        fillsCreated: 0,
        fillsSkipped: 0,
        createdFills: []
      };
    }
  }

  /**
   * Create fill record from WebSocket data
   * 
   * @param {Object} webSocketFillData - Fill data from WebSocket
   * @param {Object} orderData - Associated order data
   * @returns {Promise<Object>} Result object
   */
  async createFillFromWebSocket(webSocketFillData, orderData) {
    return this.createFillRecord(webSocketFillData, orderData, {
      source: 'websocket'
    });
  }

  /**
   * Create fill record from exchange API data
   * 
   * @param {Object} exchangeFillData - Fill data from exchange API
   * @param {Object} orderData - Associated order data
   * @returns {Promise<Object>} Result object
   */
  async createFillFromExchangeApi(exchangeFillData, orderData) {
    return this.createFillRecord(exchangeFillData, orderData, {
      source: 'exchange_api'
    });
  }

  /**
   * Create fill record from reconciliation (Kraken order data)
   * 
   * @param {Object} orderData - Our order data
   * @param {Object} krakenOrderData - Kraken order data with trades
   * @returns {Promise<Object>} Result object
   */
  async createFillFromReconciliation(orderData, krakenOrderData) {
    if (!krakenOrderData.trades || krakenOrderData.trades.length === 0) {
      this.logger.warn(`No trades found for filled order ${orderData.id}`);
      return {
        success: false,
        error: 'No trades found',
        fillsCreated: 0,
        fillsSkipped: 0,
        createdFills: []
      };
    }

    // Extract fill data from Kraken order
    const filledAmount = parseFloat(krakenOrderData.vol_exec) || 0;
    const totalCost = parseFloat(krakenOrderData.cost) || 0;
    const feeAmount = parseFloat(krakenOrderData.fee) || 0;
    const fillPrice = filledAmount > 0 ? totalCost / filledAmount : 0;

    const fillData = {
      filledAmount,
      totalCost,
      feeAmount,
      price: fillPrice,
      size: filledAmount,
      quantity: filledAmount,
      cost: totalCost,
      fee: feeAmount
    };

    return this.createFillRecord(fillData, orderData, {
      source: 'reconciliation',
      krakenTrades: krakenOrderData.trades,
      krakenClosetm: krakenOrderData.closetm
    });
  }

  /**
   * Calculate comprehensive position balances for a specific position
   * Tracks position size, take-profit fills, and open take-profit orders
   * 
   * @param {string} positionId - Position ID to calculate balances for
   * @returns {Promise<Object>} Detailed balance information
   */
  async calculatePositionBalances(positionId) {
    try {
      this.logger.debug(`Calculating balances for position ${positionId}`);
      
      // Get position details
      const positions = await this.getPositions();
      const position = positions.find(p => p.id === positionId);
      
      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }
      
      // Get take-profit orders for this position
      const takeProfits = await this.getPositionTakeProfits(positionId);
      
      // Calculate position balances
      const positionSize = position.size || position.amount || 0;
      const positionBalances = {
        total: positionSize,
        filled: positionSize, // Positions are by definition filled
        remaining: positionSize, // Available for take-profit coverage
        dataSource: position.dataSource || 'unknown'
      };
      
      // Calculate take-profit balances from orders (most accurate for sells)
      const takeProfitOrdersTotal = takeProfits.categorized.active.reduce((sum, order) => {
        return sum + (order.amount || order.size || 0);
      }, 0);
      
      const takeProfitOrdersFilled = takeProfits.categorized.filled.reduce((sum, order) => {
        return sum + (order.filled || order.amount || order.size || 0);
      }, 0);
      
      const takeProfitOrdersOpen = takeProfitOrdersTotal;
      
      // Try to get take-profit fills data (if available)
      let takeProfitFillsTotal = 0;
      let takeProfitFillsDataSource = 'none';
      
      try {
        const allFills = await this.fillManager.getAll();
        const takeProfitFills = allFills.filter(fill => 
          this.config.sellSides.includes(fill.side) &&
          (fill.orderId === positionId || fill.internalOrderId === positionId)
        );
        
        takeProfitFillsTotal = takeProfitFills.reduce((sum, fill) => {
          return sum + (fill.quantity || fill.size || fill.amount || 0);
        }, 0);
        
        takeProfitFillsDataSource = takeProfitFills.length > 0 ? 'fills' : 'none';
        
      } catch (error) {
        this.logger.debug(`Could not get take-profit fills for ${positionId}:`, error.message);
      }
      
      // Take-profit balances - prefer fills data if available, otherwise use orders
      const useFillsForTakeProfits = takeProfitFillsTotal > 0;
      const takeProfitBalances = {
        total: takeProfitOrdersTotal + takeProfitOrdersFilled,
        filled: useFillsForTakeProfits ? takeProfitFillsTotal : takeProfitOrdersFilled,
        open: takeProfitOrdersOpen,
        dataSource: useFillsForTakeProfits ? 'fills' : 'orders'
      };
      
      // Balance analysis
      const uncoveredAmount = Math.max(0, positionSize - takeProfitBalances.total);
      const oversoldAmount = Math.max(0, takeProfitBalances.total - positionSize);
      const coveragePercentage = positionSize > 0 ? (takeProfitBalances.total / positionSize) * 100 : 0;
      
      const analysis = {
        uncovered: uncoveredAmount,
        oversold: oversoldAmount,
        coveragePercentage: Math.round(coveragePercentage * 100) / 100,
        isOversold: oversoldAmount > 0,
        isFullyCovered: coveragePercentage >= 100,
        isUncovered: uncoveredAmount > 0,
        hasOpenTakeProfits: takeProfitBalances.open > 0,
        hasFilledTakeProfits: takeProfitBalances.filled > 0
      };
      
      return {
        positionId,
        position: positionBalances,
        takeProfits: takeProfitBalances,
        analysis,
        timestamp: Date.now()
      };
      
    } catch (error) {
      this.logger.error(`Failed to calculate balances for position ${positionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Calculate balances for all positions in the session
   * 
   * @returns {Promise<Object>} All position balances with summary
   */
  async calculateAllPositionBalances() {
    try {
      this.logger.debug(`Calculating balances for all positions in session ${this.sessionId}`);
      
      const positions = await this.getPositions();
      const balances = await Promise.all(
        positions.map(position => this.calculatePositionBalances(position.id))
      );
      
      // Calculate session-wide summary
      const summary = {
        totalPositions: balances.length,
        totalPositionSize: balances.reduce((sum, b) => sum + b.position.total, 0),
        totalTakeProfitOpen: balances.reduce((sum, b) => sum + b.takeProfits.open, 0),
        totalTakeProfitFilled: balances.reduce((sum, b) => sum + b.takeProfits.filled, 0),
        totalUncovered: balances.reduce((sum, b) => sum + b.analysis.uncovered, 0),
        totalOversold: balances.reduce((sum, b) => sum + b.analysis.oversold, 0),
        
        // Position states
        fullyCoveredCount: balances.filter(b => b.analysis.isFullyCovered).length,
        uncoveredCount: balances.filter(b => b.analysis.isUncovered).length,
        oversoldCount: balances.filter(b => b.analysis.isOversold).length,
        
        // Coverage statistics
        averageCoverage: balances.length > 0 ? 
          balances.reduce((sum, b) => sum + b.analysis.coveragePercentage, 0) / balances.length : 0,
        
        // Data source breakdown
        positionDataSources: this._summarizeDataSources(balances, 'position'),
        takeProfitDataSources: this._summarizeDataSources(balances, 'takeProfits')
      };
      
      this.logger.info(`Session ${this.sessionId} balance summary:`, {
        totalPositions: summary.totalPositions,
        totalPositionSize: summary.totalPositionSize,
        totalUncovered: summary.totalUncovered,
        totalOversold: summary.totalOversold,
        averageCoverage: Math.round(summary.averageCoverage * 100) / 100 + '%'
      });
      
      return {
        sessionId: this.sessionId,
        balances,
        summary,
        timestamp: Date.now()
      };
      
    } catch (error) {
      this.logger.error('Failed to calculate all position balances:', error);
      throw error;
    }
  }
  
  /**
   * Get positions with balance information included
   * Enhanced version of getPositionStates with detailed balance tracking
   * 
   * @returns {Promise<Object>} Position states with balance information
   */
  async getPositionStatesWithBalances() {
    try {
      this.logger.debug(`Getting position states with balances for session ${this.sessionId}`);
      
      const positions = await this.getPositions();
      const positionStatesWithBalances = await Promise.all(
        positions.map(async (position) => {
          const balances = await this.calculatePositionBalances(position.id);
          const takeProfits = await this.getPositionTakeProfits(position.id);
          
          // Enhanced coverage analysis using balance data
          const coverageStatus = this._determineCoverageStatus(balances, position);
          
          return {
            position,
            balances,
            takeProfits,
            coverage: {
              status: coverageStatus,
              filledAmount: balances.takeProfits.filled,
              openAmount: balances.takeProfits.open,
              remainingSize: balances.analysis.uncovered,
              percentage: balances.analysis.coveragePercentage,
              needsCoverage: balances.analysis.isUncovered && !balances.analysis.hasOpenTakeProfits,
              isOversold: balances.analysis.isOversold,
              hasActiveTakeProfits: balances.analysis.hasOpenTakeProfits,
              hasFilledTakeProfits: balances.analysis.hasFilledTakeProfits
            }
          };
        })
      );
      
      // Enhanced summary with balance information
      const summary = {
        totalPositions: positionStatesWithBalances.length,
        fullyCovered: positionStatesWithBalances.filter(p => p.coverage.status === 'fully_covered').length,
        partiallyCovered: positionStatesWithBalances.filter(p => p.coverage.status === 'partially_covered').length,
        uncovered: positionStatesWithBalances.filter(p => p.coverage.status === 'uncovered').length,
        oversold: positionStatesWithBalances.filter(p => p.coverage.isOversold).length,
        totalNeedingCoverage: positionStatesWithBalances.filter(p => p.coverage.needsCoverage).length,
        
        // Balance totals
        totalPositionSize: positionStatesWithBalances.reduce((sum, p) => sum + p.balances.position.total, 0),
        totalTakeProfitOpen: positionStatesWithBalances.reduce((sum, p) => sum + p.balances.takeProfits.open, 0),
        totalTakeProfitFilled: positionStatesWithBalances.reduce((sum, p) => sum + p.balances.takeProfits.filled, 0),
        totalUncovered: positionStatesWithBalances.reduce((sum, p) => sum + p.balances.analysis.uncovered, 0),
        totalOversold: positionStatesWithBalances.reduce((sum, p) => sum + p.balances.analysis.oversold, 0)
      };
      
      this.logger.info('[Position States With Balances] Summary:', summary);
      
      return {
        positionStates: positionStatesWithBalances,
        summary,
        dataInfo: {
          positionsSource: 'fills_data',
          takeProfitSource: 'orders_data',
          balanceTracking: true,
          oversoldDetection: true
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to get position states with balances:', error);
      throw error;
    }
  }
  
  /**
   * Detect oversold positions (where take-profit orders exceed position size)
   * 
   * @returns {Promise<Array>} Array of oversold positions with details
   */
  async detectOversoldPositions() {
    try {
      this.logger.debug(`Detecting oversold positions for session ${this.sessionId}`);
      
      const allBalances = await this.calculateAllPositionBalances();
      const oversoldPositions = allBalances.balances.filter(balance => 
        balance.analysis.isOversold
      );
      
      this.logger.info(`Found ${oversoldPositions.length} oversold positions`);
      
      return oversoldPositions.map(balance => ({
        positionId: balance.positionId,
        positionSize: balance.position.total,
        takeProfitTotal: balance.takeProfits.total,
        oversoldAmount: balance.analysis.oversold,
        coveragePercentage: balance.analysis.coveragePercentage,
        details: balance
      }));
      
    } catch (error) {
      this.logger.error('Failed to detect oversold positions:', error);
      throw error;
    }
  }
  
  /**
   * Detect positions with partial fills (partially executed take-profits)
   * 
   * @returns {Promise<Array>} Array of positions with partial fills
   */
  async detectPartialFills() {
    try {
      this.logger.debug(`Detecting partial fills for session ${this.sessionId}`);
      
      const allBalances = await this.calculateAllPositionBalances();
      const partialFillPositions = allBalances.balances.filter(balance => 
        balance.analysis.hasFilledTakeProfits && 
        balance.analysis.hasOpenTakeProfits &&
        !balance.analysis.isFullyCovered
      );
      
      this.logger.info(`Found ${partialFillPositions.length} positions with partial fills`);
      
      return partialFillPositions.map(balance => ({
        positionId: balance.positionId,
        positionSize: balance.position.total,
        filledAmount: balance.takeProfits.filled,
        openAmount: balance.takeProfits.open,
        uncoveredAmount: balance.analysis.uncovered,
        coveragePercentage: balance.analysis.coveragePercentage,
        details: balance
      }));
      
    } catch (error) {
      this.logger.error('Failed to detect partial fills:', error);
      throw error;
    }
  }
  
  /**
   * Get comprehensive balance report for the session
   * 
   * @returns {Promise<Object>} Detailed balance report
   */
  async getBalanceReport() {
    try {
      this.logger.debug(`Generating balance report for session ${this.sessionId}`);
      
      const [allBalances, oversoldPositions, partialFillPositions, sellOrderStats] = await Promise.all([
        this.calculateAllPositionBalances(),
        this.detectOversoldPositions(),
        this.detectPartialFills(),
        this.getSellOrderStatistics()
      ]);
      
      // Enhanced summary with sell order statistics
      const enhancedSummary = {
        ...allBalances.summary,
        // Add sell order totals to the summary
        totalOpenSellOrders: sellOrderStats.summary.totalOpenSellOrders,
        totalFilledSellOrders: sellOrderStats.summary.totalFilledSellOrders,
        totalOpenSellAmount: sellOrderStats.summary.totalOpenSellAmount,
        totalFilledSellAmount: sellOrderStats.summary.totalFilledSellAmount,
        totalActiveSellAmount: sellOrderStats.summary.totalActiveSellAmount,
        totalCancelledSellOrders: sellOrderStats.summary.totalCancelledSellOrders,
        totalExpiredSellOrders: sellOrderStats.summary.totalExpiredSellOrders,
        totalCancelledSellAmount: sellOrderStats.summary.totalCancelledSellAmount,
        totalExpiredSellAmount: sellOrderStats.summary.totalExpiredSellAmount
      };
      
      const report = {
        sessionId: this.sessionId,
        timestamp: Date.now(),
        summary: enhancedSummary,
        sellOrderStats, // Include detailed sell order statistics
        issues: {
          oversold: {
            count: oversoldPositions.length,
            positions: oversoldPositions,
            totalOversoldAmount: oversoldPositions.reduce((sum, p) => sum + p.oversoldAmount, 0)
          },
          partialFills: {
            count: partialFillPositions.length,
            positions: partialFillPositions,
            totalPartialAmount: partialFillPositions.reduce((sum, p) => sum + p.filledAmount, 0)
          }
        },
        balances: allBalances.balances,
        recommendations: this._generateBalanceRecommendations(allBalances, oversoldPositions, partialFillPositions)
      };
      
      this.logger.info(`Balance report generated: ${report.summary.totalPositions} positions, ${report.issues.oversold.count} oversold, ${report.issues.partialFills.count} partial fills, ${report.summary.totalOpenSellOrders} open sell orders, ${report.summary.totalFilledSellOrders} filled sell orders`);
      
      return report;
      
    } catch (error) {
      this.logger.error('Failed to generate balance report:', error);
      throw error;
    }
  }
  
  /**
   * Helper method to determine coverage status based on balance data
   * 
   * @private
   */
  _determineCoverageStatus(balances, position) {
    if (position.skipTakeProfit) {
      return 'skipped_take_profit';
    }
    
    if (balances.analysis.isOversold) {
      return 'oversold';
    }
    
    if (balances.analysis.isFullyCovered) {
      return 'fully_covered';
    }
    
    if (balances.analysis.hasFilledTakeProfits || balances.analysis.hasOpenTakeProfits) {
      return 'partially_covered';
    }
    
    return 'uncovered';
  }
  
  /**
   * Helper method to summarize data sources
   * 
   * @private
   */
  _summarizeDataSources(balances, type) {
    const sources = {};
    balances.forEach(balance => {
      const source = balance[type].dataSource;
      sources[source] = (sources[source] || 0) + 1;
    });
    return sources;
  }
  
  /**
   * Generate recommendations based on balance analysis
   * 
   * @private
   */
  _generateBalanceRecommendations(allBalances, oversoldPositions, partialFillPositions) {
    const recommendations = [];
    
    if (oversoldPositions.length > 0) {
      recommendations.push({
        type: 'oversold_warning',
        priority: 'high',
        message: `${oversoldPositions.length} positions are oversold - take-profit orders exceed position size`,
        action: 'Review and cancel excess take-profit orders'
      });
    }
    
    if (partialFillPositions.length > 0) {
      recommendations.push({
        type: 'partial_fills_detected',
        priority: 'medium',
        message: `${partialFillPositions.length} positions have partial fills with remaining open orders`,
        action: 'Monitor for complete fills or adjust order sizes'
      });
    }
    
    if (allBalances.summary.totalUncovered > 0) {
      recommendations.push({
        type: 'uncovered_positions',
        priority: 'medium',
        message: `${allBalances.summary.totalUncovered.toFixed(4)} total uncovered position size`,
        action: 'Create take-profit orders for uncovered positions'
      });
    }
    
    if (allBalances.summary.averageCoverage < 50) {
      recommendations.push({
        type: 'low_coverage',
        priority: 'medium',
        message: `Low average coverage: ${allBalances.summary.averageCoverage.toFixed(1)}%`,
        action: 'Increase take-profit order creation to improve coverage'
      });
    }
    
    return recommendations;
  }

  /**
   * Get all sell orders (both open and filled) for the session
   * @returns {Promise<Object>} Sell order statistics
   */
  async getSellOrderStatistics() {
    try {
      this.logger.debug('Getting sell order statistics');
      
      const orders = await this.getOrders();
      const sellOrders = orders.filter(order => order.side === 'sell');
      
      // Categorize sell orders
      const openSellOrders = sellOrders.filter(order => 
        ['open', 'OPEN', 'partial', 'PARTIAL'].includes(order.status)
      );
      
      const filledSellOrders = sellOrders.filter(order => 
        ['filled', 'FILLED', 'closed', 'CLOSED'].includes(order.status)
      );
      
      const cancelledSellOrders = sellOrders.filter(order => 
        ['cancelled', 'CANCELLED', 'canceled', 'CANCELED'].includes(order.status)
      );
      
      const expiredSellOrders = sellOrders.filter(order => 
        ['expired', 'EXPIRED'].includes(order.status)
      );
      
      // Calculate totals
      const totalOpenSellAmount = openSellOrders.reduce((sum, order) => 
        sum + parseFloat(order.size || order.amount || 0), 0
      );
      
      const totalFilledSellAmount = filledSellOrders.reduce((sum, order) => 
        sum + parseFloat(order.filled || order.size || order.amount || 0), 0
      );
      
      const totalCancelledSellAmount = cancelledSellOrders.reduce((sum, order) => 
        sum + parseFloat(order.size || order.amount || 0), 0
      );
      
      const totalExpiredSellAmount = expiredSellOrders.reduce((sum, order) => 
        sum + parseFloat(order.size || order.amount || 0), 0
      );
      
      // Categorize by purpose
      const takeProfitOrders = sellOrders.filter(order => 
        order.purpose === 'take-profit' || 
        order.parentOrderId || 
        (order.metadata && order.metadata.createdBy && order.metadata.createdBy.includes('take-profit'))
      );
      
      const emergencyExitOrders = sellOrders.filter(order => 
        order.purpose === 'emergency-exit' || 
        order.purpose === 'stop-loss' ||
        (order.metadata && order.metadata.createdBy && order.metadata.createdBy.includes('emergency'))
      );
      
      const manualSellOrders = sellOrders.filter(order => 
        !order.purpose || 
        (!order.parentOrderId && !order.metadata?.createdBy)
      );
      
      return {
        summary: {
          totalSellOrders: sellOrders.length,
          totalOpenSellOrders: openSellOrders.length,
          totalFilledSellOrders: filledSellOrders.length,
          totalCancelledSellOrders: cancelledSellOrders.length,
          totalExpiredSellOrders: expiredSellOrders.length,
          
          totalOpenSellAmount: parseFloat(totalOpenSellAmount.toFixed(8)),
          totalFilledSellAmount: parseFloat(totalFilledSellAmount.toFixed(8)),
          totalCancelledSellAmount: parseFloat(totalCancelledSellAmount.toFixed(8)),
          totalExpiredSellAmount: parseFloat(totalExpiredSellAmount.toFixed(8)),
          
          totalActiveSellAmount: parseFloat((totalOpenSellAmount + totalFilledSellAmount).toFixed(8))
        },
        
        byPurpose: {
          takeProfitOrders: {
            total: takeProfitOrders.length,
            open: takeProfitOrders.filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status)).length,
            filled: takeProfitOrders.filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status)).length,
            cancelled: takeProfitOrders.filter(o => ['cancelled', 'CANCELLED', 'canceled', 'CANCELED'].includes(o.status)).length,
            expired: takeProfitOrders.filter(o => ['expired', 'EXPIRED'].includes(o.status)).length,
            
            openAmount: parseFloat(takeProfitOrders
              .filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.size || o.amount || 0), 0).toFixed(8)),
            filledAmount: parseFloat(takeProfitOrders
              .filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.filled || o.size || o.amount || 0), 0).toFixed(8))
          },
          
          emergencyExitOrders: {
            total: emergencyExitOrders.length,
            open: emergencyExitOrders.filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status)).length,
            filled: emergencyExitOrders.filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status)).length,
            cancelled: emergencyExitOrders.filter(o => ['cancelled', 'CANCELLED', 'canceled', 'CANCELED'].includes(o.status)).length,
            expired: emergencyExitOrders.filter(o => ['expired', 'EXPIRED'].includes(o.status)).length,
            
            openAmount: parseFloat(emergencyExitOrders
              .filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.size || o.amount || 0), 0).toFixed(8)),
            filledAmount: parseFloat(emergencyExitOrders
              .filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.filled || o.size || o.amount || 0), 0).toFixed(8))
          },
          
          manualSellOrders: {
            total: manualSellOrders.length,
            open: manualSellOrders.filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status)).length,
            filled: manualSellOrders.filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status)).length,
            cancelled: manualSellOrders.filter(o => ['cancelled', 'CANCELLED', 'canceled', 'CANCELED'].includes(o.status)).length,
            expired: manualSellOrders.filter(o => ['expired', 'EXPIRED'].includes(o.status)).length,
            
            openAmount: parseFloat(manualSellOrders
              .filter(o => ['open', 'OPEN', 'partial', 'PARTIAL'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.size || o.amount || 0), 0).toFixed(8)),
            filledAmount: parseFloat(manualSellOrders
              .filter(o => ['filled', 'FILLED', 'closed', 'CLOSED'].includes(o.status))
              .reduce((sum, o) => sum + parseFloat(o.filled || o.size || o.amount || 0), 0).toFixed(8))
          }
        },
        
        details: {
          openSellOrders: openSellOrders.map(order => ({
            id: order.id,
            price: parseFloat(order.price || 0),
            size: parseFloat(order.size || order.amount || 0),
            purpose: order.purpose || 'manual',
            parentOrderId: order.parentOrderId,
            status: order.status,
            createdAt: order.timestamp || order.createdAt
          })),
          
          filledSellOrders: filledSellOrders.map(order => ({
            id: order.id,
            price: parseFloat(order.avgFillPrice || order.price || 0),
            size: parseFloat(order.filled || order.size || order.amount || 0),
            purpose: order.purpose || 'manual',
            parentOrderId: order.parentOrderId,
            status: order.status,
            filledAt: order.lastUpdated || order.updatedAt || order.timestamp
          }))
        }
      };
      
    } catch (error) {
      this.logger.error('Error getting sell order statistics:', error);
      throw error;
    }
  }
}

export default PositionManager; 