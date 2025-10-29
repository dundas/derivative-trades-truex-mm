/**
 * Container-Only Logger
 * 
 * Simplified logger for containerized services that includes correlation IDs
 * for better traceability across services in Azure Container Apps.
 * This version doesn't depend on Cloudflare logging services.
 */

export class ContainerLogger {
  /**
   * Create a new ContainerLogger
   * @param {Object} options - Logger options
   * @param {string} options.component - Component name
   * @param {string} options.correlationId - Correlation ID for tracing
   * @param {string} options.level - Minimum log level (debug, info, warn, error)
   */
  constructor(options = {}) {
    this.component = options.component || 'Service';
    this.correlationId = options.correlationId || '';
    this.level = options.level || 'info';
    this.levelPriority = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
  }

  /**
   * Check if a log level should be output based on the current level setting
   * @param {string} level - Log level to check
   * @returns {boolean} Whether the level should be logged
   */
  shouldLog(level) {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }

  /**
   * Format a log message with correlation ID
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   * @returns {string} Formatted log message
   */
  formatMessage(level, message, data) {
    const timestamp = new Date().toISOString();
    const correlationPart = this.correlationId ? `[${this.correlationId}]` : '';
    const dataPart = data ? JSON.stringify(data) : '';
    
    return `${timestamp} [${level.toUpperCase()}][${this.component}]${correlationPart} ${message} ${dataPart}`.trim();
  }

  /**
   * Log a debug message
   * @param {string} message - Message to log
   * @param {any} data - Additional data to log
   */
  debug(message, data) {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  /**
   * Log an info message
   * @param {string} message - Message to log
   * @param {any} data - Additional data to log
   */
  info(message, data) {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  /**
   * Log a warning message
   * @param {string} message - Message to log
   * @param {any} data - Additional data to log
   */
  warn(message, data) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  /**
   * Log an error message
   * @param {string} message - Message to log
   * @param {any} data - Additional data to log
   */
  error(message, data) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, data));
    }
  }
}

/**
 * Create a new ContainerLogger
 * @param {Object} options - Logger options
 * @returns {ContainerLogger} A new logger instance
 */
export function createLogger(options = {}) {
  return new ContainerLogger(options);
}
