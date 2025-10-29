/**
 * Enhanced Redis Backend API
 * 
 * This file extends the core Redis Backend API with enhanced operations
 * based on the data structures observed in the trading system.
 */

import { RedisDataAPI } from './redis-data-api.js';
import { 
  EnhancedOrderOperations, 
  EnhancedFillOperations, 
  EnhancedSessionOperations 
} from './enhanced-operations.js';

/**
 * EnhancedRedisAPI extends the core RedisDataAPI with additional
 * specialized operations for working with trading data
 * 
 * Key features:
 * - Session data access and management
 * - Order and fill operations
 * - Open position identification (via enhancedOrders.getOpenPositions)
 * - Settlement support functions
 */
export class EnhancedRedisAPI extends RedisDataAPI {
  /**
   * Creates a new EnhancedRedisAPI instance
   * 
   * @param {Object} config - Configuration options (same as RedisDataAPI)
   */
  constructor(config) {
    // Initialize the base RedisDataAPI
    super(config);
    
    // Don't create enhanced operations yet - defer until after initialize() is called
    this.enhancedOrders = null;
    this.enhancedFills = null;
    this.enhancedSession = null;
  }
  
  /**
   * Initialize the API and create enhanced operations
   * This overrides the base initialize method to also set up enhanced operations
   * after the base initialization is complete
   * 
   * After initialization, the following enhanced operations are available:
   * - enhancedOrders: Extended order operations including getOpenPositions()
   * - enhancedFills: Extended fill operations
   * - enhancedSession: Extended session operations
   */
  async initialize() {
    // First, initialize the base RedisDataAPI
    await super.initialize();
    
    // Now that the base API is fully initialized, create the enhanced operations,
    // but only if not in discovery mode, as the underlying managers wouldn't be set up.
    if (!this.config.discoveryMode) {
      this.enhancedOrders = new EnhancedOrderOperations(this.orders);
      this.enhancedFills = new EnhancedFillOperations(this.fills);
      this.enhancedSession = new EnhancedSessionOperations(this.session);
    }
  
    return this;
  }
  
  /**
   * Generate a comprehensive summary of the session
   * @returns {Promise<Object>} - Session summary
   */
  async getSessionSummary() {
    return this.enhancedSession.getSessionSummary(this.orders, this.fills);
  }
  
  /**
   * Clean up resources and connections
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Clean up any resources when API is no longer needed
    await super.disconnect();
  }
}
