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

const POSTGRESQL_URL_TLS_PARAMETERS = [
  'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat',
];

export function resolvePostgreSQLSSL(connectionString, ca) {
  const parsed = new URL(connectionString);
  const configuredHosts = parsed.searchParams.getAll('host');
  if (configuredHosts.length > 1) {
    throw new Error('PostgreSQL connection URL must not contain duplicate host parameters');
  }
  // Query parameters override URL authority fields in pg-connection-string.
  // Base the plaintext exception on the host pg will actually connect to.
  const effectiveHost = configuredHosts[0] || parsed.hostname;
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(effectiveHost);
  const sslMode = parsed.searchParams.get('sslmode');
  if (isLocal && (sslMode === null || sslMode === 'disable')) return false;
  if (sslMode === 'disable') {
    throw new Error('sslmode=disable is only permitted for local PostgreSQL connections');
  }
  if (ca !== undefined && (typeof ca !== 'string' || ca.trim() === '')) {
    throw new Error('PostgreSQL TLS CA must be a non-empty PEM string when provided');
  }
  return ca === undefined ? { rejectUnauthorized: true } : { rejectUnauthorized: true, ca };
}

/**
 * node-postgres reparses connectionString after merging explicit options, so
 * URL TLS parameters can silently replace an already-verified `ssl` object.
 * Resolve policy from the original URL, then remove every TLS parameter that
 * pg-connection-string understands before handing the URL to Pool or Client.
 */
export function resolvePostgreSQLConnectionConfig(connectionString, ca) {
  const ssl = resolvePostgreSQLSSL(connectionString, ca);
  const parsed = new URL(connectionString);
  for (const parameter of POSTGRESQL_URL_TLS_PARAMETERS) {
    parsed.searchParams.delete(parameter);
  }
  return { connectionString: parsed.toString(), ssl };
}

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
    this.connectionTimeoutMillis = config.connectionTimeoutMillis ?? 10_000;
    this.sslCa = config.sslCa;
    this.monotonicNow = typeof config.monotonicNow === 'function'
      ? config.monotonicNow : () => performance.now();
    if (!Number.isSafeInteger(this.connectionTimeoutMillis) || this.connectionTimeoutMillis < 1) {
      throw new Error('connectionTimeoutMillis must be a positive safe integer');
    }
    this.pool = null;
    this.initialized = false;
    
    // Connection statistics
    this.stats = {
      connectionsOpened: 0,
      queriesExecuted: 0,
      activeQueries: 0,
      queryErrors: 0,
      lastQueryLatencyMs: null,
      maxQueryLatencyMs: 0,
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
      // Local sockets may explicitly use plaintext. Remote connections always
      // verify the server certificate, optionally against an operator-supplied CA.
      const connectionConfig = resolvePostgreSQLConnectionConfig(
        this.connectionString, this.sslCa,
      );

      this.pool = new Pool({
        ...connectionConfig,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: this.connectionTimeoutMillis,
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
    const queryStart = this.monotonicNow();
    this.stats.activeQueries++;
    
    try {
      this.stats.queriesExecuted++;
      const result = await this.pool.query(text, params);
      const duration = this.monotonicNow() - queryStart;
      this.stats.lastQueryLatencyMs = duration;
      this.stats.maxQueryLatencyMs = Math.max(this.stats.maxQueryLatencyMs, duration);
      
      if (duration > 5000) {
        this.logger.warn(`[SLOW QUERY] Query took ${duration}ms`);
      }
      
      return result;
    } catch (error) {
      this.stats.queryErrors += 1;
      throw error;
    } finally {
      this.stats.activeQueries--;
    }
  }

  async boundedQuery(text, params = [], options = {}) {
    const statementTimeoutMs = Number(options.statementTimeoutMs);
    const queryTimeoutMs = Number(options.queryTimeoutMs);
    const lockTimeoutMs = Number(options.lockTimeoutMs);
    if (![statementTimeoutMs, queryTimeoutMs, lockTimeoutMs].every(Number.isSafeInteger) ||
        lockTimeoutMs < 1 || statementTimeoutMs < lockTimeoutMs || queryTimeoutMs < statementTimeoutMs) {
      throw new Error('bounded query timeouts must be safe integers satisfying lock <= statement <= query');
    }
    if (this.connectionTimeoutMillis > queryTimeoutMs) {
      throw new Error('pool acquisition timeout must not exceed bounded query timeout');
    }
    const queryStart = this.monotonicNow();
    const deadlineAt = queryStart + queryTimeoutMs;
    this.stats.activeQueries += 1;
    this.stats.queriesExecuted += 1;
    let client = null;
    let timedQuery = null;
    let beginAttempted = false;
    let transactionOpen = false;
    let commitAttempted = false;
    let discardClient = false;
    try {
      client = await this.pool.connect();
      timedQuery = (queryText, values = []) => {
        const remainingMs = Math.floor(deadlineAt - this.monotonicNow());
        if (remainingMs < 1) throw new Error('bounded query absolute deadline exceeded');
        return client.query({ text: queryText, values, query_timeout: remainingMs });
      };
      beginAttempted = true;
      await timedQuery('BEGIN');
      transactionOpen = true;
      const lockRemainingMs = Math.max(1, Math.floor(deadlineAt - this.monotonicNow()));
      await timedQuery(`SET LOCAL lock_timeout = '${Math.min(lockTimeoutMs, lockRemainingMs)}ms'`);
      const statementRemainingMs = Math.max(1, Math.floor(deadlineAt - this.monotonicNow()));
      await timedQuery(`SET LOCAL statement_timeout = '${Math.min(statementTimeoutMs, statementRemainingMs)}ms'`);
      // Server-side statement_timeout cancels the database work; node-postgres
      // query_timeout additionally bounds every protocol step in this transaction.
      const result = await timedQuery(text, params);
      commitAttempted = true;
      await timedQuery('COMMIT');
      transactionOpen = false;
      const duration = this.monotonicNow() - queryStart;
      this.stats.lastQueryLatencyMs = duration;
      this.stats.maxQueryLatencyMs = Math.max(this.stats.maxQueryLatencyMs, duration);
      return result;
    } catch (error) {
      this.stats.queryErrors += 1;
      const duration = this.monotonicNow() - queryStart;
      this.stats.lastQueryLatencyMs = duration;
      this.stats.maxQueryLatencyMs = Math.max(this.stats.maxQueryLatencyMs, duration);
      if (commitAttempted || (beginAttempted && !transactionOpen)) discardClient = true;
      if (timedQuery && transactionOpen) {
        try {
          await timedQuery('ROLLBACK');
          transactionOpen = false;
        } catch {
          discardClient = true;
        }
      }
      throw error;
    } finally {
      if (client) {
        if (discardClient || transactionOpen) client.release(true);
        else client.release();
      }
      this.stats.activeQueries -= 1;
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

  async boundedQuery(text, params = [], options = {}) {
    return this.adapter.boundedQuery(text, params, options);
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
    sslCa: env.POSTGRES_SSL_CA || undefined,
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
