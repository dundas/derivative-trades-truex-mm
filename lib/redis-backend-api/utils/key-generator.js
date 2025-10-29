/**
 * KeyGenerator
 * 
 * Utility for generating consistent Redis keys for the Redis Data API.
 * This ensures that all components use the same key format.
 */

import { formatSymbol, formatExchange, generateRedisKey } from '../../utils/redis-key-formatter.js';

/**
 * KeyGenerator class for consistent Redis key generation
 */
export class KeyGenerator {
  /**
   * Creates a new KeyGenerator
   * 
   * @param {Object} config - Configuration options
   * @param {string} config.strategy - Strategy name
   * @param {string} config.exchange - Exchange name
   * @param {string} config.symbol - Trading symbol
   * @param {string} config.sessionId - Session ID
   */
  constructor(config) {
    // Validate required parameters
    if (!config.strategy) throw new Error('Strategy is required');
    if (!config.exchange) throw new Error('Exchange is required');
    if (!config.symbol) throw new Error('Symbol is required');
    if (!config.sessionId) throw new Error('Session ID is required');
    
    this.strategy = config.strategy;
    this.exchange = config.exchange;
    this.symbol = config.symbol;
    this.sessionId = config.sessionId;
    
    // Pre-format common values
    this.formattedSymbol = formatSymbol(this.symbol);
    this.formattedExchange = formatExchange(this.exchange);
  }
  
  /**
   * Generate a session key
   * @returns {string} - Redis key for session
   */
  generateSessionKey() {
    return generateRedisKey({
      strategy: this.strategy,
      exchange: this.exchange,
      symbol: this.symbol,
      sessionId: this.sessionId,
      keyName: 'session'
    });
  }
  
  /**
   * Generate an orders collection key
   * @returns {string} - Redis key for orders collection
   */
  generateOrdersKey() {
    return generateRedisKey({
      strategy: this.strategy,
      exchange: this.exchange,
      symbol: this.symbol,
      sessionId: this.sessionId,
      keyName: 'orders'
    });
  }
  
  /**
   * Generate a fills collection key
   * @returns {string} - Redis key for fills collection
   */
  generateFillsKey() {
    return generateRedisKey({
      strategy: this.strategy,
      exchange: this.exchange,
      symbol: this.symbol,
      sessionId: this.sessionId,
      keyName: 'fills'
    });
  }
  
  /**
   * Generate a positions collection key
   * @returns {string} - Redis key for positions collection
   */
  generatePositionsKey() {
    return generateRedisKey({
      strategy: this.strategy,
      exchange: this.exchange,
      symbol: this.symbol,
      sessionId: this.sessionId,
      keyName: 'positions'
    });
  }
  
  /**
   * Generate a custom key with the given key name
   * @param {string} keyName - Custom key name
   * @returns {string} - Redis key with the custom key name
   */
  generateCustomKey(keyName) {
    return generateRedisKey({
      strategy: this.strategy,
      exchange: this.exchange,
      symbol: this.symbol,
      sessionId: this.sessionId,
      keyName
    });
  }
  
  /**
   * Parse a Redis key into its component parts
   * @param {string} keyString - The Redis key to parse
   * @returns {Object|null} - Object containing the key components or null if parsing fails
   */
  static parseKey(keyString) {
    if (!keyString) return null;
    
    // Basic structure validation
    if (typeof keyString !== 'string') {
      return null;
    }
    
    // Split the key into parts using colon as separator
    const parts = keyString.split(':');
    
    // Check for common key formats:
    // 1. keyName:strategy:exchange:symbol:sessionId
    // 2. strategy:exchange:symbol:sessionId:keyName
    
    // Try to determine if we have a UUID sessionId (format 8-4-4-4-12 hex digits)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    // Standard format: strategy:exchange:symbol:sessionId:keyName
    if (parts.length === 5) {
      // Check if the 4th part is a UUID (standard key format)
      if (uuidPattern.test(parts[3])) {
        return {
          strategy: parts[0],
          exchange: parts[1],
          symbol: parts[2],
          sessionId: parts[3],
          keyName: parts[4]
        };
      }
      
      // Check if last part is UUID (alternate format: keyType:strategy:exchange:symbol:sessionId)
      if (uuidPattern.test(parts[4])) {
        return {
          keyType: parts[0],
          strategy: parts[1],
          exchange: parts[2],
          symbol: parts[3],
          sessionId: parts[4],
          keyName: parts[0] // In this case keyType is also the keyName
        };
      }
    }
    
    // Scan for a UUID anywhere in the key parts
    for (let i = 0; i < parts.length; i++) {
      if (uuidPattern.test(parts[i])) {
        // We've found a UUID, assume it's the sessionId
        const sessionId = parts[i];
        // Create a partial result with the known sessionId
        return {
          sessionId: sessionId,
          // Include the original key for reference
          originalKey: keyString,
          // Include parts for additional parsing if needed
          parts: parts
        };
      }
    }
    
    // If no UUID found, but key is in the form of known prefixes
    const knownPrefixes = ['session', 'orders', 'fills', 'positions'];
    if (knownPrefixes.includes(parts[0])) {
      return {
        keyName: parts[0],
        originalKey: keyString,
        parts: parts
      };
    }
    
    // Return null or partial information if standard parsing fails
    return {
      originalKey: keyString,
      parts: parts
    };
  }
} 