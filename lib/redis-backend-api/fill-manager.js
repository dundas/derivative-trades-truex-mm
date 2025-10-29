/**
 * FillManager
 * 
 * Handles fill data operations for Redis Data API.
 * Includes deduplication logic to prevent duplicate fills.
 */

/**
 * FillManager class for handling fill data operations
 */
export class FillManager {
  /**
   * Create a new FillManager
   * 
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Trading session ID
   * @param {Object} config.logger - Logger instance
   * @param {Object} config.keyGenerator - Key generator instance
   * @param {Object} config.validationUtils - Validation utilities
   * @param {boolean} [config.enableCaching=true] - Enable/disable caching
   */
  constructor(config) {
    this.redis = config.redis;
    this.sessionId = config.sessionId;
    this.logger = config.logger;
    this.keyGenerator = config.keyGenerator;
    this.validationUtils = config.validationUtils;
    this.enableCaching = config.enableCaching !== false; // Default to true
    
    // Initialize cache
    this._fillsCache = null;
    this._fillsCacheExpiry = 0;
    this._cacheTTL = 1000; // 1 second default TTL (shorter for frequently changing data)
    
    // Properties used for semantic deduplication
    this.fillSignificantProps = [
      'id', 'orderId', 'side', 'price', 'size', 'symbol', 
      'fillPrice', 'fillTimestamp', 'exchangeId'
    ];
  }
  
