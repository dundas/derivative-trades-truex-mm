/**
 * Kraken WebSocket Factory
 * 
 * This file provides a factory for creating Kraken WebSocket API clients
 * with support for both v1 and v2 API versions.
 */

import KrakenWebSocketV1 from './kraken-websocket-v1.js';
import KrakenWebSocketV2 from './kraken-websocket-v2.js';

class KrakenWebSocketFactory {
  /**
   * Create a Kraken WebSocket client
   * @param {string} version - API version ('v1' or 'v2')
   * @param {object} logger - Logger instance
   * @param {object} redisClient - Redis client instance
   * @returns {KrakenWebSocketV1|KrakenWebSocketV2} WebSocket client instance
   */
  static createClient(version, logger, redisClient) {
    if (version === 'v1') {
      return new KrakenWebSocketV1(logger, redisClient);
    } else if (version === 'v2') {
      return new KrakenWebSocketV2(logger, redisClient);
    } else {
      throw new Error(`Unsupported Kraken WebSocket API version: ${version}. Supported versions are 'v1' and 'v2'.`);
    }
  }
}

export default KrakenWebSocketFactory;
