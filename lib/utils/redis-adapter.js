/**
 * Redis Client Adapter
 * 
 * This adapter ensures compatibility between the RedisClient class and components
 * that expect different method naming conventions.
 */

import RedisClient from './redis-client.js'; // Reverted to original relative path
// import RedisClient from 'file:///Users/kefentse/dev_env/decisive_trades/src/lib/utils/redis-client.js'; // Temporary absolute path for diagnostics

/**
 * Pipeline class for batched Redis operations
 */
class Pipeline {
  constructor(redisAdapter) {
    this.redisAdapter = redisAdapter;
    this.operations = [];
  }
  
  /**
   * Add a GET operation to the pipeline
   * @param {string} key - The key to get
   * @returns {Pipeline} - The pipeline instance for chaining
   */
  get(key) {
    this.operations.push({ type: 'get', key });
    return this;
  }
  
  /**
   * Add an LRANGE operation to the pipeline
   * @param {string} key - The list key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @returns {Pipeline} - The pipeline instance for chaining
   */
  lrange(key, start, stop) {
    this.operations.push({ type: 'lrange', key, start, stop });
    return this;
  }
  
  /**
   * Execute all operations in the pipeline
   * @returns {Promise<Array>} - Array of results for each operation
   */
  async exec() {
    const results = [];
    
    // Execute each operation in sequence
    // In a real pipeline, these would be sent as a batch to Redis
    for (const op of this.operations) {
      try {
        if (op.type === 'get') {
          const result = await this.redisAdapter.get(op.key);
          results.push(result);
        } else if (op.type === 'lrange') {
          const result = await this.redisAdapter.lrange(op.key, op.start, op.stop);
          results.push(result);
        }
      } catch (error) {
        results.push(null); // Push null for failed operations
      }
    }
    
    return results;
  }
}

/**
 * Creates a Redis client adapter that provides lowercase method names
 * for compatibility with components that expect them.
 */
export class RedisAdapter {
  constructor(options = {}) {
    // Create the underlying Redis client
    this.client = new RedisClient(options);
    console.log(`[DEBUG][RedisAdapterConstructor] Checking this.client.rpush: ${typeof this.client.rpush}`);
    
    // Map of lowercase method names to actual methods (excluding hash commands now)
    this.methodMap = {
      'get': this.client.get.bind(this.client),
      'set': this.client.set.bind(this.client),
      'del': this.client.del.bind(this.client),
      'smembers': this.client.smembers.bind(this.client),
      'sadd': this.client.sadd.bind(this.client),
      'srem': this.client.srem.bind(this.client),
      'sismember': this.client.sismember.bind(this.client),
      'rpush': this.client.rpush?.bind(this.client),
      'lpush': this.client.lpush?.bind(this.client),
      'lrange': this.client.lRange?.bind(this.client),
      'llen': this.client.llen?.bind(this.client) || this.client.lLen?.bind(this.client),
      'rpop': this.client.rpop?.bind(this.client),
      'lpop': this.client.lpop?.bind(this.client),
      'brpop': this.client.brpop?.bind(this.client),
      'hsetnx': this.client.hsetnx?.bind(this.client) || this.client.hSetNx?.bind(this.client),
      'keys': this.client.keys?.bind(this.client),
      '_command': this.client._command?.bind(this.client),
      'disconnect': this.client.disconnect?.bind(this.client) || this.client.quit?.bind(this.client),
      // Add sorted set methods
      'zadd': this.client.zadd?.bind(this.client) || this.client.zAdd?.bind(this.client),
      'zrange': this.client.zrange?.bind(this.client) || this.client.zRange?.bind(this.client),
      'zcard': this.client.zcard?.bind(this.client) || this.client.zCard?.bind(this.client),
      'zrem': this.client.zrem?.bind(this.client) || this.client.zRem?.bind(this.client),
      'zrangebyscore': this.client.zrangebyscore?.bind(this.client) || this.client.zRangeByScore?.bind(this.client),
      'zremrangebyscore': this.client.zremrangebyscore?.bind(this.client) || this.client.zRemRangeByScore?.bind(this.client),
      // Add exists method
      'exists': this.client.exists?.bind(this.client) || this.client.exists?.bind(this.client),
      // Add type method
      'type': this.client.type?.bind(this.client),
      // Add expire method
      'expire': this.client.expire?.bind(this.client),
      // Add TTL method
      'ttl': this.client.ttl?.bind(this.client),
      // Add hgetall method
      'hgetall': this.client.hGetAll?.bind(this.client) || this.client.hgetall?.bind(this.client)
    };
    
    // Track initialization status
    this.initialized = true;
    
    // Track error state
    this.lastError = null;
    this.errorCount = 0;
  }
  
  /**
   * Create a pipeline for batch operations
   * @returns {Pipeline} - A new pipeline instance
   */
  pipeline() {
    return new Pipeline(this);
  }
  
  /**
   * Handle Redis errors consistently
   * @private
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
   * @returns {any} Default return value for the failed operation
   */
  _handleError(error, operation) {
    this.lastError = error;
    this.errorCount++;
    
    console.error(`Redis ${operation} error:`, error.message);
    
    // Check if we should exit on Redis error
    if (process.env.EXIT_ON_REDIS_ERROR === 'true') {
      console.error('EXIT_ON_REDIS_ERROR is set to true. Exiting process...');
      process.exit(1);
    }
    
    // Return appropriate default value based on operation type
    switch (operation) {
      case 'get':
        return null;
      case 'set':
      case 'setex':
        return false;
      case 'del':
      case 'sadd':
      case 'srem':
      case 'publish':
        return 0;
      case 'smembers':
      case 'lrange':
        return [];
      case 'sismember':
        return false;
      default:
        return null;
    }
  }
  
