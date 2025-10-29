/**
 * Redis Backend API
 * 
 * Main entry point for Redis data operations. Provides a consistent interface
 * for managing session, order and fill data in Redis. This API acts as the
 * backend data layer for interacting with Redis, handling key generation,
 * data validation, and deduplication of orders and fills.
 * 
 * Container-Aware Feature:
 * This API now integrates with ContainerInfoService to provide container-aware
 * session management, enabling seamless operation in containerized environments
 * and supporting container-aware rolling sessions.
 */

import { SessionManager } from './session-manager.js';
import { OrderManager } from './order-manager.js';
import { FillManager } from './fill-manager.js';
import { KeyGenerator } from './utils/key-generator.js';
import { ValidationUtils } from './utils/validation-utils.js';
import { RedisClient } from '../utils/redis-client.js';
import { containerInfoService } from '../utils/container-info-service.js';

/**
 * RedisDataAPI is the main entry point for Redis data operations,
 * providing access to specialized managers for sessions, orders, and fills.
 */
export class RedisDataAPI {
  /**
   * Creates a new RedisDataAPI instance
   * 
   * @param {Object} config - Configuration options
   * @param {Object} [config.redis] - Redis client instance (not required if url and token are provided)
   * @param {string} [config.url] - Redis endpoint URL (used if redis is not provided)
   * @param {string} [config.token] - Redis authentication token (used if redis is not provided)
   * @param {string} config.sessionId - Trading session ID
   * @param {string} config.strategy - Trading strategy (e.g., 'traditional')
   * @param {string} config.exchange - Exchange name (e.g., 'kraken')
   * @param {string} config.symbol - Trading symbol (e.g., 'BTC/USD')
   * @param {Object} [config.logger] - Logger instance (defaults to console)
   * @param {boolean} [config.enableCaching=true] - Enable/disable caching
   * @param {Object} [config.containerInfoService] - Container info service (defaults to global instance)
   * @param {boolean} [config.containerAware=true] - Enable/disable container awareness
   */
  constructor(config) {
    // Initialize logger early for diagnostics
    const logger = config.logger || console;
    
    // Create Redis client if none provided but URL and token are
    if (!config.redis) {
      if (config.url && config.token) {
        logger.info(`Creating Redis client with provided URL and token`);
        config.redis = new RedisClient({
          url: config.url,
          token: config.token,
          debug: config.debug || false
        });
      } else {
        throw new Error('Either a Redis client or URL and token are required');
      }
    }
    
    // Validate session ID (always required)
    if (!config.discoveryMode && !config.sessionId) throw new Error('Session ID is required (unless in discoveryMode)');
    
    // Check if we're using sessionId-only initialization
    this.isSessionIdOnlyInit = !!(config.sessionId && (!config.strategy || !config.exchange || !config.symbol));
    
    // Store original configuration for parameter derivation if needed
    this.originalConfig = { ...config };
    
    // Only validate strategy, exchange, symbol if NOT using sessionId-only initialization AND NOT in discovery mode
    if (!this.isSessionIdOnlyInit && !config.discoveryMode) {
      if (!config.strategy) throw new Error('Strategy is required');
      if (!config.exchange) throw new Error('Exchange is required');
      if (!config.symbol) throw new Error('Symbol is required');
    }
    
    // Store configuration - use placeholder values for sessionId-only initialization
    this.config = {
      redis: config.redis,
      sessionId: config.sessionId,
      strategy: this.isSessionIdOnlyInit ? 'pending' : config.strategy,
      exchange: this.isSessionIdOnlyInit ? 'pending' : config.exchange,
      symbol: this.isSessionIdOnlyInit ? 'pending' : config.symbol,
      logger: config.logger || console,
      enableCaching: config.enableCaching !== false, // Default to true
      containerAware: config.containerAware !== false, // Default to true
      containerInfoService: config.containerInfoService || containerInfoService, // Use imported singleton instance
      discoveryMode: config.discoveryMode // Ensure discoveryMode is part of this.config
    };
    
    // Create validation utils
    this.validationUtils = new ValidationUtils();
    
    // If using sessionId-only initialization OR if in discovery mode, we'll delay creating the key generator and managers.
    // In discovery mode, parameters are not yet known.
    // In sessionId-only, they need to be derived by initialize().
    if (!this.isSessionIdOnlyInit && !config.discoveryMode) {
      this._setupManagers();
    }
  }
  
  /**
   * Get the Redis client instance
   * @returns {Object} Redis client instance
   */
  get redis() {
    return this.config.redis;
  }
  
