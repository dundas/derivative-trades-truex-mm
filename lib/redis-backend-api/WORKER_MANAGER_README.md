# Worker Manager

Centralized management for market maker workers in Redis.

## Overview

The `WorkerManager` provides a unified interface for managing market maker workers, including:
- Worker registration and lifecycle management
- Consistent worker ID generation
- Online/offline status control
- Heartbeat tracking
- Worker discovery and health monitoring
- Graceful shutdown coordination

## Key Features

### No Zombie Keys
- Worker keys have automatic TTL (default 60 seconds)
- Heartbeats refresh the TTL
- Dead workers expire naturally
- No separate offline flag keys to clean up

### Single Source of Truth
- All worker information stored in one Redis key per worker
- Format: `worker:{workerId}`
- Atomic updates for status changes

### Status Management
- Workers can be online/offline without stopping
- Offline workers skip queue processing but continue heartbeating
- Status persists across restarts until changed

## Usage

### Basic Setup

```javascript
import { WorkerManager } from '../lib/redis-backend-api/worker-manager.js';

const workerManager = new WorkerManager({
  redis: redisClient,
  logger: logger,
  ttl: 60 // Worker key TTL in seconds
});
```

### Generate Worker IDs

```javascript
// Generate a worker ID with type and exchange
const workerId = WorkerManager.generateWorkerId({
  type: 'websocket',     // Worker type (default, websocket, fix, rest)
  exchange: 'kraken',    // Exchange name
  hostname: 'server-1'   // Optional hostname
});
// Returns: 'worker-websocket-kraken-server-1-a1b2c3d4'

// Without hostname
const workerId2 = WorkerManager.generateWorkerId({
  type: 'default',
  exchange: 'binance'
});
// Returns: 'worker-binance-e5f6g7h8' (type 'default' is omitted)
```

### Register a Worker

```javascript
// Register with default values (type: 'default', exchange: 'kraken')
const worker = await workerManager.register('worker-123');

// Register with specific type and exchange
const worker = await workerManager.register('worker-123', {
  type: 'websocket',     // 'default', 'websocket', 'fix', 'rest', etc.
  exchange: 'kraken',    // 'kraken', 'binance', 'coinbase', etc.
  capabilities: ['spot', 'futures']  // Optional capabilities
});
```

### Update Heartbeat

```javascript
// Simple heartbeat
await workerManager.heartbeat('worker-123');

// Heartbeat with updates
await workerManager.heartbeat('worker-123', {
  activeSession: 'session-456',
  status: 'processing'
});
```

### Control Online/Offline Status

```javascript
// Mark offline (won't process queue)
await workerManager.markOffline('worker-123');

// Mark online (resume processing)
await workerManager.markOnline('worker-123');

// Check status
const isOnline = await workerManager.isOnline('worker-123');
```

### Find Available Workers

```javascript
// Find any idle worker
const availableWorker = await workerManager.findAvailableWorker();

// Find workers by type
const websocketWorkers = await workerManager.findWorkersByType('websocket');

// Find workers by exchange
const krakenWorkers = await workerManager.findWorkersByExchange('kraken');

// Find matching worker with specific criteria
const matchingWorker = await workerManager.findMatchingWorker({
  type: 'websocket',
  exchange: 'kraken',
  capabilities: ['spot']  // Must have all specified capabilities
});

// List all workers
const workers = await workerManager.listWorkers();

// List only online workers
const onlineWorkers = await workerManager.listWorkers({
  includeOffline: false
});
```

### Monitor Health

```javascript
// Get detailed health info
const health = await workerManager.monitorHealth('worker-123');
/*
{
  healthy: true,
  workerId: 'worker-123',
  status: 'idle',
  isOnline: true,
  isAlive: true,
  heartbeatAge: 15,
  activeSession: null,
  uptime: 3600
}
*/

// Get overall stats (basic)
const stats = await workerManager.getStats();

// Get enhanced stats with breakdowns
const enhancedStats = await workerManager.getEnhancedStats();
/*
{
  total: 5,
  alive: 4,
  online: 3,
  offline: 2,
  idle: 2,
  processing: 1,
  expired: 1,
  globalOffline: false,
  byType: {
    websocket: { total: 3, online: 2, processing: 1, idle: 1 },
    fix: { total: 2, online: 1, processing: 0, idle: 1 }
  },
  byExchange: {
    kraken: { total: 4, online: 3, processing: 1, idle: 2 },
    binance: { total: 1, online: 0, processing: 0, idle: 0 }
  }
}
*/
```

### Emergency Controls