  /**
   * Get a value from Redis by key
   * @param {string} key - The key to retrieve
   * @returns {Promise<any>} The value stored at the key
   */
  async get(key) {
    if (!this.methodMap['get']) {
      return this._handleError(new Error('Redis get method not available'), 'get');
    }
    
    try {
      return await this.methodMap['get'](key);
    } catch (error) {
      return this._handleError(error, 'get');
    }
  }

  /**
   * Find keys matching a pattern
   * @param {string} pattern - The pattern to match keys against
   * @returns {Promise<Array>} Array of matching keys
   */
  async keys(pattern) {
    if (!this.methodMap['keys']) {
      return this._handleError(new Error('Redis keys method not available'), 'keys');
    }
    
    try {
      const result = await this.methodMap['keys'](pattern);
      return result || [];
    } catch (error) {
      return this._handleError(error, 'keys');
    }
  }
  
  /**
   * Set a value in Redis
   * @param {string} key - The key to set
   * @param {any} value - The value to store
   * @param {Object} options - Additional options like expiry
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, options) {
    if (!this.methodMap['set']) {
      return this._handleError(new Error('Redis set method not available'), 'set');
    }
    
    try {
      return await this.methodMap['set'](key, value, options);
    } catch (error) {
      return this._handleError(error, 'set');
    }
  }
  
  /**
   * Delete a key from Redis
   * @param {string} key - The key to delete
   * @returns {Promise<number>} Number of keys deleted
   */
  async del(key) {
    if (!this.methodMap['del']) {
      return this._handleError(new Error('Redis del method not available'), 'del');
    }
    
    try {
      return await this.methodMap['del'](key);
    } catch (error) {
      return this._handleError(error, 'del');
    }
  }
  
  /**
   * Get all members of a set
   * @param {string} key - The set key
   * @returns {Promise<Array>} Members of the set
   */
  async smembers(key) {
    if (!this.methodMap['smembers']) {
      return this._handleError(new Error('Redis smembers method not available'), 'smembers');
    }
    
    try {
      return await this.methodMap['smembers'](key);
    } catch (error) {
      return this._handleError(error, 'smembers');
    }
  }
  
  /**
   * Add a member to a set
   * @param {string} key - The set key
   * @param {string} member - The member to add
   * @returns {Promise<number>} Number of members added
   */
  async sadd(key, member) {
    if (!this.methodMap['sadd']) {
      return this._handleError(new Error('Redis sadd method not available'), 'sadd');
    }
    
    try {
      return await this.methodMap['sadd'](key, member);
    } catch (error) {
      return this._handleError(error, 'sadd');
    }
  }
  
  /**
   * Remove a member from a set
   * @param {string} key - The set key
   * @param {string} member - The member to remove
   * @returns {Promise<number>} Number of members removed
   */
  async srem(key, member) {
    if (!this.methodMap['srem']) {
      return this._handleError(new Error('Redis srem method not available'), 'srem');
    }
    
    try {
      return await this.methodMap['srem'](key, member);
    } catch (error) {
      return this._handleError(error, 'srem');
    }
  }
  
  /**
   * Check if a member exists in a set
   * @param {string} key - The set key
   * @param {string} member - The member to check
   * @returns {Promise<boolean>} True if member exists in set
   */
  async sismember(key, member) {
    if (!this.methodMap['sismember']) {
      return this._handleError(new Error('Redis sismember method not available'), 'sismember');
    }
    
    try {
      return await this.methodMap['sismember'](key, member);
    } catch (error) {
      return this._handleError(error, 'sismember');
    }
  }
  
  /**
   * Get TTL (time to live) of a key
   * @param {string} key - The key to check TTL for
   * @returns {Promise<number>} TTL in seconds, -1 if no expiry, -2 if key doesn't exist
   */
  async ttl(key) {
    if (!this.methodMap['ttl']) {
      return this._handleError(new Error('Redis ttl method not available'), 'ttl');
    }
    
    try {
      return await this.methodMap['ttl'](key);
    } catch (error) {
      return this._handleError(error, 'ttl');
    }
  }
  
  /**
   * Check connection to Redis
   * @returns {Promise<string>} Pong response
   */
  async ping() {
    if (!this.methodMap['ping']) {
      return this._handleError(new Error('Redis ping method not available'), 'ping');
    }
    
    try {
      return await this.methodMap['ping']();
    } catch (error) {
      return this._handleError(error, 'ping');
    }
  }
  
  /**
   * Publish a message to a channel
   * @param {string} channel - The channel to publish to
   * @param {string} message - The message to publish
   * @returns {Promise<number>} Number of clients that received the message
   */
  async publish(channel, message) {
    if (!this.methodMap['publish']) {
      return this._handleError(new Error('Redis publish method not available'), 'publish');
    }
    
    try {
      return await this.methodMap['publish'](channel, message);
    } catch (error) {
      return this._handleError(error, 'publish');
    }
  }
  
