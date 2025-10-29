/**
 * Usage examples for the Logger utility
 */
import { Logger, LogLevel } from './logger.js';

/**
 * Example 1: Basic usage with default settings
 */
const basicExample = () => {
  // Create a logger for a component
  const logger = new Logger('BasicExample');
  
  // Log at different levels
  logger.debug('This is a debug message'); // Won't show with default INFO level
  logger.info('This is an info message');
  logger.warn('This is a warning message');
  logger.error('This is an error message');
  
  // Log with additional data
  logger.info('User logged in', { userId: '123', timestamp: Date.now() });
  logger.error('Operation failed', { code: 500, reason: 'Database connection error' });
};

/**
 * Example 2: Advanced configuration
 */
const advancedExample = () => {
  // Create a logger with custom settings
  const logger = new Logger('AdvancedExample', LogLevel.DEBUG, {
    useJson: true,
    includeTimestamp: true
  });
  
  // Now debug messages will be shown
  logger.debug('Debug message with JSON formatting');
  
  // Change settings dynamically
  logger.setLevel(LogLevel.WARN).setJsonOutput(false);
  
  // Now only WARN and ERROR will be shown, and in text format
  logger.debug('This debug message will be filtered out');
  logger.info('This info message will be filtered out');
  logger.warn('This warning will be shown in text format');
};

/**
 * Example 3: Child loggers
 */
const childLoggerExample = () => {
  // Create a parent logger
  const appLogger = new Logger('App', LogLevel.INFO);
  
  // Create child loggers for different components
  const authLogger = appLogger.createChild('Auth');
  const apiLogger = appLogger.createChild('API');
  const dbLogger = appLogger.createChild('Database');
  
  // Use the child loggers
  authLogger.info('User authentication successful');
  apiLogger.warn('Rate limit approaching');
  dbLogger.error('Connection failed', { retryCount: 3 });
  
  // Create nested child loggers
  const userApiLogger = apiLogger.createChild('UserService');
  userApiLogger.info('User profile updated'); // Will log with 'App:API:UserService' prefix
};

/**
 * Example 4: Integration with Kraken WebSocket adapter
 */
const webSocketExample = () => {
  const logger = new Logger('KrakenWS');
  
  // Similar to the adapter implementation
  logger.info('Connecting to WebSocket endpoint', { url: 'wss://ws-auth.kraken.com/v2' });
  logger.debug('Setting up event handlers');
  
  // Simulate subscription
  logger.info(`[Private WS Subscribe] Subscribing to private feed`, { channel: 'openOrders' });
  
  // Log different event types
  logger.debug('WebSocket message received', { type: 'heartbeat' });
  logger.info('Order status updated', { orderId: 'OZFXS-RZQXS-RCSPIY', status: 'filled' });
  logger.warn('Connection unstable', { latency: 1500 });
  logger.error('Connection lost', { attempt: 1, maxRetries: 5 });
};

// Export examples for potential usage in documentation
export {
  basicExample,
  advancedExample,
  childLoggerExample,
  webSocketExample
};

// For testing in Node.js
if (require.main === module) {
  console.log('\n--- Basic Example ---');
  basicExample();
  
  console.log('\n--- Advanced Example ---');
  advancedExample();
  
  console.log('\n--- Child Logger Example ---');
  childLoggerExample();
  
  console.log('\n--- WebSocket Example ---');
  webSocketExample();
}