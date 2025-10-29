# Redis Backend API

A robust, standardized interface for Redis operations across the DecisiveTrades platform, focusing on trading data (sessions, orders, fills).

## Features

- **Standardized Data Access**: Consistent interface for Redis operations
- **Deduplication**: Prevents duplicate data in Redis
- **Validation**: Centralized data validation
- **Caching**: Intelligent caching for improved performance
- **Enhanced Analytics**: Advanced operations for trading analysis

## Installation

The API is already integrated into the DecisiveTrades codebase. No additional installation is required.

## Basic Usage

### Traditional Initialization

```javascript
import { RedisDataAPI } from '../../src/lib/redis-backend-api/index.js';
import { getRedisClient } from '../../src/lib/utils/redis-client.js';

// Create Redis client
const redis = getRedisClient();

// Create API instance with full parameters
const redisApi = new RedisDataAPI({
  redis,
  sessionId: 'your-session-id',
  strategy: 'traditional-v2',
  exchange: 'kraken',
  symbol: 'BTC/USD',
  logger: console
});

// Initialize the API
await redisApi.initialize();

// Get session data
const session = await redisApi.session.get();
console.log('Session:', session);

// Get all orders
const orders = await redisApi.orders.getAll();
console.log(`Found ${orders.length} orders`);

// Get all fills
const fills = await redisApi.fills.getAll();
console.log(`Found ${fills.length} fills`);

// Remember to disconnect when done
await redisApi.disconnect();
```

### SessionId-Only Initialization

You can now initialize the API with just a sessionId. The API will automatically derive the strategy, exchange, and symbol parameters from Redis during initialization:

```javascript
import { RedisDataAPI } from '../../src/lib/redis-backend-api/index.js';
import { getRedisClient } from '../../src/lib/utils/redis-client.js';

// Create Redis client
const redis = getRedisClient();

// Create API instance with only sessionId
const redisApi = new RedisDataAPI({
  redis,
  sessionId: 'your-session-id', // Only sessionId is required
  logger: console
});

// This will derive strategy, exchange, and symbol from Redis
// by searching for keys matching *:*:*:your-session-id:session
await redisApi.initialize();

// Now you can use the API normally
const session = await redisApi.session.get();
console.log('Session:', session);
```

This approach greatly simplifies integration with existing systems where you may only have the sessionId available but need to access all associated trading data.

## Enhanced Usage

For advanced analytics and trading operations, use the EnhancedRedisAPI. The EnhancedRedisAPI inherits from RedisDataAPI, so it also supports sessionId-only initialization:

```javascript
import { EnhancedRedisAPI } from '../../src/lib/redis-backend-api/index.js';
import { getRedisClient } from '../../src/lib/utils/redis-client.js';

// Create Redis client
const redis = getRedisClient();

// Create enhanced API instance with just sessionId
const enhancedApi = new EnhancedRedisAPI({
  redis,
  sessionId: 'your-session-id',  // Only the sessionId is required
  logger: console
});

// Initialize the API
await enhancedApi.initialize();

// Get order metrics
const metrics = await enhancedApi.enhancedOrders.getOrderMetrics();
console.log(`Total Orders: ${metrics.total}, Buy Orders: ${metrics.buyCount}, Sell Orders: ${metrics.sellCount}`);

// Find matched buy/sell order pairs
const orderPairs = await enhancedApi.enhancedOrders.getOrderPairs();
console.log(`Found ${orderPairs.length} buy/sell order pairs`);

// Calculate profit/loss
const pnl = await enhancedApi.enhancedFills.calculateProfitLoss();
console.log(`Realized P&L: $${pnl.realizedPnL.toFixed(2)}, Percent P&L: ${pnl.percentPnL.toFixed(2)}%`);

// Generate a comprehensive session summary
const summary = await enhancedApi.getSessionSummary();
console.log(JSON.stringify(summary, null, 2));

// Disconnect when done
await enhancedApi.disconnect();
```

## API Reference

### RedisDataAPI

Main factory class that provides access to specialized managers.

#### Constructor

