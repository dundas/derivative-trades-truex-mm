/**
 * Redis Publisher for Pub/Sub Architecture
 * 
 * This utility provides methods to publish messages to Redis pub/sub channels,
 * specifically for notifying the orderbook archiver about new batches.
 */

export default class RedisPublisher {
  /**
   * Create a new Redis Publisher
   * @param {Object} redis - Redis client instance
   * @param {string} channelPrefix - Prefix for pub/sub channels (default: 'orderbook:batch:ready')
   */
  constructor(redis, channelPrefix = 'orderbook:batch:ready') {
    this.redis = redis;
    this.channelPrefix = channelPrefix;
  }

  /**
   * Publish a message to a Redis channel
   * @param {string} channel - Channel name
   * @param {Object} message - Message to publish (will be JSON stringified)
   * @returns {Promise<boolean>} - Success status
   */
  async publish(channel, message) {
    try {
      const stringMessage = typeof message === 'string' ? message : JSON.stringify(message);
      
      // Check which Redis client interface is available
      if (typeof this.redis.publish === 'function') {
        // Standard Redis client interface
        const result = await this.redis.publish(channel, stringMessage);
        return result >= 0; // Returns number of clients that received the message
      } else if (typeof this.redis.call === 'function') {
        // Some Redis clients use a 'call' method
        const result = await this.redis.call('PUBLISH', channel, stringMessage);
        return result >= 0;
      } else if (typeof this.redis.execute === 'function') {
        // Some Redis clients use an 'execute' method
        const result = await this.redis.execute(['PUBLISH', channel, stringMessage]);
        return result >= 0;
      } else if (this.redis._fetch && this.redis.url) {
        // Upstash Redis REST API client
        const result = await this.redis._fetch(`${this.redis.url}`, {
          method: 'POST',
          body: JSON.stringify(['PUBLISH', channel, stringMessage])
        });
        
        const data = await result.json();
        return data.result >= 0;
      } else {
        console.warn(`Redis client doesn't support any known publish method`);
        return false;
      }
    } catch (error) {
      console.error(`Error publishing to channel ${channel}:`, error);
      return false;
    }
  }

  /**
   * Publish a batch notification
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol name
   * @param {string} batchKey - Redis key of the batch
   * @param {number} batchSize - Size of the batch
   * @returns {Promise<boolean>} - Success status
   */
  async publishBatchNotification(exchange, symbol, batchKey, batchSize) {
    try {
      const message = {
        exchange,
        symbol,
        batchKey,
        batchSize,
        timestamp: Date.now()
      };
      
      // Publish to both the general channel and the symbol-specific channel
      const generalResult = await this.publish(`${this.channelPrefix}`, message);
      const symbolResult = await this.publish(`${this.channelPrefix}:${exchange}:${symbol}`, message);
      
      return generalResult && symbolResult;
    } catch (error) {
      console.error(`Error publishing batch notification for ${exchange}:${symbol}:`, error);
      return false;
    }
  }
}