  /**
   * Subscribe to a channel
   * @param {string} channel - The channel to subscribe to
   * @param {Function} callback - Callback to handle messages
   * @returns {Promise<void>}
   */
  async subscribe(channel, callback) {
    if (!this.methodMap['subscribe']) {
      this._handleError(new Error('Redis subscribe method not available'), 'subscribe');
      return;
    }
    
    try {
      return await this.methodMap['subscribe'](channel, callback);
    } catch (error) {
      this._handleError(error, 'subscribe');
    }
  }
  
  /**
   * Unsubscribe from a channel
   * @param {string} channel - The channel to unsubscribe from
   * @returns {Promise<void>}
   */
  async unsubscribe(channel) {
    if (!this.methodMap['unsubscribe']) {
      this._handleError(new Error('Redis unsubscribe method not available'), 'unsubscribe');
      return;
    }
    
    try {
      return await this.methodMap['unsubscribe'](channel);
    } catch (error) {
      this._handleError(error, 'unsubscribe');
    }
  }
  
  /**
   * Disconnect from Redis
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.methodMap['disconnect']) {
      console.warn('[RedisAdapter] No disconnect method available, using no-op implementation');
      return Promise.resolve();
    }
    
    try {
      return await this.methodMap['disconnect']();
    } catch (error) {
      console.warn(`[RedisAdapter] Error during disconnect: ${error.message}`);
      return Promise.resolve();
    }
  }
  
  /**
   * Get a range of elements from a list
   * @param {string} key - The list key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @returns {Promise<Array>} Range of elements
   */
  async lrange(key, start, stop) {
    if (!this.methodMap['lrange']) {
      return this._handleError(new Error('Redis lrange method not available'), 'lrange');
    }
    
    try {
      const result = await this.methodMap['lrange'](key, start, stop);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      return this._handleError(error, 'lrange');
    }
  }
  
  /**
   * Get the length of a list
   * @param {string} key - The list key
   * @returns {Promise<number>} Length of the list
   */
  async llen(key) {
    if (!this.methodMap['llen']) {
      return this._handleError(new Error('Redis llen method not available'), 'llen');
    }
    
    try {
      const result = await this.methodMap['llen'](key);
      return typeof result === 'number' ? result : 0;
    } catch (error) {
      return this._handleError(error, 'llen');
    }
  }
  
  /**
   * Prepend one or multiple values to a list
   * @param {string} key - The key of the list
   * @param  {...any} values - The values to prepend
   * @returns {Promise<number>} The length of the list after the push operation
   */
  async lpush(key, ...values) {
    if (this.client && typeof this.client.lpush === 'function') {
      return this.client.lpush(key, ...values);
    }
    if (this.client && typeof this.client.lPush === 'function') {
      return this.client.lPush(key, ...values);
    }
    if (this.methodMap && typeof this.methodMap['lpush'] === 'function') {
      return this.methodMap['lpush'](key, ...values);
    }
    throw new Error('[RedisAdapter] lpush not implemented on client');
  }

  /**
   * Remove and return the last element in a list
   * @param {string} key - The key of the list
   * @returns {Promise<string|null>} The value of the last element, or null when key does not exist
   */
  async rpop(key) {
    if (this.client && typeof this.client.rpop === 'function') {
      return this.client.rpop(key);
    }
    if (this.methodMap && typeof this.methodMap['rpop'] === 'function') {
      return this.methodMap['rpop'](key);
    }
    throw new Error('[RedisAdapter] rpop not implemented on client');
  }

  /**
   * Remove and return the first element in a list
   * @param {string} key - The key of the list
   * @returns {Promise<string|null>} The value of the first element, or null when key does not exist
   */
  async lpop(key) {
    if (this.client && typeof this.client.lpop === 'function') {
      return this.client.lpop(key);
    }
    if (this.methodMap && typeof this.methodMap['lpop'] === 'function') {
      return this.methodMap['lpop'](key);
    }
    throw new Error('[RedisAdapter] lpop not implemented on client');
  }

  /**
   * Remove elements from a list
   * @param {string} key
   * @param {number} count
   * @param {string} value
   * @returns {Promise<number>} number of removed elements
   */
  async lrem(key, count, value) {
    if (this.client && typeof this.client.lrem === 'function') {
      return this.client.lrem(key, count, value);
    }
    if (this.client && typeof this.client.lRem === 'function') {
      return this.client.lRem(key, count, value);
    }
    if (this.methodMap && typeof this.methodMap['lrem'] === 'function') {
      return this.methodMap['lrem'](key, count, value);
    }
    if (this.client && typeof this.client._command === 'function') {
      return this.client._command('LREM', key, String(count), value);
    }
    throw new Error('[RedisAdapter] lrem not implemented on client');
  }

  /**
   * Remove and return an element from the end of list(s) - blocking version
   * @param {...any} args - Keys followed by timeout
   * @returns {Promise<Array|null>} [key, element] or null if timeout
   */
  async brpop(...args) {
    if (this.client && typeof this.client.brpop === 'function') {
      return this.client.brpop(...args);
    }
    if (this.methodMap && typeof this.methodMap['brpop'] === 'function') {
      return this.methodMap['brpop'](...args);
    }
    throw new Error('[RedisAdapter] brpop not implemented on client');
  }
  
