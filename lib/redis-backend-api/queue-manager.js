/**
 * QueueManager
 * 
 * Centralized queue management for different trading services.
 * Supports multiple queue types including spot, futures, options, etc.
 * 
 * Queue Naming Convention:
 * - Spot Trading: 'session:queue' (default/legacy)
 * - Futures Trading: 'futures:session:queue'
 * - Options Trading: 'options:session:queue'
 * - Custom: '{prefix}:session:queue'
 * 
 * Features:
 * - Queue type-based routing
 * - Session prioritization
 * - Dead letter queue handling
 * - Queue statistics and monitoring
 * - Bulk operations support
 */

export class QueueManager {
  /**
   * Available queue types with their Redis keys
   */
  static QUEUE_TYPES = {
    SPOT: 'session:queue',           // Default/legacy queue for spot trading
    FUTURES: 'futures:session:queue', // Futures trading queue
    OPTIONS: 'options:session:queue', // Options trading queue
    FOREX: 'forex:session:queue',     // Forex trading queue
    CRYPTO: 'crypto:session:queue',   // Crypto-specific queue
    TEST: 'test:session:queue',       // Test/development queue
    // Exchange-specific futures queues
    KRAKEN_FUTURES: 'kraken-futures:session:queue',
    COINBASE_FUTURES: 'coinbase-futures:session:queue'
  };

  /**
   * Dead letter queue suffixes
   */
  static DLQ_SUFFIX = ':dlq';
  static PROCESSING_SUFFIX = ':processing';
  static PRIORITY_SUFFIX = ':priority';

  /**
   * Create a new QueueManager
   * 
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {Object} config.logger - Logger instance
   * @param {string} [config.defaultQueue='SPOT'] - Default queue type
   * @param {number} [config.dlqRetries=3] - Dead letter queue retry attempts
   * @param {number} [config.processingTimeout=300000] - Processing timeout in ms (5 minutes)
   */
  constructor(config) {
    this.redis = config.redis;
    this.logger = config.logger;
    this.defaultQueue = config.defaultQueue || 'SPOT';
    this.dlqRetries = config.dlqRetries || 3;
    this.processingTimeout = config.processingTimeout || 300000; // 5 minutes
  }

  /**
   * Get queue key for a specific queue type
   * 
   * @param {string} queueType - Queue type (SPOT, FUTURES, etc.)
   * @returns {string} Redis queue key
   */
  getQueueKey(queueType = this.defaultQueue) {
    const key = QueueManager.QUEUE_TYPES[queueType];
    if (!key) {
      throw new Error(`Unknown queue type: ${queueType}. Available types: ${Object.keys(QueueManager.QUEUE_TYPES).join(', ')}`);
    }
    return key;
  }

  /**
   * Add a session to the appropriate queue
   * 
   * @param {string} sessionId - Session ID to add
   * @param {Object} [options={}] - Queue options
   * @param {string} [options.queueType='SPOT'] - Queue type
   * @param {boolean} [options.priority=false] - Add to priority queue
   * @param {Object} [options.metadata] - Additional metadata to store with session
   * @returns {Promise<void>}
   */
  async addToQueue(sessionId, options = {}) {
    const {
      queueType = this.defaultQueue,
      priority = false,
      metadata = {}
    } = options;

    try {
      let queueKey = this.getQueueKey(queueType);
      
      // Use priority queue if requested
      if (priority) {
        queueKey += QueueManager.PRIORITY_SUFFIX;
      }

      // Store metadata if provided
      if (Object.keys(metadata).length > 0) {
        const metadataKey = `${queueKey}:metadata:${sessionId}`;
        await this.redis.hset(metadataKey, {
          ...metadata,
          queuedAt: new Date().toISOString(),
          queueType
        });
        // Set expiry for metadata (1 day)
        await this.redis.expire(metadataKey, 86400);
      }

      // Add to queue (LPUSH for FIFO behavior)
      await this.redis.lpush(queueKey, sessionId);
      
      this.logger.info(`Session ${sessionId} added to ${queueType} queue${priority ? ' (priority)' : ''}`, {
        queueKey,
        priority,
        metadata
      });

    } catch (error) {
      this.logger.error(`Failed to add session ${sessionId} to queue:`, error);
      throw error;
    }
  }

