/**
 * Logger Package
 * 
 * This package provides a standardized logging solution with optional R2 storage integration.
 * It includes Winston-based logging with silent mode, category-based logging, and more.
 */

// Convert require to dynamic import for use in ESM
import winstonLoggerModule from './winston.js';
import examplesModule from './examples.js';

// Destructure after importing
const { WinstonLogger, createLogger } = winstonLoggerModule;
const examples = examplesModule;

// Export everything using named exports
export {
  // Main logger class
  WinstonLogger,
  
  // Factory function to create a logger
  createLogger,
  
  // Examples of usage
  examples
};

// For backward compatibility with dynamic import
export default {
  WinstonLogger,
  createLogger,
  examples
};
