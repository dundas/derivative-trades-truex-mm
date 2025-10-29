/**
 * Shared Neon connection pool for all services
 * This module provides a singleton connection pool that can be shared
 * across the settlement service, migration service, and other components
 * to prevent connection exhaustion.
 */

import { Pool } from 'pg';

let pool = null;

/**
 * Get or create the shared connection pool
 * @param {string} connectionString - Neon connection string (optional if pool exists)
 * @returns {Pool} The connection pool instance
 */
export function getPool(connectionString = null) {
  if (!pool) {
    const connString = connectionString || process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connString) {
      throw new Error('No PostgreSQL connection string provided. Set DATABASE_URL or POSTGRES_URL');
    }

    // Check if using pooled connection
    const isPooled = connString.includes('-pooler.');
    
    pool = new Pool({
      connectionString: connString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Connection pool settings optimized for pooled connections
      max: isPooled ? 50 : 10, // Lower than frontend since backend services share the pool
      idleTimeoutMillis: 30000, // 30 seconds
      connectionTimeoutMillis: 10000, // 10 seconds
      // For pooled connections, we can be more aggressive with connections
      allowExitOnIdle: true,
    });

    // Add error handler
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
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
    console.error('Error executing query:', error);
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
    console.error('Transaction error:', error);
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
 * This provides a similar interface to the neon() function but uses the pool
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