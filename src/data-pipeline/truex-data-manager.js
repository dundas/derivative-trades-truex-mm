/**
 * TrueX Data Manager - Layer 1: Memory Cache
 * 
 * Provides fast in-memory storage for orders, fills, and OHLC data with:
 * - O(1) lookup by orderId and exchangeOrderId
 * - Fill deduplication using execID
 * - Write-behind queues for batch flushing to Redis
 * - Memory cleanup for completed orders
 * 
 * Performance targets:
 * - Read latency: < 1ms
 * - Write latency: < 1ms
 * - Memory footprint: ~1KB per order, ~500 bytes per fill
 */
export class TrueXDataManager {
  constructor(options = {}) {
    // Fast lookup structures
    this.orders = new Map();              // orderId -> Order
    this.ordersByExchangeId = new Map();  // exchangeOrderId -> Order
    this.fills = new Map();               // fillId -> Fill
    this.fillsByExecId = new Map();       // execID -> Fill (for deduplication)
    this.ohlcBuffer = [];                 // Array of pending OHLC candles
    this.executionReports = new Map();    // execID -> ExecutionReport
    
    // Write-behind queues for Redis batch flushing
    this.pendingWrites = {
      orders: [],
      fills: [],
      ohlc: []
    };
    
    // Configuration
    this.flushInterval = options.flushInterval || 1000;  // 1 second
    this.maxBatchSize = options.maxBatchSize || 100;
    this.maxOrderAge = options.maxOrderAge || 3600000;   // 1 hour
    
    // Statistics
    this.stats = {
      ordersInMemory: 0,
      fillsInMemory: 0,
      ohlcInMemory: 0,
      pendingFlushes: 0,
      lastFlushTime: 0,
      totalOrdersProcessed: 0,
      totalFillsProcessed: 0,
      duplicateFillsSkipped: 0
    };
    
    // Logger
    this.logger = options.logger || console;
  }
  
  /**
   * Add order to memory
   */
  addOrder(order) {
    if (!order.orderId) {
      throw new Error('Order must have orderId');
    }
    
    // Store by orderId
    this.orders.set(order.orderId, order);
    
    // Store by exchangeOrderId if available
    if (order.exchangeOrderId) {
      this.ordersByExchangeId.set(order.exchangeOrderId, order);
    }
    
    // Add to pending writes queue
    this.pendingWrites.orders.push(order);
    
    // Update stats
    this.stats.ordersInMemory = this.orders.size;
    this.stats.totalOrdersProcessed++;
    
    this.logger.debug(`[TrueXDataManager] Order added: ${order.orderId}`);
    
    return order;
  }
  
  /**
   * Get order by orderId
   */
  getOrder(orderId) {
    return this.orders.get(orderId);
  }
  
  /**
   * Get order by exchangeOrderId
   */
  getOrderByExchangeId(exchangeOrderId) {
    return this.ordersByExchangeId.get(exchangeOrderId);
  }
  
  /**
   * Update order in memory
   */
  updateOrder(orderId, updates) {
    const order = this.orders.get(orderId);
    if (!order) {
      this.logger.warn(`[TrueXDataManager] Order not found for update: ${orderId}`);
      return null;
    }
    
    // Update exchangeOrderId index if it changed
    if (updates.exchangeOrderId && updates.exchangeOrderId !== order.exchangeOrderId) {
      // Remove old index
      if (order.exchangeOrderId) {
        this.ordersByExchangeId.delete(order.exchangeOrderId);
      }
      // Add new index
      this.ordersByExchangeId.set(updates.exchangeOrderId, order);
    }
    
    // Apply updates
    Object.assign(order, updates);
    order.updatedAt = Date.now();
    
    // Add to pending writes
    this.pendingWrites.orders.push(order);
    
    this.logger.debug(`[TrueXDataManager] Order updated: ${orderId}`);
    
    return order;
  }
  
  /**
   * Get all orders
   */
  getAllOrders() {
    return Array.from(this.orders.values());
  }
  
  /**
   * Add fill to memory with deduplication
   */
  addFill(fill) {
    if (!fill.fillId) {
      throw new Error('Fill must have fillId');
    }
    
    if (!fill.execID) {
      throw new Error('Fill must have execID for deduplication');
    }
    
    // Check for duplicate using execID
    if (this.fillsByExecId.has(fill.execID)) {
      this.logger.warn(`[TrueXDataManager] Duplicate fill detected: ${fill.execID}`);
      this.stats.duplicateFillsSkipped++;
      return null;
    }
    
    // Store fill
    this.fills.set(fill.fillId, fill);
    this.fillsByExecId.set(fill.execID, fill);
    
    // Add to pending writes
    this.pendingWrites.fills.push(fill);
    
    // Update stats
    this.stats.fillsInMemory = this.fills.size;
    this.stats.totalFillsProcessed++;
    
    this.logger.debug(`[TrueXDataManager] Fill added: ${fill.fillId} (execID: ${fill.execID})`);
    
    return fill;
  }
  
