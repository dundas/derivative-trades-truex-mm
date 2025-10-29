/**
 * Central Tracking Manager - Simplified Version
 * 
 * Manages cross-session order tracking using Redis hash maps with field-level TTL.
 * This is a simplified version focused on reconciler needs.
 */

export class CentralTrackingManager {
  constructor(options = {}) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.config = {
      orderTTL: options.orderTTL || 259200 // 3 days in seconds
    };
  }
  
  /**
   * Get the Redis key for order mapping
   */
  getOrderMapKey(exchange) {
    return `order_map:${exchange}`;
  }
  
  /**
   * Add an order to central tracking
   */
  async addOrder(exchange, orderId, orderInfo) {
    try {
      const key = this.getOrderMapKey(exchange);
      
      // Store order info with field-level TTL
      await this.redis.hSet(key, orderId, orderInfo.sessionId);
      
      // Set field-level TTL if supported
      if (this.redis.hexpire) {
        await this.redis.hexpire(key, orderId, this.config.orderTTL);
      }
      
      this.logger?.debug(`✅ Added order to central tracking: ${orderId} -> ${orderInfo.sessionId}`);
      
      return {
        orderId,
        sessionId: orderInfo.sessionId,
        exchange
      };
      
    } catch (error) {
      this.logger?.error(`❌ Failed to add order to central tracking:`, error);
      throw error;
    }
  }
  
  /**
   * Get orders for a specific session
   */
  async getOrdersBySession(exchange, sessionId) {
    try {
      const key = this.getOrderMapKey(exchange);
      const allOrders = await this.redis.hGetAll(key);
      
      const sessionOrders = [];
      
      for (const [orderId, storedSessionId] of Object.entries(allOrders || {})) {
        if (storedSessionId === sessionId) {
          sessionOrders.push({
            orderId,
            sessionId: storedSessionId,
            exchange
          });
        }
      }
      
      return sessionOrders;
      
    } catch (error) {
      this.logger?.error(`❌ Failed to get orders for session ${sessionId}:`, error);
      return [];
    }
  }
  
  /**
   * Get all orders for an exchange
   */
  async getAllOrders(exchange) {
    try {
      const key = this.getOrderMapKey(exchange);
      const allOrders = await this.redis.hGetAll(key);
      
      const orders = [];
      
      for (const [orderId, sessionId] of Object.entries(allOrders || {})) {
        orders.push({
          orderId,
          sessionId,
          exchange
        });
      }
      
      return orders;
      
    } catch (error) {
      this.logger?.error(`❌ Failed to get all orders for exchange ${exchange}:`, error);
      return [];
    }
  }
  
  /**
   * Remove an order from central tracking
   */
  async removeOrder(exchange, orderId) {
    try {
      const key = this.getOrderMapKey(exchange);
      await this.redis.hDel(key, orderId);
      
      this.logger?.debug(`🗑️ Removed order from central tracking: ${orderId}`);
      
    } catch (error) {
      this.logger?.error(`❌ Failed to remove order from central tracking:`, error);
    }
  }
} 