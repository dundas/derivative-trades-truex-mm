# Queue Manager Documentation

The QueueManager provides centralized queue management for different trading services, supporting multiple queue types including spot, futures, options, and more.

## Overview

The QueueManager handles:
- Multiple queue types (spot, futures, options, forex, crypto)
- Priority queues for urgent sessions
- Dead letter queue (DLQ) for failed sessions
- Processing state tracking
- Queue statistics and monitoring
- Session migration between queues

## Queue Types

```javascript
QueueManager.QUEUE_TYPES = {
  SPOT: 'session:queue',           // Default/legacy queue for spot trading
  FUTURES: 'futures:session:queue', // Futures trading queue
  OPTIONS: 'options:session:queue', // Options trading queue
  FOREX: 'forex:session:queue',     // Forex trading queue
  CRYPTO: 'crypto:session:queue',   // Crypto-specific queue
  TEST: 'test:session:queue'        // Test/development queue
}
```

## Basic Usage

### Creating a Queue Manager

```javascript
import { createQueueManager } from '@src/lib/redis-backend-api';

// Create with default configuration
const queueManager = createQueueManager(redis, logger);

// Or create with custom configuration
const queueManager = new QueueManager({
  redis,
  logger,
  defaultQueue: 'FUTURES',
  dlqRetries: 3,
  processingTimeout: 300000 // 5 minutes
});
```

### Adding Sessions to Queues

```javascript
// Add to default (SPOT) queue
await queueManager.addToQueue('session-123');

// Add to futures queue
await queueManager.addToQueue('futures-session-456', {
  queueType: 'FUTURES'
});

// Add with priority
await queueManager.addToQueue('urgent-session-789', {
  queueType: 'SPOT',
  priority: true
});

// Add with metadata
await queueManager.addToQueue('session-with-meta', {
  queueType: 'FUTURES',
  metadata: {
    symbol: 'PF_XRPUSD',
    strategy: 'high-leverage',
    budget: 50000
  }
});
```

### Popping Sessions from Queues

```javascript
// Pop from default queue
const sessionId = await queueManager.popFromQueue();

// Pop from futures queue
const futuresSession = await queueManager.popFromQueue({
  queueType: 'FUTURES'
});

// Use blocking pop with timeout
const session = await queueManager.popFromQueue({
  queueType: 'SPOT',
  blocking: true,
  timeout: 10 // Wait up to 10 seconds
});
```

### Queue Statistics

```javascript
// Get length of specific queue
const spotQueueLength = await queueManager.getQueueLength('SPOT');
const futuresQueueLength = await queueManager.getQueueLength('FUTURES');

// Get all queue statistics
const stats = await queueManager.getAllQueueStats();
console.log(stats);
// Output:
// {
//   SPOT: { regular: 5, priority: 2, dlq: 0, processing: 1, total: 7 },
//   FUTURES: { regular: 3, priority: 0, dlq: 1, processing: 2, total: 3 },
//   ...
// }
```

## Advanced Features

### Dead Letter Queue (DLQ) Handling

```javascript
// Move failed session to DLQ
try {
  // Process session...
} catch (error) {
  await queueManager.moveToDeadLetterQueue(sessionId, 'FUTURES', error);
}
```

### Processing State Management

```javascript
// Sessions are automatically moved to processing state when popped
// Mark as completed when done
await queueManager.markCompleted(sessionId, 'FUTURES');

// Recover stale sessions that have been processing too long
const recovered = await queueManager.recoverStaleProcessing('FUTURES');
console.log(`Recovered ${recovered} stale sessions`);
```

### Queue Migration

```javascript
// Migrate all sessions from test to production
const migrated = await queueManager.migrateQueue('TEST', 'SPOT');

// Migrate specific number of sessions
const migratedCount = await queueManager.migrateQueue('SPOT', 'FUTURES', 10);
```

### Queue Maintenance

```javascript
// Clear a queue (use with caution!)
const clearStats = await queueManager.clearQueue('TEST', true); // Include DLQ

// Get processing sessions that might be stuck
const processingStats = await queueManager.getAllQueueStats();
Object.entries(processingStats).forEach(([queue, stats]) => {
  if (stats.processing > 0) {
    console.log(`${queue} has ${stats.processing} sessions in processing`);
  }
});
```

## Integration with Session Creation

The QueueManager is integrated with the internal session creator:

```javascript
import { createSessionInternal } from '@src/lib/redis-backend-api';

// Create futures session and add to futures queue
const result = await createSessionInternal({
  redis,
  sessionData: {
    exchange: 'kraken-futures',
    symbol: 'PF_XRPUSD',
    budget: 50000,
    // ... other session data
  },
  addToQueue: true,
  queueType: 'FUTURES', // Explicitly set queue type
  priority: false
});

// Auto-detection: Sessions with futures exchange or PF_ symbols
// are automatically routed to FUTURES queue
const futuresSession = await createSessionInternal({
  redis,
  sessionData: {
    symbol: 'PF_ETHUSD', // Auto-detected as futures
    // ...
  }
});
```

## Worker Integration

Workers can use the QueueManager to process specific queue types:

```javascript
// Worker processing futures queue
while (isRunning) {
  const sessionId = await queueManager.popFromQueue({
    queueType: 'FUTURES',
    blocking: true,
    timeout: 5
  });
  
  if (sessionId) {
    try {
      await processFuturesSession(sessionId);
      await queueManager.markCompleted(sessionId, 'FUTURES');
    } catch (error) {
      await queueManager.moveToDeadLetterQueue(sessionId, 'FUTURES', error);
    }
  }
}
```

## Error Handling

```javascript
// Comprehensive error handling example
async function processSessionWithRetry(sessionId, queueType) {
  const maxRetries = 3;
  let attempts = 0;
  
  while (attempts < maxRetries) {
    try {
      await processSession(sessionId);
      await queueManager.markCompleted(sessionId, queueType);
      return; // Success
    } catch (error) {
      attempts++;
      logger.error(`Attempt ${attempts} failed for ${sessionId}:`, error);
      
      if (attempts >= maxRetries) {
        // Move to DLQ after max retries
        await queueManager.moveToDeadLetterQueue(sessionId, queueType, error);
      } else {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }
  }
}
```

## Queue Naming Convention

When adding new queue types, follow this convention:
- Format: `{type}:session:queue`
- Examples: `futures:session:queue`, `options:session:queue`
- Special queues: `:priority`, `:dlq`, `:processing` suffixes

## Best Practices

1. **Queue Type Selection**: Choose the appropriate queue type based on the trading instrument
2. **Priority Usage**: Use priority queues sparingly for truly urgent sessions
3. **Error Handling**: Always handle errors and move failed sessions to DLQ
4. **Monitoring**: Regularly check queue statistics and recover stale sessions
5. **Cleanup**: Implement regular cleanup of old DLQ entries
6. **Metadata**: Store relevant metadata for debugging and monitoring

## Future Enhancements

Planned features:
- Queue rate limiting
- Automatic retry with exponential backoff
- Queue health metrics export
- Cross-queue dependencies
- Session batching support