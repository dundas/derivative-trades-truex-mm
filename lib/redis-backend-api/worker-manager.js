/**
 * Worker Manager
 * 
 * Centralized management for market maker workers in Redis.
 * Handles worker registration, status tracking, heartbeats, and lifecycle management.
 * 
 * Key Features:
 * - Worker registration with automatic expiry
 * - Online/offline status management
 * - Heartbeat tracking
 * - Worker discovery and monitoring
 * - Graceful shutdown coordination
 */

import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export class WorkerManager {
  constructor({ redis, logger, ttl = 120 }) {
    this.redis = redis;
    this.logger = logger || logger;
    this.ttl = ttl; // Worker key TTL in seconds (default 2 minutes)
    // Use new namespace to avoid conflicts with mysterious worker data
    this.prefix = 'worker-registry:';
  }

  /**
   * Generate a consistent worker ID
   * @param {Object} options - Options for ID generation
   * @param {string} options.type - Worker type (default, websocket, fix, rest)
   * @param {string} options.exchange - Exchange name (kraken, binance, etc)
   * @param {string} options.hostname - Optional hostname
   * @returns {string} Generated worker ID
   */
  static generateWorkerId(options = {}) {
    const { type = 'default', exchange = 'kraken', hostname } = options;
    const uuid = uuidv4().split('-')[0]; // Use first segment of UUID for brevity
    
    // Build ID parts
    const parts = [];
    
    // Add type if not default
    if (type !== 'default') {
      parts.push(type);
    }
    
    // Add exchange
    parts.push(exchange);
    
    // Add hostname only if it's meaningful and not a container name
    if (hostname && 
        !hostname.match(/^[a-f0-9]{12}$/) && // Not a container ID
        !hostname.startsWith('worker-') && // Not already a worker name
        hostname !== 'localhost') { // Not localhost
      parts.push(hostname);
    }
    
    // Add short UUID
    parts.push(uuid);
    
    // Join with hyphens
    return parts.join('-');
  }

  /**
   * Register a new worker
   */
  async register(workerId, initialData = {}, clientInfo = {}) {
    const workerInfo = {
      id: workerId,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      status: 'idle',
      activeSession: null,
      isOnline: true,
      isEnabled: true, // Worker is enabled to process sessions by default
      // Worker capabilities
      type: initialData.type || 'default',
      exchange: initialData.exchange || 'kraken',
      capabilities: initialData.capabilities || [],
      // Client information
      clientInfo: {
        ip: clientInfo.ip || null,
        userAgent: clientInfo.userAgent || null,
        hostname: clientInfo.hostname || null,
        registeredFrom: clientInfo.registeredFrom || 'unknown',
        ...clientInfo
      },
      // Allow other custom data
      ...initialData
    };

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(workerInfo));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    // Also register in type and exchange indexes for efficient lookup
    await this.addToIndex('type', workerInfo.type, workerId);
    await this.addToIndex('exchange', workerInfo.exchange, workerId);

    this.logger.info(`Worker registered: ${workerId}`, { 
      status: workerInfo.status,
      type: workerInfo.type,
      exchange: workerInfo.exchange,
      clientInfo: workerInfo.clientInfo
    });
    return workerInfo;
  }

  /**
   * Update worker heartbeat and status
   */
  async heartbeat(workerId, updates = {}, clientInfo = {}) {
    const workerData = await this.get(workerId);
    if (!workerData) {
      throw new Error(`Worker ${workerId} not found`);
    }

    const updatedWorker = {
      ...workerData,
      lastHeartbeat: Date.now(),
      ...updates
    };

    // Update client info if provided
    if (clientInfo && Object.keys(clientInfo).length > 0) {
      updatedWorker.clientInfo = {
        ...updatedWorker.clientInfo,
        ...clientInfo,
        lastHeartbeatFrom: clientInfo.ip || updatedWorker.clientInfo?.lastHeartbeatFrom
      };
    }

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(updatedWorker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    return updatedWorker;
  }

  /**
   * Get worker data
   */
  async get(workerId) {
    const data = await this.redis.get(`${this.prefix}${workerId}`);
    if (!data) return null;

    try {
      return JSON.parse(data);
    } catch (error) {
      this.logger.error(`Failed to parse worker data for ${workerId}:`, error);
      return null;
    }
  }

  /**
   * Update worker status
   */
  async updateStatus(workerId, status) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    worker.status = status;
    worker.lastStatusChange = Date.now();

    // Update isOnline based on status
    if (status === 'offline' || status === 'paused') {
      worker.isOnline = false;
    } else if (status === 'idle' || status === 'processing') {
      worker.isOnline = true;
    }

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(worker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    this.logger.info(`Worker ${workerId} status updated to: ${status}`);
    return worker;
  }

  /**
   * Mark worker as offline
   */
  async markOffline(workerId) {
    return this.updateStatus(workerId, 'offline');
  }

  /**
   * Mark worker as online
   */
  async markOnline(workerId) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    // Set appropriate status based on active session
    const status = worker.activeSession ? 'processing' : 'idle';
    return this.updateStatus(workerId, status);
  }

  /**
   * Disable worker from processing sessions (admin control)
   */
  async disable(workerId) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    worker.isEnabled = false;
    worker.lastHeartbeat = Date.now();

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(worker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    this.logger.info(`Worker ${workerId} disabled from processing sessions`);
    return worker;
  }

  /**
   * Enable worker to process sessions (admin control)
   */
  async enable(workerId) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    worker.isEnabled = true;
    worker.lastHeartbeat = Date.now();

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(worker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    this.logger.info(`Worker ${workerId} enabled to process sessions`);
    return worker;
  }

  /**
   * Set active session for worker
   */
  async setActiveSession(workerId, sessionId) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    worker.activeSession = sessionId;
    worker.status = sessionId ? 'processing' : 'idle';
    worker.lastActivityChange = Date.now();

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(worker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    return worker;
  }

  /**
   * Check if worker is online (heartbeat status - is the process alive?)
   */
  async isOnline(workerId) {
    const worker = await this.get(workerId);
    if (!worker) return false;

    // Check heartbeat freshness
    if (worker.lastHeartbeat) {
      const heartbeatAge = Date.now() - worker.lastHeartbeat;
      const isAlive = heartbeatAge < (this.ttl * 1000);
      if (!isAlive) {
        return false;
      }
    }

    return worker.isOnline !== false;
  }

  /**
   * Check if worker is enabled to process sessions (admin control)
   */
  async isEnabled(workerId) {
    const worker = await this.get(workerId);
    if (!worker) return false;

    // Check various offline indicators
    if (worker.status === 'offline' || worker.status === 'paused') {
      return false;
    }

    if (worker.isEnabled === false) {
      return false;
    }

    // Check for global offline flag
    const globalOffline = await this.redis.get('workers:offline');
    if (globalOffline === '1' || globalOffline === 'true') {
      return false;
    }

    return true;
  }

  /**
   * Check if worker can process sessions (combines both checks)
   */
  async canProcessSessions(workerId) {
    const isOnline = await this.isOnline(workerId);
    const isEnabled = await this.isEnabled(workerId);
    return isOnline && isEnabled;
  }

  /**
   * List all workers
   */
  async listWorkers(options = {}) {
    const { includeOffline = true, includeExpired = false } = options;
    const workerKeys = await this.redis.keys(`${this.prefix}*`);
    const workers = [];

    for (const key of workerKeys) {
      // Skip sub-keys
      if (key.split(':').length > 2) continue;

      const workerData = await this.redis.get(key);
      if (!workerData) continue;

      try {
        const worker = JSON.parse(workerData);
        const isAlive = (Date.now() - worker.lastHeartbeat) < (this.ttl * 1000);

        // Skip based on filters
        if (!includeOffline && (worker.status === 'offline' || !worker.isOnline)) {
          continue;
        }

        if (!includeExpired && !isAlive) {
          continue;
        }

        workers.push({
          ...worker,
          isAlive,
          secondsSinceHeartbeat: Math.floor((Date.now() - worker.lastHeartbeat) / 1000)
        });
      } catch (error) {
        this.logger.error(`Failed to parse worker data for ${key}:`, error);
      }
    }

    return workers;
  }

  /**
   * Find available worker for session
   */
  async findAvailableWorker() {
    const workers = await this.listWorkers({
      includeOffline: false,
      includeExpired: false
    });

    // Find idle workers that are online
    const availableWorkers = workers.filter(w => 
      w.status === 'idle' && 
      w.isOnline === true &&
      w.isAlive === true &&
      !w.activeSession
    );

    if (availableWorkers.length === 0) {
      return null;
    }

    // Return the worker that has been idle the longest
    return availableWorkers.sort((a, b) => 
      (a.lastActivityChange || a.startedAt) - (b.lastActivityChange || b.startedAt)
    )[0];
  }

  /**
   * Remove worker (unregister)
   */
  async remove(workerId) {
    // Get worker data before removing to clean up indexes
    const workerData = await this.get(workerId);
    
    const existed = await this.redis.exists(`${this.prefix}${workerId}`);
    await this.redis.del(`${this.prefix}${workerId}`);
    
    // Clean up indexes
    if (workerData) {
      await this.removeFromIndex('type', workerData.type, workerId);
      await this.removeFromIndex('exchange', workerData.exchange, workerId);
    }
    
    if (existed) {
      this.logger.info(`Worker ${workerId} removed`);
    }
    
    return existed;
  }

  /**
   * Set global offline flag
   */
  async setGlobalOffline(offline = true, ttl = 86400) {
    if (offline) {
      await this.redis.set('workers:offline', '1', 'EX', ttl);
      this.logger.info('Global offline flag set', { ttl });
    } else {
      await this.redis.del('workers:offline');
      this.logger.info('Global offline flag removed');
    }
  }

  /**
   * Check global offline status
   */
  async isGlobalOffline() {
    const flag = await this.redis.get('workers:offline');
    return flag === '1' || flag === 'true';
  }

  /**
   * Mark all workers offline
   */
  async markAllOffline() {
    const workers = await this.listWorkers();
    let count = 0;

    for (const worker of workers) {
      try {
        await this.markOffline(worker.id);
        count++;
      } catch (error) {
        this.logger.error(`Failed to mark worker ${worker.id} offline:`, error);
      }
    }

    // Also set global flag
    await this.setGlobalOffline(true);

    this.logger.info(`Marked ${count} workers as offline`);
    return count;
  }

  /**
   * Mark all workers online
   */
  async markAllOnline() {
    // Remove global flag first
    await this.setGlobalOffline(false);

    const workers = await this.listWorkers();
    let count = 0;

    for (const worker of workers) {
      if (worker.status === 'offline' || !worker.isOnline) {
        try {
          await this.markOnline(worker.id);
          count++;
        } catch (error) {
          this.logger.error(`Failed to mark worker ${worker.id} online:`, error);
        }
      }
    }

    this.logger.info(`Marked ${count} workers as online`);
    return count;
  }

  /**
   * Get worker statistics
   */
  async getStats() {
    const workers = await this.listWorkers({ includeExpired: true });
    
    const stats = {
      total: workers.length,
      alive: workers.filter(w => w.isAlive).length,
      online: workers.filter(w => w.isOnline && w.status !== 'offline').length,
      offline: workers.filter(w => !w.isOnline || w.status === 'offline').length,
      idle: workers.filter(w => w.status === 'idle' && w.isOnline).length,
      processing: workers.filter(w => w.status === 'processing').length,
      expired: workers.filter(w => !w.isAlive).length,
      globalOffline: await this.isGlobalOffline()
    };

    return stats;
  }

  /**
   * Clean up expired workers
   */
  async cleanup() {
    const workers = await this.listWorkers({ includeExpired: true });
    let cleaned = 0;

    for (const worker of workers) {
      if (!worker.isAlive) {
        await this.remove(worker.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} expired workers`);
    }

    return cleaned;
  }

  /**
   * Send shutdown signal to worker
   */
  async sendShutdownSignal(workerId = null) {
    if (workerId) {
      // Worker-specific shutdown
      await this.redis.set(`shutdown:worker:${workerId}`, '1', 'EX', 3600);
      this.logger.info(`Shutdown signal sent to worker: ${workerId}`);
    } else {
      // Global shutdown
      await this.redis.set('shutdown:all-workers', '1', 'EX', 3600);
      this.logger.info('Global shutdown signal sent');
    }
  }

  /**
   * Check for shutdown signals (global or worker-specific)
   * @param {string} workerId - Worker ID to check for specific shutdown signal
   * @returns {Promise<{shouldShutdown: boolean, isGlobal: boolean, workerId?: string}>}
   */
  async checkShutdownSignals(workerId = null) {
    try {
      // Check for global shutdown signal
      const globalShutdown = await this.redis.get('shutdown:all-workers');
      if (globalShutdown) {
        return { shouldShutdown: true, isGlobal: true };
      }

      // Check for worker-specific shutdown signal if workerId provided
      if (workerId) {
        const workerShutdown = await this.redis.get(`shutdown:worker:${workerId}`);
        if (workerShutdown) {
          // Clean up the signal
          await this.redis.del(`shutdown:worker:${workerId}`);
          return { shouldShutdown: true, isGlobal: false, workerId };
        }
      }

      return { shouldShutdown: false, isGlobal: false };
    } catch (error) {
      this.logger.error(`Error checking shutdown signals for worker ${workerId}:`, error);
      return { shouldShutdown: false, isGlobal: false };
    }
  }

  /**
   * Clear shutdown signals
   */
  async clearShutdownSignals() {
    const keys = await this.redis.keys('shutdown:*');
    if (keys.length > 0) {
      await this.redis.del(...keys);
      this.logger.info(`Cleared ${keys.length} shutdown signals`);
    }
    return keys.length;
  }

  /**
   * Check if a worker is active (simple boolean check)
   * This provides a clean API for other services to check worker status
   */
  async isActive(workerId) {
    const worker = await this.get(workerId);
    if (!worker) {
      return false;
    }

    const now = Date.now();
    const heartbeatAge = now - worker.lastHeartbeat;
    const isAlive = heartbeatAge < (this.ttl * 1000);

    // Worker is active if it's alive, online, and not explicitly offline
    return isAlive && worker.isOnline && worker.status !== 'offline';
  }

  /**
   * Monitor worker health
   */
  async monitorHealth(workerId) {
    const worker = await this.get(workerId);
    if (!worker) {
      return { healthy: false, reason: 'Worker not found' };
    }

    const now = Date.now();
    const heartbeatAge = now - worker.lastHeartbeat;
    const isAlive = heartbeatAge < (this.ttl * 1000);

    const health = {
      healthy: isAlive && worker.isOnline && worker.status !== 'offline',
      workerId: worker.id,
      status: worker.status,
      isOnline: worker.isOnline,
      isAlive,
      heartbeatAge: Math.floor(heartbeatAge / 1000),
      activeSession: worker.activeSession,
      uptime: Math.floor((now - worker.startedAt) / 1000),
      type: worker.type,
      exchange: worker.exchange
    };

    if (!health.healthy) {
      if (!isAlive) health.reason = 'No recent heartbeat';
      else if (!worker.isOnline) health.reason = 'Worker is offline';
      else if (worker.status === 'offline') health.reason = 'Worker status is offline';
    }

    return health;
  }

  /**
   * Find workers by type
   */
  async findWorkersByType(type, options = {}) {
    const workerIds = await this.getFromIndex('type', type);
    const workers = [];

    for (const workerId of workerIds) {
      const worker = await this.get(workerId);
      if (worker) {
        const isAlive = (Date.now() - worker.lastHeartbeat) < (this.ttl * 1000);
        
        // Apply filters
        if (!options.includeOffline && (worker.status === 'offline' || !worker.isOnline)) {
          continue;
        }
        if (!options.includeExpired && !isAlive) {
          continue;
        }

        workers.push({
          ...worker,
          isAlive,
          secondsSinceHeartbeat: Math.floor((Date.now() - worker.lastHeartbeat) / 1000)
        });
      }
    }

    return workers;
  }

  /**
   * Find workers by exchange
   */
  async findWorkersByExchange(exchange, options = {}) {
    const workerIds = await this.getFromIndex('exchange', exchange);
    const workers = [];

    for (const workerId of workerIds) {
      const worker = await this.get(workerId);
      if (worker) {
        const isAlive = (Date.now() - worker.lastHeartbeat) < (this.ttl * 1000);
        
        // Apply filters
        if (!options.includeOffline && (worker.status === 'offline' || !worker.isOnline)) {
          continue;
        }
        if (!options.includeExpired && !isAlive) {
          continue;
        }

        workers.push({
          ...worker,
          isAlive,
          secondsSinceHeartbeat: Math.floor((Date.now() - worker.lastHeartbeat) / 1000)
        });
      }
    }

    return workers;
  }

  /**
   * Find available worker matching criteria
   */
  async findMatchingWorker(criteria = {}) {
    const { type, exchange, capabilities = [] } = criteria;
    
    let workers = await this.listWorkers({
      includeOffline: false,
      includeExpired: false
    });

    // Filter by type if specified
    if (type) {
      workers = workers.filter(w => w.type === type);
    }

    // Filter by exchange if specified
    if (exchange) {
      workers = workers.filter(w => w.exchange === exchange);
    }

    // Filter by capabilities if specified
    if (capabilities.length > 0) {
      workers = workers.filter(w => {
        const workerCaps = w.capabilities || [];
        return capabilities.every(cap => workerCaps.includes(cap));
      });
    }

    // Find idle workers
    const availableWorkers = workers.filter(w => 
      w.status === 'idle' && 
      w.isOnline === true &&
      w.isAlive === true &&
      !w.activeSession
    );

    if (availableWorkers.length === 0) {
      return null;
    }

    // Return the worker that has been idle the longest
    return availableWorkers.sort((a, b) => 
      (a.lastActivityChange || a.startedAt) - (b.lastActivityChange || b.startedAt)
    )[0];
  }

  /**
   * Update worker type or exchange
   */
  async updateWorkerCapabilities(workerId, updates = {}) {
    const worker = await this.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    // Update indexes if type or exchange changed
    if (updates.type && updates.type !== worker.type) {
      await this.removeFromIndex('type', worker.type, workerId);
      await this.addToIndex('type', updates.type, workerId);
      worker.type = updates.type;
    }

    if (updates.exchange && updates.exchange !== worker.exchange) {
      await this.removeFromIndex('exchange', worker.exchange, workerId);
      await this.addToIndex('exchange', updates.exchange, workerId);
      worker.exchange = updates.exchange;
    }

    if (updates.capabilities) {
      worker.capabilities = updates.capabilities;
    }

    worker.lastCapabilityUpdate = Date.now();

    await this.redis.set(`${this.prefix}${workerId}`, JSON.stringify(worker));
    await this.redis.expire(`${this.prefix}${workerId}`, this.ttl);

    this.logger.info(`Worker ${workerId} capabilities updated`, updates);
    return worker;
  }

  /**
   * Add worker to index
   */
  async addToIndex(indexType, value, workerId) {
    const key = `${this.prefix}index:${indexType}:${value}`;
    await this.redis.sadd(key, workerId);
    await this.redis.expire(key, 3600); // 1 hour TTL for indexes
  }

  /**
   * Remove worker from index
   */
  async removeFromIndex(indexType, value, workerId) {
    const key = `${this.prefix}index:${indexType}:${value}`;
    await this.redis.srem(key, workerId);
  }

  /**
   * Get workers from index
   */
  async getFromIndex(indexType, value) {
    const key = `${this.prefix}index:${indexType}:${value}`;
    return await this.redis.smembers(key) || [];
  }

  /**
   * Get enhanced statistics including type and exchange breakdown
   */
  async getEnhancedStats() {
    const workers = await this.listWorkers({ includeExpired: true });
    
    const stats = {
      total: workers.length,
      alive: workers.filter(w => w.isAlive).length,
      online: workers.filter(w => w.isOnline && w.status !== 'offline').length,
      offline: workers.filter(w => !w.isOnline || w.status === 'offline').length,
      idle: workers.filter(w => w.status === 'idle' && w.isOnline).length,
      processing: workers.filter(w => w.status === 'processing').length,
      expired: workers.filter(w => !w.isAlive).length,
      globalOffline: await this.isGlobalOffline(),
      // Breakdown by type
      byType: {},
      // Breakdown by exchange
      byExchange: {}
    };

    // Calculate type breakdown
    for (const worker of workers) {
      const type = worker.type || 'unknown';
      if (!stats.byType[type]) {
        stats.byType[type] = {
          total: 0,
          online: 0,
          processing: 0,
          idle: 0
        };
      }
      stats.byType[type].total++;
      if (worker.isOnline && worker.status !== 'offline') {
        stats.byType[type].online++;
        if (worker.status === 'processing') {
          stats.byType[type].processing++;
        } else if (worker.status === 'idle') {
          stats.byType[type].idle++;
        }
      }
    }

    // Calculate exchange breakdown
    for (const worker of workers) {
      const exchange = worker.exchange || 'unknown';
      if (!stats.byExchange[exchange]) {
        stats.byExchange[exchange] = {
          total: 0,
          online: 0,
          processing: 0,
          idle: 0
        };
      }
      stats.byExchange[exchange].total++;
      if (worker.isOnline && worker.status !== 'offline') {
        stats.byExchange[exchange].online++;
        if (worker.status === 'processing') {
          stats.byExchange[exchange].processing++;
        } else if (worker.status === 'idle') {
          stats.byExchange[exchange].idle++;
        }
      }
    }

    return stats;
  }
}