/**
 * Container-Aware Rolling Session Manager
 * 
 * This class extends the standard session management functionality to support
 * container-aware rolling sessions, where session management responsibility
 * is transferred between containers in a distributed environment.
 * 
 * Key features:
 * - Automatic session handoff between containers
 * - Container metadata tracking for each session transition
 * - Support for clean session transfer during container shutdowns
 * - Cross-container session orphan detection and recovery
 */

import { containerInfoService } from '../utils/container-info-service.js';

export class RollingSessionManager {
  /**
   * Create a new RollingSessionManager
   * @param {Object} options - Configuration options
   * @param {Object} options.sessionManager - Instance of the SessionManager
   * @param {Object} options.redis - Redis client instance
   * @param {Object} options.logger - Logger instance
   * @param {Object} [options.containerInfoService] - Container info service (default: containerInfoService)
   * @param {Boolean} [options.alwaysRoll=false] - Always roll sessions regardless of other conditions
   * @param {Number} [options.maxChainLength=10] - Maximum number of times a session can be rolled (0 = unlimited)
   */
  constructor(options) {
    this.sessionManager = options.sessionManager;
    this.redis = options.redis;
    this.logger = options.logger;
    this.containerInfoService = options.containerInfoService || containerInfoService;
    this.alwaysRoll = options.alwaysRoll || false;
    this.maxChainLength = options.maxChainLength !== undefined ? options.maxChainLength : 10;
    
    // Get container info
    this.containerInfo = this.containerInfoService.getInfo();
    this.containerId = this.containerInfo.containerId;
    
    this.logger.debug(`[RollingSessionManager] Initialized with container ID: ${this.containerId}`);
    this.logger.debug(`[RollingSessionManager] Always roll sessions: ${this.alwaysRoll}`);
    this.logger.debug(`[RollingSessionManager] Max chain length: ${this.maxChainLength} (0 = unlimited)`);
  }
  
  /**
   * Create a new session with a specific ID
   * @private
   * @param {String} newSessionId - The ID to use for the new session
   * @param {Object} sessionData - The data for the new session
   * @returns {Promise<Object>} The newly created session
   */
  async _createSessionWithId(newSessionId, sessionData) {
    this.logger.debug(`[RollingSessionManager] Creating new session with ID: ${newSessionId}`);
    
    // Direct creation method by constructing the key manually
    // This avoids issues with the sessionManager's sessionId property
    const { strategy, exchange, symbol } = sessionData;
    
    // Clean symbol for Redis key pattern
    const cleanSymbol = symbol.toLowerCase().replace('/', '-');
    
    // Construct the session key manually
    const sessionKey = `${strategy}:${exchange}:${cleanSymbol}:${newSessionId}:session`;
    
    // Add container metadata
    const cInfo = this.containerInfoService.getInfo();
    sessionData.container = {
      containerId: cInfo.containerId,
      containerType: cInfo.hostname !== 'unknown-hostname' ? 'worker' : 'unknown',
      hostname: cInfo.hostname,
      region: cInfo.region,
    };
    
    // Add managing container ID
    sessionData.managingContainerId = cInfo.containerId;
    
    // Ensure the ID is set correctly
    sessionData.id = newSessionId;
    
    // Store in Redis
    await this.redis.set(sessionKey, JSON.stringify(sessionData));
    
    this.logger.debug(`[RollingSessionManager] Created new session with key: ${sessionKey}`);
    
    return sessionData;
  }
  
