/**
 * Temporary minimal implementation of TradingLogger
 * to unblock the trading application
 */

// Import fs for file stream operations
import fs from 'fs';
import util from 'util'; // For util.format

// REMOVE CAPTURE OF ORIGINAL CONSOLE FUNCTIONS HERE
// const _originalConsoleFunctions = {
//   log: console.log,
//   error: console.error,
//   warn: console.warn,
//   debug: console.debug,
//   info: console.info,
// };

class TradingLogger {
  constructor(options = {}) {
    this.options = {
      component: options.component || 'trading',
      level: options.level || 'info', // Add level handling
      fileStream: options.fileStream || null, // Add fileStream option
      ...options
    };
    // Store the stream directly on the instance
    this.fileStream = this.options.fileStream; 
    
    // Basic level comparison (can be enhanced)
    this.logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.currentLogLevel = this.logLevels[this.options.level.toLowerCase()] ?? this.logLevels.info;
  }
  
  // Helper to format arguments for logging
  _formatArgs(...args) {
    // Use util.format for better handling of different types (like Node's console)
    // Replace Error objects with their message and stack for better file logging
    const formattedArgs = args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
      }
      return arg;
    });
    return util.format(...formattedArgs);
  }

  // Generic log method (less used directly now)
  log(level, message, data) {
    // This method seems less used now that specific level methods exist. 
    // Keep it simple or align with specific level methods if needed.
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  // Error log level
  error(message, data) {
    if (this.logLevels.error >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}] [ERROR]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawError(`${prefix} ${formattedMessage}`);
    }
  }
  
  // Warning log level
  warn(message, data) {
    if (this.logLevels.warn >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}] [WARN]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawWarn(`${prefix} ${formattedMessage}`);
    }
  }
  
  // Info log level
  info(message, data) {
    if (this.logLevels.info >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}] [INFO]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawInfo(`${prefix} ${formattedMessage}`);
    }
  }
  
  // Debug log level
  debug(message, data) {
    if (this.logLevels.debug >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}] [DEBUG]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawDebug(`${prefix} ${formattedMessage}`);
    }
  }
  
  // Category-specific log methods (stubs) - updated to use level checks
  logOrder(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][ORDER] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`); // Use _rawLog, _rawInfo etc. based on level?
    }
  }
  
  logTrade(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
     if (numericLevel >= this.currentLogLevel) {
       const timestamp = new Date().toISOString();
       const prefix = `[${timestamp}] [${this.options.component}][TRADE] [${level.toUpperCase()}]`;
       const formattedMessage = this._formatArgs(message, data || '');
       this._rawLog(`${prefix} ${formattedMessage}`);
     }
  }
  
  logCycle(level, message, data) {
     const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
     if (numericLevel >= this.currentLogLevel) {
       const timestamp = new Date().toISOString();
       const prefix = `[${timestamp}] [${this.options.component}][CYCLE] [${level.toUpperCase()}]`;
       const formattedMessage = this._formatArgs(message, data || '');
       this._rawLog(`${prefix} ${formattedMessage}`);
     }
  }
  
  logPosition(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][POSITION] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  logMarket(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][MARKET] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  logStrategy(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][STRATEGY] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  logExecution(level, message, data) {
     const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
     if (numericLevel >= this.currentLogLevel) {
       const timestamp = new Date().toISOString();
       const prefix = `[${timestamp}] [${this.options.component}][EXECUTION] [${level.toUpperCase()}]`;
       const formattedMessage = this._formatArgs(message, data || '');
       this._rawLog(`${prefix} ${formattedMessage}`);
     }
  }
  
  /**
   * Log trading decisions
   * @param {string} level - Log level (INFO, DEBUG, WARN, ERROR)
   * @param {string} message - Log message
   * @param {Object} data - Additional data to log
   */
  logDecision(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][DECISION] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  /**
   * Log general data (used by CSVLogger and other components)
   * @param {string} level - Log level (INFO, DEBUG, WARN, ERROR)
   * @param {string} message - Log message
   * @param {Object} data - Additional data to log
   */
  logData(level, message, data) {
    const numericLevel = this.logLevels[level.toLowerCase()] ?? this.logLevels.info;
    if (numericLevel >= this.currentLogLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${this.options.component}][DATA] [${level.toUpperCase()}]`;
      const formattedMessage = this._formatArgs(message, data || '');
      this._rawLog(`${prefix} ${formattedMessage}`);
    }
  }
  
  // --- Raw logging methods updated to write to file stream ---
  _writeToStream(message) {
    if (this.fileStream && this.fileStream.writable) {
      try {
        // Ensure message ends with a newline for file logging
        this.fileStream.write(message.endsWith('\n') ? message : message + '\n');
      } catch (error) {
        // Fallback to console if stream fails
        console.error('[TradingLogger] Error writing to file stream:', error);
      }
    }
  }
  
  _rawLog(message) {
    console.log(message); // Keep console output, now goes through capture wrapper
    // this._writeToStream(message); // Write to file if stream exists
  }
  
  _rawError(message) {
    console.error(message); // Keep console output, now goes through capture wrapper
    // this._writeToStream(message); // Write to file if stream exists
  }
  
  _rawWarn(message) {
    console.warn(message); // Keep console output, now goes through capture wrapper
    // this._writeToStream(message); // Write to file if stream exists
  }
  
  _rawInfo(message) {
    console.info(message); // Keep console output, now goes through capture wrapper
    // this._writeToStream(message); // Write to file if stream exists
  }
  
  _rawDebug(message) {
    console.debug(message); // Keep console output, now goes through capture wrapper
    // this._writeToStream(message); // Write to file if stream exists
  }
  
  // --- Cleanup method updated ---
  close() {
    // Close the file stream if it exists and is writable
    if (this.fileStream && typeof this.fileStream.end === 'function') {
      console.log(`[TradingLogger] Closing log file stream for ${this.options.component}...`);
      this.fileStream.end();
      this.fileStream = null; // Prevent further writes
    }
  }
  
  /**
   * Create a child logger with a new component name
   * Used by AdaptiveMarketMaker and related components
   * @param {string} childComponent Name of the child component
   * @returns {TradingLogger} A new logger instance with the child component name
   */
  createChild(childComponent) {
    // Pass the fileStream to the child logger so it writes to the same file
    return new TradingLogger({
      ...this.options,
      component: `${this.options.component}:${childComponent}`,
      fileStream: this.fileStream // Important: Share the stream
    });
  }
}

// Create a default trading logger instance
// The default instance won't have a fileStream unless configured later
const defaultTradingLogger = new TradingLogger();

// Export both the class and a default instance
export { TradingLogger };
export default defaultTradingLogger;