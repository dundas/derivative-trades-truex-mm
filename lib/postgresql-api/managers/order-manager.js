/**
 * PostgreSQL Order Manager
 * 
 * High-level operations for trading orders in PostgreSQL.
 * Provides a clean API similar to the redis-backend-api pattern.
 */

import { 
  ORDERS_SCHEMA
} from '../schemas/index.js';
import {
  generateBulkInsertSQL,
  generateInsertSQL,
  generateUpdateSQL,
  mapDataToSchema,
  normalizeDataToSchema,
  validateData
} from '../utils/sql-generator.js';

export class OrderManager {
  constructor(dbAdapter) {
    this.db = dbAdapter;
    this.schema = ORDERS_SCHEMA;
  }

  /**
   * Save a single order
   * @param {Object} orderData - Order data
   * @returns {Promise<Object>} - Result with id and success status
   */
  async saveOrder(orderData) {
    try {
      // Normalize field names to match schema
      const normalized = normalizeDataToSchema(this.schema, orderData);
      
      // Validate data
      const errors = validateData(this.schema, normalized);
      if (errors.length > 0) {
        throw new Error(`Validation errors: ${errors.join(', ')}`);
      }

      // Map to ordered array
      const values = mapDataToSchema(this.schema, normalized);
      
      // Generate SQL
      const sql = generateInsertSQL(this.schema, 'UPDATE');
      
      // Execute query
      const result = await this.db.query(sql, values);
      
      return {
        success: true,
        id: orderData.id,
        result: result.rows[0]
      };
      
    } catch (error) {
      return {
        success: false,
        id: orderData.id,
        error: error.message
      };
    }
  }

  /**
   * Save multiple orders using bulk insert
   * @param {Array<Object>} orders - Array of order data
   * @returns {Promise<Object>} - Bulk operation results
   */
  async saveOrdersBulk(orders) {
    if (!orders || orders.length === 0) {
      return { success: 0, failed: 0, results: [] };
    }

    const CHUNK_SIZE = 500; // Orders can handle larger chunks
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
      const chunk = orders.slice(i, i + CHUNK_SIZE);
      
      try {
        // Normalize and map all order data
        const mappedData = chunk.map(order => {
          const normalized = normalizeDataToSchema(this.schema, order);
          return mapDataToSchema(this.schema, normalized);
        });
        
        const flatParams = mappedData.flat();
        
        // Generate bulk insert SQL
        const sql = generateBulkInsertSQL(this.schema, chunk.length);
        
        const result = await this.db.query(sql, flatParams);
        
        successCount += result.rowCount;
        chunk.forEach((order, idx) => {
          results.push({
            id: order.id,
            success: true,
            result: result.rows[idx]
          });
        });
        
      } catch (error) {
        console.error(`[BULK ORDER INSERT ERROR] Failed to insert ${chunk.length} orders:`, error.message);
        failedCount += chunk.length;
        
        // Log sample failed order for debugging
        if (chunk.length > 0) {
          console.error('Sample failed order:', JSON.stringify(chunk[0], null, 2));
        }
        
        chunk.forEach((order) => {
          results.push({
            id: order.id,
            success: false,
            error: error.message
          });
        });
      }
    }

