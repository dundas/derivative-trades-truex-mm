/**
 * Logger Examples
 * 
 * This file provides examples of how to use the generalized Winston logger
 * with R2 storage and silent mode.
 */

import { WinstonLogger, createLogger } from './winston.js';

/**
 * Example 1: Basic Usage
 * 
 * Create a simple logger that logs to console
 */
function basicLoggerExample() {
  // Create a logger
  const logger = createLogger({
    component: 'example-service'
  });

  // Log messages at different levels
  logger.debug('Debug message');
  logger.info('Info message');
  logger.warn('Warning message');
  logger.error('Error message');

  // Log with additional metadata
  logger.info('User logged in', { userId: '123', timestamp: Date.now() });

  // Log an error with details
  try {
    throw new Error('Something went wrong');
  } catch (error) {
    logger.error('Error during operation', error, { context: 'example' });
  }
}

/**
 * Example 2: Silent Mode
 * 
 * Create a logger in silent mode that only stores logs in R2
 * without displaying them in the console
 */
function silentModeExample() {
  // Create a logger in silent mode
  const logger = createLogger({
    component: 'background-job',
    silent: true,
    useR2: true
  });

  // These logs won't appear in console but will be stored in R2 if configured
  logger.info('Background job started');
  logger.info('Processing data', { items: 100 });
  logger.info('Background job completed');

  // Error logs will still appear in console as a fallback in silent mode
  logger.error('Critical error in background job');

  // You can dynamically toggle silent mode
  logger.setSilent(false);
  logger.info('This will now appear in console');
  logger.setSilent(true);
  logger.info('This will be silent again');
}

/**
 * Example 3: Category Logging
 * 
 * Use category-based logging for grouping related logs
 */
function categoryLoggingExample() {
  const logger = createLogger({
    component: 'api-server'
  });

  // Log with different categories
  logger.logCategory('DATABASE', 'info', 'Connected to database');
  logger.logCategory('API', 'info', 'Request received', { endpoint: '/users', method: 'GET' });
  logger.logCategory('AUTH', 'warn', 'Failed login attempt', { username: 'user123' });
}

/**
 * Example 4: Child Loggers
 * 
 * Create child loggers for specific components
 */
function childLoggerExample() {
  // Create a parent logger
  const appLogger = createLogger({
    component: 'app'
  });

  // Create child loggers that inherit settings
  const authLogger = appLogger.createChild('auth');
  const dbLogger = appLogger.createChild('database');
  const apiLogger = appLogger.createChild('api');

  // Use the child loggers
  authLogger.info('User authenticated');
  dbLogger.info('Query executed', { table: 'users', operation: 'SELECT' });
  apiLogger.info('Request processed');
}

/**
 * Example 5: R2 Storage Configuration
 * 
 * Configure R2 storage explicitly
 */
function r2ConfigurationExample() {
  const logger = createLogger({
    component: 'data-processor',
    useR2: true,
    r2Config: {
      accountId: 'your-cloudflare-account-id', // This will construct the endpoint
      // Alternatively, you can specify the endpoint directly:
      // endpoint: 'https://your-account.r2.cloudflarestorage.com',
      accessKeyId: 'your-access-key',
      secretAccessKey: 'your-secret-key',
      bucket: 'your-logs-bucket'
    },
    batchSize: 50 // Batch 50 logs before uploading to R2
  });

  // Logs will be stored in R2 with the configured settings
  logger.info('Data processing started');
}

/**
 * Example 6: Migration-Specific Usage with Silent Mode Toggle
 * 
 * Shows how to use the logger for migration scenarios with silent mode toggle
 */