  /**
   * Set key with expiration
   * @param {string} key - The key to set
   * @param {number} seconds - Expiration time in seconds
   * @param {any} value - The value to store
   * @returns {Promise<boolean>} Success status
   */
  /**
   * Set a value in Redis with expiration time
   * @param {string} key - The key to set
   * @param {number} seconds - Expiration time in seconds
   * @param {any} value - The value to store
   * @returns {Promise<boolean>} Success status
   */
  async setex(key, seconds, value) {
    if (!this.methodMap['setex']) {
      console.error('Redis setex method not available, falling back to set with EX option');
      if (!this.methodMap['set']) {
        return this._handleError(new Error('Redis set method not available'), 'setex');
      }
      
      try {
        // Use the set method with EX option
        console.log(`[RedisAdapter] Using set with EX instead of setex for key ${key}`);
        return await this.methodMap['set'](key, value, 'EX', seconds);
      } catch (error) {
        return this._handleError(error, 'setex');
      }
    }
    
    try {
      console.log(`[RedisAdapter] Using setex for key ${key} with TTL ${seconds}s`);
      // Use the setex method directly - important to pass parameters in the correct order
      return await this.methodMap['setex'](key, seconds, value);
    } catch (error) {
      return this._handleError(error, 'setex');
    }
  }
  
  // Explicitly define forwarding methods for HASH and LIST operations
  // This makes it clearer and ensures we are calling the methods on this.client
  // if they exist (checking for the correct camelCase names).

  async hsetnx(key, field, value) {
    // Check for direct lowercase hsetnx on the client (e.g., Upstash client)
    if (this.client && typeof this.client.hsetnx === 'function') {
      return this.client.hsetnx(key, field, value);
    }
    // Fallback: Check for camelCase HSetNx on the client
    if (this.client && typeof this.client.hSetNx === 'function') {
      this.logger?.warn(`[WARN][RedisAdapter.hsetnx] Direct client method 'hsetnx' (lowercase) missing, using 'hSetNx' (camelCase) for key: ${key}, field: ${field}`);
      return this.client.hSetNx(key, field, value);
    }
    // Fallback to methodMap (which should now also prefer lowercase)
    if (this.methodMap && typeof this.methodMap['hsetnx'] === 'function') {
      this.logger?.warn(`[WARN][RedisAdapter.hsetnx] Direct client methods (hsetnx/hSetNx) missing, using methodMap fallback for key: ${key}, field: ${field}`);
      return await this.methodMap['hsetnx'](key, field, value);
    }
    this.logger?.error('[RedisAdapter] hsetnx method not available on underlying client (checked hsetnx, hSetNx) or in methodMap', { key, field });
    throw new Error('[RedisAdapter] hsetnx not implemented on client (checked hsetnx, hSetNx)');
  }

  /**
   * Get the value of a hash field.
   * @param {string} key - The key of the hash.
   * @param {string} field - The field name.
   * @returns {Promise<string|null>} The value or null.
   */
  async hget(key, field) {
    // Try multiple method names to support different Redis clients (Upstash uses lowercase)
    const hGetMethod = this.client.hGet || this.client.hget || this.client.hGet;
    
    if (!this.client || !hGetMethod) {
      return this._handleError(new Error('Redis hGet method not available on underlying client'), 'hget');
    }
    try {
      // Call the method bound to the client
      return await hGetMethod.call(this.client, key, field);
    } catch (error) {
      return this._handleError(error, 'hget');
    }
  }

  /**
   * Get all fields and values in a hash. (lowercase alias for hGetAll)
   * @param {string} key - The key of the hash.
   * @returns {Promise<Object|null>} An object representing the hash, or null on error/not found.
   */
  async hgetall(key) {
    return this.hGetAll(key);
  }

  /**
   * Get all fields and values in a hash.
   * @param {string} key - The key of the hash.
   * @returns {Promise<Object|null>} An object representing the hash, or null on error/not found.
   */
  async hGetAll(key) {
    // Try multiple method names to support different Redis clients (Upstash uses lowercase)
    const hGetAllMethod = this.client.hGetAll || this.client.hgetall || this.client.hgetAll;
    
    if (!this.client || !hGetAllMethod) {
      // Attempt fallback via generic command if available
      if (typeof this.client._command === 'function') {
        console.warn('[RedisAdapter] hGetAll not found, attempting fallback via _command');
        try {
          // Upstash _command often returns flat array [field1, value1, ...]
          const flatResult = await this.client._command('HGETALL', key);
          if (!Array.isArray(flatResult)) {
            console.error('[RedisAdapter] _command HGETALL did not return an array', flatResult);
            return this._handleError(new Error('_command HGETALL failed'), 'hgetall');
          }
          // Convert flat array to object
          const objResult = {};
          for (let i = 0; i < flatResult.length; i += 2) {
            if (typeof flatResult[i] !== 'undefined' && typeof flatResult[i+1] !== 'undefined') {
              objResult[flatResult[i]] = flatResult[i+1];
            }
          }
          return objResult;
        } catch(cmdError) {
          return this._handleError(cmdError, 'hgetall_command_fallback');
        }
      } else {
        return this._handleError(new Error('Redis hGetAll method not available on underlying client and no _command fallback'), 'hgetall');
      }
    }
    try {
      // Call the method bound to the client
      return await hGetAllMethod.call(this.client, key);
    } catch (error) {
      return this._handleError(error, 'hGetAll');
    }
  }