```javascript
// Mark all workers offline
await workerManager.markAllOffline();

// Mark all workers online
await workerManager.markAllOnline();

// Send shutdown signals
await workerManager.sendShutdownSignal('worker-123'); // Specific
await workerManager.sendShutdownSignal(); // Global

// Clear shutdown signals
await workerManager.clearShutdownSignals();
```

### Update Worker Capabilities

```javascript
// Update type, exchange, or capabilities
const updated = await workerManager.updateWorkerCapabilities('worker-123', {
  type: 'hybrid',
  exchange: 'binance',
  capabilities: ['spot', 'futures', 'options']
});
```

## Worker Data Structure

```javascript
{
  id: "worker-123",
  startedAt: 1234567890000,
  lastHeartbeat: 1234567890000,
  status: "idle", // idle, processing, offline, paused
  activeSession: null,
  isOnline: true,
  lastStatusChange: 1234567890000,
  // New fields
  type: "websocket",  // Worker type
  exchange: "kraken", // Exchange it handles
  capabilities: ["spot", "futures"], // Optional capabilities
  lastCapabilityUpdate: 1234567890000,
  // ... custom fields
}
```

## Status Values

- `idle`: Online and ready to process
- `processing`: Online and processing a session
- `offline`: Not processing queue (manual)
- `paused`: Not processing queue (temporary)

## Integration with UnifiedMarketMaker

The `unified-market-maker.js` now uses WorkerManager for all worker operations:

```javascript
// Registration with type and exchange from command-line args
await this.registerWorker(args);

// Inside registerWorker:
const workerType = args['worker-type'] || args.type || 'default';
const workerExchange = args['worker-exchange'] || args.exchange || 'kraken';
const workerCapabilities = args['worker-capabilities'] || args.capabilities || [];

await this.workerManager.register(this.workerId, {
  type: workerType,
  exchange: workerExchange,
  capabilities: capabilities
});

// Heartbeat loop
setInterval(async () => {
  const isOnline = await this.workerManager.isOnline(this.workerId);
  await this.workerManager.heartbeat(this.workerId, {
    status: !isOnline ? 'offline' : (this.activeSession ? 'processing' : 'idle'),
    activeSession: this.activeSession
  });
}, 30000);

// Check before processing
const isOnline = await this.workerManager.isOnline(this.workerId);
if (!isOnline) {
  // Skip queue processing
}
```

### Command-Line Configuration

Workers can be configured via command-line arguments:

```bash
# Set worker type (default: 'default')
node unified-market-maker.js --worker-type=websocket

# Set exchange (default: 'kraken')
node unified-market-maker.js --worker-exchange=binance

# Set capabilities (comma-separated)
node unified-market-maker.js --worker-capabilities=spot,futures,options

# Combined example
node unified-market-maker.js \
  --worker-type=websocket \
  --worker-exchange=kraken \
  --worker-capabilities=spot,futures
```

## Testing

Run the test script to see all features:

```bash
node scripts/test-worker-manager.js
```

## Benefits

1. **Centralized Management**: All worker operations in one place
2. **Automatic Cleanup**: TTL-based expiration prevents stale data
3. **Atomic Operations**: Status changes are atomic
4. **Rich Monitoring**: Detailed health and statistics
5. **Flexible Control**: Online/offline without stopping workers
6. **No Zombie Keys**: No separate flag keys to manage
7. **Type & Exchange Support**: Workers can be categorized and matched to sessions
8. **Capability-based Routing**: Match workers to sessions based on capabilities
9. **Efficient Indexes**: Fast lookup by type or exchange

## Use Cases

### Multi-Exchange Support
```javascript
// Register exchange-specific workers
await workerManager.register('kraken-worker-1', { exchange: 'kraken' });
await workerManager.register('binance-worker-1', { exchange: 'binance' });

// Find worker for specific exchange
const worker = await workerManager.findMatchingWorker({ exchange: 'kraken' });
```

### Protocol-Specific Workers
```javascript
// Register protocol-specific workers
await workerManager.register('websocket-worker-1', { type: 'websocket' });
await workerManager.register('fix-worker-1', { type: 'fix' });

// Route sessions to appropriate worker type
const worker = await workerManager.findMatchingWorker({ 
  type: 'websocket',
  exchange: 'kraken' 
});
```

### Capability-Based Routing
```javascript
// Register workers with capabilities
await workerManager.register('spot-worker-1', { 
  capabilities: ['spot'] 
});
await workerManager.register('advanced-worker-1', { 
  capabilities: ['spot', 'futures', 'options'] 
});

// Find worker with specific capabilities
const worker = await workerManager.findMatchingWorker({
  capabilities: ['futures']  // Will match advanced-worker-1
});
```