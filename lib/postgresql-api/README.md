# PostgreSQL API

A unified PostgreSQL database API for the decisive_trades application, providing centralized schema management, high-level operations, and consistent interfaces across all services.

## 🎯 **Purpose**

This API solves the critical problems we were facing with scattered database code:

1. **Schema Inconsistencies** - Different services using different column names (`sessionId` vs `sessionid`)
2. **Duplicate Code** - Each service maintaining its own database utilities
3. **No Bulk Operations** - Inefficient single-record inserts
4. **Validation Issues** - No centralized data validation
5. **Migration Complexity** - Hard to maintain consistent schemas across migrations and services

## 🏗️ **Architecture**

Similar to our `redis-backend-api`, this provides:

```
postgresql-api/
├── schemas/           # Centralized schema definitions
├── utils/            # SQL generation utilities  
├── managers/         # High-level operation managers
├── adapters/         # Database connection adapters
└── index.js          # Main API interface
```

## 🚀 **Key Features**

### ✅ **Centralized Schema Management**
- Single source of truth for all table schemas
- PostgreSQL-specific data types and constraints
- Automatic index generation
- Field name normalization (handles `sessionId` → `sessionid`)

### ✅ **High-Level Managers**
- `SessionManager` - Session operations
- `OrderManager` - Order operations
- `FillManager` - Fill operations (coming soon)

### ✅ **Bulk Operations**
- Optimized bulk inserts with chunking
- PostgreSQL-native `INSERT ... ON CONFLICT` handling
- Automatic field mapping and validation

### ✅ **Consistent API**
- Same interface pattern as redis-backend-api
- Unified error handling
- Connection pooling with statistics

## 📝 **Usage Examples**

### Basic Setup

```javascript
import { createPostgreSQLAPIFromEnv } from './src/lib/postgresql-api/index.js';

// Create API instance from environment
const db = createPostgreSQLAPIFromEnv();
await db.initialize();
```

### Session Operations

```javascript
// Get a session
const session = await db.sessions.getSession('session_id');

// Save a session (handles field name variations)
await db.sessions.saveSession({
  id: 'session_123',
  sessionId: 'session_123',  // Will be normalized to 'sessionid'
  symbol: 'BTC/USDT',
  status: 'active',
  createdAt: Date.now()     // Will be normalized to 'createdat'
});

// Bulk save sessions
const results = await db.sessions.saveSessionsBulk(sessionArray);
console.log(`Saved ${results.success} sessions, failed ${results.failed}`);

// Find sessions for settlement
const sessionsToSettle = await db.sessions.findSessionsToSettle({
  daysAgo: 2,
  activeOnly: false
});
```

### Order Operations

```javascript
// Get orders for a session
const orders = await db.orders.getOrders('session_id');

// Get open sell orders
const openSells = await db.orders.getOpenOrders('session_id', 'sell');

// Bulk save orders
const results = await db.orders.saveOrdersBulk(orderArray);

// Check if session has open sells
const { hasOpenSells, details } = await db.orders.hasOpenSells('session_id');

// Get order statistics
const stats = await db.orders.getOrderStats('session_id');
```

### Bulk Operations Helper

```javascript
// Convenient bulk operations
await db.bulk.sessions.save(sessionArray);
await db.bulk.orders.save(orderArray);
```

### Migration Helpers

```javascript
// Get migrated sessions
const migratedIds = await db.migration.getMigratedSessions();

// Mark session as migrated
await db.migration.markSessionAsMigrated('session_id');
```

### Settlement Helpers

```javascript
// Find sessions needing settlement
const sessions = await db.settlement.findSessionsToSettle({ daysAgo: 3 });

// Update settlement status
await db.settlement.updateSettlementStatus('session_id', true);

// Check for open sells
const { hasOpenSells } = await db.settlement.hasOpenSells('session_id');
```

## 🔧 **Advanced Usage**

### Raw Queries

```javascript
// Execute raw PostgreSQL
const result = await db.query('SELECT * FROM sessions WHERE status = $1', ['active']);
```

### Transactions

```javascript
// Execute multiple queries in a transaction
await db.transaction([
  { text: 'UPDATE sessions SET status = $1 WHERE id = $2', params: ['completed', 'session_id'] },
  { text: 'INSERT INTO orders ...', params: [...] }
]);
```

### Schema Access

