/**
 * PostgreSQL Fill Manager
 * 
 * High-level operations for trading fills in PostgreSQL.
 * Provides a clean API similar to the redis-backend-api pattern.
 */

import { 
  FILLS_SCHEMA
} from '../schemas/index.js';
import {
  generateBulkInsertSQL,
  generateInsertSQL,
  generateUpdateSQL,
  mapDataToSchema,
  normalizeDataToSchema,
  validateData
} from '../utils/sql-generator.js';

export class FillManager {
  constructor(dbAdapter) {
    this.db = dbAdapter;
    this.schema = FILLS_SCHEMA;
  }

  /**
   * Save a single fill
   * @param {Object} fillData - Fill data
   * @returns {Promise<Object>} - Saved fill data
   */
  async saveFill(fillData) {
    try {
      const normalizedData = normalizeDataToSchema(this.schema, fillData);
      const mappedData = mapDataToSchema(this.schema, normalizedData);
      const validatedData = validateData(this.schema, mappedData);
      
      const sql = generateInsertSQL(this.schema, true); // true for upsert
      const result = await this.db.query(sql, Object.values(validatedData));
      
      return result.rows[0];
    } catch (error) {
      console.error(`Error saving fill ${fillData.id}:`, error.message);
      throw error;
    }
  }

