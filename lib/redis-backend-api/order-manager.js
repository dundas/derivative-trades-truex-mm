/**
 * OrderManager
 * 
 * Handles order data operations for Redis Data API.
 * Includes deduplication logic to prevent duplicate orders.
 */

/**
 * OrderManager class for handling order data operations
 */
export class OrderManager {
  /**
   * Create a new OrderManager
   * 
   * @param {Object} config - Configuration options
   * @param {Object} config.redis - Redis client instance
   * @param {string} config.sessionId - Trading session ID
   * @param {Object} config.logger - Logger instance
   * @param {Object} config.keyGenerator - Key generator instance
   * @param {Object} config.validationUtils - Validation utilities
   * @param {Object} [config.sessionManager] - Session manager instance
   * @param {boolean} [config.enableCaching=true] - Enable/disable caching
   */
  constructor(config) {
    this.redis = config.redis;
    this.sessionId = config.sessionId;
    this.logger = config.logger;
    this.keyGenerator = config.keyGenerator;
    this.validationUtils = config.validationUtils;
    this.sessionManager = config.sessionManager;
    this.enableCaching = config.enableCaching !== false; // Default to true
    
    // Initialize cache
    this._ordersCache = null;
    this._ordersCacheExpiry = 0;
    this._cacheTTL = 1000; // 1 second default TTL (shorter for frequently changing data)
    
    // Properties used for semantic deduplication
    this.orderSignificantProps = [
      'id', 'side', 'price', 'size', 'symbol', 'orderType', 
      'status', 'parentOrderId', 'exchangeId'
    ];
  }
  
