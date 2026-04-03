import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * FIX Protocol Connection Manager for TrueX
 * 
 * Implements FIX 5.0 SP2 over FIXT.1.1 transport with dual endpoint support:
 * - TRUEX_UAT_OE: Order Entry endpoint
 * - TRUEX_UAT_MD: Market Data endpoint
 * 
 * Features:
 * - HMAC-SHA256 authentication
 * - Message sequence management
 * - Heartbeat handling
 * - Automatic reconnection with exponential backoff
 */
export class FIXConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Connection configuration
    this.host = options.host;
    this.port = options.port;
    this.senderCompID = options.senderCompID || 'CLI_CLIENT';
    this.targetCompID = options.targetCompID; // TRUEX_UAT_OE or TRUEX_UAT_MD
    
    // Authentication
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    
    // Protocol settings
    this.beginString = 'FIXT.1.1';
    this.defaultApplVerID = 'FIX.5.0SP2';
    this.heartbeatInterval = options.heartbeatInterval || 30; // seconds
    
    // Connection state
    this.socket = null;
    this.isConnected = false;
    this.isLoggedOn = false;
    
    // Message sequence numbers
    this.msgSeqNum = 1;
    this.expectedSeqNum = 1;

    // Optional Redis client for sequence number persistence
    this.redisClient = options.redisClient || null;
    // Include targetCompID to distinguish OE vs MD sessions sharing the same senderCompID
    this._seqKeyOut = `fix:seq:${this.senderCompID}:${this.targetCompID}:out`;
    this._seqKeyIn = `fix:seq:${this.senderCompID}:${this.targetCompID}:in`;

    // Track whether this is the first ever connect (vs reconnect)
    this.hasConnectedBefore = false;
    
    // Heartbeat management
    this.heartbeatTimer = null;
    this.lastHeartbeatReceived = null;
    this.lastHeartbeatSent = null;
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.initialReconnectDelay = options.initialReconnectDelay || 1000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.isReconnecting = false; // guard against duplicate reconnect scheduling
    
    // Message buffer for incomplete messages
    this.messageBuffer = '';
    
    // Message storage for resend requests
    this.sentMessages = new Map(); // seq -> { seqNum, fields, rawMessage, sentAt }
    this.maxStoredMessages = options.maxStoredMessages || 10000;
    this.messageRetentionMs = options.messageRetentionMs || 3600000; // 1 hour default
    
    // Logger
    this.logger = options.logger || console;
    // Optional audit logger
    this.auditLogger = options.auditLogger || null;
    
    // FIX message delimiter
    this.SOH = '\x01'; // Start of Header (ASCII 1)
    
    // Cleanup timer for message storage
    this.cleanupTimer = null;
    this.cleanupInterval = options.cleanupInterval || 300000; // 5 minutes default
  }

  /**
   * Clean up old messages from storage to prevent memory leaks
   * Removes messages older than messageRetentionMs and enforces maxStoredMessages cap
   * @private
   */
  cleanupOldMessages() {
    const now = Date.now();
    let removedByAge = 0;
    let removedByCap = 0;
    
    // 1. Remove messages older than messageRetentionMs
    for (const [seq, stored] of this.sentMessages.entries()) {
      if (now - stored.sentAt > this.messageRetentionMs) {
        this.sentMessages.delete(seq);
        removedByAge++;
      }
    }
    
    // 2. Enforce maxStoredMessages cap (FIFO removal)
    if (this.sentMessages.size > this.maxStoredMessages) {
      // Sort by sequence number (oldest first)
      const sortedSeqs = Array.from(this.sentMessages.keys()).sort((a, b) => a - b);
      const toRemove = this.sentMessages.size - this.maxStoredMessages;
      
      for (let i = 0; i < toRemove; i++) {
        this.sentMessages.delete(sortedSeqs[i]);
        removedByCap++;
      }
    }
    
    // Log cleanup summary at debug level
    if ((removedByAge > 0 || removedByCap > 0) && this.logger.debug) {
      this.logger.debug(
        `[FIXConnection] Cleanup: removed ${removedByAge} expired, ${removedByCap} over cap. ` +
        `Current: ${this.sentMessages.size}/${this.maxStoredMessages}`
      );
    }
    
    return { removedByAge, removedByCap, currentSize: this.sentMessages.size };
  }
  
  /**
   * Start periodic cleanup timer
   * @private
   */
  startCleanupTimer() {
    if (this.cleanupTimer) {
      return; // Already running
    }
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldMessages();
    }, this.cleanupInterval);
    
    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
    
    if (this.logger.debug) {
      this.logger.debug(`[FIXConnection] Cleanup timer started (interval: ${this.cleanupInterval}ms)`);
    }
  }
  
  /**
   * Stop periodic cleanup timer
   * @private
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      
      if (this.logger.debug) {
        this.logger.debug('[FIXConnection] Cleanup timer stopped');
      }
    }
  }

  /**
   * Redact sensitive tags (553/554) in raw FIX string before logging
   */
  redactRaw(raw) {
    try {
      // Replace 553 and 554 values up to SOH
      const soh = this.SOH;
      return raw
        .replace(new RegExp(`${soh}553=[^${soh}]*${soh}`,'g'), `${soh}553=[REDACTED]${soh}`)
        .replace(new RegExp(`${soh}554=[^${soh}]*${soh}`,'g'), `${soh}554=[REDACTED]${soh}`);
    } catch {
      return raw;
    }
  }
  
  /**
   * Load persisted sequence numbers from Redis.
   * Defaults to 1 when the key is missing.
   */
  async loadSequenceNumbers() {
    if (!this.redisClient) return;
    const [outVal, inVal] = await Promise.all([
      this.redisClient.get(this._seqKeyOut),
      this.redisClient.get(this._seqKeyIn),
    ]);
    this.msgSeqNum = outVal ? parseInt(outVal, 10) : 1;
    this.expectedSeqNum = inVal ? parseInt(inVal, 10) : 1;
  }

  /**
   * Connect to FIX server
   */
  async connect() {
    // Load persisted sequence numbers from Redis before connecting.
    // This handles both crash-recovery (first connect after restart) and mid-process reconnects.
    // loadSequenceNumbers() defaults to 1 when keys are absent, so no separate reset is needed
    // when Redis is available. The reset-to-1 in the socket callback is skipped when Redis is
    // configured (see below) to avoid overwriting the loaded values.
    if (this.redisClient) {
      try {
        await this.loadSequenceNumbers();
      } catch (err) {
        this.logger.warn(`[FIXConnection] Redis seqnum load failed, starting from 1: ${err.message}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.logger.info(`[FIXConnection] Connecting to ${this.targetCompID} at ${this.host}:${this.port}`);

      // Reset heartbeat timestamps so stale values from a previous session cannot
      // trigger an immediate disconnect the moment startHeartbeat() fires.
      this.lastHeartbeatReceived = null;
      this.lastHeartbeatSent = null;

      // Cancel any pending reconnect timer so it cannot fire a second connection.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Clear the reconnect guard so a fresh connect attempt is always allowed.
      this.isReconnecting = false;
      
      this.socket = new net.Socket();
      let settled = false;
      let logonTimeout = null;
      
      // Connection timeout
      const timeout = setTimeout(() => {
        if (this.socket) this.socket.destroy();
        if (!settled) {
          settled = true;
          reject(new Error('Connection timeout'));
        }
      }, 30000);
      
      // Handle incoming data
      this.socket.on('data', (data) => {
        this.handleIncomingData(data);
      });
      
      // Handle connection close
      this.socket.on('close', () => {
        this.logger.warn(`[FIXConnection] Connection closed to ${this.targetCompID}`);
        this.handleDisconnect();
      });
      
      // Handle errors
      this.socket.on('error', (error) => {
        this.logger.error(`[FIXConnection] Socket error: ${error.message}`);
        if (logonTimeout) clearTimeout(logonTimeout);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('error', error);
      });

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        this.logger.info(`[FIXConnection] TCP connection established to ${this.targetCompID}`);
        this.isConnected = true;

        // Reset sequence numbers to 1 only on first connect when Redis is not configured.
        // When Redis is available, loadSequenceNumbers() already set the correct values
        // (defaulting to 1 when no keys exist), so resetting here would overwrite them.
        const isReconnect = this.hasConnectedBefore;
        if (!isReconnect && !this.redisClient) {
          this.msgSeqNum = 1;
          this.expectedSeqNum = 1;
        }

        // Wait for proxy to establish connection to TrueX (if using proxy)
        // This delay is critical when connecting through a proxy server
        this.logger.info(`[FIXConnection] Waiting for connection setup...`);
        setTimeout(() => {
          // Send logon message
          this.sendLogon(isReconnect)
            .then(() => {
              this.logger.info(`[FIXConnection] Logon message sent to ${this.targetCompID}`);
              
              // Wait for logon response
              logonTimeout = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  reject(new Error('Logon timeout - no response from server'));
                }
              }, 10000);
            
            // Listen for logon response
            const logonHandler = (message) => {
              if (message.fields['35'] === 'A') { // Logon message
                if (logonTimeout) clearTimeout(logonTimeout);
                this.removeListener('message', logonHandler);

                // Check SessionStatus (1409) — non-zero means the exchange
                // accepted the TCP logon but flagged a session-level problem.
                // 9 = MsgSeqNum too low (seqnum mismatch on reconnect).
                // 5 = Invalid API key/signature. 6 = Account locked.
                const sessionStatus = message.fields['1409'];
                if (sessionStatus && sessionStatus !== '0') {
                  const statusMessages = {
                    '5': 'Invalid API key or signature',
                    '6': 'Account locked',
                    '7': 'Logins not allowed at this time',
                    '9': 'MsgSeqNum too low — seqnum mismatch, will reset on next reconnect',
                  };
                  const statusText = statusMessages[sessionStatus] || `SessionStatus=${sessionStatus}`;
                  this.logger.error(`[FIXConnection] Logon to ${this.targetCompID} has session problem: ${statusText}`);

                  // For seqnum mismatch (9): force a full reset on next reconnect
                  // by clearing hasConnectedBefore so 141=Y is sent with seqnum=1.
                  if (sessionStatus === '9') {
                    this.hasConnectedBefore = false;
                    this.msgSeqNum = 1;
                    this.expectedSeqNum = 1;
                  }

                  if (!settled) {
                    settled = true;
                    reject(new Error(`Logon session problem: ${statusText}`));
                  }
                  return;
                }

                this.isLoggedOn = true;
                this.hasConnectedBefore = true;
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                this.startCleanupTimer(); // Start periodic message cleanup
                this.logger.info(`[FIXConnection] Logged on to ${this.targetCompID}`);
                if (!settled) {
                  settled = true;
                  resolve();
                }
              } else if (message.fields['35'] === '3') { // Reject
                if (logonTimeout) clearTimeout(logonTimeout);
                this.removeListener('message', logonHandler);
                const rejectReason = message.fields['58'] || 'Unknown reason';
                if (!settled) {
                  settled = true;
                  reject(new Error(`Logon rejected: ${rejectReason}`));
                }
              }
            };
            
            this.on('message', logonHandler);
          })
          .catch(reject);
        }, 2000); // Wait 2 seconds for proxy to establish TrueX connection
      });
      
    });
  }
  
  /**
   * Send FIX Logon message with HMAC-SHA256 authentication
   * @param {boolean} isReconnect - true when reconnecting to preserve seqnums
   */
  async sendLogon(isReconnect = false) {
    const sendingTime = this.getUTCTimestamp();
    const msgType = 'A';
    const msgSeqNum = this.msgSeqNum.toString();

    // Build signature payload using TrueX specification:
    // sending_time + msg_type + msg_seq_num + sender_comp_id + target_comp_id + username
    const signaturePayload = sendingTime + msgType + msgSeqNum + this.senderCompID + this.targetCompID + this.apiKey;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(signaturePayload)
      .digest('base64');  // TrueX uses base64, not hex

    const fields = {
      '8': this.beginString,           // BeginString
      '35': msgType,                    // MsgType = Logon
      '49': this.senderCompID,          // SenderCompID
      '56': this.targetCompID,          // TargetCompID
      '34': msgSeqNum,                  // MsgSeqNum
      '52': sendingTime,                // SendingTime
      '58': 'CancelOnDisconnect=Y',     // Cancel open orders on disconnect
      '98': '0',                        // EncryptMethod = None
      '108': this.heartbeatInterval.toString(), // HeartBtInt
      '553': this.apiKey,               // Username
      '554': signature,                 // Password = HMAC signature (base64)
      '1137': this.defaultApplVerID     // DefaultApplVerID
    };

    // Only reset sequence numbers on initial logon, not reconnects.
    // On reconnect, preserve seqnums so the exchange can do normal gap recovery.
    if (!isReconnect) {
      fields['141'] = 'Y'; // ResetSeqNumFlag
    }

    await this.sendMessage(fields);
  }
  
  /**
   * Send FIX message
   */
  async sendMessage(fields) {
    // Ensure standard header fields are present
    const completeFields = {
      '34': this.msgSeqNum.toString(),       // MsgSeqNum (auto-increment)
      '49': this.senderCompID,               // SenderCompID
      '52': this.getUTCTimestamp(),          // SendingTime
      '56': this.targetCompID,               // TargetCompID
      // Note: DefaultApplVerID (1137) is ONLY for Logon messages, not for orders
      ...fields  // User-provided fields can override defaults
    };
    
    // Define strict field order per FIX protocol
    // Header fields (8,9,34,35,49,56,52) MUST come first, then body fields
    const headerFieldOrder = ['35', '49', '56', '34', '52'];  // Order after 8 and 9
    const commonBodyFields = ['11', '18', '41', '38', '40', '44', '54', '55', '59', '453', '448', '452'];  // Body fields + Party ID in order: 453→448→452
    
    // Build message body with STRICT field ordering
    let body = '';
    
    // 1. Add header fields first (in order)
    for (const tag of headerFieldOrder) {
      if (completeFields[tag]) {
        body += `${tag}=${completeFields[tag]}${this.SOH}`;
      }
    }
    
    // 2. Add common body fields (in order)
    for (const tag of commonBodyFields) {
      if (completeFields[tag]) {
        body += `${tag}=${completeFields[tag]}${this.SOH}`;
      }
    }
    
    // 3. Add any remaining fields not in the predefined lists (except 8, 9, 10)
    const processedTags = new Set([...headerFieldOrder, ...commonBodyFields, '8', '9', '10']);
    for (const [tag, value] of Object.entries(completeFields)) {
      if (!processedTags.has(tag) && value !== undefined) {
        body += `${tag}=${value}${this.SOH}`;
      }
    }
    
    // Calculate body length
    const bodyLength = body.length;
    
    // Build complete message
    let message = `8=${this.beginString}${this.SOH}`;
    message += `9=${bodyLength}${this.SOH}`;
    message += body;
    
    // Calculate checksum
    const checksum = this.calculateChecksum(message);
    message += `10=${checksum}${this.SOH}`;
    
    // Store message for potential resend requests (before sending)
    const currentSeqNum = this.msgSeqNum;
    this.sentMessages.set(currentSeqNum, {
      seqNum: currentSeqNum,
      fields: { ...fields }, // Clone fields to avoid mutations
      rawMessage: message,
      sentAt: Date.now()
    });
    
    // Debug log message storage
    if (this.logger.debug) {
      this.logger.debug(`[FIXConnection] Stored message seq ${currentSeqNum} (total: ${this.sentMessages.size})`);
    }
    
    this.logger.info(`[FIXConnection] Stored message seq ${currentSeqNum} (total: ${this.sentMessages.size})`);
    
    // Debug: Log raw message being sent
    if (process.env.TRUEX_DEBUG_MODE === 'true') {
      const preview = message.replace(/\x01/g, '|').substring(0, 300);
      this.logger.info(`[FIXConnection] Sending raw: ${preview}${message.length > 300 ? '...' : ''}`);
    }
    
    // Send message with basic precondition checks
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket is not writable');
    }
    const wrote = this.socket.write(message);
    if (wrote === false) {
      await new Promise((resolve) => this.socket.once('drain', resolve));
    }
    // Audit log outbound FIX if configured
    if (this.auditLogger) {
      const currentSeq = this.msgSeqNum; // before increment
      const redacted = this.redactRaw(message);
      this.auditLogger.logFIXMessage(redacted, {
        direction: 'OUTBOUND',
        msgType: fields['35'],
        msgSeqNum: currentSeq,
        senderCompID: this.senderCompID,
        targetCompID: this.targetCompID
      });
    }
    
    // Increment sequence number
    this.msgSeqNum++;

    // Fire-and-forget: persist outbound sequence number to Redis (must not block)
    if (this.redisClient) {
      void this.redisClient.set(this._seqKeyOut, this.msgSeqNum)
        .catch(err => this.logger.warn(`[FIXConnection] Failed to persist outbound seqnum: ${err.message}`));
    }

    // Emit sent event with redacted sensitive fields
    const redactedFields = { ...fields };
    if (redactedFields['553']) redactedFields['553'] = '[REDACTED]';
    if (redactedFields['554']) redactedFields['554'] = '[REDACTED]';
    this.emit('sent', { raw: message, fields: redactedFields, msgSeqNum: this.msgSeqNum - 1 });
    
    return { raw: message, fields, msgSeqNum: this.msgSeqNum - 1 };
  }
  
  /**
   * Handle incoming data from socket
   */
  handleIncomingData(data) {
    // Append to buffer
    this.messageBuffer += data.toString('binary');
    
    // Process complete messages
    let processed = 0;
    const MAX_PER_TICK = 50;
    while (true) {
      // Find message boundaries (8=FIXT.1.1 to 10=xxx)
      const startIndex = this.messageBuffer.indexOf('8=');
      if (startIndex === -1) break;
      
      // Look for checksum field (10=)
      const checksumIndex = this.messageBuffer.indexOf(`${this.SOH}10=`, startIndex);
      if (checksumIndex === -1) break;
      
      // Find end of checksum (next SOH)
      const endIndex = this.messageBuffer.indexOf(this.SOH, checksumIndex + 4);
      if (endIndex === -1) break;
      
      // Extract complete message
      const rawMessage = this.messageBuffer.substring(startIndex, endIndex + 1);
      this.messageBuffer = this.messageBuffer.substring(endIndex + 1);
      
      // Parse and emit message
      const parsedMessage = this.parseMessage(rawMessage);
      if (parsedMessage) {
        this.handleMessage(parsedMessage);
      }
      processed++;
      if (processed >= MAX_PER_TICK) {
        // Yield to event loop to avoid blocking under high load
        setImmediate(() => this.handleIncomingData(Buffer.from('')));
        break;
      }
    }
  }
  
  /**
   * Parse FIX message
   */
  parseMessage(rawMessage) {
    const fields = {};
    const parts = rawMessage.split(this.SOH);
    
    for (const part of parts) {
      if (!part) continue;
      const [tag, value] = part.split('=');
      if (tag && value !== undefined) {
        fields[tag] = value;
      }
    }
    
    return {
      raw: rawMessage,
      fields: fields
    };
  }
  
  /**
   * Handle parsed FIX message
   */
  handleMessage(message) {
    const msgType = message.fields['35'];
    const msgSeqNum = parseInt(message.fields['34']);
    // Audit log inbound FIX if configured
    if (this.auditLogger && message && message.raw) {
      const redacted = this.redactRaw(message.raw);
      this.auditLogger.logFIXMessage(redacted, {
        direction: 'INBOUND',
        msgType,
        msgSeqNum,
        senderCompID: this.senderCompID,
        targetCompID: this.targetCompID
      });
    }
    
    // Validate sequence number
    const seqStatus = this.validateSequence(msgSeqNum);
    if (seqStatus === 'DUPLICATE') {
      this.logger.warn(`[FIXConnection] Duplicate message received: seq ${msgSeqNum}, MsgType=${msgType}`);
      if (process.env.TRUEX_DEBUG_MODE === 'true') {
        this.logger.warn(`[FIXConnection] Duplicate message fields:`, message.fields);
      }
      return;
    } else if (seqStatus === 'GAP') {
      this.logger.error(`[FIXConnection] Sequence gap detected: expected ${this.expectedSeqNum}, received ${msgSeqNum}`);
      this.requestResend(this.expectedSeqNum, msgSeqNum - 1);
      return;
    }
    
    // Handle specific message types
    switch (msgType) {
      case '0': // Heartbeat
        this.handleHeartbeat(message);
        break;
      case '1': // Test Request
        this.handleTestRequest(message);
        break;
      case '2': // Resend Request
        this.handleResendRequest(message);
        break;
      case '3': // Reject
        this.handleReject(message);
        break;
      case '5': // Logout
        this.handleLogout(message);
        break;
      default:
        // Emit message for application handling
        this.emit('message', message);
    }
  }
  
  /**
   * Validate message sequence number
   */
  validateSequence(receivedSeqNum) {
    if (receivedSeqNum < this.expectedSeqNum) {
      return 'DUPLICATE';
    } else if (receivedSeqNum > this.expectedSeqNum) {
      return 'GAP';
    } else {
      this.expectedSeqNum++;
      // Fire-and-forget: persist inbound expected sequence number to Redis (must not block)
      if (this.redisClient) {
        void this.redisClient.set(this._seqKeyIn, this.expectedSeqNum)
          .catch(err => this.logger.warn(`[FIXConnection] Failed to persist inbound seqnum: ${err.message}`));
      }
      return 'OK';
    }
  }
  
  /**
   * Request resend of missing messages
   */
  async requestResend(beginSeqNo, endSeqNo) {
    this.logger.info(`[FIXConnection] Requesting resend: ${beginSeqNo} to ${endSeqNo}`);
    
    const fields = {
      '8': this.beginString,
      '35': '2',                        // MsgType = Resend Request
      '49': this.senderCompID,
      '56': this.targetCompID,
      '34': this.msgSeqNum.toString(),
      '52': this.getUTCTimestamp(),
      '7': beginSeqNo.toString(),       // BeginSeqNo
      '16': endSeqNo.toString(),        // EndSeqNo
      '1137': this.defaultApplVerID
    };
    
    await this.sendMessage(fields);
    this.emit('resend-request', { beginSeqNo, endSeqNo });
  }
  
  /**
   * Handle heartbeat message
   */
  handleHeartbeat(message) {
    this.lastHeartbeatReceived = Date.now();
    this.logger.debug(`[FIXConnection] Heartbeat received from ${this.targetCompID}`);
  }
  
  /**
   * Handle test request
   */
  async handleTestRequest(message) {
    const testReqID = message.fields['112'];
    this.logger.debug(`[FIXConnection] Test request received: ${testReqID}`);
    
    // Send heartbeat response
    const fields = {
      '8': this.beginString,
      '35': '0',                        // MsgType = Heartbeat
      '49': this.senderCompID,
      '56': this.targetCompID,
      '34': this.msgSeqNum.toString(),
      '52': this.getUTCTimestamp(),
      '112': testReqID,                 // TestReqID
      '1137': this.defaultApplVerID
    };
    
    await this.sendMessage(fields);
  }
  
  /**
   * Handle resend request from server
   */
  handleResendRequest(message) {
    // Parse resend request fields
    const beginSeqNo = parseInt(message.fields['7']);
    const endSeqNoField = parseInt(message.fields['16']);
    
    // Handle EndSeqNo = 0 as "all messages from BeginSeqNo onwards"
    const endSeqNo = endSeqNoField === 0 ? this.msgSeqNum - 1 : endSeqNoField;
    
    this.logger.warn(`[FIXConnection] Server requested resend: ${beginSeqNo} to ${endSeqNoField === 0 ? '∞' : endSeqNo} (actual: ${endSeqNo})`);
    
    // Validate range
    if (beginSeqNo < 1 || endSeqNo < beginSeqNo) {
      this.logger.error(`[FIXConnection] Invalid resend range: ${beginSeqNo} to ${endSeqNo}`);
      this.emit('resend-request-received', { beginSeqNo, endSeqNo, count: 0, error: 'Invalid range' });
      return;
    }
    
    // Track resend statistics
    let resentCount = 0;
    let skippedCount = 0;
    
    // Iterate through requested sequence range
    for (let seq = beginSeqNo; seq <= endSeqNo; seq++) {
      // Lookup message from storage
      const stored = this.sentMessages.get(seq);
      
      if (stored) {
        try {
          // Clone fields to avoid mutating stored data
          const clonedFields = { ...stored.fields };
          
          // Add PossDupFlag (field 43) to indicate possibly duplicate message
          clonedFields['43'] = 'Y';
          
          // Update SendingTime (field 52) to NOW for resent messages
          // Per FIX spec, SendingTime should be the current time when resending
          clonedFields['52'] = this.getUTCTimestamp();
          
          // Note: OrigSendingTime (field 122) would hold the original time
          // but TrueX rejects messages with field 122, so we omit it
          
          // Rebuild FIX message from stored fields with correct header ordering.
          // NOTE: Object.entries() sorts integer keys numerically (7,16,34,35,...),
          // which puts body fields before MsgType (35). We must explicitly order
          // header fields first to comply with FIX spec.
          const bodyFields = { ...clonedFields };
          delete bodyFields['8'];  // BeginString
          delete bodyFields['9'];  // BodyLength
          delete bodyFields['10']; // CheckSum

          const headerFieldOrder = ['35', '49', '56', '34', '52'];
          let body = '';

          // 1. Header fields in required order
          for (const tag of headerFieldOrder) {
            if (bodyFields[tag] !== undefined) {
              body += `${tag}=${bodyFields[tag]}${this.SOH}`;
            }
          }

          // 2. Remaining fields (excluding header tags already written)
          const processedTags = new Set(headerFieldOrder);
          for (const [tag, value] of Object.entries(bodyFields)) {
            if (!processedTags.has(tag) && value !== undefined) {
              body += `${tag}=${value}${this.SOH}`;
            }
          }
          
          // Calculate body length
          const bodyLength = body.length;
          
          // Build complete message
          let resendMessage = `8=${this.beginString}${this.SOH}`;
          resendMessage += `9=${bodyLength}${this.SOH}`;
          resendMessage += body;
          
          // Calculate checksum
          const checksum = this.calculateChecksum(resendMessage);
          resendMessage += `10=${checksum}${this.SOH}`;
          
          // Write reconstructed message to socket
          if (this.socket && !this.socket.destroyed) {
            this.socket.write(resendMessage);
            resentCount++;
            
            // Log each resent message at INFO level
            this.logger.info(`[FIXConnection] Resent message seq ${seq}`);
          } else {
            this.logger.error(`[FIXConnection] Cannot resend seq ${seq}: socket not writable`);
            skippedCount++;
          }
        } catch (error) {
          this.logger.error(`[FIXConnection] Error resending seq ${seq}: ${error.message}`);
          skippedCount++;
        }
      } else {
        // Message not in storage - log warning and continue
        this.logger.warn(`[FIXConnection] Message seq ${seq} not in storage, skipping`);
        skippedCount++;
      }
    }
    
    // Log summary after completion
    this.logger.info(`[FIXConnection] Resend complete: ${resentCount} messages resent, ${skippedCount} skipped (${beginSeqNo}-${endSeqNo})`);
    
    // Emit resendCompleted event with statistics
    this.emit('resendCompleted', {
      beginSeqNo,
      endSeqNo,
      count: resentCount,
      skipped: skippedCount,
      requested: endSeqNo - beginSeqNo + 1
    });
  }
  
  /**
   * Handle reject message
   */
  handleReject(message) {
    const rejectReason = message.fields['58'] || 'Unknown';
    const refSeqNum = message.fields['45'];
    this.logger.error(`[FIXConnection] Message rejected: ${rejectReason} (RefSeqNum: ${refSeqNum})`);
    this.emit('reject', { reason: rejectReason, refSeqNum, message });
  }
  
  /**
   * Handle logout message
   */
  handleLogout(message) {
    const text = message.fields['58'] || '';
    this.logger.info(`[FIXConnection] Logout received: ${text}`);
    this.isLoggedOn = false;
    this.emit('logout', { text, message });
  }
  
  /**
   * Start heartbeat timer
   */
  startHeartbeat() {
    this.stopHeartbeat();
    
    const intervalMs = this.heartbeatInterval * 1000;
    
    this.heartbeatTimer = setInterval(async () => {
      // Check if we've received a heartbeat recently
      const now = Date.now();
      if (this.lastHeartbeatReceived && (now - this.lastHeartbeatReceived) > intervalMs * 2) {
        this.logger.error(`[FIXConnection] No heartbeat received for ${(now - this.lastHeartbeatReceived) / 1000}s`);
        this.handleDisconnect();
        return;
      }
      
      // Send heartbeat
      const fields = {
        '8': this.beginString,
        '35': '0',                        // MsgType = Heartbeat
        '49': this.senderCompID,
        '56': this.targetCompID,
        '34': this.msgSeqNum.toString(),
        '52': this.getUTCTimestamp(),
        '1137': this.defaultApplVerID
      };
      
      await this.sendMessage(fields);
      this.lastHeartbeatSent = Date.now();
      this.logger.debug(`[FIXConnection] Heartbeat sent to ${this.targetCompID}`);
    }, intervalMs);
  }
  
  /**
   * Stop heartbeat timer
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  /**
   * Handle disconnection
   */
  handleDisconnect() {
    this.isConnected = false;
    this.isLoggedOn = false;
    this.stopHeartbeat();
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.emit('disconnect');
    
    // Attempt reconnection unless this was an explicit disconnect request
    if (this.intentionalClose) {
      // Reset flag and do not reconnect
      this.intentionalClose = false;
      return;
    }
    this.attemptReconnect();
  }
  
  /**
   * Attempt reconnection with exponential backoff.
   *
   * Guards against duplicate reconnect scheduling: when both the logon-timeout
   * promise rejection AND the socket 'close' event fire in the same tick, only
   * the first call proceeds.  The guard is cleared at the start of connect() so
   * the next connection attempt always gets a clean slate.
   */
  attemptReconnect() {
    // Max-retry check always runs first so the flag is always cleaned up.
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`[FIXConnection] Max reconnection attempts reached for ${this.targetCompID}`);
      this.isReconnecting = false;
      this.emit('max-reconnect-attempts');
      return;
    }

    // Prevent two parallel reconnect timers (Bug 2 guard).
    if (this.isReconnecting) {
      this.logger.warn(`[FIXConnection] Reconnect already scheduled for ${this.targetCompID}, ignoring duplicate call`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    this.logger.info(`[FIXConnection] Reconnecting to ${this.targetCompID} in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.logger.error(`[FIXConnection] Reconnection failed: ${error.message}`);
        this.attemptReconnect();
      });
    }, delay);
  }
  
  /**
   * Send logout and disconnect
   */
  async disconnect() {
    this.logger.info(`[FIXConnection] Disconnecting from ${this.targetCompID}`);
    this.intentionalClose = true;
    
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Send logout if logged on
    if (this.isLoggedOn) {
      const fields = {
        '8': this.beginString,
        '35': '5',                        // MsgType = Logout
        '49': this.senderCompID,
        '56': this.targetCompID,
        '34': this.msgSeqNum.toString(),
        '52': this.getUTCTimestamp(),
        '1137': this.defaultApplVerID
      };
      
      await this.sendMessage(fields);
    }
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Stop cleanup timer
    this.stopCleanupTimer();
    
    // Close socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.isConnected = false;
    this.isLoggedOn = false;
  }
  
  /**
   * Calculate FIX checksum
   */
  calculateChecksum(message) {
    let sum = 0;
    for (let i = 0; i < message.length; i++) {
      sum += message.charCodeAt(i);
    }
    return String(sum % 256).padStart(3, '0');
  }
  
  /**
   * Get UTC timestamp in FIX format (YYYYMMDD-HH:MM:SS.sss)
   */
  getUTCTimestamp() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
    
    return `${year}${month}${day}-${hours}:${minutes}:${seconds}.${milliseconds}`;
  }
  
  /**
   * Get connection state
   */
  getState() {
    return {
      isConnected: this.isConnected,
      isLoggedOn: this.isLoggedOn,
      targetCompID: this.targetCompID,
      msgSeqNum: this.msgSeqNum,
      expectedSeqNum: this.expectedSeqNum,
      reconnectAttempts: this.reconnectAttempts,
      lastHeartbeatReceived: this.lastHeartbeatReceived,
      lastHeartbeatSent: this.lastHeartbeatSent
    };
  }
}
