// Session Log R2 Transport for Winston
// Based on the migration service's R2 transport implementation

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const winston = require('winston');
const Transport = require('winston-transport');
const path = require('path');

class SessionLogR2Transport extends Transport {
  constructor(options = {}) {
    super(options);
    
    // R2 Configuration
    this.accountId = options.accountId || process.env.R2_ACCOUNT_ID;
    this.accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
    this.secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = options.bucketName || process.env.R2_BUCKET_NAME || 'trading-logs';
    this.sessionId = options.sessionId;
    
    // Batching configuration
    this.batchSize = options.batchSize || 25;
    this.flushInterval = options.flushInterval || 10000; // 10 seconds
    this.logQueue = [];
    this.partNumber = 1;
    this.currentPartSize = 0;
    this.maxPartSize = options.maxPartSize || 500 * 1024; // 500KB per part
    
    // Initialize R2 client
    if (this.accountId && this.accessKeyId && this.secretAccessKey) {
      this.r2Client = new S3Client({
        region: 'auto',
        endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        },
        forcePathStyle: true
      });
      
      // Set up periodic flushing
      this.flushTimer = setInterval(() => this.flush(), this.flushInterval);
      
      // Handle graceful shutdown
      process.on('SIGINT', () => this.close());
      process.on('SIGTERM', () => this.close());
    }
  }
  
  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });
    
    // Add to queue
    this.logQueue.push(info);
    this.currentPartSize += JSON.stringify(info).length;
    
    // Check if we should flush (batch size or part size reached)
    if (this.logQueue.length >= this.batchSize || this.currentPartSize >= this.maxPartSize) {
      this.flush();
    }
    
    callback();
  }
  
  async flush() {
    if (!this.r2Client || this.logQueue.length === 0) return;
    
    const logsToUpload = [...this.logQueue];
    this.logQueue = [];
    
    try {
      // Format logs as newline-delimited JSON
      const logContent = logsToUpload
        .map(log => JSON.stringify({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level,
          message: log.message,
          ...log.metadata
        }))
        .join('\n');
      
      // Determine file path based on content type
      let key;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      
      if (this.currentPartSize >= this.maxPartSize) {
        // Save as a log part
        key = `sessions/${this.sessionId}/logs/log-part-${this.partNumber}-${timestamp}.log`;
        this.partNumber++;
        this.currentPartSize = 0;
      } else {
        // Save to the main full.log (append mode simulation)
        key = `sessions/${this.sessionId}/logs/chunks/log-${timestamp}.json`;
      }
      
      // Upload to R2
      await this.r2Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: logContent,
        ContentType: 'application/json',
        Metadata: {
          sessionId: this.sessionId,
          uploadTime: new Date().toISOString(),
          logCount: logsToUpload.length.toString()
        }
      }));
      
    } catch (error) {
      // Re-queue logs on error
      this.logQueue.unshift(...logsToUpload);
      this.emit('error', error);
    }
  }
  
  async uploadProcessedLogs(processedFiles) {
    // Upload processed log files (summary, errors, etc.) to R2
    if (!this.r2Client) return;
    
    for (const file of processedFiles) {
      try {
        const key = `sessions/${this.sessionId}/logs/${path.basename(file.path)}`;
        
        await this.r2Client.send(new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: file.content,
          ContentType: file.contentType || 'text/plain',
          Metadata: {
            sessionId: this.sessionId,
            fileType: file.type,
            uploadTime: new Date().toISOString()
          }
        }));
        
      } catch (error) {
        this.emit('error', error);
      }
    }
  }
  
  async close() {
    // Flush remaining logs
    await this.flush();
    
    // Clear interval
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
  }
}

// Factory function to create session logger with R2 transport
function createSessionLogger(sessionId, options = {}) {
  const logger = winston.createLogger({
    level: options.level || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      // Console transport
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }),
      // File transport for local backup
      new winston.transports.File({
        filename: `session-logs/${sessionId}/full.log`,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.printf(info => {
            return `[${info.timestamp}] [${info.level.toUpperCase()}] ${info.message}`;
          })
        )
      }),
      // R2 transport
      new SessionLogR2Transport({
        sessionId,
        ...options.r2
      })
    ]
  });
  
  // Add method to upload processed files
  logger.uploadProcessedFiles = async (files) => {
    const r2Transport = logger.transports.find(t => t instanceof SessionLogR2Transport);
    if (r2Transport) {
      await r2Transport.uploadProcessedLogs(files);
    }
  };
  
  return logger;
}

module.exports = {
  SessionLogR2Transport,
  createSessionLogger
};