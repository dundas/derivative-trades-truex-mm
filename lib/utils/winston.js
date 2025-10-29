/**
 * Winston Logger with Cloudflare R2 Integration
 * 
 * This module provides a standardized logging solution using Winston with Cloudflare R2 storage.
 * It follows similar patterns to our other loggers (TradingLogger, Logger) but adds R2 persistence.
 */

import winston from 'winston';
import { S3Client } from '@aws-sdk/client-s3';
import { createCustomR2Transport } from './custom-r2-transport.js';

const { format } = winston;

/**
 * Winston-based logger with Cloudflare R2 storage capability
 */
class WinstonLogger {
  /**
   * Creates a new Winston Logger with optional R2 integration
   * 
   * @param {Object} options - Logger configuration options
   * @param {String} [options.component='app'] - Component name for this logger
   * @param {String} [options.level='info'] - Minimum log level (debug, info, warn, error)
   * @param {String} [options.runId] - Unique ID for this run (auto-generated if not provided)
   * @param {Boolean} [options.useR2=true] - Whether to enable R2 storage
   * @param {Boolean} [options.silent] - If true, logs won't be displayed in console but still cached to R2.
   *                                     If false, explicitly overrides environment settings to force console output.
   * @param {String} [options.sessionId] - Session ID for organizing logs in BUCKET/sessions/SESSION_ID/migrations
   * @param {String} [options.migrationId] - Migration ID for organizing logs in BUCKET/migrations/MIGRATION_ID-timestamp
   * @param {String} [options.customBucketPath] - Custom bucket path template for R2 storage
   * @param {Object} [options.r2Config] - Cloudflare R2 configuration
   * @param {String} [options.r2Config.accountId] - Cloudflare account ID (used to construct endpoint)
   * @param {String} [options.r2Config.endpoint] - R2 endpoint URL (optional if accountId is provided)
   * @param {String} [options.r2Config.accessKeyId] - R2 access key ID
   * @param {String} [options.r2Config.secretAccessKey] - R2 secret access key
   * @param {String} [options.r2Config.bucket] - R2 bucket name
   * @param {Number} [options.batchSize=25] - Number of logs to batch before uploading to R2
   */
  constructor(options = {}) {
    // Store options
    this.options = {
      component: options.component || 'app',
      level: options.level || process.env.LOG_LEVEL || 'info',
      runId: options.runId || `run-${Date.now()}`,
      useR2: options.useR2 !== false,
      silent: options.silent || false,
      sessionId: options.sessionId,
      migrationId: options.migrationId,
      customBucketPath: options.customBucketPath,
      r2Config: options.r2Config || {},
      batchSize: options.batchSize || 25
    };

    // Initialize Winston logger
    this._initializeLogger();
  }

