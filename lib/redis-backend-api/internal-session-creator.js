/**
 * Internal Session Creator
 * 
 * Provides internal session creation functionality that can be used
 * directly within the system without external API calls. This is
 * particularly useful for rolling sessions and other internal
 * session management operations.
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { SessionManager, KeyGenerator, ValidationUtils } from './index.js';
import { QueueManager, createQueueManager } from './queue-manager.js';

const defaultLogger = logger;

/**
 * Creates a new session internally without API calls
 * @param {Object} options - Creation options
 * @param {Object} options.redis - Redis client instance
 * @param {Object} options.sessionData - Session data to create
 * @param {boolean} [options.addToQueue=true] - Whether to add to the session queue
 * @param {string} [options.queueType='SPOT'] - Queue type (SPOT, FUTURES, OPTIONS, etc.)
 * @param {boolean} [options.priority=false] - Add to priority queue
 * @param {Object} [options.queueManager] - Optional queue manager instance
 * @param {Object} [options.logger] - Optional logger instance
 * @returns {Promise<Object>} Created session information
 */
export async function createSessionInternal(options) {
  const {
    redis,
    sessionData,
    addToQueue = true,
    queueType = 'SPOT',
    priority = false,
    queueManager,
    logger: customLogger
  } = options;
  
  const log = customLogger || defaultLogger;
  
  try {
    // Ensure session has an ID
    const sessionId = sessionData.id || sessionData.sessionId || uuidv4();
    sessionData.id = sessionId;
    sessionData.sessionId = sessionId;
    
    // Ensure timestamps
    const now = Date.now();
    sessionData.createdAt = sessionData.createdAt || new Date(now).toISOString();
    sessionData.addedAt = sessionData.addedAt || now;
    sessionData.lastUpdated = now;
    
    // Ensure status
    sessionData.status = sessionData.status || 'pending';
    
    // Ensure symbol field (required for many operations)
    if (!sessionData.symbol && sessionData.tradingPair) {
      sessionData.symbol = sessionData.tradingPair;
    }
    
    // Create key generator
    const keyGenerator = new KeyGenerator({
      strategy: sessionData.strategy || sessionData.strategyType || 'adaptive',
      exchange: sessionData.exchange || sessionData.exchangeType || 'kraken',
      symbol: (sessionData.tradingPair || sessionData.symbol).toLowerCase().replace('/', '-'),
      sessionId: sessionId
    });
    
    // Create session manager
    const sessionManager = new SessionManager({
      redis,
      sessionId,
      logger: log,
      keyGenerator,
      validationUtils: new ValidationUtils()
    });
    
    // Validate session data has required fields
    const requiredFields = ['tradingPair', 'budget', 'sessionLength'];
    const missingFields = requiredFields.filter(field => !sessionData[field]);
    
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }
    
    // Create the session
    const createdSession = await sessionManager.create(sessionData);
    log.info(`Session created internally: ${sessionId}`);
    
    // Add to session queue if requested
    if (addToQueue) {
      // Use provided queue manager or create a new one
      const qm = queueManager || createQueueManager(redis, log);
      
      // Determine queue type based on session data
      let effectiveQueueType = queueType;
      
      // Auto-detect futures sessions
      if (sessionData.exchange === 'kraken-futures' || 
          sessionData.symbol?.startsWith('PF_') ||
          sessionData.tradingPair?.startsWith('PF_')) {
        effectiveQueueType = 'FUTURES';
      }
      
      await qm.addToQueue(sessionId, {
        queueType: effectiveQueueType,
        priority,
        metadata: {
          exchange: sessionData.exchange,
          symbol: sessionData.symbol || sessionData.tradingPair,
          tradingMode: sessionData.tradingMode,
          strategy: sessionData.strategy
        }
      });
      
      log.info(`Session ${sessionId} added to ${effectiveQueueType} queue${priority ? ' (priority)' : ''}`);
    }
    
    return {
      success: true,
      sessionId,
      session: createdSession,
      sessionKey: keyGenerator.generateSessionKey(),
      queued: addToQueue,
      queueType: addToQueue ? effectiveQueueType : null
    };
    
  } catch (error) {
    log.error('Failed to create session internally:', error);
    throw error;
  }
}

/**
 * Creates a rolled session internally
 * This is a specialized version that handles the rolling process
 * @param {Object} options - Rolling options
 * @param {Object} options.redis - Redis client instance
 * @param {Object} options.currentSession - Current session to roll from
 * @param {boolean} [options.preserveBudget=true] - Whether to preserve current budget
 * @param {Object} [options.overrides={}] - Any overrides for the new session
 * @returns {Promise<Object>} Created rolled session information
 */
export async function createRolledSessionInternal(options) {
  const {
    redis,
    currentSession,
    preserveBudget = true,
    overrides = {}
  } = options;
  
  try {
    // Import the duplicator
    const { duplicateSession } = await import('./session-duplicator.js');
    
    // Create a duplicate of the current session
    const newSessionData = duplicateSession(currentSession, {
      preserveBudget,
      incrementChain: true,
      overrides
    });
    
    // Create the session internally
    const result = await createSessionInternal({
      redis,
      sessionData: newSessionData,
      addToQueue: true // Rolling sessions should go to queue
    });
    
    logger.info(`Rolled session created: ${currentSession.id} -> ${result.sessionId}`);
    
    return result;
    
  } catch (error) {
    logger.error('Failed to create rolled session:', error);
    throw error;
  }
}

/**
 * Batch creates multiple sessions internally
 * Useful for testing or creating multiple related sessions
 * @param {Object} options - Batch creation options
 * @param {Object} options.redis - Redis client instance
 * @param {Array<Object>} options.sessionsData - Array of session data objects
 * @param {boolean} [options.addToQueue=true] - Whether to add to queue
 * @returns {Promise<Array<Object>>} Array of created session results
 */
export async function batchCreateSessionsInternal(options) {
  const {
    redis,
    sessionsData,
    addToQueue = true
  } = options;
  
  const results = [];
  
  for (const sessionData of sessionsData) {
    try {
      const result = await createSessionInternal({
        redis,
        sessionData,
        addToQueue
      });
      results.push(result);
    } catch (error) {
      logger.error(`Failed to create session in batch:`, error);
      results.push({
        success: false,
        error: error.message,
        sessionData
      });
    }
  }
  
  logger.info(`Batch created ${results.filter(r => r.success).length}/${sessionsData.length} sessions`);
  
  return results;
}

export default {
  createSessionInternal,
  createRolledSessionInternal,
  batchCreateSessionsInternal
};