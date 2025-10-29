/**
 * Logger utility for JavaScript services
 * This is a JS version of the TypeScript logger at src/lib/utils/logger.ts
 * Provides structured logging with levels, context, timestamps and formatting.
 */

/**
 * Enum for log levels
 * @readonly
 * @enum {number}
 */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  // String name lookup for a given level value
  nameFor: function(level) {
    return Object.keys(this).find(key => this[key] === level) || 'UNKNOWN';
  }
};

/**
 * Logger class for consistent logging across JavaScript services
 */
export class Logger {
  /**
   * Creates a new Logger instance
   * @param {string} component - Component name for this logger
   * @param {number} [minLevel=LogLevel.INFO] - Minimum log level to output
   * @param {Object} [options] - Additional logger options
   * @param {boolean} [options.useJson=false] - Whether to output logs in JSON format
   * @param {boolean} [options.includeTimestamp=true] - Whether to include timestamps in logs
   */
  constructor(component, minLevel = LogLevel.INFO, options = {}) {
    this.component = component;
    this.minLevel = minLevel;
    this.useJson = options.useJson !== undefined ? options.useJson : false;
    this.includeTimestamp = options.includeTimestamp !== undefined ? options.includeTimestamp : true;
  }

  /**
   * Internal log method
   * @param {number} level - Log level
   * @param {string} message - Message to log
   * @param {Object} [data] - Optional data to include in log
   * @private
   */
  _log(level, message, data) {
    // Skip logging if below minimum level
    if (level < this.minLevel) return;

    const timestamp = this.includeTimestamp ? new Date().toISOString() : undefined;
    const levelName = LogLevel.nameFor(level);
    
    if (this.useJson) {
      // Structured JSON logging format
      const logData = {
        timestamp,
        level: levelName,
        component: this.component,
        message,
        ...(data ? { data } : {})
      };
      
      // In Node.js/browser environments, use appropriate console method
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(JSON.stringify(logData));
          break;
        case LogLevel.INFO:
          console.info(JSON.stringify(logData));
          break;
        case LogLevel.WARN:
          console.warn(JSON.stringify(logData));
          break;
        case LogLevel.ERROR:
          console.error(JSON.stringify(logData));
          break;
      }
    } else {
      // Human-readable format
      const timestampStr = timestamp ? `${timestamp} ` : '';
      const prefix = `${timestampStr}[${levelName}] [${this.component}]`;
      
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(`${prefix} ${message}`, data || '');
          break;
        case LogLevel.INFO:
          console.info(`${prefix} ${message}`, data || '');
          break;
        case LogLevel.WARN:
          console.warn(`${prefix} ${message}`, data || '');
          break;
        case LogLevel.ERROR:
          console.error(`${prefix} ${message}`, data || '');
          break;
      }
    }
  }

  /**
   * Log a debug message
   * @param {string} message - Message to log
   * @param {Object} [data] - Optional data to include in log
   */
  debug(message, data) {
    this._log(LogLevel.DEBUG, message, data);
  }

  /**
   * Log an info message
   * @param {string} message - Message to log
   * @param {Object} [data] - Optional data to include in log
   */
  info(message, data) {
    this._log(LogLevel.INFO, message, data);
  }

  /**
   * Log a warning message
   * @param {string} message - Message to log
   * @param {Object} [data] - Optional data to include in log
   */
  warn(message, data) {
    this._log(LogLevel.WARN, message, data);
  }

  /**
   * Log an error message
   * @param {string} message - Message to log
   * @param {Object} [data] - Optional data to include in log
   */
  error(message, data) {
    this._log(LogLevel.ERROR, message, data);
  }

  /**
   * Create a child logger with a nested component name
   * @param {string} childComponent - Child component name
   * @returns {Logger} New logger instance with inherited settings
   */
  createChild(childComponent) {
    return new Logger(
      `${this.component}:${childComponent}`, 
      this.minLevel,
      { useJson: this.useJson, includeTimestamp: this.includeTimestamp }
    );
  }

  /**
   * Set the minimum log level for this logger
   * @param {number} level - New minimum log level
   * @returns {Logger} This logger instance for chaining
   */
  setLevel(level) {
    this.minLevel = level;
    return this;
  }

  /**
   * Enable or disable JSON formatting for this logger
   * @param {boolean} enabled - Whether to enable JSON formatting
   * @returns {Logger} This logger instance for chaining
   */
  setJsonOutput(enabled) {
    this.useJson = enabled;
    return this;
  }
} 