  /**
   * Initialize the Winston logger with appropriate transports
   * @private
   */
  _initializeLogger() {
    // Initialize transports array
    const transports = [];
    
    // Add console transport if not in silent mode
    if (!this.options.silent) {
      transports.push(new winston.transports.Console({
        format: format.combine(
          format.timestamp(),
          format.colorize(),
          format.printf(({ timestamp, level, message, component, runId, ...meta }) => {
            const componentStr = component || this.options.component;
            const runIdStr = runId || this.options.runId;
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `[${timestamp}] [${level.toUpperCase()}] [${componentStr}]${runIdStr ? ` [RunID: ${runIdStr}]` : ''} ${message} ${metaStr}`;
          })
        )
      }));
    }

    // Get R2 credentials from options or environment variables
    const r2AccountId = this.options.r2Config?.accountId || process.env.R2_ACCOUNT_ID;
    const r2AccessKeyId = this.options.r2Config?.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
    const r2SecretAccessKey = this.options.r2Config?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
    const r2Bucket = this.options.r2Config?.bucket || process.env.R2_BUCKET_NAME || process.env.R2_BUCKET;
    
    // Determine the endpoint - either explicitly provided or constructed from account ID
    // Make sure endpoint doesn't include the bucket name (common error)
    let r2Endpoint = this.options.r2Config?.endpoint || process.env.R2_ENDPOINT;
    if (!r2Endpoint && r2AccountId) {
      r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
    }
    
    // Remove bucket name from endpoint if it's included
    if (r2Endpoint && r2Bucket && r2Endpoint.endsWith(`/${r2Bucket}`)) {
      r2Endpoint = r2Endpoint.substring(0, r2Endpoint.length - r2Bucket.length - 1);
      console.log(`Warning: Removed bucket name from endpoint. Using: ${r2Endpoint}`);
    }
    
    const useR2 = this.options.useR2 && 
                  r2AccessKeyId && 
                  r2SecretAccessKey && 
                  r2Endpoint && 
                  r2Bucket &&
                  process.env.R2_ARCHIVE_ENABLED !== 'false';

    if (useR2) {
      try {
        // Add debug output to help with troubleshooting
        console.debug("Configuring R2 transport with:", {
          endpoint: r2Endpoint,
          bucket: r2Bucket,
          accessKey: r2AccessKeyId ? `${r2AccessKeyId.substring(0, 4)}...` : 'undefined',
          secretKey: r2SecretAccessKey ? '(set)' : 'undefined',
          forcePathStyle: true
        });
        
        // Configure R2 client
        const r2Client = new S3Client({
          region: 'auto',
          endpoint: r2Endpoint,
          credentials: {
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey
          },
          forcePathStyle: true
        });

        // Current date for folder structure
        const now = new Date();
        const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        // Determine the bucket path based on options or use default
        let bucketPath;
        const r2LogPath = process.env.R2_LOG_PATH || 'logs';
        
        if (this.options.sessionId) {
          // For session-specific logs: BUCKET/sessions/SESSION_ID/migrations
          bucketPath = `sessions/${this.options.sessionId}/migrations/log-${this.options.runId}-\${timestamp}.json`;
        } else if (this.options.migrationId) {
          // For migration logs: BUCKET/migrations/MIGRATION_ID-timestamp
          const timestamp = Math.floor(Date.now() / 1000);
          bucketPath = `migrations/${this.options.migrationId}-${timestamp}/log-\${timestamp}.json`;
        } else if (this.options.customBucketPath) {
          // Use custom path if provided
          bucketPath = this.options.customBucketPath;
        } else if (r2LogPath === 'migrations') {
          // If R2_LOG_PATH is set to 'migrations', use that format
          bucketPath = `migrations/${this.options.component}-${this.options.runId}-${Date.now()}/log-\${timestamp}.json`;
        } else {
          // Default path
          bucketPath = `${r2LogPath}/${this.options.component}/${dateFolder}/log-${this.options.runId}-\${timestamp}.json`;
        }
        
        // Create custom R2 transport
        const r2Transport = createCustomR2Transport({
          bucket: r2Bucket,
          bucketPath: bucketPath,
          client: r2Client,
          batchSize: this.options.batchSize
        });

        // Add transport to the list
        transports.push(r2Transport);
        this._r2Transport = r2Transport;
        console.debug(`R2 transport configured with bucket: ${r2Bucket}, path: ${bucketPath}`);
        
        // If in silent mode with R2 enabled, add a fallback console transport for errors
        // This ensures critical errors are still visible even in silent mode
        if (this.options.silent) {
          transports.push(new winston.transports.Console({
            level: 'error',
            format: format.combine(
              format.timestamp(),
              format.colorize(),
              format.printf(({ timestamp, level, message, component, runId, ...meta }) => {
                const componentStr = component || this.options.component;
                const runIdStr = runId || this.options.runId;
                const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                return `[${timestamp}] [${level.toUpperCase()}] [${componentStr}]${runIdStr ? ` [RunID: ${runIdStr}]` : ''} ${message} ${metaStr}`;
              })
            )
          }));
        }
      } catch (error) {
        console.error('Failed to initialize R2 transport:', error.message);
        
        // If in silent mode but R2 failed, add console transport as fallback
        if (this.options.silent && transports.length === 0) {
          transports.push(new winston.transports.Console({
            format: format.combine(
              format.timestamp(),
              format.colorize(),
              format.printf(({ timestamp, level, message, component, runId, ...meta }) => {
                const componentStr = component || this.options.component;
                const runIdStr = runId || this.options.runId;
                const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                return `[${timestamp}] [${level.toUpperCase()}] [${componentStr}]${runIdStr ? ` [RunID: ${runIdStr}]` : ''} ${message} ${metaStr}`;
              })
            )
          }));
        }
      }
    } else if (this.options.silent && transports.length === 0) {
      // If silent mode is requested but R2 is not available, add console transport as fallback
      transports.push(new winston.transports.Console({
        level: 'error', // Only log errors
        format: format.combine(
          format.timestamp(),
          format.colorize(),
          format.printf(({ timestamp, level, message, component, runId, ...meta }) => {
            const componentStr = component || this.options.component;
            const runIdStr = runId || this.options.runId;
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `[${timestamp}] [${level.toUpperCase()}] [${componentStr}]${runIdStr ? ` [RunID: ${runIdStr}]` : ''} ${message} ${metaStr}`;
          })
        )
      }));
    }

    // Create the Winston logger
    this.logger = winston.createLogger({
      level: this.options.level,
      format: format.combine(
        format.timestamp(),
        format.json()
      ),
      defaultMeta: { 
        component: this.options.component,
        runId: this.options.runId
      },
      transports
    });
  }

