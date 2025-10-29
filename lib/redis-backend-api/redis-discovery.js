/**
 * RedisDiscovery
 * 
 * Provides methods to discover and categorize Redis keys, particularly
 * those related to a specific session ID.
 */
import { KeyGenerator } from './utils/key-generator.js';
import { SessionManager } from './session-manager.js';

export class RedisDiscovery {
  /**
   * Creates an instance of RedisDiscovery.
   * @param {object} options - Configuration options.
   * @param {object} options.redisAdapter - An instance of RedisAdapter.
   * @param {object} options.logger - A logger instance.
   * @param {object} [options.keyGenerator] - An instance of KeyGenerator (optional).
   */
  constructor({ redisAdapter, logger, keyGenerator = null }) {
    if (!redisAdapter) {
      throw new Error('RedisDiscovery: redisAdapter is required.');
    }
    if (!logger) {
      throw new Error('RedisDiscovery: logger is required.');
    }
    this.redisAdapter = redisAdapter;
    this.logger = logger.createChild ? logger.createChild('RedisDiscovery') : logger;
    this.keyGenerator = keyGenerator;
  }

  /**
   * Find all Redis keys associated with a session ID using SessionManager.
   * This is much more efficient than wildcard scanning.
   * @param {string} sessionId - The session ID to search for.
   * @returns {Promise<string[]>} Array of Redis keys associated with the session.
   */
  async getKeysBySessionId(sessionId) {
    if (!sessionId) {
      throw new Error('SessionId is required for key discovery');
    }

    this.logger.info(`Using SessionManager to find keys for session ${sessionId}`);

    try {
      // Use SessionManager to get all keys for this session
      const sessionKeys = await SessionManager.getSessionKeys({
        redis: this.redisAdapter.client || this.redisAdapter, // Handle both wrapped and direct clients
        sessionId,
        includeHistory: false,
        logger: this.logger
      });

      if (!sessionKeys) {
        this.logger.warn(`No session found for ID: ${sessionId}`);
        return [];
      }

      // Extract all keys from the categorized result
      const allKeys = sessionKeys.all || [];
      this.logger.info(`Found ${allKeys.length} keys for session ${sessionId} using SessionManager`);
      
      // Log the key components for debugging
      if (sessionKeys.keyComponents) {
        this.logger.debug(`Session key components:`, sessionKeys.keyComponents);
      }
      
      return allKeys;
    } catch (error) {
      this.logger.error(`Error discovering keys for session ${sessionId}: ${error.message}`);
      
      // Fallback to the old wildcard method if SessionManager fails
      this.logger.info(`Falling back to wildcard search for session ${sessionId}`);
      try {
        const pattern = `*${sessionId}*`;
        const keys = await this.redisAdapter.scanKeys(pattern);
        this.logger.info(`Found ${keys.length} keys for session ${sessionId} using fallback pattern "${pattern}".`);
        return keys;
      } catch (fallbackError) {
        this.logger.error(`Fallback key discovery also failed: ${fallbackError.message}`);
        throw error; // Throw the original error
      }
    }
  }

