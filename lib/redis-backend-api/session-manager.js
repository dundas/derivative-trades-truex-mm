/**
 * SessionManager
 * 
 * Handles session data operations for Redis Data API.
 * 
 * Container-Aware Session Management:
 * Sessions now include container metadata for tracking which container instance
 * created or is managing each session. This enables container-aware rolling sessions
 * and proper session management in distributed containerized environments.
 */

/**
 * SessionManager class for handling session data operations
 */
export class SessionManager {
  /**
   * List of critical fields that should be preserved during updates
   * These fields are set during session creation and should not be lost
   */
  static PRESERVED_FIELDS = [
    // Risk Management Configuration
    'riskParams',
    
    // Pricing Strategy Configuration
    'pricingStrategyConfig',
    'pricingStrategyName',
    'pricingStrategy',
    
    // Trading Configuration
    'tradingPair',
    'symbol',
    'exchange',
    'strategy',
    'tradingMode',
    'budget',
    'initialBudget',
    'sessionLength',
    
    // Session Management Flags
    'settleSessionFlag',
    'settleSession',
    'rollingFlag',
    'maxRollingChainLength',
    'forceTradingEnabled',
    'forceTradingFlag',
    'exportCsvFlag',
    'redisPersistenceFlag',
    'restartSessionFlag',
    'closeSessionFlag',
    'exitOnErrorFlag',
    
    // Exchange Configuration
    'pricePrecision',
    'sizePrecision',
    'minOrderSize',
    'mainLoopIntervalMs',
    
    // Logging Configuration
    'logLevel',
    'consoleLogging',
    'cloudflareLogging',
    'showDetailedLogs',
    'saveSessionHistory',
    'optimizeLogging',
    
    // Session Metadata
    'mode',
    'createdAt',
    'addedAt',
    'startedAt',
    'startTime'
  ];

  /**
   * Create a new SessionManager
   * 
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Trading session ID
   * @param {Object} config.logger - Logger instance
   * @param {Object} config.keyGenerator - Key generator instance
   * @param {Object} config.validationUtils - Validation utilities
   * @param {boolean} [config.enableCaching=true] - Enable/disable caching
   * @param {Object} [config.containerInfoService] - Container information service
   */
  constructor(config) {
    this.redis = config.redis;
    this.sessionId = config.sessionId;
    this.logger = config.logger;
    this.keyGenerator = config.keyGenerator;
    this.validationUtils = config.validationUtils;
    this.enableCaching = config.enableCaching !== false; // Default to true
    this.containerInfoService = config.containerInfoService;
    
    // Initialize cache
    this._sessionCache = null;
    this._sessionCacheExpiry = 0;
    this._cacheTTL = 5000; // 5 seconds default TTL
    
    // Session storage TTL (72 hours = 259200 seconds)
    this._sessionTTL = 259200; // 72 hours
    
    // Log preserved fields on initialization
    this.logger.debug(`[SessionManager] Initialized with ${SessionManager.PRESERVED_FIELDS.length} preserved fields:`, SessionManager.PRESERVED_FIELDS);
  }
  
