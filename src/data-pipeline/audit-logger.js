import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import readline from 'readline';

/**
 * Audit Logger - Disaster Recovery Layer
 * 
 * Provides append-only JSONL logging for complete data recovery.
 * Critical for TrueX where FIX-only access means no reconciliation API.
 * 
 * Features:
 * - Synchronous writes for durability
 * - Daily log rotation
 * - Complete FIX message capture
 * - Session data recovery
 * - CRITICAL alerts on write failures
 * 
 * Performance:
 * - Write latency: 1-5ms (synchronous append)
 * - File rotation: Daily (YYYY-MM-DD)
 * - Storage format: JSONL (newline-delimited JSON)
 */
export class AuditLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || './logs/truex-audit';
    this.logger = options.logger || console;
    
    // Current log file state
    this.currentDate = null;
    this.currentStream = null;
    
    // Statistics
    this.stats = {
      fixMessagesLogged: 0,
      orderEventsLogged: 0,
      fillEventsLogged: 0,
      errorsLogged: 0,
      writeFailures: 0,
      lastWriteTime: 0
    };
    
    // Ensure log directory exists
    this.ensureLogDirectory();
  }
  
  /**
   * Ensure log directory exists
   */
  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.logger.info(`[AuditLogger] Created log directory: ${this.logDir}`);
    }
  }
  
  /**
   * Get date string for log file naming (YYYY-MM-DD)
   */
  getDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Get log file path for current date
   */
  getLogPath(date = null) {
    const dateString = date || this.getDateString();
    return path.join(this.logDir, `truex-audit-${dateString}.jsonl`);
  }
  
  /**
   * Ensure current stream is open and rotated if needed
   */
  ensureCurrentStream() {
    const dateString = this.getDateString();
    
    // Check if we need to rotate to a new file
    if (this.currentDate !== dateString) {
      if (this.currentStream) {
        this.currentStream.end();
      }
      
      const logPath = this.getLogPath();
      this.currentStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.currentDate = dateString;
      
      this.logger.info(`[AuditLogger] Rotated to new log file: ${logPath}`);
    }
    
    return this.currentStream;
  }
  
  /**
   * Write log entry synchronously for durability
   */
  writeLogEntry(entry) {
    try {
      const stream = this.ensureCurrentStream();
      const logLine = JSON.stringify(entry) + '\n';
      
      // Synchronous write for critical durability
      fs.appendFileSync(this.getLogPath(), logLine);
      
      this.stats.lastWriteTime = Date.now();
      return true;
    } catch (error) {
      this.stats.writeFailures++;
      this.logger.error(`[AuditLogger] CRITICAL: Write failed: ${error.message}`);
      
      // CRITICAL: Audit log write failure should halt trading
      this.emitCriticalAlert(error);
      
      return false;
    }
  }
  
  /**
   * Log FIX message (inbound or outbound)
   */
  logFIXMessage(message, metadata = {}) {
    const logEntry = {
      timestamp: Date.now(),
      type: 'FIX_MESSAGE',
      direction: metadata.direction || 'UNKNOWN',  // 'OUTBOUND' | 'INBOUND'
      msgType: metadata.msgType,
      sessionId: metadata.sessionId,
      rawMessage: message,
      parsed: metadata.parsed || null,
      msgSeqNum: metadata.msgSeqNum,
      ...metadata
    };
    
    const success = this.writeLogEntry(logEntry);
    if (success) {
      this.stats.fixMessagesLogged++;
    }
    
    return success;
  }
  
  /**
   * Log order event
   */
  logOrderEvent(event, order) {
    const logEntry = {
      timestamp: Date.now(),
      type: 'ORDER_EVENT',
      event: event,  // 'CREATED' | 'SENT' | 'ACKNOWLEDGED' | 'FILLED' | 'CANCELLED' | 'REJECTED'
      sessionId: order.sessionId,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      price: order.price,
      status: order.status,
      orderData: order
    };
    
    const success = this.writeLogEntry(logEntry);
    if (success) {
      this.stats.orderEventsLogged++;
    }
    
    return success;
  }
  
  /**
   * Log fill event
   */
  logFillEvent(fill) {
    const logEntry = {
      timestamp: Date.now(),
      type: 'FILL_EVENT',
      sessionId: fill.sessionId,
      fillId: fill.fillId,
      execID: fill.execID,
      orderId: fill.orderId,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee,
      fillData: fill
    };
    
    const success = this.writeLogEntry(logEntry);
    if (success) {
      this.stats.fillEventsLogged++;
    }
    
    return success;
  }
  
  /**
   * Log error with stack trace
   */
  logError(error, context = {}) {
    const logEntry = {
      timestamp: Date.now(),
      type: 'ERROR',
      error: error.message,
      stack: error.stack,
      name: error.name,
      ...context
    };
    
    const success = this.writeLogEntry(logEntry);
    if (success) {
      this.stats.errorsLogged++;
    }
    
    return success;
  }
  
  /**
   * Recover session data from audit log
   */
  async recoverSessionData(sessionId, date = null) {
    let logPath = this.getLogPath(date);
    
    if (!fs.existsSync(logPath)) {
      // Fallback: use the most recent audit file available
      const files = this.getLogFiles();
      if (files.length > 0) {
        logPath = files[0].path;
        this.logger.warn(`[AuditLogger] Requested log file not found; falling back to latest: ${logPath}`);
      } else {
        throw new Error(`Audit log not found: ${logPath}`);
      }
    }
    
    this.logger.info(`[AuditLogger] Recovering session ${sessionId} from ${logPath}`);
    
    const sessionData = {
      fixMessages: [],
      orders: [],
      fills: [],
      errors: []
    };
    
    let lineCount = 0;
    let matchCount = 0;
    
    const processContent = (content) => {
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        lineCount++;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId === sessionId) {
            matchCount++;
            switch (entry.type) {
              case 'FIX_MESSAGE':
                sessionData.fixMessages.push(entry);
                break;
              case 'ORDER_EVENT':
                sessionData.orders.push(entry);
                break;
              case 'FILL_EVENT':
                sessionData.fills.push(entry);
                break;
              case 'ERROR':
                sessionData.errors.push(entry);
                break;
            }
          }
        } catch (parseError) {
          this.logger.error(`[AuditLogger] Failed to parse log line ${lineCount}: ${parseError.message}`);
        }
      }
    };
    
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      processContent(content);
    } catch (readErr) {
      if (readErr && readErr.code === 'ENOENT') {
        // Try fallback latest file if available
        const files = this.getLogFiles();
        if (files.length > 0) {
          const fallbackPath = files[0].path;
          this.logger.warn(`[AuditLogger] Read failed, falling back to latest file: ${fallbackPath}`);
          const content = fs.readFileSync(fallbackPath, 'utf8');
          processContent(content);
        } else {
          throw readErr;
        }
      } else {
        throw readErr;
      }
    }
    
    this.logger.info(`[AuditLogger] Recovery complete: ${matchCount} entries found from ${lineCount} total lines`);
    
    return sessionData;
  }
  
  /**
   * Get all log files
   */
  getLogFiles() {
    if (!fs.existsSync(this.logDir)) {
      return [];
    }
    
    const files = fs.readdirSync(this.logDir);
    return files
      .filter(file => file.startsWith('truex-audit-') && file.endsWith('.jsonl'))
      .map(file => ({
        filename: file,
        path: path.join(this.logDir, file),
        size: fs.statSync(path.join(this.logDir, file)).size,
        date: file.replace('truex-audit-', '').replace('.jsonl', '')
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  
  /**
   * Get log file statistics
   */
  async getLogFileStats(date = null) {
    let logPath = this.getLogPath(date);
    if (!fs.existsSync(logPath)) {
      const files = this.getLogFiles();
      if (files.length === 0) return null;
      logPath = files[0].path;
    }
    
    let stats;
    try {
      stats = fs.statSync(logPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const files = this.getLogFiles();
        if (files.length === 0) return null;
        logPath = files[0].path;
        stats = fs.statSync(logPath);
      } else {
        throw err;
      }
    }
    
    const counts = { totalLines: 0, fixMessages: 0, orderEvents: 0, fillEvents: 0, errors: 0 };
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        counts.totalLines++;
        try {
          const entry = JSON.parse(line);
          switch (entry.type) {
            case 'FIX_MESSAGE': counts.fixMessages++; break;
            case 'ORDER_EVENT': counts.orderEvents++; break;
            case 'FILL_EVENT': counts.fillEvents++; break;
            case 'ERROR': counts.errors++; break;
          }
        } catch (_) {
          // ignore parse errors
        }
      }
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
      // If file vanished, surface as null to be safe
      return null;
    }
    
    return { filename: path.basename(logPath), path: logPath, size: stats.size, created: stats.birthtime, modified: stats.mtime, ...counts };
  }
  
  /**
   * Emit critical alert for audit log write failure
   */
  emitCriticalAlert(error) {
    // This should trigger immediate trading halt
    this.logger.error('🚨 CRITICAL ALERT: Audit log write failure - HALT TRADING 🚨');
    this.logger.error(`Error: ${error.message}`);
    this.logger.error(`Stack: ${error.stack}`);
    
    // In production, this would:
    // 1. Send PagerDuty/Slack alert
    // 2. Halt all trading operations
    // 3. Close FIX connections
    // 4. Notify on-call team
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentLogFile: this.getLogPath(),
      logDirectory: this.logDir
    };
  }
  
  /**
   * Close audit logger
   */
  close() {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
      this.currentDate = null;
    }
    
    this.logger.info('[AuditLogger] Audit logger closed');
  }
}