  /**
   * Get all fills for the session
   * @returns {Promise<Array>} - Array of fills
   */
  async getAll() {
    if (this.enableCaching && this._fillsCache && this._fillsCacheExpiry > Date.now()) {
      this.logger.debug(`[FillManager] Using cached fills for session ${this.sessionId}`);
      return this._fillsCache;
    }

    try {
      const fillsKey = this.keyGenerator.generateFillsKey();
      this.logger.debug(`[FillManager] Fetching fills using LRANGE for key: ${fillsKey}`);

      let fillStrings;
      if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        this.logger.debug('[FillManager] Using this.redis.client._command for LRANGE');
        fillStrings = await this.redis.client._command('LRANGE', fillsKey, 0, -1);
      } else if (this.redis && typeof this.redis.lrange === 'function') {
        this.logger.debug('[FillManager] Using this.redis.lrange for LRANGE');
        fillStrings = await this.redis.lrange(fillsKey, 0, -1);
      } else {
        this.logger.error('[FillManager] No suitable method found for LRANGE on redis client.');
        throw new Error('Redis client does not support lrange or a compatible _command method');
      }
      
      let fills = [];
      if (Array.isArray(fillStrings)) {
        for (const fillString of fillStrings) {
          if (typeof fillString === 'string') {
            try {
              const fill = JSON.parse(fillString);
              fills.push({
                ...fill,
                sessionId: this.sessionId // Ensure sessionId is present
              });
            } catch (error) {
              this.logger.error(`[FillManager] Error parsing fill JSON string: ${error.message}`, { fillString });
            }
          } else {
             this.logger.warn('[FillManager] Unexpected non-string value found in fills list', { value: fillString });
          }
        }
      } else {
        this.logger.debug(`[FillManager] No fills found or unexpected data type from LRANGE for key ${fillsKey}`);
      }
      
      if (this.enableCaching) {
        this._fillsCache = fills;
        this._fillsCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return fills;
    } catch (error) {
      this.logger.error(`[FillManager] Error getting fills: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get a specific fill by ID
   * @param {string} fillId - Fill ID to get
   * @returns {Promise<Object|null>} - Fill data or null if not found
   */
  async getById(fillId) {
    try {
      // Get all fills first
      const fills = await this.getAll();
      
      // Find the fill with the specified ID
      return fills.find(fill => fill.id === fillId) || null;
    } catch (error) {
      this.logger.error(`[FillManager] Error getting fill by ID: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get fills for a specific order
   * @param {string} orderId - Order ID to get fills for
   * @returns {Promise<Array>} - Array of fills for the order
   */
  async getByOrderId(orderId) {
    try {
      // Get all fills first
      const fills = await this.getAll();
      
      // Find fills with the specified order ID
      return fills.filter(fill => {
        // Check both orderId field and id field for compatibility
        return fill.orderId === orderId || fill.id === orderId;
      });
    } catch (error) {
      this.logger.error(`[FillManager] Error getting fills by order ID: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Add a new fill to the collection
   * @param {Object} fill - Fill data to add
   * @returns {Promise<Object>} - Added fill data
   */
  async add(fill) {
    try {
      // Validate fill data
      const validatedFill = this.validationUtils.validateFillData({
        ...fill,
        sessionId: this.sessionId // Ensure sessionId is present
      });

      // Check if fill already exists to prevent duplicates
      const existingFills = await this.getAll();
      const existingFill = existingFills.find(f => f.id === validatedFill.id);
      
      if (existingFill) {
        // If fill exists, check if we should update it (newer timestamp)
        const existingTimestamp = existingFill.lastUpdated || existingFill.timestamp || 0;
        const newTimestamp = validatedFill.lastUpdated || validatedFill.timestamp || 0;
        
        if (newTimestamp > existingTimestamp) {
          this.logger.debug(`[FillManager] Updating existing fill ${validatedFill.id} with newer data`);
          return await this.update(validatedFill);
        } else {
          this.logger.debug(`[FillManager] Fill ${validatedFill.id} already exists with same or newer timestamp, skipping duplicate`);
          return existingFill;
        }
      }

      const fillsKey = this.keyGenerator.generateFillsKey();
      
      let stringifiedFill;
      try {
        stringifiedFill = JSON.stringify(validatedFill);
      } catch (stringifyError) {
        this.logger.error(`[FillManager] Error stringifying fill: ${stringifyError.message}`, { fillId: validatedFill.id });
        throw stringifyError;
      }

      this.logger.debug(`[FillManager] Adding new fill ${validatedFill.id} using RPUSH to key: ${fillsKey}`);
      
      if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        this.logger.debug('[FillManager] Using this.redis.client._command for RPUSH');
        await this.redis.client._command('RPUSH', fillsKey, stringifiedFill);
      } else if (this.redis && typeof this.redis.rpush === 'function') {
        this.logger.debug('[FillManager] Using this.redis.rpush for RPUSH');
        await this.redis.rpush(fillsKey, stringifiedFill);
      } else {
        this.logger.error('[FillManager] No suitable method found for RPUSH on redis client.');
        throw new Error('Redis client does not support rpush or a compatible _command method');
      }
      
      this.logger.info(`[FillManager] Successfully added new fill ${validatedFill.id} to Redis list`);

      if (this.enableCaching) {
        this._fillsCache = null;
        this._fillsCacheExpiry = 0;
      }
      return validatedFill;
    } catch (error) {
      this.logger.error(`[FillManager] Error adding fill: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update an existing fill
   * @param {Object} fill - Fill data to update
   * @returns {Promise<Object|null>} - Updated fill data or null if not found
   */
  async update(fill) {
    try {
      // Validate fill data
      const validatedFill = this.validationUtils.validateFillData({
        ...fill,
        sessionId: this.sessionId
      });
      
      // Get all existing fills
      const existingFills = await this.getAll();
      
      // Check if the fill exists
      const existingFillIndex = existingFills.findIndex(
        existingFill => existingFill.id === validatedFill.id
      );
      
      if (existingFillIndex === -1) {
        this.logger.error(`[FillManager] Fill with ID ${validatedFill.id} not found for update`);
        return null;
      }
      
      // Get the fills collection key
      const fillsKey = this.keyGenerator.generateFillsKey();
      
      // Update the fill within the array
      const updatedFills = existingFills.map(fill => {
        if (fill.id === validatedFill.id) {
          return {
            ...fill,
            ...validatedFill,
            lastUpdated: Date.now() // Add update timestamp
          };
        }
        return fill;
      });
      
      // Store updated fills as array
      this.logger.debug(`[FillManager] Updating fill ${validatedFill.id} in key: ${fillsKey}`);
      await this.redis.set(fillsKey, JSON.stringify(updatedFills));
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._fillsCache = updatedFills;
        this._fillsCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return fillsMap[validatedFill.id];
    } catch (error) {
      this.logger.error(`[FillManager] Error updating fill: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update multiple fills at once
   * @param {Array} fills - Array of fills to update
   * @returns {Promise<Array>} - Array of updated fills
   */
  async bulkUpdate(fills) {
    try {
      if (!Array.isArray(fills) || fills.length === 0) {
        this.logger.error('[FillManager] Invalid or empty fills array for bulk update');
        return [];
      }
      
      // Get all existing fills
      const existingFills = await this.getAll();
      
      // Create a map for easier lookup, but we'll keep an array for storage
      const existingFillsMap = {};
      existingFills.forEach(fill => {
        existingFillsMap[fill.id] = fill;
      });
      
      // We'll track both updated fills and the complete updated array
      const updatedFillsList = [];
      let updatedFillsArray = [...existingFills];
      
      for (const fill of fills) {
        // Validate the fill data
        try {
          const validatedFill = this.validationUtils.validateFillData({
            ...fill,
            sessionId: this.sessionId
          });
          
          // Check if the fill exists
          if (existingFillsMap[validatedFill.id]) {
            // Create the updated fill
            const updatedFill = {
              ...existingFillsMap[validatedFill.id],
              ...validatedFill,
              lastUpdated: Date.now()
            };
            
            // Add to our updated list
            updatedFillsList.push(updatedFill);
            
            // Update in the array
            updatedFillsArray = updatedFillsArray.map(fill => 
              fill.id === validatedFill.id ? updatedFill : fill
            );
          } else {
            this.logger.warn(`[FillManager] Fill with ID ${validatedFill.id} not found for bulk update`);
          }
        } catch (error) {
          this.logger.error(`[FillManager] Error validating fill for bulk update: ${error.message}`);
          // Continue with other fills even if one fails
        }
      }
      
      if (updatedFillsList.length === 0) {
        this.logger.warn('[FillManager] No valid fills found for bulk update');
        return [];
      }
      
      // Get the fills collection key
      const fillsKey = this.keyGenerator.generateFillsKey();
      
      // Store updated fills as array
      this.logger.debug(`[FillManager] Bulk updating ${updatedFillsList.length} fills in key: ${fillsKey}`);
      await this.redis.set(fillsKey, JSON.stringify(updatedFillsArray));
      
      // Update cache if enabled
      if (this.enableCaching) {
        this._fillsCache = updatedFillsArray;
        this._fillsCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      return updatedFillsList;
    } catch (error) {
      this.logger.error(`[FillManager] Error in bulk update: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Validate fill data structure
   * @param {Object} fill - Fill data to validate
   * @returns {Object} - Validated fill data
   * @throws {Error} If validation fails
   */
  validate(fill) {
    return this.validationUtils.validateFillData(fill);
  }
  
  /**
   * Clear the fills cache
   */
  clearCache() {
    this._fillsCache = null;
    this._fillsCacheExpiry = 0;
  }
} 