    return {
      success: successCount,
      failed: failedCount,
      results: results
    };
  }

  /**
   * Get orders for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Array<Object>>} - Array of orders
   */
  async getOrders(sessionId) {
    try {
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE sessionid = $1 
        ORDER BY createdat DESC
      `;
      
      const result = await this.db.query(sql, [sessionId]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting orders for session ${sessionId}:`, error.message);
      return [];
    }
  }

  /**
   * Get open orders for a session
   * @param {string} sessionId - Session ID
   * @param {string} side - Order side ('buy' or 'sell'), optional
   * @returns {Promise<Array<Object>>} - Array of open orders
   */
  async getOpenOrders(sessionId, side = null) {
    try {
      let sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE sessionid = $1 
        AND (status = 'OPEN' OR status = 'PARTIALLY_FILLED')
        AND (remaining > 0 OR filled < size)
      `;
      
      const params = [sessionId];
      
      if (side) {
        sql += ` AND side = $2`;
        params.push(side);
      }
      
      sql += ` ORDER BY createdat DESC`;
      
      const result = await this.db.query(sql, params);
      return result.rows;
    } catch (error) {
      console.error(`Error getting open orders for session ${sessionId}:`, error.message);
      return [];
    }
  }

  /**
   * Get an order by ID
   * @param {string} orderId - Order ID
   * @returns {Promise<Object|null>} - Order data or null
   */
  async getOrder(orderId) {
    try {
      const sql = `SELECT * FROM ${this.schema.tableName} WHERE id = $1`;
      const result = await this.db.query(sql, [orderId]);
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error getting order ${orderId}:`, error.message);
      return null;
    }
  }

  /**
   * Update order status
   * @param {string} orderId - Order ID
   * @param {string} status - New status
   * @param {Object} additionalFields - Additional fields to update
   * @returns {Promise<boolean>} - Success status
   */
  async updateOrderStatus(orderId, status, additionalFields = {}) {
    try {
      const updateFields = ['status', 'updatedat'];
      const values = [status, Date.now()];
      
      // Add any additional fields
      Object.entries(additionalFields).forEach(([field, value]) => {
        if (this.schema.columns[field]) {
          updateFields.push(field);
          values.push(value);
        }
      });
      
      values.push(orderId); // Primary key
      
      const sql = generateUpdateSQL(this.schema, updateFields);
      const result = await this.db.query(sql, values);
      
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error updating order status for ${orderId}:`, error.message);
      return false;
    }
  }

  /**
   * Cancel an order
   * @param {string} orderId - Order ID
   * @param {string} reason - Cancellation reason
   * @returns {Promise<boolean>} - Success status
   */
  async cancelOrder(orderId, reason = null) {
    const additionalFields = {
      canceledat: Date.now()
    };
    
    if (reason) {
      additionalFields.cancelreason = reason;
    }
    
    return this.updateOrderStatus(orderId, 'CANCELLED', additionalFields);
  }

  /**
   * Mark order as filled
   * @param {string} orderId - Order ID
   * @param {number} filledSize - Amount filled
   * @param {number} fillTimestamp - Fill timestamp
   * @returns {Promise<boolean>} - Success status
   */
  async markOrderFilled(orderId, filledSize, fillTimestamp = null) {
    const additionalFields = {
      filledsize: filledSize,
      filled: filledSize,
      filledat: fillTimestamp || Date.now(),
      lastfilltimestamp: fillTimestamp || Date.now()
    };
    
    return this.updateOrderStatus(orderId, 'FILLED', additionalFields);
  }

  /**
   * Get orders by status
   * @param {string} status - Order status
   * @param {number} limit - Maximum results
   * @returns {Promise<Array<Object>>} - Array of orders
   */
  async getOrdersByStatus(status, limit = 100) {
    try {
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE status = $1 
        ORDER BY createdat DESC 
        LIMIT $2
      `;
      
      const result = await this.db.query(sql, [status, limit]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting orders by status ${status}:`, error.message);
      return [];
    }
  }

  /**
   * Get recent orders
   * @param {number} hours - Hours back to look
   * @param {number} limit - Maximum results
   * @returns {Promise<Array<Object>>} - Array of orders
   */
  async getRecentOrders(hours = 24, limit = 100) {
    try {
      const pastTimestamp = Date.now() - (hours * 60 * 60 * 1000);
      
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE createdat >= $1 
        ORDER BY createdat DESC 
        LIMIT $2
      `;
      
      const result = await this.db.query(sql, [pastTimestamp, limit]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting recent orders:`, error.message);
      return [];
    }
  }

  /**
   * Get order statistics for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} - Order statistics
   */
  async getOrderStats(sessionId) {
    try {
      const sql = `
        SELECT 
          COUNT(*) as total_orders,
          COUNT(CASE WHEN side = 'buy' THEN 1 END) as buy_orders,
          COUNT(CASE WHEN side = 'sell' THEN 1 END) as sell_orders,
          COUNT(CASE WHEN status = 'FILLED' THEN 1 END) as filled_orders,
          COUNT(CASE WHEN status = 'OPEN' OR status = 'PARTIALLY_FILLED' THEN 1 END) as open_orders,
          COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_orders,
          SUM(CASE WHEN side = 'buy' AND status = 'FILLED' THEN size ELSE 0 END) as total_buy_volume,
          SUM(CASE WHEN side = 'sell' AND status = 'FILLED' THEN size ELSE 0 END) as total_sell_volume,
          SUM(CASE WHEN status = 'FILLED' THEN fee ELSE 0 END) as total_fees
        FROM ${this.schema.tableName}
        WHERE sessionid = $1
      `;
      
      const result = await this.db.query(sql, [sessionId]);
      return result.rows[0] || {};
    } catch (error) {
      console.error(`Error getting order stats for session ${sessionId}:`, error.message);
      return {};
    }
  }

  /**
   * Check if session has open sell orders
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} - Object with hasOpenSells and details
   */
  async hasOpenSells(sessionId) {
    try {
      const openSells = await this.getOpenOrders(sessionId, 'sell');
      
      return {
        hasOpenSells: openSells.length > 0,
        details: openSells.length > 0 ? 
          `${openSells.length} open sell orders found` : 
          'No open sell orders',
        openSells: openSells.map(order => ({
          id: order.id,
          status: order.status,
          size: order.size,
          filled: order.filled,
          remaining: order.remaining
        }))
      };
    } catch (error) {
      console.error(`Error checking open sells for session ${sessionId}:`, error.message);
      return {
        hasOpenSells: false,
        details: 'Error checking open sells',
        openSells: []
      };
    }
  }
} 