```javascript
constructor({
  redis,            // Required: Redis client instance
  sessionId,        // Required: Trading session ID
  strategy,         // Required: Trading strategy (e.g., 'traditional-v2')
  exchange,         // Required: Exchange name (e.g., 'kraken')
  symbol,           // Required: Trading symbol (e.g., 'BTC/USD')
  logger,           // Optional: Logger instance (defaults to console)
  enableCaching     // Optional: Enable/disable caching (default true)
})
```

#### Properties

- `session`: SessionManager instance
- `orders`: OrderManager instance
- `fills`: FillManager instance
- `config`: Configuration properties

#### Methods

- `initialize()`: Initialize the API and managers
- `disconnect()`: Clean up resources and connections
- `clearCache()`: Clear all caches

### EnhancedRedisAPI

Extends the base RedisDataAPI with advanced trading analytics features.

#### Additional Properties

- `enhancedOrders`: EnhancedOrderOperations instance
- `enhancedFills`: EnhancedFillOperations instance
- `enhancedSession`: EnhancedSessionOperations instance

#### Additional Methods

- `getSessionSummary()`: Generates a comprehensive session summary

### EnhancedOrderOperations

Advanced order analytics, position derivation, and order management operations.

- `getOrderMetrics()`: Get count statistics for orders
- `getBuyOrders()`: Get all buy orders
- `getSellOrders()`: Get all sell orders
- `getOpenOrders()`: Get all open orders
- `getOrdersByStatus(status)`: Get orders filtered by status
- `getOrderPairs()`: Match buy and sell orders. This relies on `parentOrderId` being set on take-profit/stop-loss orders to link them back to the originating order, and `clientOrderId` often being used to ensure uniqueness of these derived orders.
- `cancelOpenOrders(side)`: Cancel all open orders of a specified side
- `getOpenPositions()`: Derive open positions from orders and fills
- `analyzePositions()`: Generate detailed position analytics

### EnhancedFillOperations

Advanced fill analytics and profit/loss calculations.

- `getBuyFills()`: Get all buy fills
- `getSellFills()`: Get all sell fills
- `getFillsByOrderId(orderId)`: Get fills for a specific order
- `calculateProfitLoss()`: Calculate profit/loss metrics for the session
- `getMatchedFillPairs()`: Match buy and sell fills for profit analysis

### EnhancedSessionOperations

Advanced session operations and summary information.

- `getSessionSummary(orderManager, fillManager)`: Generate comprehensive session summary
- `getSessionRuntime()`: Calculate the total runtime of the session
- `getVerificationItems()`: Generate verification data for migration validation

## Agent Integration

### Replacing Specialized Managers

The Enhanced Redis API can fully replace traditional specialized managers (OrderManager, PositionManager, PersistenceManager) in agent implementations. This provides a more consistent, maintainable approach with a single source of truth for all Redis data operations.

```javascript
// Before: Using specialized managers
class TraditionalAgent {
  constructor(config) {
    // Multiple specialized managers accessing the same data
    this.orderManager = new OrderManager(config);
    this.positionManager = new PositionManager(config);
    this.persistenceManager = new PersistenceManager(config);
  }
}

// After: Using the Enhanced Redis API
class ModernAgent {
  constructor(config) {
    // Single API for all Redis data operations
    this.redisApi = new EnhancedRedisAPI({
      redis: config.redis,
      sessionId: config.sessionId,
      strategy: config.strategy,
      exchange: config.exchange,
      symbol: config.symbol,
      logger: config.logger
    });
  }
  
  // Order operations
  async cancelOpenOrders(side) {
    return this.redisApi.enhancedOrders.cancelOpenOrders(side);
  }
  
  // Position operations
  async getOpenPositions() {
    return this.redisApi.enhancedOrders.getOpenPositions();
  }
  
  // Session operations
  async updateSessionStatus(status) {
    return this.redisApi.session.updateStatus(status);
  }
}
```

### Benefits of Using Enhanced Redis API

- **Unified Data Access**: Single source of truth for all Redis data operations
- **Consistent Validation**: All data is validated through the same pipeline
- **Reduced Duplication**: No redundant code across specialized managers
- **Advanced Analytics**: Built-in methods for metrics, P&L, and position analysis
- **Simpler Maintenance**: Updates to data handling only needed in one place
- **Reduced Bugs**: Consistent data handling prevents environment-specific bugs

