/**
 * Upstash Redis Adapter
 * 
 * This module provides an adapter for Upstash Redis that works in both
 * Node.js and Cloudflare Workers environments. Optimized for real-time
 * market data handling with batching and stream management.
 */

/**
 * Upstash Redis Adapter
 */
export class UpstashRedisAdapter {
  /**
   * Create a new Upstash Redis adapter
   * 
   * @param {Object} options - Adapter options
   * @param {string} options.url - Upstash Redis URL
   * @param {string} options.token - Upstash Redis token
   * @param {Function} options.logger - Logger function
   * @param {number} options.batchSize - Maximum batch size (default: 100)
   * @param {number} options.batchTimeoutMs - Batch timeout in ms (default: 1000)
   * @param {number} options.streamMaxLen - Maximum stream length (default: 10000)
   */
  constructor(options = {}) {
    this.options = {
      batchSize: 100,
      batchTimeoutMs: 1000,
      streamMaxLen: 10000,
      maxDepthLevels: 100,  // Maximum order book depth levels to maintain
      snapshotInterval: 60000,  // Store full snapshot every minute
      maxQueueSize: 1000,  // Maximum queue size for backpressure monitoring
      ...options
    };
    
    this.client = null;
    this.isCloudflareEnv = typeof process === 'undefined';
    this.pendingWrites = new Map();
    this.batchTimers = new Map();
    this.orderBooks = new Map();  // Current order book state
    this.lastSnapshots = new Map();  // Last snapshot timestamps
    
    this.metrics = {
      writes: 0,
      batches: 0,
      errors: 0,
      latency: [],
      queueSizes: new Map(),  // Track queue sizes for backpressure
      backpressureEvents: 0,  // Count of backpressure events
      depthUpdates: 0,  // Count of depth updates
      snapshots: 0  // Count of snapshots taken
    };
    
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.set = this.set.bind(this);
    this.get = this.get.bind(this);
    this.del = this.del.bind(this);
    this.zadd = this.zadd.bind(this);
    this.zrange = this.zrange.bind(this);
    this.expire = this.expire.bind(this);
    this.log = this.log.bind(this);
    this.handleWebSocketData = this.handleWebSocketData.bind(this);
    this.flushBatch = this.flushBatch.bind(this);
  }
  
  /**
   * Log a message with metrics
   * 
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  log(level, message, data = {}) {
    const enrichedData = {
      ...data,
      metrics: {
        writes: this.metrics.writes,
        batches: this.metrics.batches,
        errors: this.metrics.errors,
        avgLatency: this.metrics.latency.length > 0
          ? this.metrics.latency.reduce((a, b) => a + b, 0) / this.metrics.latency.length
          : 0
      }
    };

    if (this.options.logger) {
      this.options.logger(level, message, enrichedData);
    } else {
      console[level](message, enrichedData);
    }
  }
  
  /**
   * Connect to Upstash Redis with health monitoring
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      this.log('info', 'Connecting to Upstash Redis...');
      
      if (this.isCloudflareEnv) {
        // In Cloudflare Workers environment, use @upstash/redis/cloudflare
        try {
          const { Redis } = await import('@upstash/redis/cloudflare');
          this.client = new Redis({
            url: this.options.url,
            token: this.options.token,
            automaticDeserialization: true
          });
          
          this.log('info', '✅ Connected to Upstash Redis (Cloudflare)');
        } catch (error) {
          this.metrics.errors++;
          this.log('error', `Failed to import @upstash/redis/cloudflare: ${error.message}`, { error });
          throw error;
        }
      } else {
        // In Node.js environment, use @upstash/redis
        try {
          const { Redis } = await import('@upstash/redis');
          this.client = new Redis({
            url: this.options.url,
            token: this.options.token,
            automaticDeserialization: true
          });
          
          this.log('info', '✅ Connected to Upstash Redis (Node.js)');
        } catch (error) {
          this.metrics.errors++;
          this.log('error', `Failed to import @upstash/redis: ${error.message}`, { error });
          throw error;
        }
      }
      
      // Test connection and initialize health monitoring
      await this.initializeHealthMonitoring();
      
      // Start periodic memory optimization
      this.startMemoryOptimization();
    } catch (error) {
      this.metrics.errors++;
      this.log('error', `Failed to connect to Upstash Redis: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Disconnect from Upstash Redis
   */
  disconnect() {
    this.client = null;
    this.log('info', 'Disconnected from Upstash Redis');
  }
  
