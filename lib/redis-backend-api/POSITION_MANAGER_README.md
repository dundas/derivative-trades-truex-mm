# Position Manager API

The `PositionManager` provides a centralized, consistent way to identify trading positions (filled buy orders) and their associated take-profit coverage state across the entire trading system.

## Overview

Previously, position identification and take-profit coverage analysis was scattered across multiple services with inconsistent logic. The `PositionManager` standardizes this by providing:

- **Consistent Position Identification**: Unified logic for finding filled buy orders across fills and order data
- **Coverage State Analysis**: Reliable detection of take-profit order coverage (active, filled, expired)
- **Position Linking**: Smart matching of sell orders to their corresponding buy positions
- **Summary Statistics**: Comprehensive position analytics for monitoring and debugging

## Key Features

### Position Detection
- Prefers fill data when available (more reliable)
- Falls back to order status filtering 
- Normalizes data format for consistency
- Filters out positions that are too old

### Take-Profit Matching
- Multiple matching strategies:
  - Direct `parentOrderId` matching
  - Client order ID pattern matching
  - Take-profit prefix detection (`tp`, `stp`)
- Categorizes orders by status (active, filled, expired, cancelled)

### Coverage Analysis
- Determines if positions need take-profit orders
- Identifies positions with expired or cancelled take-profits
- Provides detailed coverage breakdown statistics

## API Methods

### Core Methods

#### `getPositions()`
Returns all valid positions (filled buy orders) for the session.

```javascript
const positions = await positionManager.getPositions();
// Returns: Array of normalized position objects
```

#### `getPositionStates()`
Returns detailed state information for all positions including coverage analysis.

```javascript
const positionStates = await positionManager.getPositionStates();
// Returns: Array of position state objects with coverage details
```

#### `getUncoveredPositions()`
Returns positions that need take-profit orders.

```javascript
const uncovered = await positionManager.getUncoveredPositions();
// Returns: Array of positions without adequate take-profit coverage
```

#### `getPositionTakeProfits(positionId)`
Returns all take-profit orders for a specific position, categorized by status.

```javascript
const takeProfits = await positionManager.getPositionTakeProfits('order-123');
// Returns: { active: [], filled: [], expired: [], cancelled: [], all: [] }
```

#### `getPositionSummary()`
Returns comprehensive statistics about all positions in the session.

```javascript
const summary = await positionManager.getPositionSummary();
// Returns: Object with totals, coverage breakdown, age info, etc.
```

## Usage Examples

### Basic Setup

```javascript
import { PositionManager, SessionManager, KeyGenerator, ValidationUtils } from '../lib/redis-backend-api/index.js';

// Get session info
const sessionResult = await SessionManager.findBySessionId({
  redis: redisClient,
  sessionId: sessionId,
  logger: logger
});

const { symbol, strategy, exchange } = sessionResult.keyInfo;

// Initialize dependencies
const keyGenerator = new KeyGenerator({
  exchange, symbol, strategy, sessionId
});

const validationUtils = new ValidationUtils();

// Create position manager
const positionManager = new PositionManager({
  redis: redisClient,
  sessionId: sessionId,
  logger: logger,  
  keyGenerator: keyGenerator,
  validationUtils: validationUtils
});

await positionManager.initialize();
```

### Finding Uncovered Positions

```javascript
// Get positions that need take-profit orders
const uncoveredPositions = await positionManager.getUncoveredPositions();

console.log(`Found ${uncoveredPositions.length} positions needing take-profit orders`);

for (const position of uncoveredPositions) {
  console.log(`Position ${position.id}: ${position.size} @ ${position.avgPrice}`);
  
  // Create take-profit order logic here...
}
```

### Position Coverage Analysis

```javascript
// Get detailed position states
const positionStates = await positionManager.getPositionStates();

for (const state of positionStates) {
  const position = state.position;
  const coverage = state.coverageState;
  
  console.log(`Position ${position.id}:`);
  console.log(`  - Has Coverage: ${state.hasCoverage}`);
  console.log(`  - Active TPs: ${coverage.hasActiveTakeProfit}`);
  console.log(`  - Filled TPs: ${coverage.hasFilledTakeProfit}`); 
  console.log(`  - Expired TPs: ${coverage.hasExpiredTakeProfit}`);
  console.log(`  - Age: ${state.positionAgeHours.toFixed(1)} hours`);
}
```

