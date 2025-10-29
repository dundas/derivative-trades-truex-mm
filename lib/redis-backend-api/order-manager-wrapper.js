/**
 * OrderManager Wrapper
 * 
 * Wraps the standard OrderManager to use the extended version if exchange mapping is needed.
 * This allows backward compatibility while adding new functionality.
 */

import { OrderManager } from './order-manager.js';
import { OrderManagerExtended } from './order-manager-extended.js';

/**
 * Factory function to create the appropriate OrderManager
 * @param {Object} config - Configuration for OrderManager
 * @param {boolean} config.useExtended - Whether to use extended version with exchange mapping
 * @returns {OrderManager|OrderManagerExtended} The appropriate OrderManager instance
 */
export function createOrderManager(config) {
  const useExtended = config.useExtended !== false; // Default to true
  
  if (useExtended) {
    return new OrderManagerExtended(config);
  } else {
    return new OrderManager(config);
  }
}

// Export both classes for direct use if needed
export { OrderManager, OrderManagerExtended };