  /**
   * Get all orders for the session
   * @returns {Promise<Array>} - Array of orders
   */
  async getAll() {
    // Check cache first if enabled
    if (this.enableCaching && this._ordersCache && this._ordersCacheExpiry > Date.now()) {
      this.logger.debug(`[OrderManager] Using cached orders for session ${this.sessionId}`);
      // Return cached orders with the map property attached
      const cachedOrders = Array.isArray(this._ordersCache) ? this._ordersCache : Object.values(this._ordersCache || {});
      if (this._ordersMapCache) {
        cachedOrders._asMap = this._ordersMapCache;
      }
      return cachedOrders;
    }
    
    try {
      const ordersKey = this.keyGenerator.generateOrdersKey();
      this.logger.debug(`[OrderManager] Fetching orders for key: ${ordersKey}`);
      
      let rawResult;
      // this.redis is expected to be an instance of RedisClient from /lib/utils/redis-client.js
      if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        // Upstash Redis client direct command
        this.logger.debug('[OrderManager] Using this.redis.client._command for HGETALL');
        rawResult = await this.redis.client._command('HGETALL', ordersKey);
      } else if (this.redis && typeof this.redis.hGetAll === 'function') {
        // Corrected: Check for hGetAll on the RedisClient instance itself
        this.logger.debug('[OrderManager] Using this.redis.hGetAll for HGETALL');
        rawResult = await this.redis.hGetAll(ordersKey);
      } else if (this.redis && typeof this.redis.hgetall === 'function') {
        // Fallback for other clients that might have hgetall (lowercase)
        this.logger.debug('[OrderManager] Using this.redis.hgetall (lowercase) for HGETALL');
        rawResult = await this.redis.hgetall(ordersKey);
      } else {
        this.logger.error('[OrderManager] No suitable method found for HGETALL on redis client.', { 
          hasClientCommand: !!(this.redis && this.redis.client && typeof this.redis.client._command === 'function'),
          hasHgetAllCap: !!(this.redis && typeof this.redis.hGetAll === 'function'),
          hasHgetallLower: !!(this.redis && typeof this.redis.hgetall === 'function')
        });
        throw new Error('Redis client does not support a compatible HGETALL method (hGetAll, hgetall, or _command)');
      }
      
      // Log the raw result immediately after receiving it
      this.logger.info(`[OrderManager.getAll] Raw HGETALL result: ${JSON.stringify(rawResult)}`);

      // Process the raw result (could be array or object depending on client)
      let rawOrdersMap = {};
      if (Array.isArray(rawResult)) {
        // Handle flat array [field1, value1, field2, value2, ...]
        if (rawResult.length % 2 !== 0) {
            this.logger.warn(`[OrderManager] HGETALL for key ${ordersKey} returned array with odd number of elements.`, { rawResult });
        } else {
            for (let i = 0; i < rawResult.length; i += 2) {
                if (typeof rawResult[i] !== 'undefined' && typeof rawResult[i+1] !== 'undefined') {
                  rawOrdersMap[rawResult[i]] = rawResult[i + 1];
                } else {
                  this.logger.warn(`[OrderManager] HGETALL for key ${ordersKey} had undefined pair at index ${i}.`);
                }
            }
        }
      } else if (rawResult && typeof rawResult === 'object') {
        // Handle object { field1: value1, ... }
        rawOrdersMap = rawResult;
      } else {
         this.logger.debug(`[OrderManager] No orders found or unexpected data type from HGETALL for key ${ordersKey}. Type: ${typeof rawResult}`);
         rawOrdersMap = {}; // Ensure it's an empty object
      }

      // Now parse the values from the unified rawOrdersMap object
      let orders = [];
      let ordersMap = {}; // For backward compatibility and exchange ID lookup
      for (const orderId in rawOrdersMap) {
          const orderData = rawOrdersMap[orderId];
          let order;
          
          if (typeof orderData === 'string') {
              try {
                  order = JSON.parse(orderData);
              } catch (error) {
                  this.logger.error(`[OrderManager] Error parsing order JSON string from hash field ${orderId}: ${error.message}`, { orderData });
                  continue;
              }
          } else if (typeof orderData === 'object' && orderData !== null) {
              // Upstash Redis sometimes returns objects directly
              order = orderData;
          } else {
              this.logger.warn(`[OrderManager] Unexpected data type found in orders hash for field ${orderId}`, { value: orderData, type: typeof orderData });
              continue;
          }
          
          const processedOrder = {
              ...order,
              sessionId: this.sessionId // Ensure sessionId is present
          };
          
          orders.push(processedOrder);
          ordersMap[orderId] = processedOrder; // For backward compatibility
      }
      
      // Update cache if enabled (store both formats)
      if (this.enableCaching) {
        this._ordersCache = orders; // Store the array of order objects
        this._ordersMapCache = ordersMap; // Store the map for fast lookup
        this._ordersCacheExpiry = Date.now() + this._cacheTTL;
      }
      
      // Return array by default, but provide access to map via a property
      orders._asMap = ordersMap;
      return orders;
    } catch (error) {
      this.logger.error(`[OrderManager] Error getting orders: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get a specific order by ID
   * @param {string} orderId - Order ID to get
   * @returns {Promise<Object|null>} - Order data or null if not found
   */
  async getById(orderId) {
    try {
      if (this.enableCaching && this._ordersCache && this._ordersCacheExpiry > Date.now()) {
          const cachedOrder = Array.isArray(this._ordersCache) 
              ? this._ordersCache.find(o => o.id === orderId) 
              : (this._ordersCache[orderId] || null);
          if (cachedOrder) {
              this.logger.debug(`[OrderManager] Returning cached order for ID ${orderId}`);
              return cachedOrder;
          }
      }
      
      const ordersKey = this.keyGenerator.generateOrdersKey();
      this.logger.debug(`[OrderManager] Fetching order using HGET for key: ${ordersKey}, field: ${orderId}`);
      
      let orderString;
      // this.redis is expected to be an instance of RedisClient
      if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        this.logger.debug('[OrderManager] Using this.redis.client._command for HGET');
        orderString = await this.redis.client._command('HGET', ordersKey, orderId);
      } else if (this.redis && typeof this.redis.hGet === 'function') {
        // Corrected: Check for hGet on the RedisClient instance itself
        this.logger.debug('[OrderManager] Using this.redis.hGet for HGET');
        orderString = await this.redis.hGet(ordersKey, orderId);
      } else if (this.redis && typeof this.redis.hget === 'function') {
        // Fallback for other clients that might have hget (lowercase)
        this.logger.debug('[OrderManager] Using this.redis.hget (lowercase) for HGET');
        orderString = await this.redis.hget(ordersKey, orderId);
      } else {
        this.logger.error('[OrderManager] No suitable method found for HGET on redis client.', {
          hasClientCommand: !!(this.redis && this.redis.client && typeof this.redis.client._command === 'function'),
          hasHgetCap: !!(this.redis && typeof this.redis.hGet === 'function'),
          hasHgetLower: !!(this.redis && typeof this.redis.hget === 'function')
        });
        throw new Error('Redis client does not support a compatible HGET method (hGet, hget, or _command)');
      }
      
      if (orderString && typeof orderString === 'string') {
          try {
              const order = JSON.parse(orderString);
              // Optionally update cache with the single fetched order if cache was stale/missed
              // if (this.enableCaching) { ... update cache logic ... }
              return {
                  ...order,
                  sessionId: this.sessionId // Ensure sessionId
              };
          } catch (error) {
              this.logger.error(`[OrderManager] Error parsing order JSON string from HGET for ID ${orderId}: ${error.message}`, { orderString });
              return null;
          }
      } else {
          this.logger.debug(`[OrderManager] Order not found using HGET for ID ${orderId}`);
          return null;
      }
      
    } catch (error) {
      this.logger.error(`[OrderManager] Error getting order by ID: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Add a new order with deduplication
   * @param {Object} order - Order data to add
   * @returns {Promise<Object>} - Added order data
   */
  async add(order) {
    try {
      // Log incoming order data
      this.logger.debug(`[OrderManager] add() called with order:`, {
        id: order.id,
        parentOrderId: order.parentOrderId || 'NOT_PROVIDED',
        purpose: order.purpose || 'NOT_PROVIDED',
        hasParentOrderId: !!order.parentOrderId
      });
      
      // Validate order data
      const validatedOrder = this.validationUtils.validateOrderData({
        ...order,
        sessionId: this.sessionId
      });
      
      // Log validated order
      this.logger.debug(`[OrderManager] After validation:`, {
        id: validatedOrder.id,
        parentOrderId: validatedOrder.parentOrderId || 'NOT_IN_VALIDATED',
        purpose: validatedOrder.purpose || 'NOT_IN_VALIDATED',
        hasParentOrderId: !!validatedOrder.parentOrderId,
        hasPricingMetadata: !!validatedOrder.pricingMetadata,
        pricingMetadataKeys: validatedOrder.pricingMetadata ? Object.keys(validatedOrder.pricingMetadata) : 'NONE'
      });
      
      // Debug: Log pricing metadata preservation through validation
      if (order.pricingMetadata && !validatedOrder.pricingMetadata) {
        this.logger.error(`[PRICING_METADATA_DEBUG] Pricing metadata was LOST during validation for order ${validatedOrder.id}`);
      } else if (order.pricingMetadata && validatedOrder.pricingMetadata) {
        this.logger.info(`[PRICING_METADATA_DEBUG] Pricing metadata preserved through validation for order ${validatedOrder.id}`);
      }
      
      // Get all existing orders
      const existingOrders = await this.getAll();
      
      // Check for duplicate by ID
      const duplicateById = existingOrders.find(
        existingOrder => existingOrder.id === validatedOrder.id
      );
      
      if (duplicateById) {
        this.logger.debug(`[OrderManager] Order with ID ${validatedOrder.id} already exists, using existing order.`);
        return duplicateById;
      }
      
      // Check for semantic duplicates (same significant properties but different ID)
      const semanticDuplicate = existingOrders.find(existingOrder => 
        this.validationUtils.areObjectsSemanticallyIdentical(
          existingOrder, 
          validatedOrder, 
          this.orderSignificantProps.filter(prop => prop !== 'id') // Exclude ID for semantic comparison
        )
      );
      
      if (semanticDuplicate) {
        // Log the semantic duplicate, but proceed to add the new validatedOrder with its own ID
        this.logger.info(`[OrderManager] Order ${validatedOrder.id} is semantically similar to existing order ${semanticDuplicate.id}. Proceeding to add new order.`);
        // No longer returning semanticDuplicate here. Will proceed to add validatedOrder.
      }
      
      // No ID duplicate found (or only a semantic one, which we now allow), add the new validatedOrder
      const ordersKey = this.keyGenerator.generateOrdersKey();
      
      // Stringify the validated order
      let stringifiedOrder;
      try {
          // Debug: Log what we're about to stringify
          this.logger.info(`[PRICING_METADATA_DEBUG] About to stringify order ${validatedOrder.id}:`, {
              hasPricingMetadata: !!validatedOrder.pricingMetadata,
              pricingMetadataKeys: validatedOrder.pricingMetadata ? Object.keys(validatedOrder.pricingMetadata) : 'NONE',
              orderKeys: Object.keys(validatedOrder)
          });
          
          stringifiedOrder = JSON.stringify(validatedOrder);
          
          // Debug: Verify the stringified order contains pricing metadata
          const parsedBack = JSON.parse(stringifiedOrder);
          if (validatedOrder.pricingMetadata && !parsedBack.pricingMetadata) {
              this.logger.error(`[PRICING_METADATA_DEBUG] Pricing metadata LOST during JSON stringify/parse for order ${validatedOrder.id}`);
          } else if (validatedOrder.pricingMetadata && parsedBack.pricingMetadata) {
              this.logger.info(`[PRICING_METADATA_DEBUG] Pricing metadata preserved through JSON stringify/parse for order ${validatedOrder.id}`);
          }
      } catch (stringifyError) {
          this.logger.error(`[OrderManager] Error stringifying new order: ${stringifyError.message}`, { orderId: validatedOrder.id });
          throw stringifyError;
      }
      
      console.log(`[OrderManager CONSOLE_DEBUG] About to log HSETNX for order ${validatedOrder.id}`);
      this.logger.debug(`[OrderManager] Adding order ${validatedOrder.id} using HSETNX to key: ${ordersKey}, field: ${validatedOrder.id}`);

      let added = false;
      // Use HSETNX to add the order only if the field (orderId) doesn't exist
      // this.redis is expected to be an instance of RedisClient or RedisAdapter
      
      // Check methods in preferred order: specific methods first, then generic command
      if (this.redis && typeof this.redis.hSetNx === 'function') {
        // Check for hSetNx (camelCase) on the adapter/client instance itself
        this.logger.debug('[OrderManager] Using this.redis.hSetNx for HSETNX');
        added = await this.redis.hSetNx(ordersKey, validatedOrder.id, stringifiedOrder);
      } else if (this.redis && typeof this.redis.hsetnx === 'function') {
        // Fallback check for hsetnx (lowercase) on the adapter/client instance
        this.logger.debug('[OrderManager] Using this.redis.hsetnx (lowercase) for HSETNX');
        added = await this.redis.hsetnx(ordersKey, validatedOrder.id, stringifiedOrder);
      } else if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        // Explicitly check for the generic _command method on the underlying client
        this.logger.debug('[OrderManager] Using this.redis.client._command for HSETNX');
        added = await this.redis.client._command('HSETNX', ordersKey, validatedOrder.id, stringifiedOrder);
      } else {
        // All checks failed
        this.logger.error('[OrderManager] No suitable method found for HSETNX on redis adapter or client.', {
          hasHsetnxCap: !!(this.redis && typeof this.redis.hSetNx === 'function'), 
          hasHsetnxLower: !!(this.redis && typeof this.redis.hsetnx === 'function'),
          hasClientCommand: !!(this.redis && this.redis.client && typeof this.redis.client._command === 'function') 
        });
        throw new Error('Redis client/adapter does not support HSETNX via hSetNx, hsetnx, or a compatible _command method.');
      }

      if (added) {
          this.logger.info(`[OrderManager] Successfully added order ${validatedOrder.id} to Redis hash`);
          // Invalidate cache on successful add
          if (this.enableCaching) {
              this._ordersCache = null;
              this._ordersCacheExpiry = 0;
          }
          return validatedOrder;
      } else {
          this.logger.warn(`[OrderManager] Order ${validatedOrder.id} already exists in hash (HSETNX returned 0), likely race condition. Returning existing.`);
          // Fetch the existing order data since HSETNX didn't set ours
          return this.getById(validatedOrder.id); 
      }
    } catch (error) {
      this.logger.error(`[OrderManager] Error adding order: ${error.message}`);
      throw error; // Re-throw original error
    }
  }
  
  /**
   * Update an existing order
   * @param {Object} order - Order data to update
   * @returns {Promise<Object>} - Updated order data
   */
  async update(order) {
    try {
      // Validate order data
      const validatedOrder = this.validationUtils.validateOrderData({
        ...order,
        sessionId: this.sessionId
      });
      
      // Get the orders collection key (Hash key)
      const ordersKey = this.keyGenerator.generateOrdersKey();
      
      // Prepare the updated order object
      const orderToStore = {
          ...validatedOrder, // Start with validated incoming data
          lastUpdated: Date.now() // Use numeric timestamp instead of date string
      };
      
      // Stringify the final order object to store
      let stringifiedOrder;
      try {
          stringifiedOrder = JSON.stringify(orderToStore);
      } catch (stringifyError) {
          this.logger.error(`[OrderManager] Error stringifying order for update: ${stringifyError.message}`, { orderId: validatedOrder.id });
          throw stringifyError;
      }
      
      // Use HSET to update the order in the Hash (overwrites existing field)
      this.logger.debug(`[OrderManager] Updating order ${validatedOrder.id} using HSET in key: ${ordersKey}, field: ${validatedOrder.id}`);
      
      // Prefer adapter's lowercase hset, then camelCase hSet, then direct client _command
      if (this.redis && typeof this.redis.hset === 'function') { // Check lowercase first
        this.logger.debug('[OrderManager UPDATE] Using this.redis.hset (adapter lowercase) for HSET');
        await this.redis.hset(ordersKey, validatedOrder.id, stringifiedOrder);
      } else if (this.redis && typeof this.redis.hSet === 'function') { // Fallback to camelCase on adapter
        this.logger.debug('[OrderManager UPDATE] Using this.redis.hSet (adapter camelCase) for HSET');
        await this.redis.hSet(ordersKey, validatedOrder.id, stringifiedOrder);
      } else if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        this.logger.warn('[OrderManager UPDATE] Falling back to this.redis.client._command for HSET');
        await this.redis.client._command('HSET', ordersKey, validatedOrder.id, stringifiedOrder);
      } else {
        this.logger.error('[OrderManager UPDATE] No suitable method found for HSET on redis adapter or client.', {
            hasAdapterHsetLower: !!(this.redis && typeof this.redis.hset === 'function'),
            hasAdapterHsetCamel: !!(this.redis && typeof this.redis.hSet === 'function'),
            hasClientCommand: !!(this.redis && this.redis.client && typeof this.redis.client._command === 'function')
        });
        throw new Error('Redis client does not support hset/hSet via adapter or a compatible _command method for HSET');
      }
      
      this.logger.info(`[OrderManager] Successfully updated order ${validatedOrder.id} in Redis hash`);

      // Invalidate cache on successful update
      if (this.enableCaching) {
        this._ordersCache = null;
        this._ordersCacheExpiry = 0;
      }
      
      return orderToStore; // Return the data we just stored
    } catch (error) {
      this.logger.error(`[OrderManager] Error updating order: ${error.message}`);
      throw error; // Re-throw original error
    }
  }