### Session Summary

```javascript
// Get comprehensive session statistics  
const summary = await positionManager.getPositionSummary();

console.log(`Session Summary:`);
console.log(`  Total Positions: ${summary.totalPositions}`);
console.log(`  Covered: ${summary.coveredPositions}`);
console.log(`  Uncovered: ${summary.uncoveredPositions}`);
console.log(`  Total Value: $${summary.totalPositionValue.toFixed(2)}`);
console.log(`  Coverage Breakdown:`);
console.log(`    - Active TP: ${summary.coverageBreakdown.activeTakeProfit}`);
console.log(`    - Filled TP: ${summary.coverageBreakdown.filledTakeProfit}`);
console.log(`    - Expired TP: ${summary.coverageBreakdown.expiredTakeProfit}`);
console.log(`    - No TP: ${summary.coverageBreakdown.noTakeProfit}`);
```

## Configuration Options

The `PositionManager` constructor accepts these configuration options:

```javascript
const positionManager = new PositionManager({
  redis: redisClient,          // Required: Redis client instance
  sessionId: sessionId,        // Required: Session ID
  logger: logger,              // Required: Logger instance  
  keyGenerator: keyGenerator,  // Required: Key generator
  validationUtils: validationUtils, // Required: Validation utils
  
  // Optional configuration
  maxPositionAgeMs: 7 * 24 * 60 * 60 * 1000, // Max position age (7 days)
  takeProfitPrefixes: ['tp', 'stp'], // TP order prefixes to match
  positionSides: ['buy', 'BUY'],     // Sides that create positions
  sellSides: ['sell', 'SELL'],       // Sides that close positions
  filledStatuses: ['FILLED', 'filled'], // Statuses indicating filled orders
  activeStatuses: ['OPEN', 'open', 'FILLED', 'filled', 'PARTIALLY_FILLED'] // Active order statuses
});
```

## Integration Examples

### Take-Profit Service Integration

The `TakeProfitService` has been refactored to use `PositionManager`:

```javascript
// Before: Complex custom logic
const [orders, fills] = await Promise.all([...]);
// 100+ lines of position identification logic...

// After: Clean API usage
const positionManager = await this.createPositionManager(sessionId);
const uncoveredPositions = await positionManager.getUncoveredPositions();
const positionSummary = await positionManager.getPositionSummary();
```

### Settlement Service Integration

```javascript
// Find positions that need settlement take-profit orders
const positionManager = await this.createPositionManager(sessionId);
const uncoveredPositions = await positionManager.getUncoveredPositions();

// Apply aging-based pricing for old positions
for (const position of uncoveredPositions) {
  const positionAgeHours = (Date.now() - position.timestamp) / (1000 * 60 * 60);
  
  if (positionAgeHours > 24) {
    // Create settlement take-profit with aging adjustment
    await this.createSettlementTakeProfit(position, positionAgeHours);
  }
}
```

## Testing

Use the provided test script to validate the API:

```bash
node scripts/analysis/test-position-manager.js <sessionId>
```

This will demonstrate all API methods and provide detailed output about position states and coverage.

## Benefits

### For Take-Profit Service
- **50% reduction** in complex position identification code
- **Consistent logic** across market-maker and settlement contexts
- **Better reliability** with standardized position matching

### For Settlement Service  
- **Unified position detection** with aging analysis
- **Detailed coverage breakdown** for settlement decisions
- **Consistent data format** across all position operations

### For Analysis & Monitoring
- **Standardized position metrics** across all services
- **Rich position state information** for debugging
- **Comprehensive coverage analytics** for system health

## Migration Guide

To migrate existing position identification code:

1. **Replace custom position detection logic** with `positionManager.getPositions()`
2. **Replace take-profit matching logic** with `positionManager.getPositionTakeProfits()`
3. **Use `getUncoveredPositions()`** instead of custom coverage analysis
4. **Leverage `getPositionSummary()`** for monitoring and statistics

This provides immediate consistency improvements and reduces maintenance burden across the entire trading system. 