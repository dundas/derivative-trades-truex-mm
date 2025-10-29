/**
 * Unified PostgreSQL API
 * 
 * This is the main entry point for the PostgreSQL API that provides
 * a unified interface for all PostgreSQL operations across the 
 * decisive_trades application.
 * 
 * Similar to redis-backend-api, this provides:
 * - Centralized schema management
 * - High-level manager classes
 * - Bulk and individual operations
 * - Consistent field naming and validation
 * 
 * Usage:
 * ```javascript
 * import { PostgreSQLAPI } from './src/lib/postgresql-api/index.js';
 * 
 * const db = new PostgreSQLAPI({ connectionString: process.env.NEON_CONN });
 * await db.initialize();
 * 
 * // Use managers for high-level operations
 * const session = await db.sessions.getSession('session_id');
 * const orders = await db.orders.getOrders('session_id');
 * 
 * // Bulk operations
 * await db.sessions.saveSessionsBulk(sessionArray);
 * await db.orders.saveOrdersBulk(orderArray);
 * ```
 */

import pg from 'pg';
const { Pool } = pg;

// Import schemas
import { 
  POSTGRESQL_SCHEMAS,
  SESSIONS_SCHEMA,
  ORDERS_SCHEMA,
  FILLS_SCHEMA,
  COLUMN_NAMES,
  PRIMARY_KEYS
} from './schemas/index.js';

// Import utilities
import {
  generateCreateTableSQL,
  generateIndexesSQL,
  generateInsertSQL,
  generateBulkInsertSQL,
  generateUpdateSQL,
  generateSelectSQL,
  mapDataToSchema,
  normalizeDataToSchema,
  validateData
} from './utils/sql-generator.js';

// Import managers
import { SessionManager } from './managers/session-manager.js';
import { OrderManager } from './managers/order-manager.js';
import { FillManager } from './managers/fill-manager.js';

/**
 * PostgreSQL Database Adapter
 * Handles connection pooling and query execution
 */
export class PostgreSQLAdapter {
  constructor(config) {
    this.connectionString = config.connectionString;
    this.logger = config.logger || console;
    this.pool = null;
    this.initialized = false;
    
    // Connection statistics
    this.stats = {
      connectionsOpened: 0,
      queriesExecuted: 0,
      activeQueries: 0
    };
  }

  /**
   * Initialize the database connection and ensure tables exist
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      // Create connection pool
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: {
          rejectUnauthorized: false
        }
      });

      // Test connection
      await this.query('SELECT 1');
      
      // Ensure tables exist
      await this.ensureTablesExist();
      
      this.initialized = true;
      this.logger.info('✅ PostgreSQL API initialized successfully');
      
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize PostgreSQL API: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a query using the connection pool
   */
  async query(text, params = []) {
    const queryStart = Date.now();
    this.stats.activeQueries++;
    
    try {
      this.stats.queriesExecuted++;
      const result = await this.pool.query(text, params);
      const duration = Date.now() - queryStart;
      
      if (duration > 5000) {
        this.logger.warn(`[SLOW QUERY] Query took ${duration}ms`);
      }
      
      return result;
    } finally {
      this.stats.activeQueries--;
    }
  }

