/**
 * PostgreSQL Session Manager
 * 
 * High-level operations for trading sessions in PostgreSQL.
 * Provides a clean API similar to the redis-backend-api pattern.
 */

import { 
  SESSIONS_SCHEMA,
  ORDERS_SCHEMA,
  FILLS_SCHEMA
} from '../schemas/index.js';
import {
  generateBulkInsertSQL,
  generateInsertSQL,
  generateUpdateSQL,
  generateSelectSQL,
  mapDataToSchema,
  normalizeDataToSchema,
  validateData
} from '../utils/sql-generator.js';

export class SessionManager {
  constructor(dbAdapter) {
    this.db = dbAdapter;
    this.schema = SESSIONS_SCHEMA;
  }

  /**
   * Save a single session
   * @param {Object} sessionData - Session data
   * @returns {Promise<Object>} - Result with id and success status
   */
  async saveSession(sessionData) {
    try {
      // Normalize field names to match schema
      const normalized = normalizeDataToSchema(this.schema, sessionData);
      
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
        id: sessionData.id,
        result: result.rows[0]
      };
      
    } catch (error) {
      return {
        success: false,
        id: sessionData.id,
        error: error.message
      };
    }
  }

  /**
   * Save multiple sessions using bulk insert
   * @param {Array<Object>} sessions - Array of session data
   * @returns {Promise<Object>} - Bulk operation results
   */
  async saveSessionsBulk(sessions) {
    if (!sessions || sessions.length === 0) {
      return { success: 0, failed: 0, results: [] };
    }

    const CHUNK_SIZE = 100;
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < sessions.length; i += CHUNK_SIZE) {
      const chunk = sessions.slice(i, i + CHUNK_SIZE);
      
      try {
        // Normalize and map all session data
        const mappedData = chunk.map(session => {
          const normalized = normalizeDataToSchema(this.schema, session);
          return mapDataToSchema(this.schema, normalized);
        });
        
        const flatParams = mappedData.flat();
        
        // Generate bulk insert SQL
        const sql = generateBulkInsertSQL(this.schema, chunk.length);
        
        const result = await this.db.query(sql, flatParams);
        
        successCount += result.rowCount;
        chunk.forEach((session, idx) => {
          results.push({
            id: session.id,
            success: true,
            result: result.rows[idx]
          });
        });
        
      } catch (error) {
        console.error(`[BULK SESSION INSERT ERROR] Failed to insert ${chunk.length} sessions:`, error.message);
        failedCount += chunk.length;
        
        chunk.forEach((session) => {
          results.push({
            id: session.id,
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
   * Get a session by ID
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object|null>} - Session data or null
   */
  async getSession(sessionId) {
    try {
      const sql = `SELECT * FROM ${this.schema.tableName} WHERE id = $1`;
      const result = await this.db.query(sql, [sessionId]);
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error getting session ${sessionId}:`, error.message);
      return null;
    }
  }

  /**
   * Find sessions that need settlement
   * @param {Object} options - Query options
   * @returns {Promise<Array<Object>>} - Array of sessions
   */
  async findSessionsToSettle(options = {}) {
    const { daysAgo = 2, activeOnly = false } = options;
    const now = Date.now();
    const pastTimestamp = now - (daysAgo * 24 * 60 * 60 * 1000);
    
    try {
      let whereClause = `addedat >= $1 AND (settledcomplete IS NULL OR settledcomplete = false)`;
      const params = [pastTimestamp];
      
      if (activeOnly) {
        whereClause += ` AND status = $2`;
        params.push('active');
      }
      
      const sql = `
        SELECT 
          s.*,
          (
            SELECT COUNT(*) 
            FROM orders o
            WHERE o.sessionid = s.id 
            AND o.side = 'buy' 
            AND o.status = 'filled'
          ) as filled_buy_count,
          (
            SELECT COUNT(*) 
            FROM orders o
            WHERE o.sessionid = s.id 
            AND o.side = 'sell' 
            AND o.status = 'filled'
          ) as filled_sell_count
        FROM ${this.schema.tableName} s
        WHERE ${whereClause}
        ORDER BY 
          s.lastsettleattempt IS NULL DESC,
          s.lastsettleattempt ASC,
          s.addedat DESC
        LIMIT 100
      `;
      
      const result = await this.db.query(sql, params);
      return result.rows;
      
    } catch (error) {
      console.error('Error finding sessions to settle:', error.message);
      throw error;
    }
  }

  /**
   * Update session status
   * @param {string} sessionId - Session ID
   * @param {string} status - New status
   * @param {number} endedAt - Optional end timestamp
   * @returns {Promise<boolean>} - Success status
   */
  async updateSessionStatus(sessionId, status, endedAt = null) {
    try {
      const updateFields = ['status', 'lastupdated'];
      const values = [status, Date.now()];
      
      if (endedAt !== null) {
        updateFields.push('endedat');
        values.push(endedAt);
      }
      
      values.push(sessionId); // Primary key
      
      const sql = generateUpdateSQL(this.schema, updateFields);
      const result = await this.db.query(sql, values);
      
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error updating session status for ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * Update session settlement status
   * @param {string} sessionId - Session ID
   * @param {boolean} isComplete - Whether settlement is complete
   * @returns {Promise<boolean>} - Success status
   */
  async updateSessionSettlementStatus(sessionId, isComplete) {
    try {
      const sql = `
        UPDATE ${this.schema.tableName} 
        SET settledcomplete = $1, lastsettleattempt = $2, lastupdated = $3
        WHERE id = $4
        RETURNING id
      `;
      
      const result = await this.db.query(sql, [
        isComplete,
        Date.now(),
        Date.now(),
        sessionId
      ]);
      
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error updating settlement status for ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * Get sessions by status
   * @param {string} status - Session status
   * @param {number} limit - Maximum results
   * @returns {Promise<Array<Object>>} - Array of sessions
   */
  async getSessionsByStatus(status, limit = 100) {
    try {
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE status = $1 
        ORDER BY addedat DESC 
        LIMIT $2
      `;
      
      const result = await this.db.query(sql, [status, limit]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting sessions by status ${status}:`, error.message);
      return [];
    }
  }

  /**
   * Get recent sessions
   * @param {number} hours - Hours back to look
   * @param {number} limit - Maximum results
   * @returns {Promise<Array<Object>>} - Array of sessions
   */
  async getRecentSessions(hours = 24, limit = 100) {
    try {
      const pastTimestamp = Date.now() - (hours * 60 * 60 * 1000);
      
      const sql = `
        SELECT * FROM ${this.schema.tableName} 
        WHERE addedat >= $1 
        ORDER BY addedat DESC 
        LIMIT $2
      `;
      
      const result = await this.db.query(sql, [pastTimestamp, limit]);
      return result.rows;
    } catch (error) {
      console.error(`Error getting recent sessions:`, error.message);
      return [];
    }
  }

  /**
   * Get migrated sessions
   * @returns {Promise<Array<string>>} - Array of session IDs
   */
  async getMigratedSessions() {
    try {
      const sql = `
        SELECT id, lastmigratedat
        FROM ${this.schema.tableName}
        WHERE lastmigratedat IS NOT NULL
        ORDER BY lastmigratedat DESC
      `;
      
      const result = await this.db.query(sql);
      return result.rows.map(row => row.id) || [];
    } catch (error) {
      console.error('Error getting migrated sessions:', error.message);
      throw error;
    }
  }

  /**
   * Mark session as migrated
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>} - Success status
   */
  async markSessionAsMigrated(sessionId) {
    try {
      const sql = `
        UPDATE ${this.schema.tableName} 
        SET lastmigratedat = $1, lastupdated = $2
        WHERE id = $3
        RETURNING id
      `;
      
      const result = await this.db.query(sql, [
        Date.now(),
        Date.now(),
        sessionId
      ]);
      
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error marking session as migrated ${sessionId}:`, error.message);
      return false;
    }
  }
} 