  /**
   * Set the value of a hash field.
   * @param {string} key - The key of the hash.
   * @param {string} field - The field name.
   * @param {string} value - The value to set.
   * @returns {Promise<number>} 1 if field is new, 0 if field was updated.
   */
  async hset(key, field, value) {
    try {
      // Support object form: hset(key, { field1: val1, field2: val2 })
      if (field && typeof field === 'object' && !Array.isArray(field)) {
        const entries = Object.entries(field);
        // Prefer pipeline to reduce round trips
        const pipe = this.pipeline();
        for (const [f, v] of entries) {
          const stringValue = typeof v === 'string' ? v : JSON.stringify(v);
          // Use direct client if available, else fallback to methodMap
          if (this.client && typeof this.client.hset === 'function') {
            // ioredis/Valkey lowercase method
            await this.client.hset(key, f, stringValue);
          } else if (this.client && typeof this.client.hSet === 'function') {
            await this.client.hSet(key, f, stringValue);
          } else if (this.methodMap && typeof this.methodMap['hset'] === 'function') {
            await this.methodMap['hset'](key, f, stringValue);
          } else if (this.client && typeof this.client._command === 'function') {
            await this.client._command('HSET', key, f, stringValue);
          } else {
            return this._handleError(new Error('Redis hSet method not available on underlying client'), 'hset');
          }
        }
        return entries.length; // mimic number of fields set/updated
      }

      // Regular form: hset(key, field, value)
      if (!this.client && !this.methodMap) {
        return this._handleError(new Error('Redis hset method not available on underlying client'), 'hset');
      }
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      if (this.client && typeof this.client.hset === 'function') {
        return await this.client.hset(key, field, stringValue);
      }
      if (this.client && typeof this.client.hSet === 'function') {
        return await this.client.hSet(key, field, stringValue);
      }
      if (this.methodMap && typeof this.methodMap['hset'] === 'function') {
        return await this.methodMap['hset'](key, field, stringValue);
      }
      if (this.client && typeof this.client._command === 'function') {
        return await this.client._command('HSET', key, field, stringValue);
      }
      return this._handleError(new Error('Redis hset/hSet not available'), 'hset');
    } catch (error) {
      return this._handleError(error, 'hset');
    }
  }

  /**
   * Alias for hset with camelCase naming
   */
  async hSet(key, field, value) {
    return this.hset(key, field, value);
  }

  /**
   * Get the number of fields in a hash (HLEN)
   * @param {string} key
   * @returns {Promise<number>}
   */
  async hlen(key) {
    if (this.client && typeof this.client.hlen === 'function') {
      return this.client.hlen(key);
    }
    if (this.client && typeof this.client.hLen === 'function') {
      return this.client.hLen(key);
    }
    if (this.methodMap && typeof this.methodMap['hlen'] === 'function') {
      return this.methodMap['hlen'](key);
    }
    if (this.client && typeof this.client._command === 'function') {
      return this.client._command('HLEN', key);
    }
    return this._handleError(new Error('Redis hlen method not available on underlying client'), 'hlen');
  }

  /**
   * Delete one or more hash fields (HDEL)
   * @param {string} key
   * @param {...string} fields
   * @returns {Promise<number>} number of fields removed
   */
  async hdel(key, ...fields) {
    if (this.client && typeof this.client.hdel === 'function') {
      return this.client.hdel(key, ...fields);
    }
    if (this.client && typeof this.client.hDel === 'function') {
      return this.client.hDel(key, ...fields);
    }
    if (this.methodMap && typeof this.methodMap['hdel'] === 'function') {
      return this.methodMap['hdel'](key, ...fields);
    }
    if (this.client && typeof this.client._command === 'function') {
      return this.client._command('HDEL', key, ...fields);
    }
    return this._handleError(new Error('Redis hdel method not available on underlying client'), 'hdel');
  }

  /**
   * Set the value of a hash field only if it does not exist (HSETNX)
   * @param {string} key
   * @param {string} field
   * @param {string} value
   * @returns {Promise<number>} 1 if field set, 0 if it already existed
   */
  async hsetnx(key, field, value) {
    // Prefer direct methods on the underlying client
    if (this.client && typeof this.client.hsetnx === 'function') {
      try {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        return await this.client.hsetnx(key, field, stringValue);
      } catch (error) {
        return this._handleError(error, 'hsetnx');
      }
    }
    if (this.client && typeof this.client.hSetNx === 'function') {
      try {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        return await this.client.hSetNx(key, field, stringValue);
      } catch (error) {
        return this._handleError(error, 'hsetnx');
      }
    }
    // Fallback to generic _command
    if (this.client && typeof this.client._command === 'function') {
      try {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        return await this.client._command('HSETNX', key, field, stringValue);
      } catch (cmdError) {
        return this._handleError(cmdError, 'hsetnx_command_fallback');
      }
    }
    return this._handleError(new Error('Redis hsetnx/hSetNx not available on underlying client'), 'hsetnx');
  }

  /**
   * CamelCase alias for hsetnx
   */
  async hSetNx(key, field, value) {
    return this.hsetnx(key, field, value);
  }

  /**
   * Push a value to the end of a list (right side)
   * @param {string} key - The list key
   * @param {...string} values - The values to push
   * @returns {Promise<number>} Length of the list after the push operation
   */
  async rpush(key, ...values) {
    // Check for the specific method we implemented in RedisClient
    if (this.client && typeof this.client.rpush === 'function') {
      // Use the lowercase version (rpush) if available
      return this.client.rpush(key, ...values);
    } else if (this.client && typeof this.client.rPush === 'function') {
      // Fallback to uppercase 'P' version (rPush) if that's what's available
      return this.client.rPush(key, ...values);
    } else if (this.client && typeof this.client._command === 'function') {
      // Last resort: use generic _command method if available
      console.warn('[RedisAdapter] Using fallback _command for rpush');
      return this.client._command('RPUSH', key, ...values);
    }
    console.error('[RedisAdapter] rpush/rPush method not available on underlying client');
    throw new Error('[RedisAdapter] rpush not implemented on client');
  }
  
