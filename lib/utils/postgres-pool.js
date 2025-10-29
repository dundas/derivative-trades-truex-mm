/**
 * Shared PostgreSQL connection pool for all services
 * This module provides a singleton connection pool that can be shared
 * across all services to prevent connection exhaustion.
 * Works with any PostgreSQL provider (Supabase, AWS RDS, etc.)
 */

import { Pool } from 'pg';

let pool = null;

/**
 * Get connection string from environment variables
 * Tries multiple environment variables for maximum compatibility
 * @returns {string|null} Connection string
 */
function getConnectionString(providedConnectionString = null) {
  return providedConnectionString || 
         process.env.DATABASE_URL ||
         process.env.POSTGRES_URL || 
         process.env.POSTGRESQL_URL ||
         // Backward compatibility with Neon
         process.env.NEON_CONN || 
         process.env.NEON_DATABASE_URL;
}

/**
 * Get or create the shared connection pool
 * @param {string} connectionString - PostgreSQL connection string (optional if pool exists)
 * @returns {Pool} The connection pool instance
 */
export function getPool(connectionString = null) {
  if (!pool) {
    const connString = getConnectionString(connectionString);
    if (!connString) {
      throw new Error('No PostgreSQL connection string provided. Set DATABASE_URL, POSTGRES_URL, or legacy NEON_CONN environment variable.');
    }

    // Detect pooled connections (works for Supabase, Neon, and other providers)
    const isPooled = connString.includes('-pooler.') || connString.includes('pooler.') || connString.includes('pgbouncer');
    
    pool = new Pool({
      connectionString: connString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Connection pool settings optimized for different connection types
      max: isPooled ? 50 : 20, // Higher for pooled connections
      idleTimeoutMillis: 30000, // 30 seconds
      connectionTimeoutMillis: 10000, // 10 seconds
      // Allow the process to exit when all clients are idle
      allowExitOnIdle: true,
    });

    // Add error handler
    pool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client', err);
    });
    
    // Log successful connection (without exposing credentials)
    const dbHost = new URL(connString).hostname;
    console.log(`PostgreSQL pool initialized for ${dbHost}`);
  }
  
  return pool;
}

/**
 * Execute a query using the pool
 * @param {string} queryText - The SQL query
 * @param {Array} params - Query parameters
 * @param {string} connectionString - Optional connection string
 * @returns {Promise<Object>} Query result
 */
export async function query(queryText, params = [], connectionString = null) {
  const pool = getPool(connectionString);
  let client;
  
  try {
    client = await pool.connect();
    const result = await client.query(queryText, params);
    return result;
  } catch (error) {
    console.error('Error executing PostgreSQL query:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Execute a transaction using the pool
 * @param {Function} callback - Async function that receives the client
 * @param {string} connectionString - Optional connection string
 * @returns {Promise<any>} Transaction result
 */
export async function transaction(callback, connectionString = null) {
  const pool = getPool(connectionString);
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    try {
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('PostgreSQL transaction error:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Get pool statistics
 * @returns {Object} Pool statistics
 */
export function getPoolStats() {
  if (!pool) {
    return { status: 'not initialized' };
  }
  
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/**
 * End the pool (for cleanup)
 * @returns {Promise<void>}
 */
export async function endPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * SQL template tag function for safe query building
 * This provides a similar interface to the neon() function but uses the standard pg pool
 * @param {string} connectionString - Optional connection string
 * @returns {Function} SQL template tag function
 */
export function sql(connectionString = null) {
  return async (strings, ...values) => {
    // Build the query text with placeholders
    let queryText = strings[0];
    for (let i = 0; i < values.length; i++) {
      queryText += `$${i + 1}${strings[i + 1]}`;
    }
    
    const result = await query(queryText, values, connectionString);
    return result.rows;
  };
}

// Export a default sql function using environment connection
export const defaultSql = sql();

// Backward compatibility exports
export { getPool as getNeonPool };
export { query as neonQuery };
export { transaction as neonTransaction };