  /**
   * Cancels an order by its ID.
   * Fetches the order, sets its status to 'canceled', and saves it back.
   * @param {string} orderId - The ID of the order to cancel.
   * @returns {Promise<Order|null>} The canceled order object, or null if not found or error.
   */
  async cancel(orderId) {
    this.logger.info(`[OrderManager] Attempting to cancel order ${orderId}`);
    try {
      const order = await this.getById(orderId); // Use existing getById to fetch
      if (!order) {
        this.logger.warn(`[OrderManager] Order ${orderId} not found for cancellation.`);
        return null;
      }

      if (order.status === 'CANCELLED') {
        this.logger.info(`[OrderManager] Order ${orderId} is already cancelled.`);
        return order;
      }

      // Update status and timestamp
      const originalStatus = order.status;
      order.status = 'CANCELLED';
      order.updatedAt = Date.now(); 
      order.lastUpdated = new Date().toISOString();

      const ordersKey = this.keyGenerator.generateOrdersKey();
      const orderString = JSON.stringify(order);
      
      this.logger.debug(`[OrderManager] Updating order ${orderId} to canceled status using HSET. Key: ${ordersKey}`);
      
      let setResult;
      // Prefer adapter's lowercase hset, then camelCase hSet, then direct client _command
      if (this.redis && typeof this.redis.hset === 'function') { // Check lowercase first
        this.logger.debug('[OrderManager CANCEL] Using this.redis.hset (adapter lowercase) for HSET');
        setResult = await this.redis.hset(ordersKey, orderId, orderString);
      } else if (this.redis && typeof this.redis.hSet === 'function') { // Fallback to camelCase on adapter
        this.logger.debug('[OrderManager CANCEL] Using this.redis.hSet (adapter camelCase) for HSET');
        setResult = await this.redis.hSet(ordersKey, orderId, orderString);
      } else if (this.redis && this.redis.client && typeof this.redis.client._command === 'function') {
        this.logger.warn('[OrderManager CANCEL] Falling back to this.redis.client._command for HSET');
        setResult = await this.redis.client._command('HSET', ordersKey, orderId, orderString);
      } else {
        this.logger.error('[OrderManager CANCEL] No suitable method found for HSET on redis adapter or client for cancellation.', {
            hasAdapterHsetLower: !!(this.redis && typeof this.redis.hset === 'function'),
            hasAdapterHsetCamel: !!(this.redis && typeof this.redis.hSet === 'function'),
            hasClientCommand: !!(this.redis && this.redis.client && typeof this.redis.client._command === 'function')
        });
        // Rollback status for in-memory object if Redis update fails before throwing
        order.status = originalStatus;
        order.updatedAt = order.createdAt; // Or a more appropriate rollback for updatedAt
        order.lastUpdated = new Date(order.createdAt).toISOString();
        throw new Error('Redis client does not support hset/hSet via adapter or a compatible _command method for HSET order update (cancel).');
      }

      this.logger.info(`[OrderManager] Successfully updated order ${orderId} to status 'CANCELLED' in Redis. Result: ${JSON.stringify(setResult)}`);
      
      // Invalidate cache
      this._ordersCache = null;
      this.logger.debug("[OrderManager] Cache invalidated due to order cancellation.");
      
      return order;

    } catch (error) {
      this.logger.error(`[OrderManager] Error canceling order ${orderId}: ${error.message}`, { stack: error.stack });
      return null; // Or rethrow depending on desired error handling
    }
  }

