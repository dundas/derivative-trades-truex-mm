/**
 * Custom R2 Transport for Winston Logger
 * 
 * This module provides a custom Winston transport that uses AWS SDK directly
 * to upload logs to Cloudflare R2 storage.
 */

import winston from 'winston';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Custom Winston transport for R2
export class CustomR2Transport extends winston.Transport {
  /**
   * Constructor for the custom R2 transport
   * 
   * @param {Object} options - Transport configuration options
   * @param {String} options.bucket - R2 bucket name
   * @param {String} options.bucketPath - Path template in the bucket (can include ${timestamp})
   * @param {S3Client} options.client - Preconfigured S3Client instance
   * @param {Number} [options.batchSize=25] - Number of logs to batch before uploading
   * @param {Function} [options.formatHelper] - Function to format log entries
   * @param {Boolean} [options.debug=false] - Enable additional debug output
   */
  constructor(options = {}) {
    super(options);
    
    if (!options.bucket) {
      throw new Error('Bucket name is required for CustomR2Transport');
    }
    
    if (!options.bucketPath) {
      throw new Error('Bucket path is required for CustomR2Transport');
    }
    
    if (!options.client || !(options.client instanceof S3Client)) {
      throw new Error('A valid S3Client instance is required for CustomR2Transport');
    }
    
    this.bucket = options.bucket;
    this.bucketPath = options.bucketPath;
    this.client = options.client;
    this.batchSize = options.batchSize || 25;
    this.formatHelper = options.formatHelper || ((info) => JSON.stringify(info) + '\n');
    this.debug = !!options.debug;
    
    // Initialize log queue
    this.queue = [];
    this.uploading = false;
    this.flushInterval = null;
    
    // Set up periodic flushing (every 10 seconds)
    this._setupPeriodicFlush();
    
    // Set up signal handlers for graceful shutdown
    this._setupSignalHandlers();
    
    // Log transport initialization
    console.debug(`CustomR2Transport initialized with bucket: ${this.bucket}, path: ${this.bucketPath}, batch size: ${this.batchSize}`);
  }
  
  /**
   * Set up periodic flushing of logs
   * @private
   */
  _setupPeriodicFlush() {
    // Flush logs every 10 seconds regardless of batch size
    this.flushInterval = setInterval(() => {
      if (this.queue.length > 0) {
        if (this.debug) {
          console.debug(`CustomR2Transport: Periodic flush triggered with ${this.queue.length} logs in queue`);
        }
        this.flush().catch(err => {
          console.error('Error during periodic flush:', err);
        });
      }
    }, 10000);
  }
  
