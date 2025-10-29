/**
 * Enhanced Redis Backend API Operations
 * 
 * Additional operations for the Redis Backend API based on data structure analysis.
 * This module extends the core API with specialized operations for common
 * trading data patterns.
 */

/**
 * Enhanced order operations for the OrderManager
 */
export class EnhancedOrderOperations {
  /**
   * Initialize with an existing OrderManager instance
   * @param {Object} orderManager - The OrderManager instance to enhance
   */
  constructor(orderManager) {
    this.orderManager = orderManager;
    this.redis = orderManager.redis;
    this.keyGenerator = orderManager.keyGenerator;
    this.logger = orderManager.logger;
  }

  /**
   * Find all buy orders for the session
   * @returns {Promise<Array>} - Array of buy orders
   */
  async getBuyOrders() {
    const orders = await this.orderManager.getAll();
    return orders.filter(order => order.side === 'buy');
  }

  /**
   * Find all sell orders for the session
   * @returns {Promise<Array>} - Array of sell orders
   */
  async getSellOrders() {
    const orders = await this.orderManager.getAll();
    return orders.filter(order => order.side === 'sell');
  }

  /**
   * Find orders with a specific status
   * @param {string} status - Order status (e.g., 'open', 'filled', 'canceled')
   * @returns {Promise<Array>} - Array of matching orders
   */
  async getOrdersByStatus(status) {
    const orders = await this.orderManager.getAll();
    return orders.filter(order => order.status === status);
  }

  /**
   * Find orders by parent order ID
   * @param {string} parentOrderId - ID of the parent order
   * @returns {Promise<Array>} - Array of child orders
   */
  async getOrdersByParentId(parentOrderId) {
    const orders = await this.orderManager.getAll();
    return orders.filter(order => order.parentOrderId === parentOrderId);
  }

  /**
   * Find buy/sell pairs based on parentOrderId relationships
   * @returns {Promise<Array>} - Array of { buyOrder, sellOrder } pairs
   */
  async getOrderPairs() {
    const orders = await this.orderManager.getAll();
    const buyOrders = orders.filter(order => order.side === 'buy');
    const sellOrders = orders.filter(order => order.side === 'sell');
    
    // Match pairs based on parentOrderId (sell orders reference buy orders)
    const pairs = [];
    for (const sellOrder of sellOrders) {
      if (sellOrder.parentOrderId) {
        const buyOrder = buyOrders.find(order => order.id === sellOrder.parentOrderId);
        if (buyOrder) {
          pairs.push({ buyOrder, sellOrder });
        }
      }
    }
    
    return pairs;
  }
  
  /**
   * Cancel all open orders
   * @param {string} [side] - Optional filter by side ('buy' or 'sell')
   * @returns {Promise<Array>} - Array of canceled orders
   */
  async cancelOpenOrders(side) {
    const orders = await this.orderManager.getAll();
    const openOrders = orders.filter(order => 
      order.status === 'open' && 
      (side ? order.side === side : true)
    );
    
    // Cancel each open order
    const canceledOrders = [];
    for (const order of openOrders) {
      const canceledOrder = {
        ...order,
        status: 'canceled',
        updatedAt: Date.now(),
        canceledAt: Date.now(),
        cancelReason: 'Canceled by API'
      };
      
      await this.orderManager.update(canceledOrder);
      canceledOrders.push(canceledOrder);
    }
    
    return canceledOrders;
  }
  
  /**
   * Get metrics about orders in the session
   * @returns {Promise<Object>} - Order metrics
   */
  async getOrderMetrics() {
    const orders = await this.orderManager.getAll();
    
    // Calculate metrics
    const buyOrders = orders.filter(order => order.side === 'buy');
    const sellOrders = orders.filter(order => order.side === 'sell');
    
    // Status counts
    const statusCounts = {};
    for (const order of orders) {
      statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;
    }
    
    // Open orders
    const openBuyOrders = buyOrders.filter(order => order.status === 'open');
    const openSellOrders = sellOrders.filter(order => order.status === 'open');
    
    return {
      total: orders.length,
      buyCount: buyOrders.length,
      sellCount: sellOrders.length,
      openCount: openBuyOrders.length + openSellOrders.length,
      openBuyCount: openBuyOrders.length,
      openSellCount: openSellOrders.length,
      statusCounts
    };
  }
  