  /**
   * Pop a session from the queue
   * 
   * @param {Object} [options={}] - Pop options
   * @param {string} [options.queueType='SPOT'] - Queue type
   * @param {boolean} [options.checkPriority=true] - Check priority queue first
   * @param {boolean} [options.blocking=false] - Use blocking pop
   * @param {number} [options.timeout=0] - Blocking timeout in seconds
   * @returns {Promise<string|null>} Session ID or null if empty
   */
  async popFromQueue(options = {}) {
    const {
      queueType = this.defaultQueue,
      checkPriority = true,
      blocking = false,
      timeout = 0
    } = options;

    try {
      const baseQueueKey = this.getQueueKey(queueType);
      
      // Check priority queue first if enabled
      if (checkPriority) {
        const priorityKey = baseQueueKey + QueueManager.PRIORITY_SUFFIX;
        const prioritySession = await this.redis.rpop(priorityKey);
        if (prioritySession) {
          this.logger.debug(`Popped priority session ${prioritySession} from ${queueType} queue`);
          return prioritySession;
        }
      }

      // Pop from regular queue
      let sessionId;
      if (blocking && timeout > 0) {
        // Use blocking pop with timeout
        const result = await this.redis.brpop(baseQueueKey, timeout);
        sessionId = result ? result[1] : null; // brpop returns [key, value]
      } else {
        sessionId = await this.redis.rpop(baseQueueKey);
      }

      if (sessionId) {
        this.logger.debug(`Popped session ${sessionId} from ${queueType} queue`);
        
        // Move to processing queue for tracking
        const processingKey = baseQueueKey + QueueManager.PROCESSING_SUFFIX;
        await this.redis.hset(processingKey, sessionId, JSON.stringify({
          startedAt: new Date().toISOString(),
          worker: process.pid
        }));
      }

      return sessionId;

    } catch (error) {
      this.logger.error(`Failed to pop from ${queueType} queue:`, error);
      throw error;
    }
  }

  /**
   * Get queue length for a specific queue type
   * 
   * @param {string} [queueType='SPOT'] - Queue type
   * @param {boolean} [includePriority=true] - Include priority queue in count
   * @returns {Promise<number>} Queue length
   */
  async getQueueLength(queueType = this.defaultQueue, includePriority = true) {
    try {
      const baseQueueKey = this.getQueueKey(queueType);
      let length = await this.redis.llen(baseQueueKey);

      if (includePriority) {
        const priorityKey = baseQueueKey + QueueManager.PRIORITY_SUFFIX;
        const priorityLength = await this.redis.llen(priorityKey);
        length += priorityLength;
      }

      return length;
    } catch (error) {
      this.logger.error(`Failed to get queue length for ${queueType}:`, error);
      throw error;
    }
  }

  /**
   * Get all queue statistics
   * 
   * @returns {Promise<Object>} Queue statistics for all types
   */
  async getAllQueueStats() {
    const stats = {};

    for (const [type, queueKey] of Object.entries(QueueManager.QUEUE_TYPES)) {
      try {
        const regularLength = await this.redis.llen(queueKey);
        const priorityLength = await this.redis.llen(queueKey + QueueManager.PRIORITY_SUFFIX);
        const dlqLength = await this.redis.llen(queueKey + QueueManager.DLQ_SUFFIX);
        const processingCount = await this.redis.hlen(queueKey + QueueManager.PROCESSING_SUFFIX);

        stats[type] = {
          regular: regularLength,
          priority: priorityLength,
          dlq: dlqLength,
          processing: processingCount,
          total: regularLength + priorityLength
        };
      } catch (error) {
        this.logger.error(`Failed to get stats for ${type} queue:`, error);
        stats[type] = { error: error.message };
      }
    }

    return stats;
  }

  /**
   * Move session to dead letter queue
   * 
   * @param {string} sessionId - Session ID
   * @param {string} queueType - Original queue type
   * @param {Object} error - Error that caused the failure
   * @returns {Promise<void>}
   */
  async moveToDeadLetterQueue(sessionId, queueType, error) {
    try {
      const dlqKey = this.getQueueKey(queueType) + QueueManager.DLQ_SUFFIX;
      const metadataKey = `${dlqKey}:metadata:${sessionId}`;

      // Store error information
      await this.redis.hset(metadataKey, {
        sessionId,
        queueType,
        error: error.message || 'Unknown error',
        stack: error.stack || '',
        failedAt: new Date().toISOString(),
        attempts: 1
      });

      // Add to DLQ
      await this.redis.lpush(dlqKey, sessionId);

      this.logger.warn(`Session ${sessionId} moved to dead letter queue`, {
        queueType,
        error: error.message
      });

    } catch (dlqError) {
      this.logger.error(`Failed to move session ${sessionId} to DLQ:`, dlqError);
      throw dlqError;
    }
  }

  /**
   * Mark session as completed and remove from processing
   * 
   * @param {string} sessionId - Session ID
   * @param {string} queueType - Queue type
   * @returns {Promise<void>}
   */
  async markCompleted(sessionId, queueType) {
    try {
      const processingKey = this.getQueueKey(queueType) + QueueManager.PROCESSING_SUFFIX;
      await this.redis.hdel(processingKey, sessionId);
      
      this.logger.debug(`Session ${sessionId} marked as completed in ${queueType} queue`);
    } catch (error) {
      this.logger.error(`Failed to mark session ${sessionId} as completed:`, error);
      throw error;
    }
  }

