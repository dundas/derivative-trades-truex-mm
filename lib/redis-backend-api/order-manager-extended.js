/**
 * Extended OrderManager with Exchange ID Mapping
 * 
 * Extends the base OrderManager to support bidirectional mapping
 * between clientOrderId and exchangeOrderId for proper fill matching.
 */

import { OrderManager } from './order-manager.js';

export class OrderManagerExtended extends OrderManager {
  constructor(config) {
    super(config);
    
    // NOTE: Exchange mapping TTL no longer needed since we store exchangeOrderId directly in orders
    // this.exchangeMappingTTL = 86400;
  }
  
  /**
   * Create bidirectional mapping between exchange order ID and client order ID
   * NOTE: This method is deprecated - exchange mapping is now stored directly in order objects
   * @param {string} exchangeOrderId - The exchange's order ID (e.g., OZCHSF-KBCXT-UPISGS)
   * @param {string} clientOrderId - Our client order ID (e.g., ammv2-sessionId-timestamp)
   * @returns {Promise<void>}
   * @deprecated Use order.exchangeOrderId field instead
   */
  async setExchangeMapping(exchangeOrderId, clientOrderId) {
    // NOTE: This method is now a no-op since we store exchangeOrderId directly in order objects
    // This eliminates the need for separate mapping keys and reduces Redis key proliferation
    this.logger.debug(`[OrderManager] Exchange mapping stored in order object: ${exchangeOrderId} -> ${clientOrderId}`);
  }
  
  /**
   * Get client order ID by exchange order ID
   * @param {string} exchangeOrderId - The exchange's order ID
   * @returns {Promise<string|null>} The client order ID or null if not found
   */
  async getClientOrderIdByExchange(exchangeOrderId) {
    try {
      this.logger.debug(`[OrderManager] Looking up client order ID for exchange ID: ${exchangeOrderId}`);
      
      // Get all orders and search for the one with matching exchangeOrderId
      const orders = await this.getAll();
      
      // Use the map format if available, otherwise iterate through array
      if (orders._asMap) {
        this.logger.debug(`[OrderManager] Using map lookup with ${Object.keys(orders._asMap).length} orders`);
        for (const [clientOrderId, order] of Object.entries(orders._asMap)) {
          if (order.exchangeOrderId === exchangeOrderId) {
            this.logger.info(`[OrderManager] Found client order ID: ${clientOrderId} for exchange ID: ${exchangeOrderId}`);
            return clientOrderId;
          }
        }
      } else {
        this.logger.debug(`[OrderManager] Using array lookup with ${orders.length} orders`);
        // Fallback to array iteration
        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          if (order.exchangeOrderId === exchangeOrderId) {
            this.logger.info(`[OrderManager] Found client order ID: ${order.id} for exchange ID: ${exchangeOrderId}`);
            return order.id || order.clientOrderId;
          }
        }
      }
      
      this.logger.debug(`[OrderManager] No order found with exchange ID: ${exchangeOrderId}`);
      return null;
    } catch (error) {
      this.logger.error(`[OrderManager] Error getting client order ID by exchange: ${error.message}`, {
        exchangeOrderId
      });
      return null;
    }
  }
  
  /**
   * Override the base add method to use clientOrderId as the primary key
   * @param {Object} order - Order data to add
   * @returns {Promise<Object>} - Added order data
   */
  async add(order) {
    try {
      // Ensure we use clientOrderId as the primary ID
      if (order.clientOrderId && !order.id) {
        order.id = order.clientOrderId;
      } else if (order.clientOrderId && order.id !== order.clientOrderId) {
        this.logger.warn(`[OrderManager] Order ID mismatch: id=${order.id}, clientOrderId=${order.clientOrderId}. Using clientOrderId as primary.`);
        order.id = order.clientOrderId;
      }
      
      // Remove redundant orderId field if it exists
      if (order.orderId) {
        this.logger.debug(`[OrderManager] Removing redundant orderId field: ${order.orderId}`);
        delete order.orderId;
      }
      
      // Call parent's add method
      const addedOrder = await super.add(order);
      
      // If we have an exchange order ID, create the mapping
      if (addedOrder.exchangeOrderId) {
        await this.setExchangeMapping(addedOrder.exchangeOrderId, addedOrder.id);
      }
      
      return addedOrder;
    } catch (error) {
      this.logger.error(`[OrderManager] Error in extended add method: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Override the update method to handle exchange ID mapping
   * @param {Object} order - Order data to update
   * @returns {Promise<Object>} - Updated order data
   */
  async update(order) {
    try {
      // Get existing order to check if exchangeOrderId is being added
      const existingOrder = await this.getById(order.id);
      
      // Call parent's update method
      const updatedOrder = await super.update(order);
      
      // If exchangeOrderId was added or changed, update the mapping
      if (updatedOrder.exchangeOrderId && 
          (!existingOrder || existingOrder.exchangeOrderId !== updatedOrder.exchangeOrderId)) {
        await this.setExchangeMapping(updatedOrder.exchangeOrderId, updatedOrder.id);
      }
      
      return updatedOrder;
    } catch (error) {
      this.logger.error(`[OrderManager] Error in extended update method: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get order by exchange ID (convenience method)
   * @param {string} exchangeOrderId - The exchange's order ID
   * @returns {Promise<Object|null>} - Order data or null if not found
   */
  async getByExchangeId(exchangeOrderId) {
    try {
      // First get the client order ID from the mapping
      const clientOrderId = await this.getClientOrderIdByExchange(exchangeOrderId);
      
      if (!clientOrderId) {
        this.logger.debug(`[OrderManager] No order found for exchange ID: ${exchangeOrderId}`);
        return null;
      }
      
      // Then get the order by client order ID
      return await this.getById(clientOrderId);
    } catch (error) {
      this.logger.error(`[OrderManager] Error getting order by exchange ID: ${error.message}`, {
        exchangeOrderId
      });
      return null;
    }
  }
  
  /**
   * Clean up expired exchange mappings (optional maintenance method)
   * @returns {Promise<void>}
   * @deprecated No longer needed since exchange mappings are stored in order objects
   */
  async cleanupExpiredMappings() {
    try {
      this.logger.info('[OrderManager] Exchange mappings cleanup no longer needed - stored directly in order objects');
    } catch (error) {
      this.logger.error(`[OrderManager] Error in cleanup: ${error.message}`);
    }
  }
}