  /**
   * Get open positions (filled buy orders without matching filled sells)
   * 
   * This method identifies positions that need to be settled by looking at
   * fill data rather than order status. A position is considered "open" if:
   * 1. It's a buy order with a fill (has fillPrice and fillTimestamp)
   * 2. There are no corresponding filled sell orders with this buy as the parent
   * 
   * @returns {Promise<Array>} - Array of open position objects (filled buy orders)
   */
  async getOpenPositions() {
    // Get all orders for this session
    const orders = await this.orderManager.getAll();
    
    if (!orders || orders.length === 0) {
      return [];
    }
    
    // Filter out only filled buy orders (those with fill data)
    const filledBuyOrders = orders.filter(order => 
      order.side === 'buy' && 
      order.fillPrice && 
      order.fillTimestamp
    );
    
    if (filledBuyOrders.length === 0) {
      return [];
    }
    
    // Filter out filled sell orders (those with fill data)
    const filledSellOrders = orders.filter(order => 
      order.side === 'sell' && 
      order.fillPrice && 
      order.fillTimestamp && 
      order.parentOrderId // Must have a parent order ID
    );
    
    // Create a map of sell orders by parent ID for quick lookup
    const sellOrdersByParentId = {};
    filledSellOrders.forEach(sellOrder => {
      if (!sellOrdersByParentId[sellOrder.parentOrderId]) {
        sellOrdersByParentId[sellOrder.parentOrderId] = [];
      }
      sellOrdersByParentId[sellOrder.parentOrderId].push(sellOrder);
    });
    
    // Identify open positions (filled buys without matching filled sells)
    const openPositions = filledBuyOrders.filter(buyOrder => {
      // Check if this buy order has any matching filled sell orders
      const matchingSells = sellOrdersByParentId[buyOrder.id] || [];
      
      // If there are no matching sells, this is an open position
      return matchingSells.length === 0;
    });
    
    return openPositions;
  }
}

/**
 * Enhanced fill operations for the FillManager
 */
export class EnhancedFillOperations {
  /**
   * Initialize with an existing FillManager instance
   * @param {Object} fillManager - The FillManager instance to enhance
   */
  constructor(fillManager) {
    this.fillManager = fillManager;
    this.redis = fillManager.redis;
    this.keyGenerator = fillManager.keyGenerator;
    this.logger = fillManager.logger;
  }
  
  /**
   * Find all buy fills for the session
   * @returns {Promise<Array>} - Array of buy fills
   */
  async getBuyFills() {
    const fills = await this.fillManager.getAll();
    return fills.filter(fill => fill.side === 'buy');
  }
  
  /**
   * Find all sell fills for the session
   * @returns {Promise<Array>} - Array of sell fills
   */
  async getSellFills() {
    const fills = await this.fillManager.getAll();
    return fills.filter(fill => fill.side === 'sell');
  }
  
  /**
   * Get fills by parent order ID
   * @param {string} parentOrderId - ID of the parent order
   * @returns {Promise<Array>} - Array of fills
   */
  async getFillsByParentOrderId(parentOrderId) {
    const fills = await this.fillManager.getAll();
    return fills.filter(fill => fill.parentOrderId === parentOrderId);
  }
  
  /**
   * Calculate profit/loss from fills
   * @returns {Promise<Object>} - P&L metrics
   */
  async calculateProfitLoss() {
    const fills = await this.fillManager.getAll();
    
    // Separate by side
    const buyFills = fills.filter(fill => fill.side === 'buy');
    const sellFills = fills.filter(fill => fill.side === 'sell');
    
    // Calculate realized P&L from completed trades
    let totalBuyCost = 0;
    let totalSellValue = 0;
    let totalBuySize = 0;
    let totalSellSize = 0;
    
    for (const buy of buyFills) {
      totalBuyCost += (buy.fillPrice || buy.price) * (buy.size || 0);
      totalBuySize += (buy.size || 0);
    }
    
    for (const sell of sellFills) {
      totalSellValue += (sell.fillPrice || sell.price) * (sell.size || 0);
      totalSellSize += (sell.size || 0);
    }
    
    const averageBuyPrice = totalBuySize > 0 ? totalBuyCost / totalBuySize : 0;
    const averageSellPrice = totalSellSize > 0 ? totalSellValue / totalSellSize : 0;
    
    const realizedPnL = totalSellValue - (totalSellSize / totalBuySize) * totalBuyCost;
    
    return {
      totalBuyCost,
      totalSellValue,
      totalBuySize,
      totalSellSize,
      averageBuyPrice,
      averageSellPrice,
      realizedPnL,
      percentPnL: averageBuyPrice > 0 ? ((averageSellPrice - averageBuyPrice) / averageBuyPrice) * 100 : 0
    };
  }
  
