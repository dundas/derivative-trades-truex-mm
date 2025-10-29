/**
 * Session Duplicator
 * 
 * Utility for duplicating sessions with fresh identifiers and timestamps.
 * Used primarily for rolling sessions to create a clean copy of session
 * configuration without session-specific runtime data.
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

const loggerInstance = logger;

/**
 * Fields that should be removed when duplicating a session
 */
const FIELDS_TO_REMOVE = [
  // Identity fields
  'id',
  'sessionId',
  
  // Timestamp fields
  'startedAt',
  'startTime',
  'endedAt',
  'completedAt',
  'createdAt',
  'lastUpdated',
  'addedAt',
  'cancelledAt',
  'closingStartedAt',
  'monitoringStartedAt',
  'rollingStartedAt',
  'rollingCompletedAt',
  
  // Status fields
  'status',
  'endReason',
  'cancelReason',
  'error',
  
  // Runtime state
  'positions',
  'orders',
  'fills',
  'metrics',
  'performance',
  'pnl',
  'realizedPnl',
  'unrealizedPnl',
  'totalVolume',
  'buyVolume',
  'sellVolume',
  'orderCount',
  'fillCount',
  
  // Session-specific metadata
  'workerId',
  'containerId',
  'managingContainerId',
  'completedByContainerId',
  
  // Rolling-specific fields (for the old session)
  'rolledToSessionId',
  'wasRolled',
  'rollReason',
  'rollingInProgress',
  
  // Cleanup and close data
  'enhancedCloseResults',
  'closingPhase',
  'reconciliationResults',
  'cleanedUpAt',
  'wasStuck',
  'stuckReason'
];

/**
 * Fields that should be preserved but might need special handling
 */
const FIELDS_TO_PRESERVE = [
  // Core configuration
  'symbol',
  'tradingPair',
  'strategy',
  'strategyType',
  'exchange',
  'exchangeType',
  'tradingMode',
  'budget',
  'sessionLength',
  
  // Settings and configurations
  'settings',
  'pricingStrategyConfig',
  'pricingStrategyName',
  'riskParams',
  
  // Flags
  'forceTradingEnabled',
  'settleSessionFlag',
  'settleSession',
  'exportCsvFlag',
  'redisPersistenceFlag',
  
  // Rolling chain data
  'rolledFromSessionId',
  'chainLength',
  'maxRollingChainLength',
  
  // Precision and limits
  'pricePrecision',
  'sizePrecision',
  'minOrderSize',
  'mainLoopIntervalMs'
];

/**
 * Duplicates a session by creating a clean copy with fresh identifiers
 * @param {Object} originalSession - The session to duplicate
 * @param {Object} options - Duplication options
 * @param {string} [options.newSessionId] - Optional specific session ID to use
 * @param {boolean} [options.preserveBudget=true] - Whether to preserve the current budget (with P&L)
 * @param {boolean} [options.incrementChain=true] - Whether to increment the chain length
 * @param {Object} [options.overrides={}] - Any fields to override in the new session
 * @returns {Object} The duplicated session data
 */
export function duplicateSession(originalSession, options = {}) {
  const {
    newSessionId = uuidv4(),
    preserveBudget = true,
    incrementChain = true,
    overrides = {}
  } = options;
  
  loggerInstance.info(`Duplicating session ${originalSession.id || originalSession.sessionId} -> ${newSessionId}`);
  
  // Start with a deep clone of the original session
  const duplicatedSession = JSON.parse(JSON.stringify(originalSession));
  
  // Remove all session-specific fields
  FIELDS_TO_REMOVE.forEach(field => {
    delete duplicatedSession[field];
  });
  
  // Set new identity fields
  duplicatedSession.id = newSessionId;
  duplicatedSession.sessionId = newSessionId;
  
  // Set fresh timestamps
  const now = Date.now();
  duplicatedSession.startedAt = now;
  duplicatedSession.startTime = now;
  duplicatedSession.createdAt = new Date(now).toISOString();
  duplicatedSession.addedAt = now;
  duplicatedSession.lastUpdated = now;
  
  // Set initial status
  duplicatedSession.status = 'pending'; // Will be picked up by worker
  
  // Handle budget preservation
  if (!preserveBudget && originalSession.budget !== undefined) {
    // Reset to initial budget if we have it stored
    if (originalSession.initialBalance) {
      duplicatedSession.budget = originalSession.initialBalance;
    } else if (originalSession.settings?.budget) {
      duplicatedSession.budget = originalSession.settings.budget;
    }
    // Otherwise keep the current budget value
  }
  
  // Handle rolling chain metadata
  if (incrementChain) {
    duplicatedSession.chainLength = (originalSession.chainLength || 1) + 1;
  }
  
  // Preserve the parent session reference
  duplicatedSession.rolledFromSessionId = originalSession.id || originalSession.sessionId;
  
  // Ensure required fields are present
  if (!duplicatedSession.symbol && duplicatedSession.tradingPair) {
    duplicatedSession.symbol = duplicatedSession.tradingPair;
  }
  
  // Apply any overrides
  Object.assign(duplicatedSession, overrides);
  
  // Validate the duplicated session has required fields
  const requiredFields = ['id', 'sessionId', 'symbol', 'strategy', 'exchange', 'budget', 'sessionLength'];
  const missingFields = requiredFields.filter(field => !duplicatedSession[field]);
  
  if (missingFields.length > 0) {
    logger.error(`Duplicated session missing required fields: ${missingFields.join(', ')}`);
    logger.debug('Duplicated session data:', duplicatedSession);
    throw new Error(`Duplicated session missing required fields: ${missingFields.join(', ')}`);
  }
  
  // Log what was preserved vs removed
  logger.debug(`Session duplication complete:`, {
    originalId: originalSession.id || originalSession.sessionId,
    newId: newSessionId,
    preservedBudget: preserveBudget,
    chainLength: duplicatedSession.chainLength,
    rolledFrom: duplicatedSession.rolledFromSessionId,
    fieldsRemoved: FIELDS_TO_REMOVE.filter(f => originalSession[f] !== undefined).length,
    fieldsPreserved: Object.keys(duplicatedSession).length
  });
  
  return duplicatedSession;
}