function migrationExample() {
  // Create a logger for migration
  const migrationLogger = createLogger({
    component: 'data-migration',
    runId: `migration-${Date.now()}`,
    silent: process.env.LOG_SILENT === 'true' // Toggle based on environment variable
  });

  // Log migration progress
  migrationLogger.info('Migration started', { totalItems: 1000 });

  // Simulate migration loop
  for (let i = 0; i < 5; i++) {
    migrationLogger.debug(`Processing batch ${i}`, { batchSize: 100 });
    
    // If we need more detailed logs during a specific operation,
    // we can temporarily disable silent mode
    if (i === 2) {
      migrationLogger.setSilent(false);
      migrationLogger.info('Processing critical data in batch 2');
      migrationLogger.setSilent(process.env.LOG_SILENT === 'true');
    }
  }

  // Log completion
  migrationLogger.info('Migration completed');

  // Remember to close the logger to flush R2 logs
  migrationLogger.close();
}

/**
 * Example 7: Custom Storage Path Organization
 * 
 * This example shows how to use custom storage path organization
 * for session-specific and general migration logs
 */
function customStoragePathExample() {
  // Example 1: Session-specific migration logger
  const sessionLogger = createLogger({
    component: 'session-migration',
    sessionId: 'abc123', // This will organize logs in BUCKET/sessions/abc123/migrations/
    useR2: true,
    r2Config: {
      accountId: 'your-cloudflare-account-id',
      accessKeyId: 'your-access-key',
      secretAccessKey: 'your-secret-key',
      bucket: 'your-logs-bucket'
    }
  });
  
  sessionLogger.info('Migrating session data', { stage: 'started' });
  // ...logs will be stored in: your-logs-bucket/sessions/abc123/migrations/...
  
  // Example 2: General migration logger
  const migrationLogger = createLogger({
    component: 'general-migration',
    migrationId: 'daily-migration', // This will organize logs in BUCKET/migrations/daily-migration-timestamp/
    useR2: true,
    r2Config: {
      accountId: 'your-cloudflare-account-id',
      accessKeyId: 'your-access-key',
      secretAccessKey: 'your-secret-key',
      bucket: 'your-logs-bucket'
    }
  });
  
  migrationLogger.info('Running daily migration');
  // ...logs will be stored in: your-logs-bucket/migrations/daily-migration-timestamp/...
  
  // Example 3: Completely custom path
  const customLogger = createLogger({
    component: 'custom-path-logger',
    customBucketPath: 'custom/path/to/my/logs/\${timestamp}.json',
    useR2: true,
    r2Config: {
      accountId: 'your-cloudflare-account-id',
      accessKeyId: 'your-access-key',
      secretAccessKey: 'your-secret-key',
      bucket: 'your-logs-bucket'
    }
  });
  
  customLogger.info('Using custom path');
  // ...logs will be stored in: your-logs-bucket/custom/path/to/my/logs/...
}

/**
 * Example 8: Explicitly Overriding Silent Mode
 * 
 * This example shows how to explicitly set silent=false to force console output
 * even if the environment variables would normally enable silent mode
 */
function silentModeOverrideExample() {
  // First, let's set up a logger that would normally be silent based on env vars
  process.env.LOG_SILENT = 'true';
  
  // Create a silent logger (following environment settings)
  const defaultLogger = createLogger({
    component: 'silent-by-default'
  });
  
  defaultLogger.info('This message will NOT appear in console (silent by env var)');
  
  // Create a logger that explicitly overrides silent mode
  const overrideLogger = createLogger({
    component: 'force-console-output',
    silent: false // Explicitly set to false to override env var
  });
  
  overrideLogger.info('This message WILL appear in console (explicit override)');
  
  // You can also toggle during runtime
  const toggleLogger = createLogger({
    component: 'toggle-logger',
    silent: true
  });
  
  toggleLogger.info('This message is silent');
  toggleLogger.setSilent(false);
  toggleLogger.info('This message will appear in console');
}

// Export examples
export default {
  basicLoggerExample,
  silentModeExample,
  categoryLoggingExample,
  childLoggerExample,
  r2ConfigurationExample,
  migrationExample,
  customStoragePathExample,
  silentModeOverrideExample
}; 