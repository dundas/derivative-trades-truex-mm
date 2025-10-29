/**
 * Redis Backend API
 * 
 * Main export file that provides access to the Redis Data API.
 * This makes it easier to import the API from other parts of the codebase.
 */

// Core API components
export { RedisDataAPI } from './redis-data-api.js';
export { SessionManager } from './session-manager.js';
export { RollingSessionManager } from './rolling-session-manager.js';
export { RecentSessionsManager } from './recent-sessions-manager.js';
export { OrderManager } from './order-manager.js';
export { OrderManagerExtended } from './order-manager-extended.js';
export { FillManager } from './fill-manager.js';
export { PositionManager } from './position-manager.js';
export { BalanceManager } from './balance-manager.js';
export { BalanceLedgerManager } from './balance-ledger-manager.js';
export { UniversalBudgetLedger } from './universal-budget-ledger.js';

// Enhanced API components
export { EnhancedRedisAPI } from './enhanced-redis-api.js';
export { 
  EnhancedOrderOperations,
  EnhancedFillOperations,
  EnhancedSessionOperations 
} from './enhanced-operations.js';

// Utility classes
export { KeyGenerator } from './utils/key-generator.js';
export { ValidationUtils } from './utils/validation-utils.js';

// Trade Ledger Manager for settlement service optimization
export { TradeLedgerManager } from './trade-ledger-manager.js';

// Settlement reconciliation components  
export { SettlementKeyManager } from './settlement-key-manager.js';

// New export
export * from './redis-discovery.js';

// Session duplication and internal creation utilities
export { duplicateSession, createMinimalDuplicate, prepareSessionForRolling } from './session-duplicator.js';
export { createSessionInternal, createRolledSessionInternal, batchCreateSessionsInternal } from './internal-session-creator.js';

// Worker management
export { WorkerManager } from './worker-manager.js';

// Queue management
export { QueueManager, createQueueManager } from './queue-manager.js';

// Kraken API caching for rate limit elimination
export { KrakenCacheManager, createKrakenCacheManager } from './kraken-cache-manager.js';