  /**
   * Log a debug message
   * @param {string} message - Message to log
   * @param {Object} [data] - Additional data to include
   */
  debug(message, data) {
    this.logger.debug(message, data);
  }

  /**
   * Log an info message
   * @param {string} message - Message to log
   * @param {Object} [data] - Additional data to include
   */
  info(message, data) {
    this.logger.info(message, data);
  }

  /**
   * Log a warning message
   * @param {string} message - Message to log
   * @param {Object} [data] - Additional data to include
   */
  warn(message, data) {
    this.logger.warn(message, data);
  }

  /**
   * Log an error message with special handling for Error objects
   * @param {string} message - Message to log
   * @param {Error|Object} [error] - Error object or additional data
   * @param {Object} [data] - Additional metadata
   */
  error(message, error = null, data = {}) {
    let metadata = { ...data };
    
    // Handle error objects specially
    if (error) {
      if (error instanceof Error) {
        metadata.errorName = error.name;
        metadata.stack = error.stack;
        metadata.errorMessage = error.message;
      } else if (typeof error === 'object') {
        metadata = { ...metadata, ...error };
      } else {
        metadata.errorDetails = error;
      }
    }
    
    this.logger.error(message, metadata);
  }

  /**
   * Log a message with a specific category
   * @param {string} category - Log category (e.g., 'DATABASE', 'API')
   * @param {string} level - Log level (debug, info, warn, error)
   * @param {string} message - Message to log
   * @param {Object} [data] - Additional data to include
   */
  logCategory(category, level, message, data = {}) {
    if (!['debug', 'info', 'warn', 'error'].includes(level)) {
      level = 'info'; // Default to info if invalid level
    }
    
    this.logger[level](message, { 
      ...data, 
      category 
    });
  }

  /**
   * Create a child logger with a new component name
   * @param {string} childComponent - Child component name
   * @returns {WinstonLogger} - New logger instance with the child component name
   */
  createChild(childComponent) {
    return new WinstonLogger({
      ...this.options,
      component: `${this.options.component}:${childComponent}`
    });
  }

  /**
   * Close the logger and flush any pending logs
   * @returns {Promise<boolean>} True if logs were flushed successfully, false if not
   */
  async close() {
    try {
      console.debug('Logger.close: Closing logger and flushing logs');
      
      // Check if the logger is still available
      if (!this.logger || !this.logger.transports) {
        console.debug('Logger.close: Logger not initialized properly');
        return false;
      }
      
      // Attempt to flush R2 logs
      if (this._r2Transport) {
        console.debug(`Logger.close: Found R2 transport with bucket: ${this._r2Transport.bucket}`);
        
        try {
          await this._r2Transport.flush();
          console.debug('Logger.close: Logs flushed successfully');
          this.info('Logs flushed to R2 storage');
          
          // Allow some time for the final log to be processed
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Final flush
          await this._r2Transport.flush();
        } catch (error) {
          console.error(`Logger.close: Error flushing logs: ${error.message}`);
          return false;
        }
      } else {
        console.debug('Logger.close: No R2 transport found');
      }
      
      // Close all transports
      await Promise.all(
        Object.values(this.logger.transports)
          .filter(transport => typeof transport.close === 'function')
          .map(transport => transport.close())
      );
      
      console.debug('Logger.close: Completed');
      return true;
    } catch (error) {
      console.error(`Logger.close: Unexpected error during close: ${error.message}`);
      return false;
    }
  }

  /**
   * Set the minimum log level
   * @param {string} level - New minimum log level
   * @returns {WinstonLogger} - This logger instance for chaining
   */
  setLevel(level) {
    this.options.level = level;
    this.logger.level = level;
    return this;
  }

  /**
   * Toggle silent mode
   * @param {boolean} silent - Whether to enable silent mode
   * @returns {WinstonLogger} - This logger instance for chaining
   */
  setSilent(silent) {
    // If changing silent mode, we need to re-initialize the logger
    if (this.options.silent !== silent) {
      this.options.silent = silent;
      this._initializeLogger();
    }
    return this;
  }
}

/**
 * Factory function to create a new logger instance
 * @param {Object} options - Logger configuration options
 * @returns {WinstonLogger} A new logger instance
 */
function createLogger(options = {}) {
  return new WinstonLogger(options);
}

// Export the class and factory function
export { WinstonLogger, createLogger };
export default { WinstonLogger, createLogger }; 