  /**
   * Recover stale sessions from processing queue
   * 
   * @param {string} [queueType='SPOT'] - Queue type
   * @returns {Promise<number>} Number of sessions recovered
   */
  async recoverStaleProcessing(queueType = this.defaultQueue) {
    try {
      const baseQueueKey = this.getQueueKey(queueType);
      const processingKey = baseQueueKey + QueueManager.PROCESSING_SUFFIX;
      
      // Get all processing sessions
      const processing = await this.redis.hgetall(processingKey);
      const now = Date.now();
      let recovered = 0;

      for (const [sessionId, dataStr] of Object.entries(processing)) {
        try {
          const data = JSON.parse(dataStr);
          const startedAt = new Date(data.startedAt).getTime();
          
          // Check if session has exceeded timeout
          if (now - startedAt > this.processingTimeout) {
            // Remove from processing
            await this.redis.hdel(processingKey, sessionId);
            
            // Add back to main queue
            await this.redis.lpush(baseQueueKey, sessionId);
            
            recovered++;
            this.logger.warn(`Recovered stale session ${sessionId} from processing queue`, {
              queueType,
              processingTime: now - startedAt
            });
          }
        } catch (error) {
          this.logger.error(`Failed to process stale session ${sessionId}:`, error);
        }
      }

      if (recovered > 0) {
        this.logger.info(`Recovered ${recovered} stale sessions from ${queueType} processing queue`);
      }

      return recovered;
    } catch (error) {
      this.logger.error(`Failed to recover stale processing sessions:`, error);
      throw error;
    }
  }

  /**
   * Clear a specific queue (use with caution!)
   * 
   * @param {string} queueType - Queue type to clear
   * @param {boolean} [includeDLQ=false] - Also clear dead letter queue
   * @returns {Promise<Object>} Clear statistics
   */
  async clearQueue(queueType, includeDLQ = false) {
    try {
      const baseQueueKey = this.getQueueKey(queueType);
      const stats = {
        regular: 0,
        priority: 0,
        dlq: 0,
        processing: 0
      };

      // Clear regular queue
      stats.regular = await this.redis.llen(baseQueueKey);
      await this.redis.del(baseQueueKey);

      // Clear priority queue
      const priorityKey = baseQueueKey + QueueManager.PRIORITY_SUFFIX;
      stats.priority = await this.redis.llen(priorityKey);
      await this.redis.del(priorityKey);

      // Clear processing queue
      const processingKey = baseQueueKey + QueueManager.PROCESSING_SUFFIX;
      stats.processing = await this.redis.hlen(processingKey);
      await this.redis.del(processingKey);

      // Clear DLQ if requested
      if (includeDLQ) {
        const dlqKey = baseQueueKey + QueueManager.DLQ_SUFFIX;
        stats.dlq = await this.redis.llen(dlqKey);
        await this.redis.del(dlqKey);
      }

      this.logger.warn(`Cleared ${queueType} queue`, stats);
      return stats;

    } catch (error) {
      this.logger.error(`Failed to clear ${queueType} queue:`, error);
      throw error;
    }
  }

  /**
   * Migrate sessions between queues
   * 
   * @param {string} fromQueue - Source queue type
   * @param {string} toQueue - Destination queue type
   * @param {number} [count=0] - Number to migrate (0 = all)
   * @returns {Promise<number>} Number of sessions migrated
   */
  async migrateQueue(fromQueue, toQueue, count = 0) {
    try {
      const fromKey = this.getQueueKey(fromQueue);
      const toKey = this.getQueueKey(toQueue);
      
      let migrated = 0;
      
      if (count === 0) {
        // Migrate all
        let sessionId;
        while ((sessionId = await this.redis.rpop(fromKey))) {
          await this.redis.lpush(toKey, sessionId);
          migrated++;
        }
      } else {
        // Migrate specific count
        for (let i = 0; i < count; i++) {
          const sessionId = await this.redis.rpop(fromKey);
          if (!sessionId) break;
          
          await this.redis.lpush(toKey, sessionId);
          migrated++;
        }
      }

      this.logger.info(`Migrated ${migrated} sessions from ${fromQueue} to ${toQueue}`);
      return migrated;

    } catch (error) {
      this.logger.error(`Failed to migrate sessions:`, error);
      throw error;
    }
  }
}

/**
 * Create queue manager with standard configuration
 * 
 * @param {Object} redis - Redis client
 * @param {Object} logger - Logger instance
 * @returns {QueueManager} Queue manager instance
 */
export function createQueueManager(redis, logger) {
  return new QueueManager({
    redis,
    logger,
    defaultQueue: 'SPOT',
    dlqRetries: 3,
    processingTimeout: 300000 // 5 minutes
  });
}