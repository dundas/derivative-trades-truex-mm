/**
 * Order Correlation Validator
 * 
 * Prevents orphaned orders and parentOrderId discrepancies by:
 * 1. Validating parent order exists and is valid
 * 2. Checking for existing sell orders before creating new ones
 * 3. Ensuring proper order lineage tracking
 */

export class OrderCorrelationValidator {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.redis = options.redis;
    this.sessionId = options.sessionId;
  }

  /**
   * Validate that we can safely create a sell order for a buy position
   * Returns: { canCreate: boolean, reason: string, existingOrders?: Array }
   */
  async validateSellOrderCreation(buyOrderId, proposedSellOrder, sessionRedisApi) {
    try {
      this.logger.info(`🔍 Validating sell order creation for buy order: ${buyOrderId}`);

      // 1. Validate parent buy order exists and is filled
      const parentValidation = await this.validateParentBuyOrder(buyOrderId, sessionRedisApi);
      if (!parentValidation.isValid) {
        return {
          canCreate: false,
          reason: `Parent order validation failed: ${parentValidation.reason}`,
          parentOrder: parentValidation.order
        };
      }

      // 2. Check for existing sell orders linked to this buy order
      const existingOrdersCheck = await this.checkExistingSellOrders(buyOrderId, sessionRedisApi);
      if (existingOrdersCheck.hasExisting) {
        return {
          canCreate: false,
          reason: `Existing sell orders found for buy order ${buyOrderId}`,
          existingOrders: existingOrdersCheck.orders,
          parentOrder: parentValidation.order
        };
      }

      // 3. Validate proposed order parameters
      const orderValidation = await this.validateOrderParameters(proposedSellOrder, parentValidation.order);
      if (!orderValidation.isValid) {
        return {
          canCreate: false,
          reason: `Order parameters invalid: ${orderValidation.reason}`,
          parentOrder: parentValidation.order
        };
      }

      // 4. Check for sufficient position size
      const positionValidation = await this.validatePositionSize(buyOrderId, proposedSellOrder, sessionRedisApi);
      if (!positionValidation.isValid) {
        return {
          canCreate: false,
          reason: `Position size validation failed: ${positionValidation.reason}`,
          parentOrder: parentValidation.order,
          availableSize: positionValidation.availableSize
        };
      }

      return {
        canCreate: true,
        reason: 'All validations passed',
        parentOrder: parentValidation.order,
        availableSize: positionValidation.availableSize
      };

    } catch (error) {
      this.logger.error(`❌ Error validating sell order creation:`, error);
      return {
        canCreate: false,
        reason: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * Validate that the parent buy order exists and is in a valid state
   */
  async validateParentBuyOrder(buyOrderId, sessionRedisApi) {
    try {
      const allOrders = await sessionRedisApi.orders.getAll();
      const parentOrder = allOrders.find(order => order.id === buyOrderId);

      if (!parentOrder) {
        return {
          isValid: false,
          reason: `Parent order ${buyOrderId} not found in Redis`,
          order: null
        };
      }

      if (parentOrder.side !== 'buy' && parentOrder.side !== 'BUY') {
        return {
          isValid: false,
          reason: `Parent order ${buyOrderId} is not a buy order (side: ${parentOrder.side})`,
          order: parentOrder
        };
      }

      if (parentOrder.status !== 'FILLED' && parentOrder.status !== 'filled') {
        return {
          isValid: false,
          reason: `Parent order ${buyOrderId} is not filled (status: ${parentOrder.status})`,
          order: parentOrder
        };
      }

      const filledAmount = parseFloat(parentOrder.filled || parentOrder.size || parentOrder.amount || 0);
      if (filledAmount <= 0) {
        return {
          isValid: false,
          reason: `Parent order ${buyOrderId} has no filled amount (filled: ${parentOrder.filled})`,
          order: parentOrder
        };
      }

      return {
        isValid: true,
        reason: 'Parent order is valid',
        order: parentOrder,
        filledAmount: filledAmount
      };

    } catch (error) {
      return {
        isValid: false,
        reason: `Error checking parent order: ${error.message}`,
        order: null
      };
    }
  }

  /**
   * Check for existing sell orders that reference this buy order as parent
   */
  async checkExistingSellOrders(buyOrderId, sessionRedisApi) {
    try {
      const allOrders = await sessionRedisApi.orders.getAll();
      
      // Find all sell orders that reference this buy order as parent
      const existingSellOrders = allOrders.filter(order => 
        (order.side === 'sell' || order.side === 'SELL') &&
        order.parentOrderId === buyOrderId &&
        // Only consider active orders (not cancelled/rejected)
        !['CANCELLED', 'cancelled', 'REJECTED', 'rejected', 'EXPIRED', 'expired'].includes(order.status)
      );

      if (existingSellOrders.length > 0) {
        this.logger.warn(`Found ${existingSellOrders.length} existing sell orders for buy order ${buyOrderId}:`, 
          existingSellOrders.map(o => ({
            id: o.id,
            status: o.status,
            amount: o.amount || o.size,
            purpose: o.purpose
          }))
        );

        return {
          hasExisting: true,
          orders: existingSellOrders,
          count: existingSellOrders.length
        };
      }

      return {
        hasExisting: false,
        orders: [],
        count: 0
      };

    } catch (error) {
      this.logger.error(`Error checking existing sell orders for ${buyOrderId}:`, error);
      throw error;
    }
  }

  /**
   * Validate the proposed order parameters make sense
   */
  async validateOrderParameters(proposedOrder, parentOrder) {
    try {
      // Basic parameter validation
      if (!proposedOrder.amount && !proposedOrder.size) {
        return {
          isValid: false,
          reason: 'Proposed order missing amount/size'
        };
      }

      if (!proposedOrder.price || proposedOrder.price <= 0) {
        return {
          isValid: false,
          reason: 'Proposed order missing or invalid price'
        };
      }

      if (!proposedOrder.symbol) {
        return {
          isValid: false,
          reason: 'Proposed order missing symbol'
        };
      }

      // Validate order amount doesn't exceed parent order
      const proposedAmount = parseFloat(proposedOrder.amount || proposedOrder.size);
      const parentFilledAmount = parseFloat(parentOrder.filled || parentOrder.size || parentOrder.amount);

      if (proposedAmount > parentFilledAmount * 1.001) { // Allow tiny rounding differences
        return {
          isValid: false,
          reason: `Proposed amount ${proposedAmount} exceeds parent filled amount ${parentFilledAmount}`
        };
      }

      // Validate symbols match
      if (proposedOrder.symbol !== parentOrder.symbol) {
        return {
          isValid: false,
          reason: `Symbol mismatch: proposed ${proposedOrder.symbol} vs parent ${parentOrder.symbol}`
        };
      }

      return {
        isValid: true,
        reason: 'Order parameters are valid'
      };

    } catch (error) {
      return {
        isValid: false,
        reason: `Parameter validation error: ${error.message}`
      };
    }
  }

  /**
   * Validate that there's sufficient position size available for the proposed order
   */
  async validatePositionSize(buyOrderId, proposedOrder, sessionRedisApi) {
    try {
      // Get all orders to calculate net position
      const allOrders = await sessionRedisApi.orders.getAll();
      const parentOrder = allOrders.find(order => order.id === buyOrderId);
      
      if (!parentOrder) {
        return {
          isValid: false,
          reason: 'Parent order not found for position calculation'
        };
      }

      // Calculate total filled amount from the parent buy order
      const totalBuyAmount = parseFloat(parentOrder.filled || parentOrder.size || parentOrder.amount || 0);
      
      // Calculate already allocated amount from existing sell orders
      const existingSellOrders = allOrders.filter(order =>
        (order.side === 'sell' || order.side === 'SELL') &&
        order.parentOrderId === buyOrderId &&
        !['CANCELLED', 'cancelled', 'REJECTED', 'rejected', 'EXPIRED', 'expired'].includes(order.status)
      );

      const alreadyAllocated = existingSellOrders.reduce((sum, order) => {
        return sum + parseFloat(order.amount || order.size || 0);
      }, 0);

      const availableSize = totalBuyAmount - alreadyAllocated;
      const proposedAmount = parseFloat(proposedOrder.amount || proposedOrder.size);

      this.logger.info(`Position size validation:`, {
        buyOrderId,
        totalBuyAmount,
        alreadyAllocated,
        availableSize,
        proposedAmount,
        existingSellOrdersCount: existingSellOrders.length
      });

      if (proposedAmount > availableSize * 1.001) { // Allow tiny rounding differences
        return {
          isValid: false,
          reason: `Insufficient position size: need ${proposedAmount}, available ${availableSize}`,
          availableSize,
          alreadyAllocated,
          totalBuyAmount
        };
      }

      return {
        isValid: true,
        reason: 'Sufficient position size available',
        availableSize,
        alreadyAllocated,
        totalBuyAmount
      };

    } catch (error) {
      return {
        isValid: false,
        reason: `Position size validation error: ${error.message}`
      };
    }
  }

  /**
   * Create a correlation record to track the relationship between orders
   */
  async createOrderCorrelationRecord(parentOrderId, childOrderId, sessionRedisApi, metadata = {}) {
    try {
      const correlationRecord = {
        parentOrderId,
        childOrderId,
        sessionId: this.sessionId,
        createdAt: Date.now(),
        type: 'take-profit',
        ...metadata
      };

      // Store in Redis for tracking
      const correlationKey = `order_correlation:${this.sessionId}:${childOrderId}`;
      if (this.redis) {
        await this.redis.set(correlationKey, JSON.stringify(correlationRecord));
        await this.redis.expire(correlationKey, 7 * 24 * 60 * 60); // 7 days
      }

      this.logger.info(`✅ Created order correlation record:`, {
        parentOrderId,
        childOrderId,
        correlationKey
      });

      return correlationRecord;

    } catch (error) {
      this.logger.error(`Error creating correlation record:`, error);
      throw error;
    }
  }

  /**
   * Verify order correlation after creation to ensure no orphaned orders
   */
  async verifyOrderCorrelation(childOrderId, expectedParentId, sessionRedisApi) {
    try {
      const allOrders = await sessionRedisApi.orders.getAll();
      const childOrder = allOrders.find(order => order.id === childOrderId);
      
      if (!childOrder) {
        return {
          isValid: false,
          reason: `Child order ${childOrderId} not found`,
          childOrder: null
        };
      }

      if (childOrder.parentOrderId !== expectedParentId) {
        return {
          isValid: false,
          reason: `Parent ID mismatch: expected ${expectedParentId}, got ${childOrder.parentOrderId}`,
          childOrder: childOrder
        };
      }

      // Verify parent order still exists
      const parentOrder = allOrders.find(order => order.id === expectedParentId);
      if (!parentOrder) {
        return {
          isValid: false,
          reason: `Parent order ${expectedParentId} not found`,
          childOrder: childOrder
        };
      }

      return {
        isValid: true,
        reason: 'Order correlation verified',
        childOrder: childOrder,
        parentOrder: parentOrder
      };

    } catch (error) {
      return {
        isValid: false,
        reason: `Correlation verification error: ${error.message}`
      };
    }
  }
} 