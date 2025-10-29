// Integration example for session logs with R2 storage
// This shows how to modify the existing log-manager.js to support R2

const fs = require('fs').promises;
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

class SessionLogR2Manager {
  constructor(options = {}) {
    this.accountId = options.accountId || process.env.R2_ACCOUNT_ID;
    this.accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
    this.secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = options.bucketName || process.env.R2_BUCKET_NAME || 'trading-logs';
    
    // Initialize R2 client if credentials are provided
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
    }
  }
  
  /**
   * Upload session logs directory to R2
   * @param {string} sessionId - The session ID
   * @param {string} localPath - Local path to session logs directory
   */
  async uploadSessionLogs(sessionId, localPath) {
    if (!this.r2Client) {
      console.warn('[SessionLogR2Manager] R2 client not configured, skipping upload');
      return;
    }
    
    try {
      // Read all files in the session directory
      const files = await fs.readdir(localPath);
      
      for (const file of files) {
        const filePath = path.join(localPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile()) {
          await this.uploadFile(sessionId, filePath, file);
        }
      }
      
      console.log(`[SessionLogR2Manager] Successfully uploaded ${files.length} files for session ${sessionId}`);
    } catch (error) {
      console.error('[SessionLogR2Manager] Error uploading session logs:', error);
      throw error;
    }
  }
  
  /**
   * Upload a single file to R2
   */
  async uploadFile(sessionId, filePath, fileName) {
    try {
      const content = await fs.readFile(filePath);
      const contentType = this.getContentType(fileName);
      
      const key = `sessions/${sessionId}/logs/${fileName}`;
      
      await this.r2Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: content,
        ContentType: contentType,
        Metadata: {
          sessionId,
          uploadTime: new Date().toISOString(),
          originalPath: filePath
        }
      }));
      
      console.log(`[SessionLogR2Manager] Uploaded ${key}`);
    } catch (error) {
      console.error(`[SessionLogR2Manager] Error uploading ${fileName}:`, error);
      throw error;
    }
  }
  
  /**
   * Stream upload for large log files
   */
  async streamUploadLargeFile(sessionId, filePath, fileName) {
    const fs = require('fs');
    const stream = fs.createReadStream(filePath);
    
    const key = `sessions/${sessionId}/logs/${fileName}`;
    
    try {
      await this.r2Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: stream,
        ContentType: 'text/plain',
        Metadata: {
          sessionId,
          uploadTime: new Date().toISOString()
        }
      }));
      
      console.log(`[SessionLogR2Manager] Stream uploaded ${key}`);
    } catch (error) {
      console.error(`[SessionLogR2Manager] Error stream uploading ${fileName}:`, error);
      throw error;
    }
  }
  
  /**
   * List session logs in R2
   */
  async listSessionLogs(sessionId) {
    if (!this.r2Client) return [];
    
    try {
      const prefix = `sessions/${sessionId}/logs/`;
      const response = await this.r2Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix
      }));
      
      return response.Contents || [];
    } catch (error) {
      console.error('[SessionLogR2Manager] Error listing session logs:', error);
      return [];
    }
  }
  
  /**
   * Get appropriate content type for file
   */
  getContentType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.json':
        return 'application/json';
      case '.md':
        return 'text/markdown';
      case '.log':
        return 'text/plain';
      default:
        return 'text/plain';
    }
  }
  
  /**
   * Archive and cleanup old session logs
   */
  async archiveOldSessions(daysToKeep = 7) {
    const sessionLogsDir = 'session-logs';
    
    try {
      const sessions = await fs.readdir(sessionLogsDir);
      const now = Date.now();
      const cutoffTime = now - (daysToKeep * 24 * 60 * 60 * 1000);
      
      for (const sessionId of sessions) {
        const sessionPath = path.join(sessionLogsDir, sessionId);
        const stats = await fs.stat(sessionPath);
        
        if (stats.isDirectory() && stats.mtimeMs < cutoffTime) {
          // Upload to R2 before deletion
          await this.uploadSessionLogs(sessionId, sessionPath);
          
          // Delete local files after successful upload
          await fs.rm(sessionPath, { recursive: true });
          console.log(`[SessionLogR2Manager] Archived and removed local session: ${sessionId}`);
        }
      }
    } catch (error) {
      console.error('[SessionLogR2Manager] Error archiving old sessions:', error);
    }
  }
}

// Integration with existing LogManager
async function enhanceLogManagerWithR2(LogManager) {
  const originalProcessSessionData = LogManager.prototype.processSessionData;
  
  LogManager.prototype.processSessionData = async function(sessionId, options = {}) {
    // Call original method
    const result = await originalProcessSessionData.call(this, sessionId, options);
    
    // Upload to R2 if enabled
    if (process.env.R2_ARCHIVE_ENABLED === 'true') {
      const r2Manager = new SessionLogR2Manager();
      const sessionPath = path.join(this.baseDir || 'session-logs', sessionId);
      
      try {
        await r2Manager.uploadSessionLogs(sessionId, sessionPath);
        console.log(`[LogManager] Session logs uploaded to R2 for ${sessionId}`);
      } catch (error) {
        console.error(`[LogManager] Failed to upload to R2:`, error);
      }
    }
    
    return result;
  };
}

module.exports = {
  SessionLogR2Manager,
  enhanceLogManagerWithR2
};