  /**
   * Set up managers with the current configuration
   * @private
   */
  _setupManagers() {
    // Generate standard key generator
    this.keyGenerator = new KeyGenerator({
      strategy: this.config.strategy,
      exchange: this.config.exchange,
      symbol: this.config.symbol,
      sessionId: this.config.sessionId
    });
    
    // Log container information if enabled
    if (this.config.containerAware && this.config.containerInfoService) {
      const cInfo = this.config.containerInfoService.getInfo();
      const identifier = cInfo.hostname ? `${cInfo.hostname}:${cInfo.containerId.slice(0,8)}` : `container:${cInfo.containerId.slice(0,8)}`;
      this.config.logger.info(`[RedisDataAPI] Initializing with container awareness: ${identifier}`);
      this.config.logger.debug(`[RedisDataAPI] Container info: ${JSON.stringify(cInfo)}`);
    }
    
    // Initialize managers
    this.session = new SessionManager({
      redis: this.config.redis,
      sessionId: this.config.sessionId,
      logger: this.config.logger,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils,
      enableCaching: this.config.enableCaching,
      // Only pass containerInfoService if container awareness is enabled
      ...(this.config.containerAware ? { containerInfoService: this.config.containerInfoService } : {})
    });
    
    this.orders = new OrderManager({
      ...this.config,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils
    });
    
    this.fills = new FillManager({
      ...this.config,
      keyGenerator: this.keyGenerator,
      validationUtils: this.validationUtils
    });
  }
  
  /**
   * Derive strategy, exchange, and symbol parameters from the sessionId
   * @private
   * @returns {Promise<boolean>} Success flag
   */
  async _deriveParametersFromSessionId() {
    const { redis, sessionId, logger } = this.originalConfig;
    
    try {
      // Find the session key in Redis
      const sessionKeyPattern = `*:*:*:${sessionId}:session`;
      logger.debug(`Looking for session key with pattern: ${sessionKeyPattern}`);
      
      const matchingKeys = await redis.keys(sessionKeyPattern);
      
      if (!matchingKeys || matchingKeys.length === 0) {
        throw new Error(`No session found for sessionId: ${sessionId}`);
      }
      
      if (matchingKeys.length > 1) {
        logger.warn(`Multiple session keys found for ${sessionId}. Using the first one.`);
      }
      
      // Use the first matching key (usually there should only be one)
      const sessionKey = matchingKeys[0];
      logger.debug(`Found session key: ${sessionKey}`);
      
      // Parse the key to extract strategy, exchange, and symbol
      // Format is: strategy:exchange:symbol:sessionId:keyName
      const keyParts = sessionKey.split(':');
      
      if (keyParts.length < 5) {
        throw new Error(`Invalid session key format: ${sessionKey}`);
      }
      
      const strategy = keyParts[0];
      const exchange = keyParts[1];
      // Convert btc-usd to BTC/USD
      const symbol = keyParts[2].replace('-', '/').toUpperCase(); 
      
      logger.debug(`Derived parameters - Strategy: ${strategy}, Exchange: ${exchange}, Symbol: ${symbol}`);
      
      // Update the config with the derived parameters
      this.config = {
        ...this.originalConfig,
        strategy,
        exchange,
        symbol,
        logger: this.originalConfig.logger || console,
        enableCaching: this.originalConfig.enableCaching !== false
      };
      
      return true;
    } catch (error) {
      this.config.logger.error(`Failed to derive parameters from sessionId: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Initialize the API and managers
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      // If using sessionId-only initialization, derive parameters first
      if (this.isSessionIdOnlyInit) {
        await this._deriveParametersFromSessionId();
        
        // Now that we have all required parameters, set up the managers
        this._setupManagers();
      }
      
      // Perform any necessary initialization steps, but only if not in discovery mode
      if (!this.config.discoveryMode) {
        if (typeof this.session.initialize === 'function') {
          await this.session.initialize();
        }
        
        if (typeof this.orders.initialize === 'function') {
          await this.orders.initialize();
        }
        
        if (typeof this.fills.initialize === 'function') {
          await this.fills.initialize();
        }
      }
      
      return true;
    } catch (error) {
      const logger = this.config.logger || console;
      logger.error(`Error initializing Redis Data API: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Clean up resources and connections
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Clean up any resources when API is no longer needed
    // This is mostly for completeness as Redis connections are usually managed separately
    this.config.logger.debug('Disconnecting Redis Data API');
  }
  
  /**
   * Clear all caches
   * @returns {Promise<void>}
   */
  async clearCache() {
    if (typeof this.session.clearCache === 'function') {
      await this.session.clearCache();
    }
    
    if (typeof this.orders.clearCache === 'function') {
      await this.orders.clearCache();
    }
    
    if (typeof this.fills.clearCache === 'function') {
      await this.fills.clearCache();
    }
  }
} 