/**
 * Creates a minimal session duplicate for API creation
 * This version creates only the essential fields needed for session creation
 * @param {Object} originalSession - The session to duplicate
 * @param {Object} options - Duplication options
 * @returns {Object} Minimal session data for API creation
 */
export function createMinimalDuplicate(originalSession, options = {}) {
  const {
    newSessionId = uuidv4(),
    preserveBudget = true
  } = options;
  
  // Extract only the essential configuration
  const minimalSession = {
    // Identity
    id: newSessionId,
    sessionId: newSessionId,
    
    // Core trading parameters
    tradingPair: originalSession.tradingPair || originalSession.symbol,
    strategy: originalSession.strategy || originalSession.strategyType || 'adaptive',
    exchange: originalSession.exchange || originalSession.exchangeType || 'kraken',
    tradingMode: originalSession.tradingMode || 'paper',
    
    // Financial
    budget: preserveBudget ? originalSession.budget : (originalSession.initialBalance || originalSession.budget),
    
    // Timing
    sessionLength: originalSession.sessionLength,
    
    // Configurations (deeply nested, need careful extraction)
    pricingStrategyConfig: originalSession.pricingStrategyConfig || 
                           originalSession.settings?.pricingStrategyConfig,
    riskParams: originalSession.riskParams || 
                originalSession.settings?.riskParams,
    
    // Flags
    forceTradingEnabled: originalSession.forceTradingEnabled || false,
    settleSessionFlag: originalSession.settleSessionFlag !== undefined ? 
                       originalSession.settleSessionFlag : true,
    
    // Rolling metadata
    rolledFromSessionId: originalSession.id || originalSession.sessionId,
    chainLength: (originalSession.chainLength || 1) + 1,
    maxRollingChainLength: originalSession.maxRollingChainLength || 
                           originalSession.settings?.maxRollingChainLength || 10
  };
  
  // Validate we have the critical fields
  if (!minimalSession.pricingStrategyConfig) {
    logger.warn('No pricing strategy config found in original session, using defaults');
    minimalSession.pricingStrategyConfig = {
      buy: { mode: 'MARKET_EDGE', percentage: 0 },
      sell: { mode: 'TARGET_PROFIT', percentage: 0.01 },
      display: 'TOTAL'
    };
  }
  
  if (!minimalSession.riskParams) {
    logger.warn('No risk params found in original session, using defaults');
    minimalSession.riskParams = {
      maxPositionSize: 0.01,
      maxDrawdown: 0.05,
      maxLeverage: 1.0,
      maxExposurePercent: 0.5,
      perTradeRiskPercent: 0.02,
      stopLossPercentage: 0.02
    };
  }
  
  return minimalSession;
}

/**
 * Prepares a session for rolling by cleaning it and marking it appropriately
 * @param {Object} session - The session to prepare for rolling
 * @param {string} nextSessionId - The ID of the next session in the chain
 * @returns {Object} The updated session data
 */
export function prepareSessionForRolling(session, nextSessionId) {
  const updatedSession = {
    ...session,
    status: 'complete',
    rolledToSessionId: nextSessionId,
    wasRolled: true,
    rollReason: 'session_timeout',
    completedAt: Date.now(),
    endedAt: Date.now(),
    lastUpdated: Date.now()
  };
  
  return updatedSession;
}

export default {
  duplicateSession,
  createMinimalDuplicate,
  prepareSessionForRolling,
  FIELDS_TO_REMOVE,
  FIELDS_TO_PRESERVE
};