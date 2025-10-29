console.log('[DEBUG] Loading redis-client.js - Using DO Redis/Valkey only');

import Redis from 'ioredis';

// Singleton instance
let _instance = null;

/**
 * Redis Client for Valkey/DO Redis (Singleton)
 * 
 * This client ONLY uses DO Redis/Valkey via the REDIS_URL environment variable.
 * Upstash is deprecated and no longer supported due to stale data.
 * 
 * Uses singleton pattern to prevent connection spam and resource waste.
 */
export class RedisClient {
  /**
   * Create a new Redis client (returns singleton instance)
   * @param {Object} options - Redis client options (ignored - uses env vars)
   */
  constructor(options = {}) {
    // Return existing instance if already created
    if (_instance) {
      return _instance;
    }
    
    // Ignore any passed options - always use DO Valkey from environment
    this.debug = options.debug || false;
    this.initialized = false;
    this.ioredisClient = null;
    this.connectionLogged = false;
    
    // Store as singleton instance
    _instance = this;
    
    // Initialize based on environment
    this._initialize();
  }

  _initialize() {
    // ALWAYS use DO Valkey - ignore any passed credentials
    const doRedisUrl = process.env.REDIS_URL;
    const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    
    if (doRedisUrl) {
      // Always use ioredis for Valkey/DO Redis
      console.log('[RedisClient] Using DO Redis/Valkey (ignoring any Upstash credentials)');
      this.isValkey = true;
      this.ioredisClient = new Redis(doRedisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        enableReadyCheck: true,
        lazyConnect: false
      });
      
      this.ioredisClient.on('connect', () => {
        if (!this.connectionLogged) {
          console.log('[RedisClient] Connected to Valkey/DO Redis (singleton instance)');
          this.connectionLogged = true;
        }
      });
      
      this.ioredisClient.on('error', (err) => {
        console.error('[RedisClient] Valkey/DO Redis error:', err);
      });
      
      this.initialized = true;
    } else if (isDevelopment) {
      // Development mode fallback - use local Redis
      console.warn('[RedisClient] REDIS_URL not set, falling back to local Redis for development');
      console.warn('[RedisClient] This is NOT recommended for production use');
      
      this.isValkey = true; // Treat local Redis same as Valkey
      this.ioredisClient = new Redis({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        enableReadyCheck: true,
        lazyConnect: false
      });
      
      this.ioredisClient.on('connect', () => {
        if (!this.connectionLogged) {
          console.log('[RedisClient] Connected to local Redis (development mode)');
          this.connectionLogged = true;
        }
      });
      
      this.ioredisClient.on('error', (err) => {
        console.error('[RedisClient] Local Redis error:', err);
      });
      
      this.initialized = true;
    } else {
      // No DO Redis URL and not in development - fail fast
      throw new Error('REDIS_URL environment variable is required. Upstash is deprecated and no longer supported. Set NODE_ENV=development to use local Redis.');
    }
  }

  /**
   * Create client from environment variables
   */
  static fromEnv(env = {}) {
    // For compatibility, just return a new instance
    // The constructor already reads from process.env
    return new RedisClient({ debug: env.DEBUG === 'true' });
  }


  /**
   * Execute a Redis command
   */
  async _execute(command, args) {
    if (!this.initialized) {
      throw new Error('Redis client not initialized');
    }

    // Always use ioredis for Valkey
    return await this.ioredisClient[command.toLowerCase()](...args);
  }

  // Key-Value Operations
  async get(key) {
    const result = await this._execute('GET', [key]);
    return result;
  }

  async set(key, value, options = {}) {
    const args = [key, value];
    if (options.ex) {
      args.push('EX', options.ex);
    } else if (options.px) {
      args.push('PX', options.px);
    }
    return await this._execute('SET', args);
  }

  async del(...keys) {
    return await this._execute('DEL', keys);
  }

  async exists(...keys) {
    return await this._execute('EXISTS', keys);
  }

  async expire(key, seconds) {
    return await this._execute('EXPIRE', [key, seconds]);
  }

  async ttl(key) {
    return await this._execute('TTL', [key]);
  }

  async incr(key) {
    return await this._execute('INCR', [key]);
  }

  async incrby(key, increment) {
    return await this._execute('INCRBY', [key, increment]);
  }

  async decr(key) {
    return await this._execute('DECR', [key]);
  }

  async decrby(key, decrement) {
    return await this._execute('DECRBY', [key, decrement]);
  }

  // Hash Operations
  async hget(key, field) {
    return await this._execute('HGET', [key, field]);
  }

  async hset(key, field, value) {
    return await this._execute('HSET', [key, field, value]);
  }

  /**
   * Set the value of a hash field, only if the field does not exist
   * Mirrors Redis HSETNX
   * @param {string} key
   * @param {string} field
   * @param {string} value
   * @returns {Promise<number>} 1 if field is a new field and value was set, 0 if field existed and no operation was performed
   */
  async hsetnx(key, field, value) {
    return await this._execute('HSETNX', [key, field, value]);
  }

  /**
   * CamelCase alias for hsetnx for adapter compatibility
   */
  async hSetNx(key, field, value) {
    return await this.hsetnx(key, field, value);
  }

  async hmset(key, ...fieldValues) {
    return await this._execute('HMSET', [key, ...fieldValues]);
  }

  async hgetall(key) {
    const result = await this._execute('HGETALL', [key]);
    
    // Convert array to object for Upstash compatibility
    if (Array.isArray(result)) {
      const obj = {};
      for (let i = 0; i < result.length; i += 2) {
        obj[result[i]] = result[i + 1];
      }
      return obj;
    }
    return result || {};
  }

  async hdel(key, ...fields) {
    return await this._execute('HDEL', [key, ...fields]);
  }

  async hincrby(key, field, increment) {
    return await this._execute('HINCRBY', [key, field, increment]);
  }

  async hkeys(key) {
    return await this._execute('HKEYS', [key]) || [];
  }

  async hvals(key) {
    return await this._execute('HVALS', [key]) || [];
  }

  async hlen(key) {
    return await this._execute('HLEN', [key]);
  }

  async hexists(key, field) {
    return await this._execute('HEXISTS', [key, field]);
  }

  // List Operations
  async lpush(key, ...values) {
    return await this._execute('LPUSH', [key, ...values]);
  }

  async rpush(key, ...values) {
    return await this._execute('RPUSH', [key, ...values]);
  }

  async lpop(key) {
    return await this._execute('LPOP', [key]);
  }

  async rpop(key) {
    return await this._execute('RPOP', [key]);
  }

  async lrange(key, start, stop) {
    return await this._execute('LRANGE', [key, start, stop]) || [];
  }

  async llen(key) {
    return await this._execute('LLEN', [key]);
  }

  async ltrim(key, start, stop) {
    return await this._execute('LTRIM', [key, start, stop]);
  }

  async lrem(key, count, value) {
    return await this._execute('LREM', [key, count, value]);
  }

  // Set Operations
  async sadd(key, ...members) {
    return await this._execute('SADD', [key, ...members]);
  }

  async srem(key, ...members) {
    return await this._execute('SREM', [key, ...members]);
  }

  async smembers(key) {
    return await this._execute('SMEMBERS', [key]) || [];
  }

  async sismember(key, member) {
    return await this._execute('SISMEMBER', [key, member]);
  }

  async scard(key) {
    return await this._execute('SCARD', [key]);
  }

  // Sorted Set Operations
  async zadd(key, ...scoreMembers) {
    return await this._execute('ZADD', [key, ...scoreMembers]);
  }

  async zrem(key, ...members) {
    return await this._execute('ZREM', [key, ...members]);
  }

  async zrange(key, start, stop, options = {}) {
    const args = [key, start, stop];
    if (options.withScores) {
      args.push('WITHSCORES');
    }
    return await this._execute('ZRANGE', args) || [];
  }

  async zrevrange(key, start, stop, options = {}) {
    const args = [key, start, stop];
    if (options.withScores) {
      args.push('WITHSCORES');
    }
    return await this._execute('ZREVRANGE', args) || [];
  }

  async zcard(key) {
    return await this._execute('ZCARD', [key]);
  }

  async zscore(key, member) {
    return await this._execute('ZSCORE', [key, member]);
  }

  async zrank(key, member) {
    return await this._execute('ZRANK', [key, member]);
  }

  async zrevrank(key, member) {
    return await this._execute('ZREVRANK', [key, member]);
  }

  async zincrby(key, increment, member) {
    return await this._execute('ZINCRBY', [key, increment, member]);
  }

  async zrangebyscore(key, min, max, options = {}) {
    const args = [key, min, max];
    if (options.withScores) {
      args.push('WITHSCORES');
    }
    if (options.limit) {
      args.push('LIMIT', options.limit.offset || 0, options.limit.count);
    }
    return await this._execute('ZRANGEBYSCORE', args) || [];
  }

  async zremrangebyscore(key, min, max) {
    return await this._execute('ZREMRANGEBYSCORE', [key, min, max]);
  }

  // Key Operations
  async keys(pattern) {
    return await this._execute('KEYS', [pattern]) || [];
  }

  async type(key) {
    return await this._execute('TYPE', [key]);
  }

  async scan(cursor, options = {}) {
    const args = [cursor];
    if (options.match) {
      args.push('MATCH', options.match);
    }
    if (options.count) {
      args.push('COUNT', options.count);
    }
    return await this._execute('SCAN', args);
  }

  // Pub/Sub Operations
  async subscribe(channel, callback) {
    // For ioredis, we need a separate subscriber connection
    if (!this.subscriber) {
      this.subscriber = this.ioredisClient.duplicate();
    }
    
    this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, message) => {
      if (ch === channel && callback) {
        callback(message);
      }
    });
  }

  async publish(channel, message) {
    return await this._execute('PUBLISH', [channel, message]);
  }

  // Transaction Operations
  async pipeline() {
    return this.ioredisClient.pipeline();
  }

  async multi() {
    return this.ioredisClient.multi();
  }

  // Utility Methods
  async ping() {
    try {
      const result = await this._execute('PING', []);
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async flushdb() {
    return await this._execute('FLUSHDB', []);
  }

  async flushall() {
    return await this._execute('FLUSHALL', []);
  }

  async dbsize() {
    return await this._execute('DBSIZE', []);
  }

  async quit() {
    if (this.ioredisClient) {
      await this.ioredisClient.quit();
      if (this.subscriber) {
        await this.subscriber.quit();
      }
    }
  }

  async disconnect() {
    await this.quit();
  }

  // Aliases for method name variations
  async hGetAll(key) {
    return await this.hgetall(key);
  }

  async lRange(key, start, stop) {
    return await this.lrange(key, start, stop);
  }

  async sMembers(key) {
    return await this.smembers(key);
  }
}

// For backward compatibility - returns singleton instance
export function getRedisClient(options = {}) {
  return new RedisClient(options);
}

// Static method to get singleton instance
RedisClient.getInstance = function(options = {}) {
  return new RedisClient(options);
};

export default RedisClient;