  /**
   * Set a key-value pair
   * 
   * @param {string} key - Key
   * @param {string|Object} value - Value
   * @param {Object} options - Options
   * @param {number} options.ex - Expiration in seconds
   * @returns {Promise<string>}
   */
  async set(key, value, options = {}) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      // Serialize object values
      const serializedValue = typeof value === 'object' ? JSON.stringify(value) : value;
      
      if (options.ex) {
        return await this.client.set(key, serializedValue, { ex: options.ex });
      } else {
        return await this.client.set(key, serializedValue);
      }
    } catch (error) {
      this.log('error', `Failed to set key ${key}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Get a value by key
   * 
   * @param {string} key - Key
   * @returns {Promise<any>}
   */
  async get(key) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      const value = await this.client.get(key);
      
      // Try to parse JSON values
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch (e) {
          // Not JSON, return as is
          return value;
        }
      }
      
      return value;
    } catch (error) {
      this.log('error', `Failed to get key ${key}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Delete a key
   * 
   * @param {string} key - Key
   * @returns {Promise<number>}
   */
  async del(key) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      return await this.client.del(key);
    } catch (error) {
      this.metrics.errors++;
      this.log('error', `Failed to delete key ${key}: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Initialize health monitoring
   * 
   * @private
   * @returns {Promise<void>}
   */
  async initializeHealthMonitoring() {
    // Test initial connection
    const start = Date.now();
    await this.set('health_check', 'ok');
    const result = await this.get('health_check');
    const latency = Date.now() - start;
    
    if (result !== 'ok') {
      throw new Error('Health check failed');
    }
    
    await this.del('health_check');
    this.metrics.latency.push(latency);
    
    // Keep only last 100 latency measurements
    if (this.metrics.latency.length > 100) {
      this.metrics.latency.shift();
    }
    
    // Start periodic health checks
    setInterval(async () => {
      try {
        const start = Date.now();
        await this.client.ping();
        const latency = Date.now() - start;
        
        this.metrics.latency.push(latency);
        if (this.metrics.latency.length > 100) {
          this.metrics.latency.shift();
        }
      } catch (error) {
        this.metrics.errors++;
        this.log('error', 'Health check failed', { error });
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Start periodic memory optimization
   * 
   * @private
   */
  async startMemoryOptimization() {
    setInterval(async () => {
      try {
        const info = await this.client.info('memory');
        const usedMemory = this.parseMemoryInfo(info);
        
        if (usedMemory > 80) { // If memory usage > 80%
          await this.optimizeMemory();
        }
      } catch (error) {
        this.metrics.errors++;
        this.log('error', 'Memory optimization failed', { error });
      }
    }, 60000); // Every minute
  }

  /**
   * Parse memory info from Redis INFO command
   * 
   * @private
   * @param {string} info - Redis INFO output
   * @returns {number} Memory usage percentage
   */
  parseMemoryInfo(info) {
    const match = info.match(/used_memory:(\d+)/i);
    if (!match) return 0;
    
    const usedMemory = parseInt(match[1], 10);
    const maxMemory = 100 * 1024 * 1024; // 100MB default limit
    return (usedMemory / maxMemory) * 100;
  }

  /**
   * Optimize memory usage
   * 
   * @private
   */
  async optimizeMemory() {
    // Get all stream keys
    const keys = await this.client.keys('stream:*');
    
    // Trim streams to maximum length
    for (const key of keys) {
      await this.client.xtrim(
        key,
        'MAXLEN',
        '~',
        this.options.streamMaxLen
      );
    }
    
    // Clean up old order book snapshots
    const snapshotKeys = await this.client.keys('snapshot:*');
    const now = Date.now();
    for (const key of snapshotKeys) {
      const timestamp = parseInt(key.split(':').pop(), 10);
      if (now - timestamp > 24 * 60 * 60 * 1000) { // Older than 24 hours
        await this.client.del(key);
      }
    }
    
    this.log('info', 'Memory optimization completed', {
      streamCount: keys.length,
      snapshotCount: snapshotKeys.length
    });
  }

  /**
   * Handle WebSocket market data with depth management
   * 
   * @param {Object} data - Market data from WebSocket
   * @returns {Promise<void>}
   */
  async handleWebSocketData(data) {
    const {
      symbol,
      type,
      timestamp = Date.now(),
      ...payload
    } = data;
    
    // Check queue size for backpressure
    const currentQueueSize = this.pendingWrites.get(`stream:${symbol}:${type}`)?.length || 0;
    this.metrics.queueSizes.set(symbol, currentQueueSize);
    
    if (currentQueueSize >= this.options.maxQueueSize) {
      this.metrics.backpressureEvents++;
      this.log('warn', 'Backpressure detected', {
        symbol,
        queueSize: currentQueueSize,
        threshold: this.options.maxQueueSize
      });
      // Force flush to handle backpressure
      await this.flushBatch(`stream:${symbol}:${type}`);
    }
    
    // Handle order book updates
    if (type === 'book') {
      await this.handleOrderBookUpdate(symbol, payload);
      return;
    }
    
    const key = `stream:${symbol}:${type}`;
    await this.addToBatch(key, { timestamp, ...payload });
  }

  /**
   * Add data to batch for processing
   * 
   * @private
   * @param {string} key - Stream key
   * @param {Object} data - Data to add
   */
  async addToBatch(key, data) {
    if (!this.pendingWrites.has(key)) {
      this.pendingWrites.set(key, []);
    }
    
    const batch = this.pendingWrites.get(key);
    batch.push(data);
    
    // Set timer for batch if not already set
    if (!this.batchTimers.has(key)) {
      const timer = setTimeout(
        () => this.flushBatch(key),
        this.options.batchTimeoutMs
      );
      this.batchTimers.set(key, timer);
    }
    
    // Flush if batch is full
    if (batch.length >= this.options.batchSize) {
      await this.flushBatch(key);
    }
  }

  /**
   * Flush batch to Redis
   * 
   * @private
   * @param {string} key - Stream key
   */
  async flushBatch(key) {
    const batch = this.pendingWrites.get(key) || [];
    if (batch.length === 0) return;
    
    // Clear batch and timer
    this.pendingWrites.set(key, []);
    const timer = this.batchTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(key);
    }
    
    try {
      const start = Date.now();
      
      // Write batch to stream
      await this.client.xadd(
        key,
        '*',  // Auto-generate ID
        'data',
        JSON.stringify(batch),
        'MAXLEN',
        '~',
        this.options.streamMaxLen
      );
      
      const latency = Date.now() - start;
      this.metrics.latency.push(latency);
      this.metrics.writes += batch.length;
      this.metrics.batches++;
      
      this.log('debug', 'Batch written to stream', {
        key,
        batchSize: batch.length,
        latency
      });
    } catch (error) {
      this.metrics.errors++;
      this.log('error', `Failed to write batch to stream ${key}`, {
        error,
        batchSize: batch.length
      });
      throw error;
    }
  }

  /**
   * Handle order book updates and manage depth
   * 
   * @private
   * @param {string} symbol - Trading pair symbol
   * @param {Object} update - Order book update
   */
  async handleOrderBookUpdate(symbol, update) {
    this.metrics.depthUpdates++;
    
    // Initialize order book if needed
    if (!this.orderBooks.has(symbol)) {
      this.orderBooks.set(symbol, {
        bids: new Map(),
        asks: new Map(),
        lastUpdateId: 0
      });
    }
    
    const orderBook = this.orderBooks.get(symbol);
    
    // Handle snapshot
    if (update.type === 'snapshot') {
      await this.handleOrderBookSnapshot(symbol, update);
      return;
    }
    
    // Validate sequence
    if (update.updateId <= orderBook.lastUpdateId) {
      this.log('debug', 'Skipping old update', {
        symbol,
        updateId: update.updateId,
        lastUpdateId: orderBook.lastUpdateId
      });
      return;
    }
    
    // Apply updates
    for (const [price, size] of update.bids || []) {
      if (size === 0) {
        orderBook.bids.delete(price);
      } else {
        orderBook.bids.set(price, size);
      }
    }
    
    for (const [price, size] of update.asks || []) {
      if (size === 0) {
        orderBook.asks.delete(price);
      } else {
        orderBook.asks.set(price, size);
      }
    }
    
    // Maintain maximum depth
    this.trimOrderBookDepth(orderBook);
    
    // Update sequence
    orderBook.lastUpdateId = update.updateId;
    
    // Check if we need to take a snapshot
    await this.checkAndTakeSnapshot(symbol, orderBook);
  }

  /**
   * Handle full order book snapshot
   * 
   * @private
   * @param {string} symbol - Trading pair symbol
   * @param {Object} snapshot - Order book snapshot
   */
  async handleOrderBookSnapshot(symbol, snapshot) {
    this.metrics.snapshots++;
    
    // Create new order book state
    const orderBook = {
      bids: new Map(snapshot.bids),
      asks: new Map(snapshot.asks),
      lastUpdateId: snapshot.lastUpdateId
    };
    
    // Trim to maximum depth
    this.trimOrderBookDepth(orderBook);
    
    // Save to memory
    this.orderBooks.set(symbol, orderBook);
    
    // Save snapshot to Redis
    const key = `snapshot:${symbol}:${Date.now()}`;
    await this.set(key, {
      bids: Array.from(orderBook.bids.entries()),
      asks: Array.from(orderBook.asks.entries()),
      lastUpdateId: orderBook.lastUpdateId,
      timestamp: Date.now()
    });
    
    this.log('info', 'Order book snapshot saved', {
      symbol,
      bidLevels: orderBook.bids.size,
      askLevels: orderBook.asks.size
    });
  }

  /**
   * Trim order book to maximum depth
   * 
   * @private
   * @param {Object} orderBook - Order book object
   */
  trimOrderBookDepth(orderBook) {
    // Sort and trim bids (highest first)
    const sortedBids = Array.from(orderBook.bids.entries())
      .sort((a, b) => b[0] - a[0])
      .slice(0, this.options.maxDepthLevels);
    
    // Sort and trim asks (lowest first)
    const sortedAsks = Array.from(orderBook.asks.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(0, this.options.maxDepthLevels);
    
    // Update order book with trimmed values
    orderBook.bids = new Map(sortedBids);
    orderBook.asks = new Map(sortedAsks);
  }

  /**
   * Check if we need to take a snapshot and do so if necessary
   * 
   * @private
   * @param {string} symbol - Trading pair symbol
   * @param {Object} orderBook - Order book object
   */
  async checkAndTakeSnapshot(symbol, orderBook) {
    const lastSnapshot = this.lastSnapshots.get(symbol) || 0;
    const now = Date.now();
    
    if (now - lastSnapshot >= this.options.snapshotInterval) {
      this.lastSnapshots.set(symbol, now);
      
      const snapshot = {
        bids: Array.from(orderBook.bids.entries()),
        asks: Array.from(orderBook.asks.entries()),
        lastUpdateId: orderBook.lastUpdateId,
        timestamp: now
      };
      
      const key = `snapshot:${symbol}:${now}`;
      await this.set(key, snapshot);
      
      this.metrics.snapshots++;
      this.log('debug', 'Periodic snapshot taken', {
        symbol,
        bidLevels: orderBook.bids.size,
        askLevels: orderBook.asks.size
      });
    }
  }
  
  /**
   * Add a member to a sorted set
   * 
   * @param {string} key - Key
   * @param {number} score - Score
   * @param {string} member - Member
   * @returns {Promise<number>}
   */
  async zadd(key, score, member) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      return await this.client.zadd(key, { score, member });
    } catch (error) {
      this.log('error', `Failed to add to sorted set ${key}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Get a range from a sorted set
   * 
   * @param {string} key - Key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @returns {Promise<Array>}
   */
  async zrange(key, start, stop) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      return await this.client.zrange(key, start, stop);
    } catch (error) {
      this.log('error', `Failed to get range from sorted set ${key}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Set a key's time to live in seconds
   * 
   * @param {string} key - Key
   * @param {number} seconds - Seconds
   * @returns {Promise<number>}
   */
  async expire(key, seconds) {
    if (!this.client) {
      throw new Error('Not connected to Upstash Redis');
    }
    
    try {
      return await this.client.expire(key, seconds);
    } catch (error) {
      this.log('error', `Failed to set expiry for key ${key}: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Store orderbook in Redis
   * 
   * @param {string} symbol - Symbol
   * @param {Object} orderbook - Orderbook data
   * @returns {Promise<string>}
   */
  async storeOrderBook(symbol, orderbook) {
    const key = `orderbook:${symbol}`;
    return await this.set(key, orderbook, { ex: 60 }); // 1 minute expiry
  }
  
  /**
   * Get orderbook from Redis
   * 
   * @param {string} symbol - Symbol
   * @returns {Promise<Object|null>}
   */
  async getOrderBook(symbol) {
    const key = `orderbook:${symbol}`;
    return await this.get(key);
  }
  
  /**
   * Track connection health
   * 
   * @param {string} workerId - Worker ID
   * @returns {Promise<number>}
   */
  async trackConnectionHealth(workerId) {
    const key = 'connections:alive';
    const timestamp = Math.floor(Date.now() / 1000);
    
    await this.zadd(key, timestamp, workerId);
    return await this.expire(key, 60); // 1 minute expiry
  }
}