  /**
   * Set exchange order ID mapping
   * NOTE: This method is deprecated - exchange mapping is now stored directly in order objects
   * 
   * @param {string} exchangeOrderId - The exchange-assigned order ID
   * @param {string} clientOrderId - The client order ID (ammv2-...)
   * @returns {Promise<boolean>} - Success status
   * @deprecated Use order.exchangeOrderId field instead
   */
  async setExchangeMapping(exchangeOrderId, clientOrderId) {
    // NOTE: This method is now a no-op since we store exchangeOrderId directly in order objects
    // This eliminates the need for separate mapping keys and reduces Redis key proliferation
    this.logger.debug(`[OrderManager] Exchange mapping stored in order object: ${exchangeOrderId} -> ${clientOrderId}`);
    return true;
  }

  /**
   * Get client order ID by exchange order ID
   * 
   * @param {string} exchangeOrderId - The exchange-assigned order ID
   * @returns {Promise<string|null>} - The client order ID or null if not found
   */
  async getClientOrderIdByExchange(exchangeOrderId) {
    try {
      this.logger.debug(`[OrderManager] Looking up client order ID for exchange ID: ${exchangeOrderId}`);
      
      // Get all orders and search for the one with matching exchangeOrderId
      const orders = await this.getAll();
      
      // Use the map format if available, otherwise iterate through array
      if (orders._asMap) {
        this.logger.debug(`[OrderManager] Using map lookup with ${Object.keys(orders._asMap).length} orders`);
        for (const [clientOrderId, order] of Object.entries(orders._asMap)) {
          this.logger.debug(`[OrderManager] Checking order ${clientOrderId}: exchangeOrderId=${order.exchangeOrderId}`);
          if (order.exchangeOrderId === exchangeOrderId) {
            this.logger.debug(`[OrderManager] Found client order ID: ${clientOrderId} for exchange ID: ${exchangeOrderId}`);
            return clientOrderId;
          }
        }
      } else {
        this.logger.debug(`[OrderManager] Using array lookup with ${orders.length} orders`);
        // Fallback to array iteration
        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          this.logger.debug(`[OrderManager] Checking order ${i}: id=${order.id}, exchangeOrderId=${order.exchangeOrderId}`);
          if (order.exchangeOrderId === exchangeOrderId) {
            this.logger.debug(`[OrderManager] Found client order ID: ${order.id} for exchange ID: ${exchangeOrderId}`);
            return order.id || order.clientOrderId;
          }
        }
      }
      
      this.logger.warn(`[OrderManager] No order found with exchange ID: ${exchangeOrderId}`);
      return null;
    } catch (error) {
      this.logger.error(`[OrderManager] Error getting client order ID by exchange ID: ${error.message}`, { 
        exchangeOrderId,
        stack: error.stack 
      });
      return null;
    }
  }

  /**
   * Remove exchange mapping (e.g., when order is completed or cancelled)
   * NOTE: This method is deprecated - exchange mapping is now stored directly in order objects
   * 
   * @param {string} exchangeOrderId - The exchange-assigned order ID
   * @returns {Promise<boolean>} - Success status
   * @deprecated No longer needed since exchange mappings are stored in order objects
   */
  async removeExchangeMapping(exchangeOrderId) {
    // NOTE: This method is now a no-op since we store exchangeOrderId directly in order objects
    // No separate mapping keys to remove
    this.logger.debug(`[OrderManager] Exchange mapping removal no longer needed: ${exchangeOrderId}`);
    return true;
  }
}