  /**
   * Alias for rpush to handle uppercase naming convention
   */
  async rPush(key, ...values) {
    return this.rpush(key, ...values);
  }
  
  /**
   * Get all keys matching a pattern using KEYS
   * @param {string} pattern - The pattern to match keys against
   * @returns {Promise<Array<string>>} Array of matching keys
   */
  async keys(pattern) {
    if (this.methodMap['keys']) {
      try {
        return await this.methodMap['keys'](pattern);
      } catch (error) {
        return this._handleError(error, 'keys');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('KEYS', pattern);
      } catch (error) {
        return this._handleError(error, 'keys');
      }
    }
    
    return this._handleError(new Error('Redis keys method not available'), 'keys');
  }
  
  /**
   * Get all keys matching a pattern using SCAN
   * @param {string} pattern - The pattern to match keys against
   * @param {number} [count=100] - Number of keys to scan per iteration
   * @returns {Promise<string[]>} Array of matching keys
   */
  async scanKeys(pattern, count = 100) {
    // First, check if we have the raw SCAN command available
    const canScan = this.client && (
      typeof this.client.scan === 'function' || 
      typeof this.methodMap['_command'] === 'function'
    );
    
    // If SCAN is not available directly, try to fallback to the keys method
    if (!canScan) {
      // Try to use the keys method if available 
      if (this.methodMap['keys']) {
        try {
          console.log(`[RedisAdapter] SCAN operation not available, falling back to KEYS ${pattern}`);
          const allKeys = await this.methodMap['keys'](pattern);
          return Array.isArray(allKeys) ? allKeys : [];
        } catch (error) {
          return this._handleError(error, 'keys');
        }
      } else {
        return this._handleError(new Error('Neither SCAN nor KEYS methods are available'), 'scanKeys');
      }
    }
    
    // If we have SCAN capabilities, use them
    try {
      const keys = [];
      let cursor = '0';
      
      do {
        let result;
        
        // Handle different Redis client implementations
        if (typeof this.client.scan === 'function') {
          // ioredis / node-redis style
          result = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
          cursor = Array.isArray(result) ? result[0] : result.cursor;
          const matchedKeys = Array.isArray(result) ? result[1] : result.keys;
          if (matchedKeys && Array.isArray(matchedKeys)) {
            keys.push(...matchedKeys);
          }
        } else if (this.methodMap['_command']) {
          // Upstash REST API style
          result = await this.methodMap['_command']('SCAN', cursor, 'MATCH', pattern, 'COUNT', count.toString());
          cursor = Array.isArray(result) ? result[0] : (result.cursor || '0');
          const matchedKeys = Array.isArray(result) ? result[1] : (result.keys || []);
          if (matchedKeys && Array.isArray(matchedKeys) && matchedKeys.length > 0) {
            keys.push(...matchedKeys);
          }
        }
      } while (cursor !== '0');
      
      return keys;
    } catch (error) {
      // On SCAN error, try KEYS as a fallback
      console.log(`[RedisAdapter] SCAN operation failed, trying KEYS ${pattern} as fallback`);
      if (this.methodMap['keys']) {
        try {
          const allKeys = await this.methodMap['keys'](pattern);
          return Array.isArray(allKeys) ? allKeys : [];
        } catch (keysError) {
          return this._handleError(keysError, 'keys');
        }
      }
      return this._handleError(error, 'scanKeys');
    }
  }

  /**
   * Static factory method to create a RedisAdapter instance using environment variables.
   * Uses standardized REDIS_URL and REDIS_TOKEN environment variables.
   * UPSTASH variables are deprecated and no longer supported.
   * @param {Object} env - The environment object (e.g., process.env)
   * @returns {RedisAdapter} A new RedisAdapter instance.
   * @throws {Error} If required Redis environment variables (URL and token) are not set.
   */
  static fromEnv(env = process.env) {
    // Use standardized Redis environment variables only
    const redisUrl = env.REDIS_URL;
    const redisToken = env.REDIS_TOKEN;
    const exitOnError = env.EXIT_ON_REDIS_ERROR === 'true'; // Check the env var set in run-market-maker

    console.log(`[DEBUG][RedisAdapter.fromEnv] Trying Redis URL: ${redisUrl ? 'Found' : 'Not Found'}, Token: ${redisToken ? 'Found' : 'Not Found'}`);


    if (!redisUrl || !redisToken) {
      const message = 'Redis client requires URL and token. Please set REDIS_URL and REDIS_TOKEN environment variables. UPSTASH variables are no longer supported.';
      console.error(`[ERROR][RedisAdapter.fromEnv] ${message}`);
      // Optionally exit if the flag is set
      if (exitOnError) {
          console.error('[ERROR][RedisAdapter.fromEnv] EXIT_ON_REDIS_ERROR is true. Exiting.');
          process.exit(1); // Exit immediately
      }
      // Otherwise, throw the error to be potentially caught upstream
      throw new Error(message);
    }

    // Use the found URL and Token
    return new RedisAdapter({
      url: redisUrl,
      token: redisToken,
      exitOnError: exitOnError // Pass the flag to the constructor if needed there too
    });
  }

