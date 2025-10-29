/**
 * API endpoints for accessing session logs stored in R2
 * Path structure: bucket/sessions/SESSION_ID/logs/
 */

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const express = require('express');

class SessionLogR2API {
  constructor(options = {}) {
    this.accountId = options.accountId || process.env.R2_ACCOUNT_ID;
    this.accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
    this.secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = options.bucketName || process.env.R2_BUCKET_NAME || 'trading-logs';
    
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
   * List all log files for a session
   */
  async listSessionLogs(sessionId) {
    if (!this.r2Client) {
      throw new Error('R2 client not configured');
    }
    
    const prefix = `sessions/${sessionId}/logs/`;
    
    try {
      const response = await this.r2Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix
      }));
      
      const files = (response.Contents || []).map(file => ({
        name: file.Key.replace(prefix, ''),
        path: file.Key,
        size: file.Size,
        lastModified: file.LastModified
      }));
      
      return files;
    } catch (error) {
      console.error('[SessionLogR2API] Error listing session logs:', error);
      throw error;
    }
  }
  
  /**
   * Get a specific log file
   */
  async getLogFile(sessionId, fileName) {
    if (!this.r2Client) {
      throw new Error('R2 client not configured');
    }
    
    const key = `sessions/${sessionId}/logs/${fileName}`;
    
    try {
      const response = await this.r2Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key
      }));
      
      const body = await streamToString(response.Body);
      
      return {
        content: body,
        contentType: response.ContentType,
        metadata: response.Metadata
      };
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      console.error('[SessionLogR2API] Error getting log file:', error);
      throw error;
    }
  }
  
  /**
   * List all sessions with logs
   */
  async listSessions(options = {}) {
    if (!this.r2Client) {
      throw new Error('R2 client not configured');
    }
    
    const prefix = 'sessions/';
    const delimiter = '/';
    
    try {
      const response = await this.r2Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        Delimiter: delimiter
      }));
      
      const sessions = (response.CommonPrefixes || []).map(prefix => {
        const sessionId = prefix.Prefix.replace('sessions/', '').replace('/', '');
        return sessionId;
      });
      
      // Filter by date if provided
      if (options.startDate || options.endDate) {
        // Would need to fetch metadata for each session to filter by date
        // For now, return all sessions
      }
      
      return sessions;
    } catch (error) {
      console.error('[SessionLogR2API] Error listing sessions:', error);
      throw error;
    }
  }
  
  /**
   * Search logs across sessions
   */
  async searchLogs(query, options = {}) {
    // This would require downloading and searching through logs
    // For production, consider using a search service or indexing logs
    throw new Error('Search functionality not implemented. Consider using CloudFlare Workers Analytics Engine or external search service.');
  }
  
  /**
   * Create Express router for API endpoints
   */
  createRouter() {
    const router = express.Router();
    
    // List all sessions
    router.get('/sessions', async (req, res) => {
      try {
        const sessions = await this.listSessions(req.query);
        res.json({ sessions });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // List logs for a session
    router.get('/sessions/:sessionId/logs', async (req, res) => {
      try {
        const files = await this.listSessionLogs(req.params.sessionId);
        res.json({ sessionId: req.params.sessionId, files });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Get specific log file
    router.get('/sessions/:sessionId/logs/:fileName', async (req, res) => {
      try {
        const file = await this.getLogFile(req.params.sessionId, req.params.fileName);
        
        if (!file) {
          return res.status(404).json({ error: 'File not found' });
        }
        
        // Set appropriate content type
        const contentType = file.contentType || 'text/plain';
        res.setHeader('Content-Type', contentType);
        
        // For JSON files, parse and return as JSON
        if (contentType === 'application/json' || req.params.fileName.endsWith('.json')) {
          try {
            const jsonContent = JSON.parse(file.content);
            res.json(jsonContent);
          } catch (e) {
            res.send(file.content);
          }
        } else {
          res.send(file.content);
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Health check
    router.get('/health', async (req, res) => {
      try {
        // Try to list bucket to verify connection
        await this.r2Client.send(new ListObjectsV2Command({
          Bucket: this.bucketName,
          MaxKeys: 1
        }));
        
        res.json({ 
          status: 'healthy',
          bucket: this.bucketName,
          path: 'sessions/SESSION_ID/logs/'
        });
      } catch (error) {
        res.status(500).json({ 
          status: 'unhealthy',
          error: error.message 
        });
      }
    });
    
    return router;
  }
}

// Helper function to convert stream to string
async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Example usage in Express app:
/*
const express = require('express');
const app = express();
const sessionLogAPI = new SessionLogR2API();

app.use('/api/session-logs', sessionLogAPI.createRouter());

app.listen(3000, () => {
  console.log('Session log API running on port 3000');
});
*/

module.exports = SessionLogR2API;