  /**
   * Match buy and sell fills to identify complete trade cycles
   * @returns {Promise<Array>} - Array of trade cycles (buy/sell fill pairs)
   */
  async getMatchedFillPairs() {
    const fills = await this.fillManager.getAll();
    
    // Separate by side
    const buyFills = fills.filter(fill => fill.side === 'buy');
    const sellFills = fills.filter(fill => fill.side === 'sell');
    
    // Match pairs based on parentOrderId
    const pairs = [];
    for (const sellFill of sellFills) {
      if (sellFill.parentOrderId) {
        const buyFill = buyFills.find(fill => fill.id === sellFill.parentOrderId);
        if (buyFill) {
          pairs.push({
            buyFill,
            sellFill,
            profit: (sellFill.fillPrice - buyFill.fillPrice) * sellFill.size,
            profitPercent: ((sellFill.fillPrice - buyFill.fillPrice) / buyFill.fillPrice) * 100
          });
        }
      }
    }
    
    return pairs;
  }
}

/**
 * Enhanced session operations for the SessionManager
 */
export class EnhancedSessionOperations {
  /**
   * Initialize with an existing SessionManager instance
   * @param {Object} sessionManager - The SessionManager instance to enhance
   */
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.redis = sessionManager.redis;
    this.keyGenerator = sessionManager.keyGenerator;
    this.logger = sessionManager.logger;
  }
  
  /**
   * Update session profit/loss information
   * @param {number} totalProfitLoss - New total profit/loss value
   * @returns {Promise<Object>} - Updated session
   */
  async updateProfitLoss(totalProfitLoss) {
    const session = await this.sessionManager.get();
    if (!session) {
      throw new Error('Session not found');
    }
    
    const updatedSession = {
      ...session,
      totalProfitLoss,
      lastUpdated: Date.now()
    };
    
    await this.sessionManager.update(updatedSession);
    return updatedSession;
  }
  
  /**
   * Get session status summary including orders and fills metrics
   * @param {Object} orderManager - OrderManager instance
   * @param {Object} fillManager - FillManager instance
   * @returns {Promise<Object>} - Session status summary
   */
  async getSessionSummary(orderManager, fillManager) {
    const session = await this.sessionManager.get();
    if (!session) {
      throw new Error('Session not found');
    }
    
    // Enhanced order operations
    const enhancedOrderOps = new EnhancedOrderOperations(orderManager);
    const orderMetrics = await enhancedOrderOps.getOrderMetrics();
    
    // Enhanced fill operations
    const enhancedFillOps = new EnhancedFillOperations(fillManager);
    const pnlMetrics = await enhancedFillOps.calculateProfitLoss();
    
    // Calculate runtime
    const startTime = session.startedAt || session.startTime;
    const endTime = session.endedAt || Date.now();
    const runtime = endTime - startTime;
    
    return {
      id: session.id,
      symbol: session.symbol,
      exchange: session.exchange,
      strategy: session.strategy,
      status: session.status,
      runtime, // ms
      runtimeFormatted: formatDuration(runtime),
      startedAt: new Date(startTime).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      budget: session.budget,
      tradingMode: session.tradingMode,
      orderMetrics,
      profitLoss: pnlMetrics
    };
  }
  
  /**
   * Get all active sessions from Redis
   * @returns {Promise<Array>} - Array of active session objects
   */
  async getAllActiveSessions() {
    try {
      // Get the active session key
      const baseKeyParts = this.keyGenerator.generateSessionKey().split(':');
      // Remove the last two parts (sessionId:session) to get the base key
      const baseKey = baseKeyParts.slice(0, 3).join(':');
      
      // Active session key format: strategy:exchange:symbol:active-session
      const activeSessionKey = `${baseKey}:active-session`;
      
      // Get active session data
      const activeSession = await this.redis.get(activeSessionKey);
      
      // Return as an array (even if only one active session)
      return activeSession ? [activeSession] : [];
    } catch (error) {
      this.logger.error(`Error getting active sessions:`, error);
      return [];
    }
  }
  
  /**
   * Mark the session as settled with settlement information (but leave status unchanged)
   * @param {Object} settlementInfo - Settlement details
   * @returns {Promise<Object>} - Updated session
   */
  async markAsSettled(settlementInfo) {
    const session = await this.sessionManager.get();
    if (!session) {
      throw new Error('Session not found');
    }
    
    const updatedSession = {
      ...session,
      // Leave status unchanged - only update settlement metadata
      endedAt: settlementInfo.endedAt || session.endedAt || Date.now(),
      settledComplete: true,
      settledAt: settlementInfo.settledAt || Date.now(),
      lastUpdated: Date.now()
    };
    
    await this.sessionManager.update(updatedSession);
    return updatedSession;
  }
}

/**
 * Helper to format duration in milliseconds to a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