  /**
   * Get multiple values from Redis in a single request
   * @param {...string} keys - The keys to get
   * @returns {Promise<Array>} Array of values in the same order as the keys
   */
  async mget(...keys) {
    console.log(`[DEBUG][RedisAdapter.mget] Attempting to fetch ${keys.length} keys`);
    
    // Check if the underlying client has mget
    if (this.client && typeof this.client.mget === 'function') {
      console.log(`[DEBUG][RedisAdapter.mget] Using client.mget directly`);
      return this.client.mget(...keys);
    }
    
    console.warn('[RedisAdapter.mget] mget method not available on client, falling back to individual gets');
    
    // Fallback implementation using individual gets
    return Promise.all(keys.map(key => this.get(key)));
  }

  /**
   * Execute Redis SCAN command with cursor iteration
   * @param {string} cursor - The cursor for iteration (start with '0')
   * @param {string} pattern - Pattern to match keys
   * @param {number} count - Number of keys to return per iteration
   * @returns {Promise<[string, string[]]>} - Tuple of [nextCursor, keys]
   */
  async scan(cursor = '0', pattern = null, count = 100) {
    try {
      if (this.client && typeof this.client.scan === 'function') {
        // Use the underlying client's scan method
        return await this.client.scan(cursor, pattern, count);
      } else if (this.methodMap && typeof this.methodMap['_command'] === 'function') {
        // Use the _command method as fallback
        const args = ['SCAN', cursor];
        if (pattern) {
          args.push('MATCH', pattern);
        }
        if (count) {
          args.push('COUNT', count.toString());
        }
        const result = await this.methodMap['_command'](...args);
        return result;
      } else {
        // If scan is not available, fallback to getting all keys with pattern
        console.warn('[RedisAdapter] SCAN method not available, falling back to keys method');
        if (pattern) {
          const keys = await this.keys(pattern);
          return ['0', keys]; // Return as if it's the last iteration
        } else {
          throw new Error('[RedisAdapter] scan not available and no pattern provided for fallback');
        }
      }
    } catch (error) {
      return this._handleError(error, 'scan');
    }
  }

  /**
   * Check if a key exists in Redis
   * @param {string} key - The key to check
   * @returns {Promise<number>} - 1 if key exists, 0 if not
   */
  async exists(key) {
    if (this.methodMap['exists']) {
      try {
        return await this.methodMap['exists'](key);
      } catch (error) {
        return this._handleError(error, 'exists');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('EXISTS', key);
      } catch (error) {
        return this._handleError(error, 'exists');
      }
    }
    
    return this._handleError(new Error('Redis exists method not available'), 'exists');
  }

  /**
   * Get the type of a key
   * @param {string} key - The key to check
   * @returns {Promise<string>} - The type of the key
   */
  async type(key) {
    if (this.methodMap['type']) {
      try {
        return await this.methodMap['type'](key);
      } catch (error) {
        return this._handleError(error, 'type');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('TYPE', key);
      } catch (error) {
        return this._handleError(error, 'type');
      }
    }
    
    return this._handleError(new Error('Redis type method not available'), 'type');
  }

  /**
   * Set expiration on a key
   * @param {string} key - The key to set expiration on
   * @param {number} seconds - Expiration time in seconds
   * @returns {Promise<number>} - 1 if expiration was set, 0 if not
   */
  async expire(key, seconds) {
    if (this.methodMap['expire']) {
      try {
        return await this.methodMap['expire'](key, seconds);
      } catch (error) {
        return this._handleError(error, 'expire');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('EXPIRE', key, seconds.toString());
      } catch (error) {
        return this._handleError(error, 'expire');
      }
    }
    
    return this._handleError(new Error('Redis expire method not available'), 'expire');
  }

  /**
   * Add one or more members to a sorted set
   * @param {string} key - The sorted set key
   * @param {number} score - The score for the member
   * @param {string} member - The member to add
   * @returns {Promise<number>} - Number of elements added
   */
  async zadd(key, score, member) {
    if (this.methodMap['zadd']) {
      try {
        return await this.methodMap['zadd'](key, score, member);
      } catch (error) {
        return this._handleError(error, 'zadd');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('ZADD', key, score.toString(), member);
      } catch (error) {
        return this._handleError(error, 'zadd');
      }
    }
    
    return this._handleError(new Error('Redis zadd method not available'), 'zadd');
  }

  /**
   * Get a range of members from a sorted set
   * @param {string} key - The sorted set key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @param {string} withScores - 'WITHSCORES' to include scores
   * @returns {Promise<Array>} - Array of members (and scores if requested)
   */
  async zrange(key, start, stop, withScores = null) {
    if (this.methodMap['zrange']) {
      try {
        if (withScores === 'WITHSCORES') {
          return await this.methodMap['zrange'](key, start, stop, 'WITHSCORES');
        } else {
          return await this.methodMap['zrange'](key, start, stop);
        }
      } catch (error) {
        return this._handleError(error, 'zrange');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        const args = ['ZRANGE', key, start.toString(), stop.toString()];
        if (withScores === 'WITHSCORES') {
          args.push('WITHSCORES');
        }
        return await this.methodMap['_command'](...args);
      } catch (error) {
        return this._handleError(error, 'zrange');
      }
    }
    
    return this._handleError(new Error('Redis zrange method not available'), 'zrange');
  }