## Common Usage Patterns

### 1. Session Management

```javascript
// Get session data
const session = await redisApi.session.get();

// Update session status
await redisApi.session.updateStatus('complete');
```

### 2. Order Operations

```javascript
// Get all orders for the current session and a specific symbol
// (OrderManager is typically instantiated with session, strategy, exchange, and symbol,
// so getAll() is scoped to these parameters unless overridden by method arguments)
const orders = await redisApi.orders.getAll('BTC/USD'); // Example: pass symbol if manager isn't pre-scoped or to override

// Add a new order (with built-in deduplication based on order ID).
// If providing a clientOrderId, ensure it is unique, especially for linking
// orders like take-profits to their parent orders.
await redisApi.orders.add(newOrder);

// Update an order status
// Note: For complex trade flows like take-profits, ensure primary order updates,
// fill recording, and balance updates are committed to Redis *before*
// initiating dependent orders (e.g., take-profit creation) to maintain data consistency.
// The AdaptiveMarketMaker._handleFill method now follows this refined sequence.
await redisApi.orders.updateStatus(orderId, 'filled', { filledAt: new Date().toISOString() });

// Cancel all open buy orders
await redisApi.enhancedOrders.cancelOpenOrders('buy');
```

### 3. Fill Operations

```javascript
// Get all fills
const fills = await redisApi.fills.getAll();

// Get fills for a specific order
const orderFills = await redisApi.fills.getByOrderId(orderId);

// Add a new fill (with built-in deduplication)
await redisApi.fills.add(newFill);
```

### 4. Enhanced Analytics

```javascript
// Get buy/sell order pairs
const orderPairs = await enhancedApi.enhancedOrders.getOrderPairs();

// Calculate profit/loss
const pnl = await enhancedApi.enhancedFills.calculateProfitLoss();

// Generate a comprehensive session summary
const summary = await enhancedApi.getSessionSummary();
```

## Error Handling

The API uses proper error handling with descriptive messages:

```javascript
try {
  const session = await redisApi.session.get();
  // Process session data
} catch (error) {
  console.error(`Error retrieving session: ${error.message}`);
  // Handle error appropriately
}
```

## Integration with Session Settlement

Example of using the Enhanced Redis API in the session-settlement-worker:

```javascript
import { EnhancedRedisAPI } from '../../src/lib/redis-backend-api/index.js';

class SessionSettlementManager {
  // ...
  
  async settleSession(sessionId) {
    // Initialize enhanced Redis API
    const redisApi = new EnhancedRedisAPI({
      redis: this.redis,
      sessionId,
      strategy: 'traditional-v2',
      exchange: 'kraken',
      symbol: 'BTC/USD',
      logger: this.logger
    });
    await redisApi.initialize();
    
    try {
      // Get session summary
      const summary = await redisApi.getSessionSummary();
      
      // Process open orders
      const openOrders = await redisApi.enhancedOrders.getOpenOrders();
      // Cancel open orders or perform other settlement actions
      
      // Generate settlement report
      const report = {
        sessionId,
        summary,
        settledAt: new Date().toISOString(),
        // Additional settlement data
      };
      
      // Update session status
      await redisApi.session.updateStatus('settled');
      
      return report;
    } catch (error) {
      this.logger.error(`Settlement error: ${error.message}`);
      throw error;
    } finally {
      await redisApi.disconnect();
    }
  }
  
  // ...
}
```

## Demo Scripts

For practical examples, see the following scripts:

1. `scripts/diagnostics/test-redis-backend-api.js` - Basic API verification
2. `scripts/diagnostics/demo-enhanced-redis-api.js` - Enhanced API features demonstration

## Related Documentation

For more detailed information, see:
- [Redis Backend API Specification](/documentation/architecture/redis-data-api-specification.md)
- [Redis Key Structure](/documentation/architecture/redis-key-structure.md)
- [Test Scripts Directory](/documentation/testing/test-scripts-directory.md)