  /**
   * Set up signal handlers for graceful shutdown
   * @private
   */
  _setupSignalHandlers() {
    // Handle SIGINT and SIGTERM to flush logs before exit
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
      // Only add if we're running in Node.js environment
      if (typeof process !== 'undefined' && process?.on) {
        const originalHandler = process.listeners(signal)[0];
        process.removeAllListeners(signal);
        
        process.on(signal, async () => {
          console.debug(`CustomR2Transport: Received ${signal}, flushing logs before exit`);
          
          try {
            await this.flush();
            console.debug('CustomR2Transport: Successfully flushed logs on shutdown');
          } catch (err) {
            console.error('CustomR2Transport: Error flushing logs on shutdown:', err);
          } finally {
            // Clear the flush interval
            if (this.flushInterval) {
              clearInterval(this.flushInterval);
              this.flushInterval = null;
            }
            
            // Call the original handler if it exists
            if (originalHandler && typeof originalHandler === 'function') {
              originalHandler();
            } else {
              process.exit(0);
            }
          }
        });
      }
    });
  }
  
  /**
   * Log method called by Winston
   * @param {Object} info - Log information
   * @param {Function} callback - Callback function
   */
  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });
    
    // Add to queue
    this.queue.push(info);
    
    // Upload if queue size exceeds batch size
    if (this.queue.length >= this.batchSize) {
      this.flush().catch(err => {
        console.error('Error during flush triggered by batch size:', err);
      });
    }
    
    // Call callback if provided
    if (callback) {
      callback();
    }
  }
  
  /**
   * Flush logs to R2 storage
   * @returns {Promise<void>}
   */
  async flush() {
    // If we're already uploading or queue is empty, don't do anything
    if (this.uploading || this.queue.length === 0) {
      if (this.debug) {
        console.debug(`CustomR2Transport: Queue empty or already uploading. Queue size: ${this.queue.length}, Uploading: ${this.uploading}`);
      }
      return;
    }
    
    // Set uploading flag
    this.uploading = true;
    
    try {
      // Get logs to upload from queue
      const logs = this.queue.splice(0, this.batchSize);
      
      // Format log entries
      const logContent = logs.map(this.formatHelper).join('');
      
      // Generate file path with timestamp
      const timestamp = Date.now();
      const filePath = this.bucketPath.replace('${timestamp}', timestamp);
      
      if (this.debug) {
        console.debug(`CustomR2Transport: Attempting to upload ${logs.length} logs to bucket: ${this.bucket}, path: ${filePath}`);
      }
      
      // Upload to R2
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: filePath,
        Body: logContent,
        ContentType: 'application/json'
      });
      
      const result = await this.client.send(command);
      
      if (this.debug) {
        console.debug(`CustomR2Transport: Successfully uploaded ${logs.length} logs to ${filePath}, result:`, result);
      } else {
        console.debug(`CustomR2Transport: Uploaded ${logs.length} logs to ${filePath}`);
      }
      
      // Check if there are more logs in the queue
      if (this.queue.length > 0) {
        if (this.debug) {
          console.debug(`CustomR2Transport: ${this.queue.length} more logs in queue. Scheduling another flush.`);
        }
        setTimeout(() => this.flush().catch(err => {
          console.error('Error during follow-up flush:', err);
        }), 100);
      }
    } catch (error) {
      console.error(`CustomR2Transport: Error uploading logs to R2:`, error);
      
      if (this.debug) {
        console.error(`Error details: ${error.name}: ${error.message}`);
        if (error.stack) {
          console.error(`Stack trace: ${error.stack}`);
        }
      }
      
      this.emit('error', error);
      
      // Put the logs back in the queue if we want retry behavior
      // this.queue.unshift(...logs);
    } finally {
      // Reset uploading flag
      this.uploading = false;
    }
  }
  
  /**
   * Close the transport
   * @returns {Promise<void>}
   */
  async close() {
    if (this.debug) {
      console.debug(`CustomR2Transport: Closing transport, queue size: ${this.queue.length}`);
    }
    
    // Clear the flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Flush any remaining logs
    await this.flush();
    
    if (this.debug) {
      console.debug(`CustomR2Transport: Transport closed, all logs flushed.`);
    }
  }
}

/**
 * Create a custom R2 transport for Winston
 * 
 * @param {Object} options - Transport configuration
 * @returns {CustomR2Transport} - Transport instance
 */
export function createCustomR2Transport(options) {
  // Create S3 client if not provided
  let client = options.client;
  
  if (!client) {
    const accountId = options.accountId || process.env.R2_ACCOUNT_ID;
    const accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
    const secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
    const endpoint = options.endpoint || 
                    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : process.env.R2_ENDPOINT);
    
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('S3 client configuration is incomplete. Provide client or all required credentials.');
    }
    
    client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey
      },
      forcePathStyle: true
    });
  }
  
  // Create transport instance
  return new CustomR2Transport({
    bucket: options.bucket,
    bucketPath: options.bucketPath,
    client,
    batchSize: options.batchSize || 25,
    formatHelper: options.formatHelper,
    debug: options.debug || process.env.R2_DEBUG === 'true'
  });
}

export default CustomR2Transport; 