  /**
   * Get the number of members in a sorted set
   * @param {string} key - The sorted set key
   * @returns {Promise<number>} - Number of members in the sorted set
   */
  async zcard(key) {
    if (this.methodMap['zcard']) {
      try {
        return await this.methodMap['zcard'](key);
      } catch (error) {
        return this._handleError(error, 'zcard');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('ZCARD', key);
      } catch (error) {
        return this._handleError(error, 'zcard');
      }
    }
    
    return this._handleError(new Error('Redis zcard method not available'), 'zcard');
  }

  /**
   * Remove one or more members from a sorted set
   * @param {string} key - The sorted set key
   * @param {string} member - The member to remove
   * @returns {Promise<number>} - Number of members removed
   */
  async zrem(key, member) {
    if (this.methodMap['zrem']) {
      try {
        return await this.methodMap['zrem'](key, member);
      } catch (error) {
        return this._handleError(error, 'zrem');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('ZREM', key, member);
      } catch (error) {
        return this._handleError(error, 'zrem');
      }
    }
    
    return this._handleError(new Error('Redis zrem method not available'), 'zrem');
  }

  /**
   * Get members from a sorted set by score range
   * @param {string} key - The sorted set key
   * @param {string|number} min - Minimum score
   * @param {string|number} max - Maximum score
   * @returns {Promise<Array>} - Array of members in the score range
   */
  async zrangebyscore(key, min, max) {
    if (this.methodMap['zrangebyscore']) {
      try {
        return await this.methodMap['zrangebyscore'](key, min, max);
      } catch (error) {
        return this._handleError(error, 'zrangebyscore');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('ZRANGEBYSCORE', key, min.toString(), max.toString());
      } catch (error) {
        return this._handleError(error, 'zrangebyscore');
      }
    }
    
    return this._handleError(new Error('Redis zrangebyscore method not available'), 'zrangebyscore');
  }

  /**
   * Remove members from a sorted set by score range
   * @param {string} key - The sorted set key
   * @param {string|number} min - Minimum score
   * @param {string|number} max - Maximum score
   * @returns {Promise<number>} - Number of members removed
   */
  async zremrangebyscore(key, min, max) {
    if (this.methodMap['zremrangebyscore']) {
      try {
        return await this.methodMap['zremrangebyscore'](key, min, max);
      } catch (error) {
        return this._handleError(error, 'zremrangebyscore');
      }
    }
    
    // Fallback using _command
    if (this.methodMap['_command']) {
      try {
        return await this.methodMap['_command']('ZREMRANGEBYSCORE', key, min.toString(), max.toString());
      } catch (error) {
        return this._handleError(error, 'zremrangebyscore');
      }
    }
    
    return this._handleError(new Error('Redis zremrangebyscore method not available'), 'zremrangebyscore');
  }
}

/**
 * Mock Redis adapter that doesn't throw errors but logs warnings
 * Used when Redis credentials are not available
 */
class MockRedisAdapter {
  constructor() {
    console.warn('Using MockRedisAdapter - all Redis operations will be no-ops');
    this.initialized = false;
    this.storage = new Map();
  }
  
  async get(key) {
    console.warn(`[MockRedis] GET ${key}`);
    return this.storage.get(key) || null;
  }
  
  async set(key, value) {
    console.warn(`[MockRedis] SET ${key}`);
    this.storage.set(key, value);
    return true;
  }
  
  /**
   * Mock implementation of setex to match the real Redis client
   * @param {string} key - The key to set
   * @param {number} seconds - Expiration time in seconds
   * @param {any} value - The value to store
   * @returns {Promise<boolean>} Success status
   */
  async setex(key, seconds, value) {
    console.warn(`[MockRedis] SETEX ${key} ${seconds}`);
    console.warn(`[MockRedis] Setting key ${key} with value (showing first 50 chars): ${JSON.stringify(value).substring(0, 50)}...`);
    this.storage.set(key, value);
    return true;
  }
  
  async del(key) {
    console.warn(`[MockRedis] DEL ${key}`);
    return this.storage.delete(key) ? 1 : 0;
  }
  
  async smembers(key) {
    console.warn(`[MockRedis] SMEMBERS ${key}`);
    return [];
  }
  
  async sadd(key, member) {
    console.warn(`[MockRedis] SADD ${key} ${member}`);
    return 1;
  }
  
  async srem(key, member) {
    console.warn(`[MockRedis] SREM ${key} ${member}`);
    return 1;
  }
  
  async sismember(key, member) {
    console.warn(`[MockRedis] SISMEMBER ${key} ${member}`);
    return false;
  }
  
  async ping() {
    console.warn('[MockRedis] PING');
    return 'PONG';
  }
  
  async publish(channel, message) {
    console.warn(`[MockRedis] PUBLISH ${channel}`);
    return 0;
  }
  
  async subscribe(channel, callback) {
    console.warn(`[MockRedis] SUBSCRIBE ${channel}`);
  }
  
  async unsubscribe(channel) {
    console.warn(`[MockRedis] UNSUBSCRIBE ${channel}`);
  }
  
  async disconnect() {
    console.warn('[MockRedis] DISCONNECT');
  }
  
  async lrange(key, start, stop) {
    console.warn(`[MockRedis] LRANGE ${key} ${start} ${stop}`);
    return [];
  }
  
  // Alias for lrange with uppercase R for consistency
  async lRange(key, start, stop) {
    return this.lrange(key, start, stop);
  }
}