  /**
   * Get session data
   * @returns {Promise<Object>} - Session data object
   */
  async get() {
    // Check cache first if enabled
    if (this.enableCaching && this._sessionCache && this._sessionCacheExpiry > Date.now()) {
      this.logger.debug(`[SessionManager] Using cached session data for ${this.sessionId}`);
      return this._sessionCache;
    }
    
    try {
      // Generate the session key
      const sessionKey = this.keyGenerator.generateSessionKey();
      this.logger.debug(`[SessionManager] Fetching session data for key: ${sessionKey}`);
      
      // Get session data from Redis
      let sessionData = await this.redis.get(sessionKey);
      
      // Handle session data format (string vs object)
      if (typeof sessionData === 'string') {
        try {
          sessionData = JSON.parse(sessionData);
        } catch (error) {
          this.logger.error(`[SessionManager] Error parsing session data: ${error.message}`);
          return null;
        }
      }
      
      if (!sessionData) {
        this.logger.debug(`[SessionManager] No session data found for session ${this.sessionId}`);
        return null;
      }
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._sessionCache = sessionData;
        this._sessionCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return sessionData;
    } catch (error) {
      this.logger.error(`[SessionManager] Error getting session data: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Create new session
   * @param {Object} sessionData - Session data to create
   * @param {boolean} [includeContainerInfo=true] - Whether to include container metadata
   * @returns {Promise<Object>} - Created session data
   */
  async create(sessionData, includeContainerInfo = true) {
    try {
      // Add container metadata if available and requested
      let sessionWithMetadata = { ...sessionData };
      
      if (includeContainerInfo && this.containerInfoService) {
        const containerMetadata = this.containerInfoService.getContainerMetadataForSession();
        this.logger.debug(`[SessionManager] Adding container metadata: ${JSON.stringify(containerMetadata)}`);
        
        sessionWithMetadata = {
          ...sessionWithMetadata,
          container: containerMetadata,
          // Track container for rolling sessions
          managingContainerId: containerMetadata.containerId
        };
      }
      
      // Validate session data
      const validatedData = this.validationUtils.validateSessionData({
        ...sessionWithMetadata,
        id: this.sessionId
      });
      
      // Log CREATE state
      this.logger.info(`[SessionManager] CREATE - Session ${this.sessionId}:`, {
        hasRiskParams: !!validatedData.riskParams,
        riskParams: validatedData.riskParams,
        fields: Object.keys(validatedData).sort()
      });
      
      // Generate the session key
      const sessionKey = this.keyGenerator.generateSessionKey();
      this.logger.debug(`[SessionManager] Creating session with key: ${sessionKey}`);
      
      // Store in Redis with 72-hour TTL
      await this.redis.set(sessionKey, JSON.stringify(validatedData), 'EX', this._sessionTTL);
      this.logger.debug(`[SessionManager] Session stored with ${this._sessionTTL / 3600}h TTL`);
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._sessionCache = validatedData;
        this._sessionCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return validatedData;
    } catch (error) {
      this.logger.error(`[SessionManager] Error creating session: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update session with new data
   * @param {Object} sessionData - Session data to update
   * @param {boolean} [updateContainerInfo=false] - Whether to update container metadata
   * @returns {Promise<Object>} - Updated session data
   */
  async update(sessionData, updateContainerInfo = false) {
    try {
      // Get existing session data first
      const existingSession = await this.get();
      
      if (!existingSession) {
        this.logger.error(`[SessionManager] Cannot update non-existent session: ${this.sessionId}`);
        throw new Error(`Session ${this.sessionId} not found`);
      }
      
      // Log BEFORE state
      this.logger.info(`[SessionManager] UPDATE BEFORE - Session ${this.sessionId}:`, {
        hasRiskParams: !!existingSession.riskParams,
        riskParams: existingSession.riskParams,
        fields: Object.keys(existingSession).sort()
      });
      
      // Log what's being updated
      this.logger.info(`[SessionManager] UPDATE REQUEST - Session ${this.sessionId}:`, {
        updateFields: Object.keys(sessionData).sort(),
        hasRiskParams: !!sessionData.riskParams
      });
      
      // Prepare update data
      let updateData = { ...sessionData };
      
      // Automatically preserve all critical fields that aren't being explicitly updated
      const preservedCount = { total: 0, fields: [] };
      SessionManager.PRESERVED_FIELDS.forEach(field => {
        if (existingSession[field] !== undefined && updateData[field] === undefined) {
          updateData[field] = existingSession[field];
          preservedCount.total++;
          preservedCount.fields.push(field);
        }
      });
      
      // Debug logging for preserved fields
      if (preservedCount.total > 0) {
        this.logger.debug(`[SessionManager] Preserved ${preservedCount.total} fields during update: ${preservedCount.fields.join(', ')}`);
      }
      
      // Update container metadata if requested and service is available
      if (updateContainerInfo && this.containerInfoService) {
        const containerMetadata = this.containerInfoService.getContainerMetadataForSession();
        this.logger.debug(`[SessionManager] Updating container metadata: ${JSON.stringify(containerMetadata)}`);
        
        // Only update container metadata, not the managing container ID
        // This preserves which container originally created the session
        updateData = {
          ...updateData,
          container: containerMetadata,
          // If management is being transferred, update the managing container
          ...(updateData.transferManagement ? { managingContainerId: containerMetadata.containerId } : {})
        };
        
        // Remove the transfer flag after processing
        if (updateData.transferManagement) {
          delete updateData.transferManagement;
        }
      }
      
      // Merge existing data with new data
      const mergedData = {
        ...existingSession,
        ...updateData,
        id: this.sessionId, // Ensure ID is preserved
        lastUpdated: Date.now() // Update timestamp
      };
      
      // Validate the merged data
      const validatedData = this.validationUtils.validateSessionData(mergedData);
      
      // Log AFTER state (pre-storage)
      this.logger.info(`[SessionManager] UPDATE AFTER - Session ${this.sessionId}:`, {
        hasRiskParams: !!validatedData.riskParams,
        riskParams: validatedData.riskParams,
        fields: Object.keys(validatedData).sort()
      });
      
      // Generate the session key
      const sessionKey = this.keyGenerator.generateSessionKey();
      this.logger.debug(`[SessionManager] Updating session with key: ${sessionKey}`);
      
      // Store in Redis with 72-hour TTL
      await this.redis.set(sessionKey, JSON.stringify(validatedData), 'EX', this._sessionTTL);
      this.logger.debug(`[SessionManager] Session updated with ${this._sessionTTL / 3600}h TTL`);
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._sessionCache = validatedData;
        this._sessionCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return validatedData;
    } catch (error) {
      this.logger.error(`[SessionManager] Error updating session: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update session status
   * @param {string} status - New status
   * @param {boolean} [updateContainerInfo=false] - Whether to update container metadata
   * @returns {Promise<Object>} - Updated session data
   */
  async updateStatus(status, updateContainerInfo = false) {
    try {
      // Get existing session data first
      const existingSession = await this.get();
      
      if (!existingSession) {
        this.logger.error(`[SessionManager] Cannot update status of non-existent session: ${this.sessionId}`);
        throw new Error(`Session ${this.sessionId} not found`);
      }
      
      // Prepare update data
      let updateData = { status };
      
      // Automatically preserve all critical fields
      SessionManager.PRESERVED_FIELDS.forEach(field => {
        if (existingSession[field] !== undefined) {
          updateData[field] = existingSession[field];
        }
      });
      
      // Add container metadata if requested and service is available
      if (updateContainerInfo && this.containerInfoService) {
        const containerMetadata = this.containerInfoService.getContainerMetadataForSession();
        this.logger.debug(`[SessionManager] Adding container metadata during status update: ${JSON.stringify(containerMetadata)}`);
        
        updateData = {
          ...updateData,
          container: containerMetadata,
          // If status is changing to 'complete', record which container performed completion
          ...(status === 'complete' ? { completedByContainerId: containerMetadata.containerId } : {})
        };
      }
      
      // Merge existing data with new status
      const mergedData = {
        ...existingSession,
        ...updateData,
        lastUpdated: Date.now() // Update timestamp
      };
      
      // Validate the status
      const validatedData = this.validationUtils.validateSessionData(mergedData);
      
      // Generate the session key
      const sessionKey = this.keyGenerator.generateSessionKey();
      this.logger.debug(`[SessionManager] Updating session status to ${status} with key: ${sessionKey}`);
      
      // Store in Redis with 72-hour TTL
      await this.redis.set(sessionKey, JSON.stringify(validatedData), 'EX', this._sessionTTL);
      this.logger.debug(`[SessionManager] Session status updated with ${this._sessionTTL / 3600}h TTL`);
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._sessionCache = validatedData;
        this._sessionCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return validatedData;
    } catch (error) {
      this.logger.error(`[SessionManager] Error updating session status: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get the Redis key for this session
   * @returns {string} - Redis key
   */
  getSessionKey() {
    return this.keyGenerator.generateSessionKey();
  }
  
  /**
   * Clear the session cache
   */
  clearCache() {
    this._sessionCache = null;
    this._sessionCacheExpiry = 0;
  }
  
  /**
   * Get session status
   * @returns {Promise<string|null>} - Session status or null if session not found
   */
  async getStatus() {
    try {
      // Get the session data
      const sessionData = await this.get();
      
      if (!sessionData) {
        this.logger.debug(`[SessionManager] No session found for ${this.sessionId}, cannot retrieve status`);
        return null;
      }
      
      this.logger.debug(`[SessionManager] Retrieved status ${sessionData.status} for session ${this.sessionId}`);
      return sessionData.status || null;
    } catch (error) {
      this.logger.error(`[SessionManager] Error getting session status: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Static method to find a session by ID without requiring the trading pair
   * Uses Redis pattern matching to locate the session
   * 
   * @static
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Session ID to find
   * @param {Object} config.logger - Logger instance
   * @returns {Promise<Object>} - Object containing session data and key information
   */
  static async findBySessionId(config) {
    const { redis, sessionId, logger = console } = config;
    
    if (!redis) throw new Error('Redis client is required');
    if (!sessionId) throw new Error('Session ID is required');
    
    try {
      // Pattern to match any session key containing the session ID
      // Format: *:{sessionId}:session
      const sessionPattern = `*:${sessionId}:session`;
      logger.debug(`[SessionManager] Searching for session with pattern: ${sessionPattern}`);
      
      // Use the SCAN command to find keys matching the pattern
      const matchingKeys = await redis.keys(sessionPattern);
      
      if (!matchingKeys || matchingKeys.length === 0) {
        logger.debug(`[SessionManager] No sessions found with ID: ${sessionId}`);
        return null;
      }
      
      // Use the first matching key (should be only one session per ID)
      const sessionKey = matchingKeys[0];
      logger.debug(`[SessionManager] Found session key: ${sessionKey}`);
      
      // Get the session data using the found key
      let sessionData = await redis.get(sessionKey);
      
      logger.debug(`[SessionManager] Retrieved raw data from Redis for key ${sessionKey}:`, {
        type: typeof sessionData,
        isString: typeof sessionData === 'string',
        isArray: Array.isArray(sessionData),
        isObject: typeof sessionData === 'object',
        hasZeroKey: sessionData && typeof sessionData === 'object' && sessionData["0"] !== undefined,
        keys: sessionData && typeof sessionData === 'object' ? Object.keys(sessionData).slice(0, 10) : 'not an object',
        stringLength: typeof sessionData === 'string' ? sessionData.length : 'not a string',
        arrayLength: Array.isArray(sessionData) ? sessionData.length : 'not an array'
      });
      
      // Handle session data format - check for array format first
      if (Array.isArray(sessionData) && sessionData.length > 0) {
        // Redis client returned data as array, use first element
        sessionData = sessionData[0];
        logger.debug(`[SessionManager] Extracted data from array format`);
      }
      
      // Handle session data format (string vs object)
      if (typeof sessionData === 'string') {
        try {
          sessionData = JSON.parse(sessionData);
          logger.debug(`[SessionManager] Successfully parsed session data from string`);
        } catch (error) {
          logger.error(`[SessionManager] Error parsing session data: ${error.message}`);
          return null;
        }
      }
      
      if (!sessionData) {
        logger.debug(`[SessionManager] No session data found for key: ${sessionKey}`);
        return null;
      }
      
      // Extract key components from the session key
      // Format: {strategy}:{exchange}:{symbol}:{sessionId}:session
      const keyParts = sessionKey.split(':');
      
      // Need at least 5 parts in a valid key
      if (keyParts.length < 5) {
        logger.error(`[SessionManager] Invalid session key format: ${sessionKey}`);
        return null;
      }
      
      // Extract key components (assuming the standard format)
      const keyInfo = {
        strategy: keyParts[0],
        exchange: keyParts[1],
        symbol: keyParts[2].replace('-', '/').toUpperCase(), // Convert back to original format (e.g., 'btc-usd' -> 'BTC/USD')
        sessionId: keyParts[3],
        keyName: keyParts[4]
      };
      
      // Return both the session data and the key information
      return {
        data: sessionData,
        keyInfo,
        sessionKey
      };
    } catch (error) {
      logger.error(`[SessionManager] Error finding session by ID: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Static method to get all Redis keys related to a session
   * Useful for retrieving all data associated with a session (orders, positions, etc.)
   * 
   * @static
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Session ID to find keys for
   * @param {boolean} [config.includeHistory=false] - Whether to include history keys
   * @param {Object} [config.logger=console] - Logger instance
   * @returns {Promise<Object>} - Object containing all keys categorized by type
   */
  static async getSessionKeys(config) {
    const { redis, sessionId, includeHistory = false, logger = console } = config;
    
    if (!redis) throw new Error('Redis client is required');
    if (!sessionId) throw new Error('Session ID is required');
    
    try {
      // First, find the session to extract key components
      const sessionResult = await SessionManager.findBySessionId({ redis, sessionId, logger });
      
      if (!sessionResult) {
        logger.debug(`[SessionManager] Cannot find session keys - Session not found: ${sessionId}`);
        return null;
      }
      
      const { keyInfo } = sessionResult;
      const { strategy, exchange, symbol } = keyInfo;
      
      // Format the symbol for Redis keys
      const formattedSymbol = symbol.toLowerCase().replace('/', '-');
      
      // Create the key prefix (all keys for this session will start with this)
      const keyPrefix = `${strategy}:${exchange}:${formattedSymbol}:${sessionId}`;
      logger.debug(`[SessionManager] Searching for all keys with prefix: ${keyPrefix}`);
      
      // Get all keys for this session
      const allSessionKeys = await redis.keys(`${keyPrefix}:*`);
      
      // Categorize keys by type
      const categorizedKeys = {
        session: null,
        orders: null,
        positions: null,
        fills: null,
        trades: null,
        metrics: null,
        logs: null,
        history: null,
        other: [],
        all: []
      };
      
      // Add all keys to the 'all' array
      categorizedKeys.all = allSessionKeys;
      
      // Process each key and categorize it
      allSessionKeys.forEach(key => {
        const parts = key.split(':');
        const keyType = parts[parts.length - 1];
        
        switch (keyType) {
          case 'session':
            categorizedKeys.session = key;
            break;
          case 'orders':
            categorizedKeys.orders = key;
            break;
          case 'positions':
            categorizedKeys.positions = key;
            break;
          case 'fills':
            categorizedKeys.fills = key;
            break;
          case 'trades':
            categorizedKeys.trades = key;
            break;
          case 'metrics':
            categorizedKeys.metrics = key;
            break;
          case 'logs':
            categorizedKeys.logs = key;
            break;
          default:
            categorizedKeys.other.push(key);
        }
      });
      
      // Include history keys if requested
      if (includeHistory) {
        const historyKey = `${strategy}:${exchange}:${formattedSymbol}:session-history`;
        categorizedKeys.history = historyKey;
      }
      
      // Add the key components for reference
      categorizedKeys.keyComponents = {
        strategy,
        exchange,
        symbol,
        formattedSymbol,
        sessionId,
        keyPrefix
      };
      
      return categorizedKeys;
    } catch (error) {
      logger.error(`[SessionManager] Error getting session keys: ${error.message}`);
      return null;
    }
  }
} 