  /**
   * Save multiple fills using bulk insert
   * @param {Array<Object>} fills - Array of fill data
   * @returns {Promise<Object>} - Bulk operation results
   */
  async saveFillsBulk(fills) {
    if (!fills || fills.length === 0) {
      return { success: 0, failed: 0, results: [] };
    }

    const CHUNK_SIZE = 1000; // Fills can handle large chunks
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < fills.length; i += CHUNK_SIZE) {
      const chunk = fills.slice(i, i + CHUNK_SIZE);
      
      try {
        // Normalize and map all fill data with enhanced fee extraction
        const mappedData = chunk.map(fill => {
          // Extract fee data from embedded data before normalization
          const enhancedFill = this._extractFeeData(fill);
          const normalized = normalizeDataToSchema(this.schema, enhancedFill);
          return mapDataToSchema(this.schema, normalized);
        });
        
        const flatParams = mappedData.flat();
        
        // Generate bulk insert SQL
        const sql = generateBulkInsertSQL(this.schema, chunk.length);
        
        const result = await this.db.query(sql, flatParams);
        
        successCount += result.rowCount;
        chunk.forEach((fill, idx) => {
          results.push({
            id: fill.id,
            success: true,
            result: result.rows[idx]
          });
        });
        
      } catch (error) {
        console.error(`[BULK FILL INSERT ERROR] Failed to insert ${chunk.length} fills:`, error.message);
        failedCount += chunk.length;
        
        // Log sample failed fill for debugging
        if (chunk.length > 0) {
          console.error('Sample failed fill:', JSON.stringify(chunk[0], null, 2));
        }
        
        chunk.forEach((fill) => {
          results.push({
            id: fill.id,
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
   * Get all fills for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Array<Object>>} - Array of fills
   */
  async getFillsBySession(sessionId) {
    try {
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE sessionid = $1 
        ORDER BY timestamp DESC
      `;
      
      const result = await this.db.query(sql, [sessionId]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting fills for session ${sessionId}:`, error.message);
      return [];
    }
  }

  /**
   * Get all fills for a specific order
   * @param {string} orderId - Order ID
   * @returns {Promise<Array<Object>>} - Array of fills for the order
   */
  async getFillsByOrder(orderId) {
    try {
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE orderid = $1 
        ORDER BY timestamp DESC
      `;
      
      const result = await this.db.query(sql, [orderId]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting fills for order ${orderId}:`, error.message);
      return [];
    }
  }

  /**
   * Get fill statistics for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} - Fill statistics
   */
  async getFillStats(sessionId) {
    try {
      const sql = `
        SELECT 
          COUNT(*) as total_fills,
          COUNT(CASE WHEN side = 'buy' THEN 1 END) as buy_fills,
          COUNT(CASE WHEN side = 'sell' THEN 1 END) as sell_fills,
          SUM(CASE WHEN side = 'buy' THEN size ELSE 0 END) as total_buy_volume,
          SUM(CASE WHEN side = 'sell' THEN size ELSE 0 END) as total_sell_volume,
          SUM(fee) as total_fees,
          AVG(price) as average_price,
          MIN(price) as min_price,
          MAX(price) as max_price
        FROM ${this.schema.tableName}
        WHERE sessionid = $1
      `;
      
      const result = await this.db.query(sql, [sessionId]);
      return result.rows[0] || {};
    } catch (error) {
      console.error(`Error getting fill stats for session ${sessionId}:`, error.message);
      return {};
    }
  }

  /**
   * Update a fill
   * @param {string} fillId - Fill ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object|null>} - Updated fill or null if not found
   */
  async updateFill(fillId, updateData) {
    try {
      const normalizedData = normalizeDataToSchema(this.schema, updateData);
      const mappedData = mapDataToSchema(this.schema, normalizedData);
      
      // Add lastupdated timestamp
      mappedData.lastupdated = Date.now();
      
      // Generate update SQL dynamically based on provided fields
      const updateFields = Object.keys(mappedData);
      const setClause = updateFields.map((field, index) => `${field} = $${index + 2}`).join(', ');
      const values = [fillId, ...Object.values(mappedData)];
      
      const sql = `
        UPDATE ${this.schema.tableName} 
        SET ${setClause}
        WHERE id = $1 
        RETURNING *
      `;
      
      const result = await this.db.query(sql, values);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error updating fill ${fillId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get a fill by ID
   * @param {string} fillId - Fill ID
   * @returns {Promise<Object|null>} - Fill data or null if not found
   */
  async getFill(fillId) {
    try {
      const sql = `SELECT * FROM ${this.schema.tableName} WHERE id = $1`;
      const result = await this.db.query(sql, [fillId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error getting fill ${fillId}:`, error.message);
      return null;
    }
  }

  /**
   * Extract fee data from various possible locations in fill data
   * @param {Object} fill - Original fill data
   * @returns {Object} - Enhanced fill with extracted fee data
   * @private
   */
  _extractFeeData(fill) {
    const enhancedFill = { ...fill };
    
    // If we already have extracted fee data, return as-is
    if (enhancedFill.feeamount !== undefined && enhancedFill.feeamount !== null) {
      return enhancedFill;
    }

    // Try to extract from embedded data
    const data = fill.data;
    if (!data || typeof data !== 'object') {
      return enhancedFill;
    }

    try {
      // Strategy 1: Direct fields in data
      if (data.feeAmount !== undefined && !enhancedFill.feeamount) {
        enhancedFill.feeamount = parseFloat(data.feeAmount) || null;
        enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
      }

      if (data.cost !== undefined && !enhancedFill.cost) {
        enhancedFill.cost = parseFloat(data.cost) || null;
      }

      if (data.fees !== undefined && !enhancedFill.fees) {
        enhancedFill.fees = data.fees;
        // If fees is an array with USD amounts, extract the amount
        if (Array.isArray(data.fees) && data.fees.length > 0) {
          const usdFee = data.fees.find(f => f.asset === 'USD' || f.currency === 'USD');
          if (usdFee && (usdFee.qty || usdFee.amount) && !enhancedFill.feeamount) {
            enhancedFill.feeamount = parseFloat(usdFee.qty || usdFee.amount) || null;
            enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
          }
        }
      }

      // Strategy 2: From originalRedisFill (migration artifact)
      if (data.originalRedisFill) {
        const original = data.originalRedisFill;
        
        if (original.feeAmount !== undefined && !enhancedFill.feeamount) {
          enhancedFill.feeamount = parseFloat(original.feeAmount) || null;
          enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
        }

        if (original.cost !== undefined && !enhancedFill.cost) {
          enhancedFill.cost = parseFloat(original.cost) || null;
        }

        if (original.fees !== undefined && !enhancedFill.fees) {
          enhancedFill.fees = original.fees;
        }

        // Extract from Redis pricingMetadata.fees in originalRedisFill  
        if (original.pricingMetadata && original.pricingMetadata.fees && !enhancedFill.feeamount) {
          const redisFees = original.pricingMetadata.fees;
          if (redisFees.estimated_amount !== undefined) {
            enhancedFill.feeamount = parseFloat(redisFees.estimated_amount) || null;
            enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
            
            // Store additional fee metadata
            enhancedFill.feedata = {
              currency: redisFees.currency || 'USD',
              amount: enhancedFill.feeamount,
              rate: redisFees.rate || null,
              type: redisFees.type || 'unknown',
              extractedFrom: 'originalRedisFill_pricingMetadata'
            };
          }
        }

        // Extract from fee object structure
        if (original.fee && typeof original.fee === 'object') {
          if (original.fee.amount !== undefined && !enhancedFill.feeamount) {
            enhancedFill.feeamount = parseFloat(original.fee.amount) || null;
            enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
          }
        }
      }

      // Strategy 3: Extract from raw Kraken execution data
      if (data.fee_usd_equiv !== undefined && !enhancedFill.feeamount) {
        enhancedFill.feeamount = parseFloat(data.fee_usd_equiv) || null;
        enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
      }

      // Strategy 4: Extract from Redis pricingMetadata.fees (actual fee data)
      if (!enhancedFill.feeamount && data.pricingMetadata && data.pricingMetadata.fees) {
        const redisFees = data.pricingMetadata.fees;
        if (redisFees.estimated_amount !== undefined) {
          enhancedFill.feeamount = parseFloat(redisFees.estimated_amount) || null;
          enhancedFill.fee = enhancedFill.fee || enhancedFill.feeamount;
          
          // Store additional fee metadata
          enhancedFill.feedata = {
            currency: redisFees.currency || 'USD',
            amount: enhancedFill.feeamount,
            rate: redisFees.rate || null,
            type: redisFees.type || 'unknown',
            extractedFrom: 'redis_pricingMetadata'
          };
        }
      }

      // Create comprehensive fee data object
      if (enhancedFill.feeamount && enhancedFill.cost) {
        const feeRate = enhancedFill.feeamount / enhancedFill.cost;
        enhancedFill.feedata = {
          currency: 'USD',
          amount: enhancedFill.feeamount,
          rate: feeRate,
          extractedFrom: 'data_field',
          extractedAt: Date.now()
        };
      }

    } catch (error) {
      console.error(`[FillManager] Error extracting fee data for fill ${fill.id}:`, error.message);
    }

    return enhancedFill;
  }

  /**
   * Delete a fill
   * @param {string} fillId - Fill ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteFill(fillId) {
    try {
      const sql = `DELETE FROM ${this.schema.tableName} WHERE id = $1`;
      const result = await this.db.query(sql, [fillId]);
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error deleting fill ${fillId}:`, error.message);
      return false;
    }
  }
} 