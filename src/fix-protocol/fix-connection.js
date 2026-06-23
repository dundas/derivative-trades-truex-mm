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
/** Emit 'reconnect-threshold' alert after this many failed attempts, but keep retrying. */
const MAX_RECONNECT_ALERT_THRESHOLD = 10;

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
    this._stableTimer = null;    // clears reconnectAttempts after 60s stable connection
    this._connectionGeneration = 0; // guards stale socket callbacks/timers
    this._logonSetupTimer = null;
    
    // Message buffer for incomplete messages
    this.messageBuffer = '';
    
    // Message storage for resend requests
    this.sentMessages = new Map(); // seq -> { seqNum, fields, rawMessage, sentAt }
    this.maxStoredMessages = options.maxStoredMessages || 10000;
    this.messageRetentionMs = options.messageRetentionMs || 3600000; // 1 hour default

    // Resend failure tracking for auto-reset
    this._resendGapStart = null; // Track current gap begin seq
    this._resendAttempts = 0;    // Consecutive resend attempts for same gap
    this._maxResendAttempts = options.maxResendAttempts || 3; // Max before forcing reset

    // Logon-timeout fallback: after N consecutive logon timeouts (server accepts
    // TCP but never sends Logon Ack — observed when the counterparty restarts
    // their FIX gateway while we have a persisted session), retry once with
    // ResetSeqNumFlag=Y so both sides reset to seq 1. Converts multi-hour
    // session-resume loops into a single recovery cycle.
    this._consecutiveLogonTimeouts = 0;
    this._logonResetFallbackEnabled = options.logonResetFallbackEnabled ?? true;
    // Reject 0 / negative / NaN explicitly (preserve the documented default)
    // so an env-misconfig doesn't silently fall back to seq-reset on every retry.
    const rawThreshold = options.logonResetThreshold;
    this._logonResetThreshold = Number.isInteger(rawThreshold) && rawThreshold > 0
      ? rawThreshold
      : 3;
    // Loop guard: if the reset fallback fires this many times in a row without
    // a successful Logon Ack, stop trying resets (we are clearly not the bug)
    // and emit `logon-reset-fallback-exhausted` for ops escalation. Prevents
    // churning TrueX-side session state when the real failure is elsewhere.
    this._consecutiveResetFallbacks = 0;
    const rawMax = options.maxConsecutiveResetFallbacks;
    this._maxConsecutiveResetFallbacks = Number.isInteger(rawMax) && rawMax > 0
      ? rawMax
      : 3;

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
   * Force a clean local sequence reset and clear persisted Redis seqnums.
   */
  async resetSequenceNumbers() {
    this.msgSeqNum = 1;
    this.expectedSeqNum = 1;
    this.hasConnectedBefore = false;

    if (!this.redisClient) return;
    try {
      if (typeof this.redisClient.del === 'function') {
        await this.redisClient.del(this._seqKeyOut, this._seqKeyIn);
      } else {
        await Promise.all([
          this.redisClient.set(this._seqKeyOut, 1),
          this.redisClient.set(this._seqKeyIn, 1),
        ]);
      }
    } catch (err) {
      this.logger.warn(`[FIXConnection] Failed to reset persisted seqnums: ${err.message}`);
    }
  }

  /**
   * Stop timers that should not survive a failed connection attempt.
   * @private
   */
  _clearLifecycleTimers() {
    this.stopHeartbeat();
    this.stopCleanupTimer();
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    if (this._logonSetupTimer) {
      clearTimeout(this._logonSetupTimer);
      this._logonSetupTimer = null;
    }
  }

  async _forceSessionReset(reason, details = {}) {
    this.logger.error(`[FIXConnection] Forcing session reset: ${reason}`);
    await this.resetSequenceNumbers();
    this._resendGapStart = null;
    this._resendAttempts = 0;
    this.emit('session-reset-forced', { reason, ...details });

    if (this.socket && !this.socket.destroyed) {
      const socket = this.socket;
      const generation = this._connectionGeneration;
      this.socket.destroy();
      this.handleDisconnect(socket, generation);
    } else {
      this.handleDisconnect();
    }
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
      
      const generation = ++this._connectionGeneration;
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;
      let logonTimeout = null;
      let logonHandler = null;
      let rejectHandler = null;
      let setupTimer = null;

      const isCurrentAttempt = () => this.socket === socket && this._connectionGeneration === generation;
      const cleanupAttempt = (destroySocket = true) => {
        if (logonTimeout) {
          clearTimeout(logonTimeout);
          logonTimeout = null;
        }
        clearTimeout(timeout);
        if (setupTimer) {
          clearTimeout(setupTimer);
          if (this._logonSetupTimer === setupTimer) this._logonSetupTimer = null;
          setupTimer = null;
        }
        if (logonHandler) {
          this.removeListener('message', logonHandler);
          logonHandler = null;
        }
        if (rejectHandler) {
          this.removeListener('reject', rejectHandler);
          rejectHandler = null;
        }
        if (isCurrentAttempt()) {
          if (destroySocket && socket && !socket.destroyed) {
            socket.destroy();
          }
          this.handleDisconnect(socket, generation);
        }
      };
      
      // Connection timeout
      const timeout = setTimeout(() => {
        if (!isCurrentAttempt()) return;
        cleanupAttempt(true);
        if (!settled) {
          settled = true;
          reject(new Error('Connection timeout'));
        }
      }, 30000);
      
      // Handle incoming data
      socket.on('data', (data) => {
        if (!isCurrentAttempt()) return;
        this.handleIncomingData(data);
      });
      
      // Handle connection close
      socket.on('close', () => {
        if (!isCurrentAttempt()) return;
        this.logger.warn(`[FIXConnection] Connection closed to ${this.targetCompID}`);
        this.handleDisconnect(socket, generation);
      });
      
      // Handle errors
      socket.on('error', (error) => {
        if (!isCurrentAttempt()) return;
        this.logger.error(`[FIXConnection] Socket error: ${error.message}`);
        cleanupAttempt(false);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('error', error);
      });

      socket.connect(this.port, this.host, () => {
        if (!isCurrentAttempt()) return;
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
        setupTimer = setTimeout(async () => {
          if (!isCurrentAttempt()) return;
          const firedSetupTimer = setupTimer;
          setupTimer = null;
          if (this._logonSetupTimer === firedSetupTimer) this._logonSetupTimer = null;

          // Logon-timeout fallback: if normal session-resume has failed N times
          // in a row, force a fresh logon (141=Y, seq=1). This recovers from
          // counterparty FIX-gateway restarts that leave us looping forever on
          // GapFill without Logon-Ack. Gate by env flag for safety.
          let logonIsReconnect = isReconnect;
          if (this._shouldUseLogonResetFallback(isReconnect)) {
            this._consecutiveResetFallbacks++;
            this.logger.warn(
              `[FIXConnection] ${this._consecutiveLogonTimeouts} consecutive logon timeouts ` +
              `for ${this.targetCompID} — falling back to ResetSeqNumFlag=Y ` +
              `(force session reset, fallback ${this._consecutiveResetFallbacks}/${this._maxConsecutiveResetFallbacks})`
            );
            this.emit('logon-reset-fallback', {
              targetCompID: this.targetCompID,
              consecutiveTimeouts: this._consecutiveLogonTimeouts,
              threshold: this._logonResetThreshold,
              fallbackAttempt: this._consecutiveResetFallbacks,
              maxFallbacks: this._maxConsecutiveResetFallbacks,
            });
            // If this fire just exhausted the budget, alert ops. Future
            // attempts will hit the `< _maxConsecutiveResetFallbacks` gate
            // in _shouldUseLogonResetFallback and fall through to a
            // normal session-resume Logon (which will keep failing, but
            // won't churn TrueX-side session state).
            if (this._consecutiveResetFallbacks >= this._maxConsecutiveResetFallbacks) {
              this.logger.error(
                `[FIXConnection] logon-reset fallback exhausted for ${this.targetCompID} ` +
                `after ${this._consecutiveResetFallbacks} consecutive attempts — escalating`
              );
              this.emit('logon-reset-fallback-exhausted', {
                targetCompID: this.targetCompID,
                attempts: this._consecutiveResetFallbacks,
              });
            }
            try {
              await this.resetSequenceNumbers();
            } catch (resetErr) {
              this.logger.error(
                `[FIXConnection] resetSequenceNumbers failed during logon-reset fallback: ${resetErr.message}`
              );
              cleanupAttempt(true);
              if (!settled) {
                settled = true;
                reject(resetErr);
              }
              return;
            }
            // The await above is a suspension point — re-check the attempt
            // generation to avoid racing a superseded reconnect attempt.
            if (!isCurrentAttempt()) return;
            logonIsReconnect = false;
            this._consecutiveLogonTimeouts = 0; // give the reset attempt a clean window
          }

          // Send logon message
          this.sendLogon(logonIsReconnect)
            .then(() => {
              if (!isCurrentAttempt()) return;
              this.logger.info(`[FIXConnection] Logon message sent to ${this.targetCompID}`);
              
              // Wait for logon response
              logonTimeout = setTimeout(() => {
                if (!isCurrentAttempt()) return;
                // Track for logon-reset fallback. Increment only on real
                // no-response timeouts, not on rejects (which go to
                // rejectHandler) or stale-attempt firings.
                this._consecutiveLogonTimeouts++;
                cleanupAttempt(true);
                if (!settled) {
                  settled = true;
                  reject(new Error('Logon timeout - no response from server'));
                }
              }, 10000);
            
            // Listen for logon response
            logonHandler = async (message) => {
              if (!isCurrentAttempt()) return;
              if (message.fields['35'] === 'A') { // Logon message
                if (logonTimeout) clearTimeout(logonTimeout);
                logonTimeout = null;
                this.removeListener('message', logonHandler);
                logonHandler = null;
                if (rejectHandler) {
                  this.removeListener('reject', rejectHandler);
                  rejectHandler = null;
                }

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
                    await this.resetSequenceNumbers();
                  }

                  cleanupAttempt(true);
                  if (!settled) {
                    settled = true;
                    reject(new Error(`Logon session problem: ${statusText}`));
                  }
                  return;
                }

                this.isLoggedOn = true;
                this.hasConnectedBefore = true;
                // Clear resend-failure tracking on successful logon
                this._resendGapStart = null;
                this._resendAttempts = 0;
                // Successful logon clears both fallback counters
                this._consecutiveLogonTimeouts = 0;
                this._consecutiveResetFallbacks = 0;
                // Do NOT reset reconnectAttempts immediately — _startStableTimer will
                // reset it after 60s of stable uptime, preventing a brief drop from
                // resetting the counter too eagerly.
                this.startHeartbeat();
                this.startCleanupTimer(); // Start periodic message cleanup
                this._startStableTimer(); // Reset reconnect counter after 60s stable
                this.logger.info(`[FIXConnection] Logged on to ${this.targetCompID}`);
                if (!settled) {
                  settled = true;
                  resolve();
                }
              }
            };
            
            this.on('message', logonHandler);
            rejectHandler = ({ reason, message }) => {
              if (!isCurrentAttempt()) return;
              if (logonTimeout) clearTimeout(logonTimeout);
              logonTimeout = null;
              if (/already authenticated/i.test(reason)) {
                this.emit('duplicate-logon', { reason, message });
              }
              cleanupAttempt(true);
              if (!settled) {
                settled = true;
                reject(new Error(`Logon rejected: ${reason}`));
              }
            };
            this.on('reject', rejectHandler);
          })
          .catch((error) => {
            if (!isCurrentAttempt()) return;
            cleanupAttempt(true);
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        }, 2000); // Wait 2 seconds for proxy to establish TrueX connection
        this._logonSetupTimer = setupTimer;
      });
      
    });
  }
  
  /**
   * Decide whether the next reconnect attempt should force a session reset
   * (ResetSeqNumFlag=Y, seq=1) instead of a normal resume. Returns true only
   * when the fallback is enabled, we are mid-reconnect, and consecutive
   * post-Logon timeouts have hit the configured threshold.
   * @param {boolean} isReconnect - true for resume attempts (not first connect)
   */
  _shouldUseLogonResetFallback(isReconnect) {
    return (
      this._logonResetFallbackEnabled &&
      isReconnect &&
      this._consecutiveLogonTimeouts >= this._logonResetThreshold &&
      this._consecutiveResetFallbacks < this._maxConsecutiveResetFallbacks
    );
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
    const commonBodyFields = ['11', '18', '2964', '41', '38', '40', '44', '54', '55', '59', '453', '448', '452'];  // Body fields + Party ID in order: 453→448→452
    
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
      if (completeFields[tag] !== undefined && completeFields[tag] !== null) {
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
    
    // SequenceReset-GapFill can legitimately advance over a gap. Handle it
    // before normal gap validation to avoid requesting the range it is filling.
    if (msgType === '4' && message.fields['123'] === 'Y') {
      const newSeqNo = parseInt(message.fields['36'], 10);
      if (!Number.isFinite(msgSeqNum) || !Number.isFinite(newSeqNo)) {
        this.logger.warn(
          `[FIXConnection] Ignoring invalid SequenceReset-GapFill: ` +
          `seq=${msgSeqNum}, newSeqNo=${message.fields['36']}, expected=${this.expectedSeqNum}`
        );
        return;
      }
      if (msgSeqNum === this.expectedSeqNum) {
        if (newSeqNo <= this.expectedSeqNum || newSeqNo <= msgSeqNum) {
          this.logger.warn(
            `[FIXConnection] Ignoring stale/non-advancing SequenceReset-GapFill: ` +
            `seq=${msgSeqNum}, newSeqNo=${message.fields['36']}, expected=${this.expectedSeqNum}`
          );
          return;
        }
        this.handleSequenceReset(message);
        return;
      }
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

      // Track resend attempts for the same gap; force reset after MAX_RESEND_ATTEMPTS
      if (this._resendGapStart !== this.expectedSeqNum) {
        this._resendGapStart = this.expectedSeqNum;
        this._resendAttempts = 1;
      } else {
        this._resendAttempts++;
      }

      if (this._resendAttempts >= this._maxResendAttempts) {
        this.logger.error(`[FIXConnection] Resend failed ${this._resendAttempts} times for gap ${this.expectedSeqNum}-${msgSeqNum - 1}. Forcing session reset.`);
        this.emit('resend-failed-reset', { expected: this.expectedSeqNum, received: msgSeqNum, attempts: this._resendAttempts });
        void this._forceSessionReset('resend-failed', {
          expected: this.expectedSeqNum,
          received: msgSeqNum,
          attempts: this._resendAttempts,
        });
        return;
      }

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
      case '4': // SequenceReset
        this.handleSequenceReset(message);
        break;
      case '5': // Logout
        this.handleLogout(message);
        break;
      default:
        // Emit message for application handling
        this.emit('message', message);
    }
  }

  handleSequenceReset(message) {
    const newSeqNo = parseInt(message.fields['36'], 10);
    const gapFill = message.fields['123'] === 'Y';
    if (!Number.isFinite(newSeqNo) || newSeqNo < 1) {
      this.logger.error(`[FIXConnection] Invalid SequenceReset NewSeqNo: ${message.fields['36']}`);
      return;
    }

    this.expectedSeqNum = newSeqNo;
    if (this.redisClient) {
      void this.redisClient.set(this._seqKeyIn, this.expectedSeqNum)
        .catch(err => this.logger.warn(`[FIXConnection] Failed to persist inbound seqnum after SequenceReset: ${err.message}`));
    }
    this._resendGapStart = null;
    this._resendAttempts = 0;
    this.logger.warn(`[FIXConnection] SequenceReset received (${gapFill ? 'GapFill' : 'Reset'}): expectedSeqNum=${newSeqNo}`);
    this.emit('sequence-reset', { newSeqNo, gapFill, message });
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
    };
    
    await this.sendMessage(fields);
  }
  
  /**
   * Handle resend request from server
   */
  handleResendRequest(message) {
    // Application-layer message types that must NOT be retransmitted.
    // Per FIX spec, stale app messages are replaced with a SequenceReset-GapFill.
    const APP_MSG_TYPES = new Set(['D', 'F', 'G', 'q']);

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

    // Helper: build and write a raw FIX message from a fields object.
    const writeRawMessage = (fields) => {
      const headerFieldOrder = ['35', '49', '56', '34', '52'];
      const bodyFields = { ...fields };
      delete bodyFields['8'];
      delete bodyFields['9'];
      delete bodyFields['10'];

      let body = '';
      for (const tag of headerFieldOrder) {
        if (bodyFields[tag] !== undefined) {
          body += `${tag}=${bodyFields[tag]}${this.SOH}`;
        }
      }
      const processedTags = new Set(headerFieldOrder);
      for (const [tag, value] of Object.entries(bodyFields)) {
        if (!processedTags.has(tag) && value !== undefined) {
          body += `${tag}=${value}${this.SOH}`;
        }
      }

      let raw = `8=${this.beginString}${this.SOH}9=${body.length}${this.SOH}${body}`;
      raw += `10=${this.calculateChecksum(raw)}${this.SOH}`;

      if (this.socket && !this.socket.destroyed) {
        this.socket.write(raw);
        return true;
      }
      return false;
    };

    // Walk the requested range.  Consecutive app-layer messages are collected
    // and emitted as a single GapFill spanning the entire run.
    let gapStart = null; // beginning seq of the current app-msg run

    const flushGapFill = (nextSeq) => {
      if (gapStart === null) return;
      // SequenceReset-GapFill: NewSeqNo = first seq AFTER the gap
      const fields = {
        '35': '4',                          // SequenceReset
        '34': gapStart.toString(),          // MsgSeqNum = first skipped seq
        '49': this.senderCompID,
        '56': this.targetCompID,
        '52': this.getUTCTimestamp(),
        '43': 'Y',                          // PossDupFlag
        '123': 'Y',                         // GapFillFlag
        '36': nextSeq.toString(),           // NewSeqNo
      };
      if (writeRawMessage(fields)) {
        this.logger.info(`[FIXConnection] GapFill sent: seqs ${gapStart}-${nextSeq - 1}, NewSeqNo=${nextSeq}`);
        resentCount++;
      } else {
        this.logger.error(`[FIXConnection] Cannot send GapFill: socket not writable`);
        skippedCount++;
      }
      gapStart = null;
    };

    for (let seq = beginSeqNo; seq <= endSeqNo; seq++) {
      const stored = this.sentMessages.get(seq);
      const msgType = stored ? stored.fields['35'] : null;

      if (!stored || APP_MSG_TYPES.has(msgType)) {
        // Accumulate into GapFill run
        if (gapStart === null) gapStart = seq;
        // Continue scanning — flush when run ends
      } else {
        // Session-layer message (35=A, 35=5) — flush any pending GapFill first
        flushGapFill(seq);

        try {
          const clonedFields = { ...stored.fields };
          clonedFields['43'] = 'Y';
          clonedFields['52'] = this.getUTCTimestamp();

          if (writeRawMessage(clonedFields)) {
            resentCount++;
            this.logger.info(`[FIXConnection] Resent session message seq ${seq} (35=${msgType})`);
          } else {
            this.logger.error(`[FIXConnection] Cannot resend seq ${seq}: socket not writable`);
            skippedCount++;
          }
        } catch (error) {
          this.logger.error(`[FIXConnection] Error resending seq ${seq}: ${error.message}`);
          skippedCount++;
        }
      }
    }

    // Flush any trailing GapFill run
    flushGapFill(endSeqNo + 1);

    // Log summary after completion
    this.logger.info(`[FIXConnection] Resend complete: ${resentCount} sent, ${skippedCount} skipped (${beginSeqNo}-${endSeqNo})`);

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
  handleDisconnect(socket = this.socket, generation = this._connectionGeneration) {
    if (socket && socket !== this.socket) return;
    if (generation !== this._connectionGeneration) return;

    this.isConnected = false;
    this.isLoggedOn = false;
    this._clearLifecycleTimers();

    // Cancel stable-connection timer so a quick drop doesn't reset the counter.
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }

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
   * Start the 60-second stable-connection timer.
   * If the connection stays up for 60s, reset reconnectAttempts to 0 so
   * the next outage starts backoff from scratch.
   * @private
   */
  _startStableTimer() {
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
    }
    this._stableTimer = setTimeout(() => {
      this._stableTimer = null;
      this.reconnectAttempts = 0;
      this.logger.info(`[FIXConnection] Connection stable for 60s — reconnect counter reset for ${this.targetCompID}`);
    }, 60000);
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
    // Prevent two parallel reconnect timers (Bug 2 guard).
    if (this.isReconnecting) {
      this.logger.warn(`[FIXConnection] Reconnect already scheduled for ${this.targetCompID}, ignoring duplicate call`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Emit threshold alert (but keep retrying — no hard cap).
    if (this.reconnectAttempts >= MAX_RECONNECT_ALERT_THRESHOLD) {
      this.logger.error(`[FIXConnection] Reconnect threshold reached (${this.reconnectAttempts} attempts) for ${this.targetCompID}`);
      this.emit('reconnect-threshold', { attempts: this.reconnectAttempts });
    }

    // Exponential backoff capped at maxReconnectDelay, plus ±20% jitter.
    const baseDelay = Math.min(
      this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    const delay = baseDelay * (0.8 + Math.random() * 0.4);

    this.logger.info(`[FIXConnection] Reconnecting to ${this.targetCompID} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

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