  /**
   * Get fill by fillId
   */
  getFill(fillId) {
    return this.fills.get(fillId);
  }
  
  /**
   * Get fill by execID (for deduplication check)
   */
  getFillByExecId(execID) {
    return this.fillsByExecId.get(execID);
  }
  
  /**
   * Get all fills
   */
  getAllFills() {
    return Array.from(this.fills.values());
  }
  
  /**
   * Add OHLC candle to buffer
   */
  addOHLC(candle) {
    if (!candle.timestamp) {
      throw new Error('OHLC candle must have timestamp');
    }
    
    this.ohlcBuffer.push(candle);
    this.pendingWrites.ohlc.push(candle);
    
    this.stats.ohlcInMemory = this.ohlcBuffer.length;
    
    this.logger.debug(`[TrueXDataManager] OHLC candle added: ${candle.symbol} ${candle.interval} @ ${candle.timestamp}`);
    
    return candle;
  }
  
  /**
   * Get OHLC buffer
   */
  getOHLCBuffer() {
    return [...this.ohlcBuffer];
  }
  
  /**
   * Add execution report to memory
   */
  addExecutionReport(execReport) {
    if (!execReport.execID) {
      throw new Error('Execution report must have execID');
    }
    
    this.executionReports.set(execReport.execID, execReport);
    
    this.logger.debug(`[TrueXDataManager] Execution report added: ${execReport.execID}`);
    
    return execReport;
  }
  
  /**
   * Get execution report by execID
   */
  getExecutionReport(execID) {
    return this.executionReports.get(execID);
  }
  
  /**
   * Get pending orders for flushing to Redis
   */
  getPendingOrders(limit = 100) {
    const pending = this.pendingWrites.orders.splice(0, limit);
    this.logger.debug(`[TrueXDataManager] Retrieved ${pending.length} pending orders for flush`);
    return pending;
  }
  
  /**
   * Get pending fills for flushing to Redis
   */
  getPendingFills(limit = 100) {
    const pending = this.pendingWrites.fills.splice(0, limit);
    this.logger.debug(`[TrueXDataManager] Retrieved ${pending.length} pending fills for flush`);
    return pending;
  }
  
  /**
   * Get pending OHLC candles for flushing to Redis
   */
  getPendingOHLC(limit = 100) {
    const pending = this.pendingWrites.ohlc.splice(0, limit);
    this.logger.debug(`[TrueXDataManager] Retrieved ${pending.length} pending OHLC candles for flush`);
    return pending;
  }
  
  /**
   * Clean up old completed orders from memory
   */
  cleanup(maxAge = this.maxOrderAge) {
    const now = Date.now();
    let cleaned = 0;
    const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
    
    for (const [orderId, order] of this.orders.entries()) {
      // Only clean orders in terminal states
      if (order && TERMINAL_STATUSES.has(order.status)) {
        const age = now - (order.updatedAt || order.createdAt || 0);
        
        if (age > maxAge) {
          // Remove from orders map
          this.orders.delete(orderId);
          
          // Remove from exchangeOrderId index
          if (order.exchangeOrderId) {
            this.ordersByExchangeId.delete(order.exchangeOrderId);
          }
          
          cleaned++;
        }
      }
    }
    
    // Update stats
    this.stats.ordersInMemory = this.orders.size;
    
    if (cleaned > 0) {
      this.logger.info(`[TrueXDataManager] Cleaned ${cleaned} old orders from memory`);
    }
    
    return cleaned;
  }
  
  /**
   * Clear OHLC buffer (after successful flush)
   */
  clearOHLCBuffer() {
    const count = this.ohlcBuffer.length;
    this.ohlcBuffer = [];
    this.stats.ohlcInMemory = 0;
    
    this.logger.debug(`[TrueXDataManager] Cleared ${count} OHLC candles from buffer`);
    
    return count;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      ordersInMemory: this.orders.size,
      fillsInMemory: this.fills.size,
      ohlcInMemory: this.ohlcBuffer.length,
      pendingOrders: this.pendingWrites.orders.length,
      pendingFills: this.pendingWrites.fills.length,
      pendingOHLC: this.pendingWrites.ohlc.length,
      executionReportsInMemory: this.executionReports.size
    };
  }
  
  /**
   * Reset all data (for testing or session restart)
   */
  reset() {
    this.orders.clear();
    this.ordersByExchangeId.clear();
    this.fills.clear();
    this.fillsByExecId.clear();
    this.ohlcBuffer = [];
    this.executionReports.clear();
    
    this.pendingWrites.orders = [];
    this.pendingWrites.fills = [];
    this.pendingWrites.ohlc = [];
    
    this.stats = {
      ordersInMemory: 0,
      fillsInMemory: 0,
      ohlcInMemory: 0,
      pendingFlushes: 0,
      lastFlushTime: 0,
      totalOrdersProcessed: 0,
      totalFillsProcessed: 0,
      duplicateFillsSkipped: 0
    };
    
    this.logger.info('[TrueXDataManager] All data reset');
  }
}