```javascript
// Access schemas directly
const sessionSchema = db.schemas.sessions;
const columnNames = Object.keys(sessionSchema.columns);

// Generate custom SQL
const sql = db.utils.generateBulkInsertSQL(sessionSchema, 100);
```

## 🔄 **Migration from Existing Code**

### Replace Settlement Service Database Code

**Before:**
```javascript
// Old settlement service code
import { NeonAdapter } from './src/utils/neon-adapter.js';
const adapter = new NeonAdapter({ connectionString: process.env.NEON_CONN });
const sessions = await adapter.findSessionsToSettle();
```

**After:**
```javascript
// New unified API
import { createPostgreSQLAPIFromEnv } from '../../../lib/postgresql-api/index.js';
const db = createPostgreSQLAPIFromEnv();
const sessions = await db.settlement.findSessionsToSettle();
```

### Replace Migration Service Code

**Before:**
```javascript
// Old migration code with inconsistent schemas
import { saveSessionsBulk } from './neonDbUtils-bulk.js';
const results = await saveSessionsBulk(sessions);
```

**After:**
```javascript
// New unified API with consistent schemas
const results = await db.bulk.sessions.save(sessions);
```

## 🔌 **Integration with Services**

### Migration Service
```javascript
import { createPostgreSQLAPIFromEnv } from '../../../lib/postgresql-api/index.js';

const db = createPostgreSQLAPIFromEnv();
await db.initialize();

// All migration operations now use consistent schemas
const migratedSessions = await db.migration.getMigratedSessions();
const results = await db.bulk.sessions.save(sessionsFromRedis);
```

### Settlement Service  
```javascript
import { createPostgreSQLAPIFromEnv } from '../../../lib/postgresql-api/index.js';

const db = createPostgreSQLAPIFromEnv();
await db.initialize();

// All settlement operations now use consistent schemas
const sessionsToSettle = await db.settlement.findSessionsToSettle();
const openSells = await db.settlement.hasOpenSells(sessionId);
```

## 📊 **Performance Features**

### Connection Pooling
- Configurable pool size (default: 20 connections)
- Automatic connection management
- Query performance monitoring

### Bulk Operations
- Chunked bulk inserts for optimal performance
- PostgreSQL-native conflict resolution
- Automatic retry logic

### Query Optimization
- Slow query logging (>5 seconds)
- Connection statistics
- Query execution metrics

## 🛡️ **Error Handling**

```javascript
try {
  const results = await db.bulk.sessions.save(sessions);
  
  // Check for partial failures
  const failed = results.results.filter(r => !r.success);
  if (failed.length > 0) {
    console.error('Some sessions failed:', failed);
  }
} catch (error) {
  console.error('Bulk operation failed:', error.message);
}
```

## 🔍 **Monitoring**

```javascript
// Get connection statistics
const stats = db.getStats();
console.log(`Active queries: ${stats.activeQueries}`);
console.log(`Total queries executed: ${stats.queriesExecuted}`);
console.log(`Pool connections: ${stats.totalConnections}`);
```

## 🧪 **Testing**

The API is designed to be easily testable:

```javascript
// Create test instance with test database
const testDb = new PostgreSQLAPI({
  connectionString: process.env.TEST_NEON_CONN
});

await testDb.initialize();
// Run tests...
await testDb.close();
```

## 🔮 **Future Enhancements**

1. **Fill Manager** - Complete the fill operations manager
2. **Query Builder** - Add fluent query building interface
3. **Schema Migrations** - Automated schema migration system
4. **Caching Layer** - Redis caching for frequently accessed data
5. **Metrics** - Enhanced performance and usage metrics
6. **Type Safety** - TypeScript definitions for better development experience

## 📋 **Schema Reference**

All schemas are defined in `/schemas/index.js` with complete PostgreSQL column definitions, including:

- **sessions** - 37 columns with trading session lifecycle
- **orders** - 26 columns with complete order tracking  
- **fills** - 15 columns with execution details

Each schema includes:
- Column types, nullability, and constraints
- Foreign key relationships
- Optimized indexes for query performance
- Field descriptions and usage notes

## 🎉 **Benefits**

1. **Consistency** - Same schema everywhere, no more field name mismatches
2. **Performance** - Optimized bulk operations and connection pooling
3. **Maintainability** - Single place to update database logic
4. **Reliability** - Centralized validation and error handling
5. **Developer Experience** - Clean, intuitive API similar to redis-backend-api 