  /**
   * Calculate the chain length of a session by traversing its parent sessions
   * @param {String} sessionId - ID of the session to check
   * @returns {Promise<Number>} The chain length (1 for original session, 2 for first roll, etc.)
   */
  async calculateChainLength(sessionId) {
    let chainLength = 1;
    let currentSessionId = sessionId;
    const maxTraversal = 100; // Safety limit to prevent infinite loops
    
    try {
      for (let i = 0; i < maxTraversal; i++) {
        // Get the session data
        const sessionKey = this.sessionManager.keyGenerator.generateSessionKey(currentSessionId);
        const sessionData = await this.redis.get(sessionKey);
        
        if (!sessionData) {
          this.logger.debug(`[RollingSessionManager] Session ${currentSessionId} not found while calculating chain length`);
          break;
        }
        
        // Parse the session data if needed
        let session = sessionData;
        if (typeof sessionData === 'string') {
          try {
            session = JSON.parse(sessionData);
          } catch (err) {
            this.logger.error(`[RollingSessionManager] Error parsing session data: ${err.message}`);
            break;
          }
        }
        
        // Check if this session was rolled from another
        if (session.rolledFromSessionId) {
          chainLength++;
          currentSessionId = session.rolledFromSessionId;
          this.logger.debug(`[RollingSessionManager] Found parent session: ${currentSessionId}, chain length now: ${chainLength}`);
        } else {
          // No more parent sessions
          break;
        }
      }
      
      this.logger.info(`[RollingSessionManager] Calculated chain length for session ${sessionId}: ${chainLength}`);
      return chainLength;
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error calculating chain length: ${error.message}`);
      return chainLength; // Return what we've calculated so far
    }
  }
  
  /**
   * Check if there is already an active session that was rolled from the current session
   * This helps prevent multiple active sessions for the same trading pair
   * 
   * @param {String} sessionId - ID of the session to check
   * @param {Object} session - Session data object
   * @returns {Promise<Boolean>} True if there is already an active rolled session
   */
  async checkForActiveRolledSessions(sessionId, session) {
    try {
      // If the session already has a nextSessionId, check if that session is active
      if (session.nextSessionId) {
        this.logger.debug(`[RollingSessionManager] Session ${sessionId} already has a next session: ${session.nextSessionId}`);
        
        // Try to get the next session
        const nextSessionKey = this.sessionManager.keyGenerator.generateSessionKey(session.nextSessionId);
        this.logger.debug(`[RollingSessionManager] Looking up next session with key: ${nextSessionKey}`);
        
        const nextSessionData = await this.sessionManager.redis.get(nextSessionKey);
        
        // Parse the session data if needed
        let nextSession = nextSessionData;
        if (typeof nextSessionData === 'string') {
          try {
            nextSession = JSON.parse(nextSessionData);
          } catch (err) {
            this.logger.error(`[RollingSessionManager] Error parsing next session data: ${err.message}`);
          }
        }
        
        if (nextSession && nextSession.status === 'active') {
          this.logger.info(`[RollingSessionManager] Found an active rolled session: ${session.nextSessionId}`);
          return true;
        }
      }
      
      // Get the trading pair details for further search
      const symbol = session.symbol;
      const exchange = session.exchange || 'kraken';
      const strategy = session.strategy || 'traditional-v2';
      
      // Format symbol properly for Redis key pattern
      const cleanSymbol = symbol.toLowerCase().replace('/', '-');
      
      // Find any recent active sessions for this same trading pair
      // that might have been created through rolling
      const sessionKeyPattern = `${strategy}:${exchange}:${cleanSymbol}:*:session`;
      this.logger.debug(`[RollingSessionManager] Searching for active sessions with pattern: ${sessionKeyPattern}`);
      
      const sessionKeys = await this.redis.keys(sessionKeyPattern);
      
      this.logger.debug(`[RollingSessionManager] Found ${sessionKeys.length} total sessions for ${symbol}`);
      
      // Check if any of these sessions were started after our session and are active
      const currentSessionStartTime = session.startedAt || 0;
      
      // Add more robust session checking for each key found
      for (const key of sessionKeys) {
        try {
          this.logger.debug(`[RollingSessionManager] Checking session key: ${key}`);
          // Get the session data from Redis
          const otherSessionData = await this.redis.get(key);
          
          if (!otherSessionData) {
            this.logger.debug(`[RollingSessionManager] No data found for key: ${key}`);
            continue;
          }
          
          // Parse the session data if it's a string
          let otherSession;
          try {
            otherSession = typeof otherSessionData === 'string' 
              ? JSON.parse(otherSessionData) 
              : otherSessionData;
          } catch (parseErr) {
            this.logger.error(`[RollingSessionManager] Error parsing session data: ${parseErr.message}`);
            continue;
          }
          
          if (!otherSession || !otherSession.id) {
            this.logger.debug(`[RollingSessionManager] Invalid session data for key: ${key}`);
            continue;
          }
          
          // Skip current session
          if (otherSession.id === sessionId) {
            this.logger.debug(`[RollingSessionManager] Skipping current session: ${sessionId}`);
            continue;
          }
          
          // Check if this session is active and meets any of the criteria for a rolled session
          const isActive = otherSession.status === 'active';
          const isNewer = otherSession.startedAt > currentSessionStartTime;
          const isRolledFromThis = otherSession.rolledFromSessionId === sessionId;
          
          // Log details about each session for debugging
          this.logger.debug(`[RollingSessionManager] Session ${otherSession.id}: ` +
            `Status=${otherSession.status}, ` +
            `StartedAt=${otherSession.startedAt}, ` +
            `RolledFrom=${otherSession.rolledFromSessionId || 'none'}`);
          
          if (isActive && (isNewer || isRolledFromThis)) {
            this.logger.info(`[RollingSessionManager] Found active session ${otherSession.id} for ${symbol}`);
            this.logger.info(`[RollingSessionManager] - isActive: ${isActive}, isNewer: ${isNewer}, isRolledFromThis: ${isRolledFromThis}`);
            return true;
          }
        } catch (err) {
          this.logger.error(`[RollingSessionManager] Error checking session: ${err.message}`);
        }
      }
      
      this.logger.info(`[RollingSessionManager] No active rolled sessions found for ${sessionId}`);
      return false;
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error checking for active rolled sessions: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Roll a session by completing the current one and starting a new one
   * @param {String} sessionId - ID of the session to roll
   * @param {Object} [options] - Session rolling options
   * @param {String} [options.reason='Container rolling session'] - Reason for rolling
   * @param {Boolean} [options.keepSettings=true] - Keep settings from original session
   * @param {Boolean} [options.preserveState=true] - Preserve state from original session
   * @returns {Promise<Object>} The new session object
   */
  async rollSession(sessionId, options = {}) {
    const {
      reason = 'Container rolling session',
      keepSettings = true,
      preserveState = true
    } = options;
    
    this.logger.info(`[RollingSessionManager] Rolling session ${sessionId}, reason: ${reason}`);
    
    try {
      // Check if max chain length is configured and not unlimited (0)
      if (this.maxChainLength > 0) {
        // Calculate current chain length
        const currentChainLength = await this.calculateChainLength(sessionId);
        
        if (currentChainLength >= this.maxChainLength) {
          this.logger.warn(`[RollingSessionManager] Cannot roll session ${sessionId} - max chain length (${this.maxChainLength}) reached. Current chain length: ${currentChainLength}`);
          return {
            success: false,
            error: `Maximum chain length of ${this.maxChainLength} reached`,
            currentChainLength: currentChainLength,
            maxChainLength: this.maxChainLength
          };
        }
        
        this.logger.info(`[RollingSessionManager] Current chain length: ${currentChainLength}, max allowed: ${this.maxChainLength}`);
      } else {
        this.logger.info(`[RollingSessionManager] Max chain length is unlimited (0), proceeding with roll`);
      }
      
      // Get the current session - use let instead of const so we can modify it if needed
      let currentSession = await this.sessionManager.get(sessionId);
      
      if (!currentSession) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      // Allow both active and complete sessions to be rolled
      // This allows rolling to work even if the session has already been marked as complete
      if (currentSession.status !== 'active' && currentSession.status !== 'complete') {
        throw new Error(`Cannot roll session ${sessionId} - session is neither active nor complete (status: ${currentSession.status})`);
      }
      
      // Log the session status for debugging
      this.logger.info(`[RollingSessionManager] Rolling session with status: ${currentSession.status}`);
      
      // If the session is already complete, we need to temporarily mark it as active for rolling
      const wasComplete = currentSession.status === 'complete';
      if (wasComplete) {
        this.logger.info(`[RollingSessionManager] Session was complete, temporarily marking as active for rolling`);
        // Make a copy to avoid modifying the original
        currentSession = { ...currentSession, status: 'active' };
      }
      
      // First, check for ANY active sessions for this trading pair that are newer
      // This is a broader check than just checking directly linked sessions
      const symbol = currentSession.symbol;
      const exchange = currentSession.exchange || 'kraken';
      const strategy = currentSession.strategy || 'traditional-v2';
      
      // Note: We're allowing multiple active sessions for the same trading pair
      // This is intentional as requested by the user
      
      // Mark the current session as paused before rolling
      // We use 'paused' as an intermediate state since 'rolling' is not a valid status
      const updatedSession = await this.sessionManager.updateStatus('paused', true);
      
      // Add a note in the session to indicate that it's being rolled, not just paused
      await this.sessionManager.update({
        rollingInProgress: true,
        rollingStartedAt: Date.now()
      });
      
      this.logger.debug(`[RollingSessionManager] Session ${sessionId} status updated to paused for rolling`);
      
      // Generate a unique ID for the new session
      const { v4: uuidv4 } = await import('uuid');
      const newSessionId = uuidv4();
      
      // Prepare the new session data based on the current session
      const newSessionData = this._prepareNewSessionData(currentSession, {
        newSessionId,
        keepSettings,
        preserveState
      });
      
      // Create the new session in Redis
      const newSession = await this._createSessionWithId(newSessionId, newSessionData);
      
      // Mark the original session as rolled and complete
      await this._completeRolledSession(sessionId, newSessionId, reason);
      
      // Start the new session process via API call
      try {
        await this._startNewSessionProcess(newSession);
        this.logger.info(`[RollingSessionManager] Successfully started new session process for ${newSession.id}`);
      } catch (startError) {
        this.logger.error(`[RollingSessionManager] Failed to start new session process: ${startError.message}`);
        // We continue anyway since the session data is already created in Redis
      }
      
      this.logger.info(`[RollingSessionManager] Successfully created new session ${newSession.id} as a rollover from ${sessionId}`);
      
      return {
        success: true,
        newSessionId: newSession.id,
        newSession
      };
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error rolling session: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Clean timestamp fields from metrics object to ensure new session has fresh timestamps
   * @private
   * @param {Object} metrics - The metrics object to clean
   * @returns {Object} Cleaned metrics object without timestamp fields
   */
  _cleanMetricsTimestamps(metrics) {
    if (!metrics) return metrics;
    
    // Create a copy of metrics
    const cleanedMetrics = { ...metrics };
    
    // Remove any timestamp-related fields that shouldn't be carried over to new sessions
    const timestampFields = [
      'timestamp', 
      'endedAt', 
      'completedAt', 
      'startedAt',
      'startTime',
      'lastUpdateTime',
      'lastCalculationTime',
      'sessionStartTime',
      'sessionEndTime'
    ];
    
    timestampFields.forEach(field => {
      delete cleanedMetrics[field];
    });
    
    // Also clean nested timestamp fields if they exist
    if (cleanedMetrics.performance) {
      timestampFields.forEach(field => {
        delete cleanedMetrics.performance[field];
      });
    }
    
    if (cleanedMetrics.timing) {
      timestampFields.forEach(field => {
        delete cleanedMetrics.timing[field];
      });
    }
    
    return cleanedMetrics;
  }

  /**
   * Prepare data for a new session based on the current session
   * @private
   * @param {Object} currentSession - The current session data
   * @param {Object} options - Options for preparing new session data
   * @returns {Object} New session data
   * @throws {Error} If required fields are missing from the current session
   */
  _prepareNewSessionData(currentSession, options) {
    const { keepSettings, preserveState, newSessionId } = options;
    
    // Validate required fields on the current session
    const requiredFields = ['symbol', 'exchange', 'strategy'];
    const missingFields = requiredFields.filter(field => !currentSession[field]);
    
    if (missingFields.length > 0) {
      const errorMessage = `Cannot prepare new session data: Missing required fields in current session: ${missingFields.join(', ')}`;
      this.logger.error(`[RollingSessionManager] ${errorMessage}`);
      throw new Error(errorMessage);
    }
    
    // Extract critical configurations from various possible locations
    const pricingStrategyConfig = currentSession.pricingStrategyConfig || 
                                  currentSession.settings?.pricingStrategyConfig ||
                                  currentSession.settings?.originalArgs?.pricingStrategyConfig;
                                  
    const riskParams = currentSession.riskParams ||
                       currentSession.settings?.riskParams ||
                       currentSession.settings?.originalArgs?.riskParams;
    
    // Create a new session object based on the current one
    const newSessionData = {
      // Core fields that should always be copied
      id: newSessionId,  // Use the explicitly provided ID
      sessionId: newSessionId, // Also set sessionId for compatibility
      symbol: currentSession.symbol,
      tradingPair: currentSession.tradingPair || currentSession.symbol,
      exchange: currentSession.exchange,
      strategy: currentSession.strategy,
      tradingMode: currentSession.tradingMode || 'paper',
      
      // ROLLING SESSION FIX: Explicitly preserve sessionLength from current session
      sessionLength: currentSession.sessionLength,
      
      // Initial status - set to pending for queue pickup
      status: 'pending',
      startedAt: Date.now(),
      startTime: Date.now(), // Include both time fields to match schema requirements
      addedAt: Date.now(), // Required for migration service
      createdAt: new Date().toISOString(),
      lastUpdated: Date.now(),
      
      // Reference to the parent session
      rolledFromSessionId: currentSession.id,
      
      // Chain metadata
      chainLength: (currentSession.chainLength || 1) + 1,
      maxChainLength: this.maxChainLength,
      maxRollingChainLength: this.maxChainLength,
      
      // Budget handling - preserve current budget (with P&L)
      budget: currentSession.budget,
      initialBalance: currentSession.initialBalance || currentSession.budget,
      
      // CRITICAL: Preserve pricing strategy configuration
      pricingStrategyConfig: pricingStrategyConfig,
      pricingStrategyName: currentSession.pricingStrategyName,
      
      // CRITICAL: Preserve risk parameters
      riskParams: riskParams,
      
      // Preserve important flags
      forceTradingEnabled: currentSession.forceTradingEnabled || false,
      settleSessionFlag: currentSession.settleSessionFlag !== undefined ? currentSession.settleSessionFlag : true,
      settleSession: currentSession.settleSession !== undefined ? currentSession.settleSession : true,
      rollingFlag: true, // Mark as a rolling session
      
      // Optional settings preservation
      ...(keepSettings ? { 
        settings: { 
          ...currentSession.settings,
          // Ensure critical fields are in settings too
          sessionLength: currentSession.sessionLength,
          maxRollingChainLength: this.maxChainLength,
          pricingStrategyConfig: pricingStrategyConfig,
          riskParams: riskParams,
          originalArgs: currentSession.settings?.originalArgs
        },
        // Preserve thresholds if they exist
        maxLossThreshold: currentSession.maxLossThreshold,
        targetProfitThreshold: currentSession.targetProfitThreshold,
        // Preserve precision settings
        pricePrecision: currentSession.pricePrecision,
        sizePrecision: currentSession.sizePrecision,
        minOrderSize: currentSession.minOrderSize,
        mainLoopIntervalMs: currentSession.mainLoopIntervalMs
      } : {
        // Even if keepSettings is false, preserve essential settings
        settings: {
          sessionLength: currentSession.sessionLength,
          maxRollingChainLength: this.maxChainLength,
          pricingStrategyConfig: pricingStrategyConfig,
          riskParams: riskParams
        }
      }),
      
      // Optional state preservation
      ...(preserveState ? {
        metrics: currentSession.metrics ? this._cleanMetricsTimestamps({ ...currentSession.metrics }) : undefined,
        positions: currentSession.positions ? [ ...currentSession.positions ] : [],
        parameters: currentSession.parameters ? { ...currentSession.parameters } : undefined
      } : {})
    };
    
    // Validate critical configurations were preserved
    if (!newSessionData.pricingStrategyConfig) {
      this.logger.warn(`[RollingSessionManager] No pricing strategy config found for rolled session - using defaults`);
      newSessionData.pricingStrategyConfig = {
        buy: { mode: 'MARKET_EDGE', percentage: 0 },
        sell: { mode: 'TARGET_PROFIT', percentage: 0.01 },
        display: 'TOTAL'
      };
    }
    
    if (!newSessionData.riskParams) {
      this.logger.warn(`[RollingSessionManager] No risk params found for rolled session - using defaults`);
      newSessionData.riskParams = {
        maxPositionSize: 0.01,
        maxDrawdown: 0.05,
        maxLeverage: 1.0,
        maxExposurePercent: 0.5,
        perTradeRiskPercent: 0.02,
        stopLossPercentage: 0.02
      };
    }
    
    // Log preservation details
    this.logger.info(`[RollingSessionManager] Prepared rolled session data:`, {
      sessionId: newSessionData.id,
      sessionLength: `${currentSession.sessionLength} -> ${newSessionData.sessionLength}`,
      budget: `${currentSession.budget} -> ${newSessionData.budget}`,
      chainLength: newSessionData.chainLength,
      hasPricingConfig: !!newSessionData.pricingStrategyConfig,
      hasRiskParams: !!newSessionData.riskParams,
      preservedSettings: keepSettings,
      preservedState: preserveState
    });
    
    // Double-check all required fields are present
    const criticalFields = ['id', 'symbol', 'exchange', 'strategy', 'sessionLength', 'budget'];
    const missingInNew = criticalFields.filter(field => !newSessionData[field]);
    if (missingInNew.length > 0) {
      const errorMessage = `Cannot create new session: Missing required fields in new session data: ${missingInNew.join(', ')}`;
      this.logger.error(`[RollingSessionManager] ${errorMessage}`);
      throw new Error(errorMessage);
    }
    
    this.logger.debug(`[RollingSessionManager] Prepared new session data with all required fields validated`);
    
    return newSessionData;
  }
  
  /**
   * Complete a rolled session with a reference to the new session
   * @private
   * @param {String} sessionId - ID of the session being rolled
   * @param {String} newSessionId - ID of the new session created from rolling
   * @param {String} reason - Reason for rolling the session
   * @returns {Promise<Object>} The updated session
   */
  async _completeRolledSession(sessionId, newSessionId, reason) {
    this.logger.debug(`[RollingSessionManager] Marking session ${sessionId} as rolled to ${newSessionId}`);
    
    // Generate timestamp for completion
    const timestamp = Date.now();
    
    try {
      // First get the current session
      const currentSession = await this.sessionManager.get(sessionId);
      if (!currentSession) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      // Create a complete updated session object with all properties
      const updatedSessionData = {
        ...currentSession,
        status: 'complete',
        rolledToSessionId: newSessionId,
        rollReason: reason,
        wasRolled: true,
        completedAt: timestamp,
        completionTimestamp: timestamp,
        rollingCompletedAt: timestamp,
        completedByContainerId: this.containerId,
        lastUpdated: timestamp
      };
      
      // Use a direct update via the session manager to ensure all properties are set
      // This handles both updating Redis and refreshing the cache
      await this.sessionManager.update(updatedSessionData);
      
      // Get the updated session to verify changes
      const updatedSession = await this.sessionManager.get(sessionId);
      
      // Log the result of the rolling operation with detailed metadata
      this.logger.debug(`[RollingSessionManager] Session ${sessionId} marked as complete and rolled to ${newSessionId}`);
      this.logger.debug(`[RollingSessionManager] Rolled Session Data:`);
      this.logger.debug(`- Status: ${updatedSession.status}`);
      this.logger.debug(`- Was Rolled: ${updatedSession.wasRolled ? 'Yes' : 'No'}`);
      this.logger.debug(`- Rolled To: ${updatedSession.rolledToSessionId || 'Not set'}`);
      
      // Safely format timestamp for logging
      try {
        this.logger.debug(`- Completed At: ${new Date(updatedSession.completedAt).toISOString()}`);
      } catch (dateError) {
        this.logger.debug(`- Completed At: ${updatedSession.completedAt} (timestamp value)`);
      }
      
      this.logger.debug(`- Completed By Container: ${updatedSession.completedByContainerId}`);
      this.logger.debug(`- Roll Reason: ${updatedSession.rollReason}`);
      
      return updatedSession;
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error completing rolled session ${sessionId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Check if a session should be rolled
   * This implementation always returns true if alwaysRoll is set to true
   * @param {String} sessionId - ID of the session to check
   * @returns {Promise<Boolean>} True if session should be rolled
   */
  async shouldRollSession(sessionId) {
    // If alwaysRoll is true, always roll the session
    if (this.alwaysRoll) {
      this.logger.debug(`[RollingSessionManager] Session ${sessionId} should be rolled (alwaysRoll=true)`);
      return true;
    }
    
    // Future implementation can check additional conditions here
    return false;
  }
  
  /**
   * Find sessions that could be rolled, based on various criteria
   * @param {Object} [options] - Filter options
   * @param {String} [options.strategy] - Filter by strategy
   * @param {String} [options.exchange] - Filter by exchange
   * @param {String} [options.symbol] - Filter by symbol
   * @param {Number} [options.olderThan] - Filter by age in milliseconds
   * @returns {Promise<Array>} List of session IDs that can be rolled
   */
  async findRollableSessions(options = {}) {
    const { strategy, exchange, symbol, olderThan } = options;
    
    // Construct the pattern for session keys
    let pattern = '*:session';
    
    if (strategy) {
      pattern = `${strategy}:*:session`;
    }
    
    if (strategy && exchange) {
      pattern = `${strategy}:${exchange}:*:session`;
    }
    
    if (strategy && exchange && symbol) {
      // Clean symbol for Redis key pattern
      const cleanSymbol = symbol.toLowerCase().replace('/', '-');
      pattern = `${strategy}:${exchange}:${cleanSymbol}:*:session`;
    }
    
    // Get all session keys matching the pattern
    const sessionKeys = await this.redis.keys(pattern);
    
    // Filter sessions that are active
    const rollableSessions = [];
    
    for (const key of sessionKeys) {
      try {
        // Extract session ID from key
        const keyParts = key.split(':');
        const sessionId = keyParts[keyParts.length - 2];
        
        // Get session status efficiently using getStatus
        const status = await this.sessionManager.getStatus(sessionId);
        
        // Only consider active sessions as rollable
        if (status === 'active') {
          // For sessions that are active, check additional criteria
          if (olderThan) {
            // Get the full session to check age
            const session = await this.sessionManager.get(sessionId);
            
            if (session && session.startedAt) {
              const age = Date.now() - session.startedAt;
              
              if (age >= olderThan) {
                rollableSessions.push(sessionId);
              }
            }
          } else {
            // If no age filter, include all active sessions
            rollableSessions.push(sessionId);
          }
        }
      } catch (error) {
        this.logger.error(`[RollingSessionManager] Error checking session key ${key}: ${error.message}`);
      }
    }
    
    this.logger.debug(`[RollingSessionManager] Found ${rollableSessions.length} rollable sessions (active status)`);
    
    return rollableSessions;
  }
  
  /**
   * Attempt to roll all eligible sessions based on defined criteria
   * @param {Object} [options] - Options for rolling sessions
   * @param {String} [options.strategy] - Filter by strategy
   * @param {String} [options.exchange] - Filter by exchange
   * @param {String} [options.symbol] - Filter by symbol
   * @param {Number} [options.olderThan] - Filter by age in milliseconds
   * @param {String} [options.reason='Automated container rolling'] - Reason for rolling
   * @param {Boolean} [options.keepSettings=true] - Keep settings from original sessions
   * @param {Boolean} [options.preserveState=true] - Preserve state from original sessions
   * @returns {Promise<Object>} Results of rolling attempt
   */
  async rollEligibleSessions(options = {}) {
    const {
      strategy,
      exchange,
      symbol,
      olderThan,
      reason = 'Automated container rolling',
      keepSettings = true,
      preserveState = true
    } = options;
    
    // Find eligible sessions
    const rollableSessions = await this.findRollableSessions({
      strategy,
      exchange,
      symbol,
      olderThan
    });
    
    this.logger.info(`[RollingSessionManager] Attempting to roll ${rollableSessions.length} eligible sessions`);
    
    // Track results
    const results = {
      attemptedCount: rollableSessions.length,
      successCount: 0,
      failedCount: 0,
      sessionResults: []
    };
    
    // Roll each eligible session
    for (const sessionId of rollableSessions) {
      try {
        // Check if this specific session should be rolled
        const shouldRoll = await this.shouldRollSession(sessionId);
        
        if (shouldRoll) {
          // Roll the session
          const newSession = await this.rollSession(sessionId, {
            reason,
            keepSettings,
            preserveState
          });
          
          results.successCount++;
          results.sessionResults.push({
            originalSessionId: sessionId,
            newSessionId: newSession.id,
            success: true
          });
        } else {
          this.logger.debug(`[RollingSessionManager] Session ${sessionId} not eligible for rolling based on specific criteria`);
          
          results.sessionResults.push({
            originalSessionId: sessionId,
            success: false,
            reason: 'Session-specific criteria not met'
          });
        }
      } catch (error) {
        this.logger.error(`[RollingSessionManager] Failed to roll session ${sessionId}: ${error.message}`);
        
        results.failedCount++;
        results.sessionResults.push({
          originalSessionId: sessionId,
          success: false,
          reason: error.message
        });
      }
    }
    
    this.logger.info(`[RollingSessionManager] Rolling sessions completed. ` +
      `Success: ${results.successCount}, Failed: ${results.failedCount}`);
    
    return results;
  }
  
  /**
   * Check if there are any active sessions for a specific trading pair
   * This is a more direct method than relying on locks
   * 
   * @param {Object} options - Session options
   * @param {String} options.strategy - The strategy name
   * @param {String} options.exchange - The exchange name
   * @param {String} options.symbol - The trading pair symbol
   * @returns {Promise<Object|null>} Active session object if found, null otherwise
   */
  async checkForActiveSessionsByTradingPair(options) {
    try {
      const { strategy, exchange, symbol } = options;
      
      // Format symbol properly for Redis key pattern
      const cleanSymbol = symbol.toLowerCase().replace('/', '-');
      
      // Create pattern to find all sessions for this trading pair
      const sessionKeyPattern = `${strategy}:${exchange}:${cleanSymbol}:*:session`;
      
      this.logger.debug(`[RollingSessionManager] Checking for active sessions with pattern: ${sessionKeyPattern}`);
      
      // Get all session keys matching the pattern
      const sessionKeys = await this.redis.keys(sessionKeyPattern);
      
      this.logger.debug(`[RollingSessionManager] Found ${sessionKeys.length} total sessions for ${symbol}`);
      
      // Check if any of these sessions are active
      for (const key of sessionKeys) {
        try {
          this.logger.debug(`[RollingSessionManager] Checking session key: ${key}`);
          
          // Get the session data from Redis
          const sessionData = await this.redis.get(key);
          
          if (!sessionData) {
            this.logger.debug(`[RollingSessionManager] No data found for key: ${key}`);
            continue;
          }
          
          // Parse the session data if it's a string
          let session;
          try {
            session = typeof sessionData === 'string' 
              ? JSON.parse(sessionData) 
              : sessionData;
          } catch (parseErr) {
            this.logger.error(`[RollingSessionManager] Error parsing session data: ${parseErr.message}`);
            continue;
          }
          
          if (!session || !session.id) {
            this.logger.debug(`[RollingSessionManager] Invalid session data for key: ${key}`);
            continue;
          }
          
          // Check if this session is active
          if (session.status === 'active') {
            this.logger.info(`[RollingSessionManager] Found active session ${session.id} for ${symbol}`);
            this.logger.info(`[RollingSessionManager] Session details: Status=${session.status}, StartedAt=${session.startedAt}`);
            
            // Return the active session
            return session;
          }
        } catch (err) {
          this.logger.error(`[RollingSessionManager] Error checking session: ${err.message}`);
        }
      }
      
      this.logger.info(`[RollingSessionManager] No active sessions found for ${symbol}`);
      return null;
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error checking for active sessions: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Start a new session process using internal session creation
   * @private
   * @param {Object} newSession - The new session data
   * @returns {Promise<Object>} Session creation result
   * @throws {Error} If session creation fails
   */
  async _startNewSessionProcess(newSession) {
    this.logger.debug(`[RollingSessionManager] Starting new session process for ${newSession.id}`);
    
    try {
      // Import internal session creator
      const { createSessionInternal } = await import('./internal-session-creator.js');
      
      // The newSession data should already be properly prepared by _prepareNewSessionData
      // Just need to ensure it has all required fields
      
      // Validate critical fields
      if (!newSession.sessionLength || newSession.sessionLength <= 0) {
        const errorMessage = `CRITICAL: Invalid sessionLength (${newSession.sessionLength}) for rolling session ${newSession.id}. Must be a positive number.`;
        this.logger.error(`[RollingSessionManager] ${errorMessage}`);
        throw new Error(errorMessage);
      }
      
      // Log the session data we're about to create
      this.logger.info(`[RollingSessionManager] Creating rolled session internally:`, {
        sessionId: newSession.id,
        tradingPair: newSession.symbol,
        strategy: newSession.strategy,
        sessionLength: newSession.sessionLength,
        budget: newSession.budget,
        chainLength: newSession.chainLength,
        rolledFromSessionId: newSession.rolledFromSessionId,
        hasPricingConfig: !!newSession.pricingStrategyConfig,
        hasRiskParams: !!newSession.riskParams
      });
      
      // Create the session internally (it will be added to queue automatically)
      const result = await createSessionInternal({
        redis: this.redis,
        sessionData: newSession,
        addToQueue: true, // Add to session:queue for worker pickup
        logger: this.logger
      });
      
      if (!result.success) {
        throw new Error(`Failed to create rolled session: ${result.error || 'Unknown error'}`);
      }
      
      this.logger.info(`[RollingSessionManager] Successfully created rolled session internally: ${newSession.id}`);
      this.logger.info(`[RollingSessionManager] Session added to queue for worker pickup`);
      
      return {
        success: true,
        sessionId: result.sessionId,
        queued: result.queued,
        message: 'Rolled session created and queued for processing'
      };
      
    } catch (error) {
      this.logger.error(`[RollingSessionManager] Error starting new session process: ${error.message}`);
      throw error;
    }
  }
}

export default RollingSessionManager;