  /**
   * Execute a transaction
   */
  async transaction(queries) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const results = [];
      for (const { text, params } of queries) {
        const result = await client.query(text, params);
        results.push(result);
      }
      
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ensure all required tables and indexes exist
   */
  async ensureTablesExist() {
    try {
      // Create tables
      for (const schema of Object.values(POSTGRESQL_SCHEMAS)) {
        const createTableSQL = generateCreateTableSQL(schema);
        await this.query(createTableSQL);
        
        // Create indexes
        const indexesSQL = generateIndexesSQL(schema);
        for (const indexSQL of indexesSQL) {
          await this.query(indexSQL);
        }
      }
      
      this.logger.info('✅ All PostgreSQL tables and indexes created successfully');
      return true;
    } catch (error) {
      this.logger.error(`Error ensuring tables exist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats() {
    return {
      totalConnections: this.pool?.totalCount || 0,
      idleConnections: this.pool?.idleCount || 0,
      waitingRequests: this.pool?.waitingCount || 0,
      ...this.stats
    };
  }

  /**
   * Close the connection pool
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
      this.logger.info('PostgreSQL connection pool closed');
    }
  }
}

/**
 * Main PostgreSQL API Class
 * Provides unified access to all PostgreSQL operations
 */
export class PostgreSQLAPI {
  constructor(config) {
    this.adapter = new PostgreSQLAdapter(config);
    
    // Initialize managers
    this.sessions = new SessionManager(this.adapter);
    this.orders = new OrderManager(this.adapter);
    this.fills = new FillManager(this.adapter);
    
    // Expose schemas and utilities for advanced usage
    this.schemas = POSTGRESQL_SCHEMAS;
    this.utils = {
      generateCreateTableSQL,
      generateIndexesSQL,
      generateInsertSQL,
      generateBulkInsertSQL,
      generateUpdateSQL,
      generateSelectSQL,
      mapDataToSchema,
      normalizeDataToSchema,
      validateData
    };
  }

  /**
   * Initialize the API
   */
  async initialize() {
    return this.adapter.initialize();
  }

  /**
   * Execute a raw query
   */
  async query(text, params = []) {
    return this.adapter.query(text, params);
  }

  /**
   * Execute a transaction
   */
  async transaction(queries) {
    return this.adapter.transaction(queries);
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return this.adapter.getPoolStats();
  }

  /**
   * Close the API
   */
  async close() {
    return this.adapter.close();
  }

  /**
   * Bulk operations helper
   * Provides a convenient interface for bulk operations across all managers
   */
  get bulk() {
    return {
      sessions: {
        save: (sessions) => this.sessions.saveSessionsBulk(sessions)
      },
      orders: {
        save: (orders) => this.orders.saveOrdersBulk(orders)
      },
      fills: {
        save: (fills) => this.fills.saveFillsBulk(fills)
      }
    };
  }

  /**
   * Migration helper methods
   * Useful for migration scripts
   */
  get migration() {
    return {
      getMigratedSessions: () => this.sessions.getMigratedSessions(),
      markSessionAsMigrated: (sessionId) => this.sessions.markSessionAsMigrated(sessionId),
      findSessionsToSettle: (options) => this.sessions.findSessionsToSettle(options)
    };
  }

  /**
   * Settlement helper methods
   * Useful for settlement services
   */
  get settlement() {
    return {
      findSessionsToSettle: (options) => this.sessions.findSessionsToSettle(options),
      updateSettlementStatus: (sessionId, isComplete) => 
        this.sessions.updateSessionSettlementStatus(sessionId, isComplete),
      hasOpenSells: (sessionId) => this.orders.hasOpenSells(sessionId),
      getOpenOrders: (sessionId, side) => this.orders.getOpenOrders(sessionId, side)
    };
  }
}

/**
 * Factory function to create a PostgreSQL API instance
 * @param {Object} config - Configuration object
 * @returns {PostgreSQLAPI} - Configured API instance
 */
export function createPostgreSQLAPI(config) {
  return new PostgreSQLAPI(config);
}

/**
 * Factory function to create API from environment
 * @param {Object} env - Environment object (defaults to process.env)
 * @returns {PostgreSQLAPI} - Configured API instance
 */
export function createPostgreSQLAPIFromEnv(env = process.env) {
  // Prefer generic Postgres first (Supabase or self-managed), then fall back to Neon only if needed
  const connectionString = env.DATABASE_URL 
    || env.POSTGRES_URL 
    || env.NEON_CONN 
    || env.NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL, POSTGRES_URL, NEON_CONN or NEON_DATABASE_URL is required');
  }

  // Lightweight debug to know which source is in use
  const source = env.DATABASE_URL ? 'DATABASE_URL' 
    : env.POSTGRES_URL ? 'POSTGRES_URL' 
    : env.NEON_CONN ? 'NEON_CONN' 
    : 'NEON_DATABASE_URL';
  console.log(`[PostgreSQLAPI] Using connection string from ${source}`);

  // Warn if Neon variables are present but not used
  if ((env.NEON_CONN || env.NEON_DATABASE_URL) && (source === 'DATABASE_URL' || source === 'POSTGRES_URL')) {
    console.warn('[PostgreSQLAPI] NEON_* env vars detected but not used; writing to generic Postgres (DATABASE_URL/POSTGRES_URL)');
  }

  return new PostgreSQLAPI({
    connectionString,
    logger: console
  });
}

// Export all schemas and utilities for direct access
export {
  POSTGRESQL_SCHEMAS,
  SESSIONS_SCHEMA,
  ORDERS_SCHEMA,
  FILLS_SCHEMA,
  COLUMN_NAMES,
  PRIMARY_KEYS,
  SessionManager,
  OrderManager,
  FillManager
};

// Export utilities
export * from './utils/sql-generator.js'; 