  /**
   * Group Redis keys by their type/purpose.
   * @param {string[]} keys - Array of Redis keys.
   * @returns {Object} Grouped keys by category.
   */
  categorizeKeys(keys) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { session: [], orders: [], fills: [], positions: [], balance: [], unknown: [] };
    }

    const categorized = {
      session: [],
      orders: [],
      fills: [],
      positions: [],
      balance: [],
      unknown: []
    };

    for (const key of keys) {
      let category = 'unknown';
      
      // Extract key suffix/type from key name
      if (key.endsWith(':session')) {
        category = 'session';
      } else if (key.endsWith(':orders')) {
        category = 'orders';
      } else if (key.endsWith(':fills')) {
        category = 'fills';
      } else if (key.endsWith(':positions')) {
        category = 'positions';
      } else if (key.endsWith(':balance')) {
        category = 'balance';
      }

      categorized[category].push(key);
    }

    return categorized;
  }

  /**
   * Enhanced getSessionData using SessionManager for better performance
   */
  async getSessionData(sessionId) {
    let sessionKeys = [];
    let sessionResult = null;
    
    try {
      // First, try to get session data using SessionManager
      sessionResult = await SessionManager.findBySessionId({
        redis: this.redisAdapter.client || this.redisAdapter,
        sessionId,
        logger: this.logger
      });
      
      if (sessionResult) {
        this.logger.debug(`Session found via SessionManager: ${sessionResult.sessionKey}`);
        
        // Now get all related keys
        sessionKeys = await this.getKeysBySessionId(sessionId);
      } else {
        this.logger.warn(`Session ${sessionId} not found via SessionManager`);
      }
    } catch (error) {
      this.logger.warn(`Error using SessionManager for session ${sessionId}: ${error.message}`);
      // Continue with empty array of keys
    }
    
    const categorizedKeys = this.categorizeKeys(sessionKeys);
    
    // Prepare result structure
    const result = {
      sessionId: sessionId,
      sessionInfo: sessionResult?.data || null,
      orders: [],
      fills: [],
      counters: {
        totalKeys: sessionKeys.length,
        session: categorizedKeys.session.length,
        orders: categorizedKeys.orders.length,
        fills: categorizedKeys.fills.length,
        positions: categorizedKeys.positions.length,
        balance: categorizedKeys.balance.length,
        unknown: categorizedKeys.unknown.length
      },
      allKeys: sessionKeys,
      hasSessionData: categorizedKeys.session.length > 0,
      hasOrdersData: categorizedKeys.orders.length > 0,
      hasFillsData: categorizedKeys.fills.length > 0,
      ordersCount: 0,
      fillsCount: 0,
      // Add key info if available from SessionManager
      keyInfo: sessionResult?.keyInfo || null,
      sessionKey: sessionResult?.sessionKey || null
    };

    // Get orders data (keeping existing logic since it works)
    if (categorizedKeys.orders.length > 0) {
      const ordersKey = categorizedKeys.orders[0];
      try {
        const ordersData = await this.redisAdapter.hgetall(ordersKey);
        if (ordersData && Object.keys(ordersData).length > 0) {
          const orderObjects = this._processHashData(ordersData, 'order');
          result.orders = orderObjects;
          result.ordersCount = orderObjects.length;
        }
      } catch (error) {
        this.logger.error(`Error getting orders data from ${ordersKey}: ${error.message}`);
      }
    }

    // Get fills data (keeping existing logic but improved)
    if (categorizedKeys.fills.length > 0) {
      const fillsKey = categorizedKeys.fills[0];
      try {
        // Try hgetall first, fallback to lrange if needed (for fills stored as lists)
        let fillsData = await this.redisAdapter.hgetall(fillsKey);
        
        if (!fillsData || Object.keys(fillsData).length === 0) {
          // Fallback to lrange for list-based fills storage
          try {
            const fillsList = await this.redisAdapter.lrange(fillsKey, 0, -1);
            if (fillsList && fillsList.length > 0) {
              const fillObjects = fillsList.map(fillJson => {
                try {
                  return JSON.parse(fillJson);
                } catch (e) {
                  this.logger.warn(`Error parsing fill JSON: ${e.message}`);
                  return null;
                }
              }).filter(Boolean);
              
              result.fills = fillObjects;
              result.fillsCount = fillObjects.length;
            }
          } catch (lrangeError) {
            this.logger.error(`Error getting fills as list from ${fillsKey}: ${lrangeError.message}`);
          }
        } else {
          // Process as hash
          const fillObjects = this._processHashData(fillsData, 'fill');
          result.fills = fillObjects;
          result.fillsCount = fillObjects.length;
        }
      } catch (error) {
        this.logger.error(`Error getting fills data from ${fillsKey}: ${error.message}`);
      }
    }

    return result;
  }

  /**
   * Helper method to process hash data (orders/fills)
   * @private
   */
  _processHashData(hashData, dataType) {
    const objects = [];
    
    if (Array.isArray(hashData)) {
      // Process array format [key1, value1, key2, value2, ...]
      for (let i = 0; i < hashData.length; i += 2) {
        try {
          if (i + 1 < hashData.length && hashData[i+1]) {
            const objectJson = hashData[i+1];
            if (objectJson && typeof objectJson === 'string') {
              const obj = JSON.parse(objectJson);
              objects.push(obj);
            }
          }
        } catch (e) {
          this.logger.warn(`Error parsing ${dataType} JSON at index ${i+1}: ${e.message}`);
        }
      }
    } else {
      // Process object format {key1: value1, key2: value2, ...}
      for (const [objKey, objectJson] of Object.entries(hashData)) {
        try {
          if (objectJson && typeof objectJson === 'string') {
            const obj = JSON.parse(objectJson);
            objects.push(obj);
          }
        } catch (e) {
          this.logger.warn(`Error parsing ${dataType} JSON for ${objKey}: ${e.message}`);
        }
      }
    }
    
    return objects;
  }

  /**
   * Extract key components from a Redis key using KeyGenerator static method
   * @param {string} key - The Redis key to parse
   * @returns {Object|null} - Object with key components or null
   */
  parseKey(key) {
    return KeyGenerator.parseKey(key);
  }
} 