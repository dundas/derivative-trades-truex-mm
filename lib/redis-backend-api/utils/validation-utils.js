/**
 * ValidationUtils
 * 
 * Utility for validating data structures before persistence.
 * This ensures consistent validation across all Redis operations.
 */

/**
 * ValidationUtils class for data validation
 */
export class ValidationUtils {
  /**
   * Validate session data structure
   * @param {Object} data - Session data to validate
   * @returns {Object} Validated and sanitized session data
   * @throws {Error} If validation fails
   */
  validateSessionData(data) {
    if (!data) {
      throw new Error('Session data cannot be null or undefined');
    }
    
    if (typeof data !== 'object') {
      throw new Error('Session data must be an object');
    }
    
    // Check required fields
    const requiredFields = ['id', 'exchange', 'strategy', 'status', 'symbol'];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
      throw new Error(`Session validation failed: Missing required fields: ${missingFields.join(', ')}`);
    }
    
    // Add lastUpdated if missing (this is the only field we'll default)
    const sanitized = {
      ...data,
      lastUpdated: data.lastUpdated || Date.now()
    };
    
    // Validate status
    const validStatuses = ['pending', 'active', 'paused', 'complete', 'error', 'cancelled', 'stopped'];
    if (!validStatuses.includes(sanitized.status)) {
      throw new Error(`Invalid session status: ${sanitized.status}. Valid values: ${validStatuses.join(', ')}`);
    }
    
    // Ensure time fields are numbers
    if (sanitized.startedAt && typeof sanitized.startedAt !== 'number') {
      throw new Error('Session startedAt must be a number (timestamp)');
    }
    
    if (sanitized.startTime && typeof sanitized.startTime !== 'number') {
      throw new Error('Session startTime must be a number (timestamp)');
    }
    
    return sanitized;
  }
  
  /**
   * Validate order data structure
   * @param {Object} data - Order data to validate
   * @returns {Object} Validated and sanitized order data
   * @throws {Error} If validation fails
   */
  validateOrderData(data) {
    if (!data) {
      throw new Error('Order data cannot be null or undefined');
    }
    
    if (typeof data !== 'object') {
      throw new Error('Order data must be an object');
    }
    
    // Required fields
    if (!data.id) {
      throw new Error('Order ID is required');
    }
    
    if (!data.side) {
      throw new Error('Order side is required');
    }
    
    // Validate side
    const validSides = ['buy', 'sell'];
    if (!validSides.includes(data.side.toLowerCase())) {
      throw new Error(`Invalid order side: ${data.side}. Valid values: ${validSides.join(', ')}`);
    }
    
    // Validate price
    if (data.price !== undefined && isNaN(parseFloat(data.price))) {
      throw new Error(`Invalid order price: ${data.price}`);
    }
    
    // Validate size/amount
    if (data.size !== undefined && isNaN(parseFloat(data.size))) {
      throw new Error(`Invalid order size: ${data.size}`);
    }
    
    // Validate that status is provided
    if (!data.status) {
      throw new Error('Order status is required - orders must explicitly set their status');
    }

    // Create a sanitized copy with required fields
    const sanitized = {
      ...data,
      // Normalize the side to lowercase
      side: data.side.toLowerCase(),
      // Ensure these fields exist
      status: data.status,
      timestamp: data.timestamp || Date.now(),
      sessionId: data.sessionId || ''
    };
    
    return sanitized;
  }
  
  /**
   * Validate fill data structure
   * @param {Object} data - Fill data to validate
   * @returns {Object} Validated and sanitized fill data
   * @throws {Error} If validation fails
   */
  validateFillData(data) {
    if (!data) {
      throw new Error('Fill data cannot be null or undefined');
    }
    
    if (typeof data !== 'object') {
      throw new Error('Fill data must be an object');
    }
    
    // Required fields
    if (!data.id) {
      throw new Error('Fill ID is required');
    }
    
    if (!data.orderId) {
      throw new Error('Order ID is required for fill');
    }
    
    if (!data.side) {
      throw new Error('Fill side is required');
    }
    
    // Validate side
    const validSides = ['buy', 'sell'];
    if (!validSides.includes(data.side.toLowerCase())) {
      throw new Error(`Invalid fill side: ${data.side}. Valid values: ${validSides.join(', ')}`);
    }
    
    // Validate price
    if (data.price !== undefined && isNaN(parseFloat(data.price))) {
      throw new Error(`Invalid fill price: ${data.price}`);
    }
    
    // Validate size/amount - look for either size or quantity fields
    const size = data.size !== undefined ? data.size : data.quantity;
    if (size !== undefined && isNaN(parseFloat(size))) {
      throw new Error(`Invalid fill size: ${size}`);
    }
    
    // Create a sanitized copy with required fields
    const sanitized = {
      ...data,
      // Normalize the side to lowercase
      side: data.side.toLowerCase(),
      // Ensure these fields exist
      timestamp: data.timestamp || data.fillTimestamp || Date.now(),
      sessionId: data.sessionId || '',
      // Standardize on size rather than quantity
      size: size !== undefined ? parseFloat(size) : 0
    };
    
    return sanitized;
  }
  
  /**
   * Check if two objects are semantically identical (same significant properties)
   * Used for deduplication
   * 
   * @param {Object} obj1 - First object
   * @param {Object} obj2 - Second object
   * @param {Array<string>} significantProps - Array of property names to compare
   * @returns {boolean} True if objects are semantically identical
   */
  areObjectsSemanticallyIdentical(obj1, obj2, significantProps = []) {
    if (!obj1 || !obj2) return false;
    
    // If no significant properties specified, use all properties from first object
    const propsToCompare = significantProps.length > 0 ? 
      significantProps : Object.keys(obj1);
    
    for (const prop of propsToCompare) {
      // Skip if property doesn't exist in both objects
      if (obj1[prop] === undefined && obj2[prop] === undefined) continue;
      
      // If property exists in one but not the other, they're not identical
      if (obj1[prop] === undefined || obj2[prop] === undefined) return false;
      
      // For numbers, compare as numbers (handle string conversions)
      if (typeof obj1[prop] === 'number' || typeof obj2[prop] === 'number') {
        if (parseFloat(obj1[prop]) !== parseFloat(obj2[prop])) return false;
        continue;
      }
      
      // For other types, standard comparison
      if (obj1[prop] !== obj2[prop]) return false;
    }
    
    return true;
  }
} 