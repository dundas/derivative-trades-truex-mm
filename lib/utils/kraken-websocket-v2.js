/**
 * Kraken WebSocket API v2 Implementation
 * 
 * This file contains the implementation for Kraken's WebSocket API v2
 * (wss://ws.kraken.com/v2)
 */

class KrakenWebSocketV2 {
  constructor(logger, redisClient) {
    this.logger = logger || console;
    this.redis = redisClient;
    this.websocket = null;
    this.connected = false;
    this.heartbeatInterval = null;
    this.subscriptions = new Map();
    this.baseUrl = 'wss://ws.kraken.com/v2';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1500; // Base delay in ms
  }

  /**
   * Connect to Kraken WebSocket API v2
   */
  async connect() {
    if (this.websocket) {
      this.logger.warn('WebSocket connection already exists, closing before reconnecting');
      try {
        this.websocket.close(1000, 'Reconnecting');
      } catch (error) {
        this.logger.error('Error closing existing WebSocket connection:', error);
      }
      this.websocket = null;
    }

    try {
      this.logger.info(`Connecting to Kraken WebSocket API v2: ${this.baseUrl}`);
      
      // Create WebSocket with custom options that help with SSL issues
      const url = new URL(this.baseUrl);
      const hostname = url.hostname;
      
      // Add headers to support SNI (Server Name Indication)
      const headers = {
        'Host': hostname,  // Explicitly set host header for SNI
        'Origin': 'https://' + hostname,
        'User-Agent': 'CloudflareWorker/1.0'
      };
      
      this.logger.info('Adding SNI support with headers:', { hostname, headers });
      
      // Create the WebSocket connection
      // Use a non-empty protocols array or omit it entirely
      this.websocket = new WebSocket(this.baseUrl, ['v2'], { headers });
      
      // Set up event handlers
      this.websocket.addEventListener('open', this._handleOpen.bind(this));
      this.websocket.addEventListener('message', this._handleMessage.bind(this));
      this.websocket.addEventListener('close', this._handleClose.bind(this));
      this.websocket.addEventListener('error', this._handleError.bind(this));
      
      return new Promise((resolve, reject) => {
        // Set timeout for connection
        const connectionTimeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 15000);
        
        // Handle successful connection
        this.websocket.addEventListener('open', () => {
          clearTimeout(connectionTimeout);
          resolve();
        }, { once: true });
        
        // Handle connection error
        this.websocket.addEventListener('error', (event) => {
          clearTimeout(connectionTimeout);
          reject(event);
        }, { once: true });
      });
    } catch (error) {
      this.logger.error('Error connecting to Kraken WebSocket API v2:', error);
      throw error;
    }
  }

  /**
   * Subscribe to orderbook data for symbols
   * @param {Array<string>} symbols - Array of symbols to subscribe to
   */
  async subscribe(symbols) {
    if (!this.websocket || !this.connected) {
      this.logger.warn('Cannot subscribe, WebSocket not connected');
      return false;
    }

    if (!symbols || symbols.length === 0) {
      this.logger.warn('No symbols provided for subscription');
      return false;
    }

    try {
      // First, unsubscribe from all current subscriptions to ensure clean state
      await this.unsubscribeAll();
      
      // Convert symbols to Kraken format (e.g., 'BTC/USD' to 'XBT/USD')
      const krakenSymbols = symbols.map(symbol => {
        // Kraken uses XBT instead of BTC
        return symbol.replace('BTC/', 'XBT/');
      });
      
      this.logger.info('Converting symbols to Kraken format:', { original: symbols, kraken: krakenSymbols });
      
      // Using Kraken WebSocket API v2 format
      const subscribeMsg = {
        method: 'subscribe',
        params: {
          channel: 'book',
          depth: 25,
          symbol: krakenSymbols
        }
      };
      
      this.logger.info('Sending subscription message:', subscribeMsg);
      this.websocket.send(JSON.stringify(subscribeMsg));
      
      // Store subscriptions
      symbols.forEach(symbol => {
        this.subscriptions.set(symbol, true);
      });
      
      return true;
    } catch (error) {
      this.logger.error('Error subscribing to symbols:', error);
      return false;
    }
  }

  /**
   * Unsubscribe from all channels
   */
  async unsubscribeAll() {
    if (!this.websocket || !this.connected) {
      this.logger.warn('Cannot unsubscribe, WebSocket not connected');
      return false;
    }

    try {
      const unsubscribeMsg = {
        method: 'unsubscribe',
        params: {
          channel: 'book'
        }
      };
      
      this.logger.info('Sending unsubscribe message:', unsubscribeMsg);
      this.websocket.send(JSON.stringify(unsubscribeMsg));
      
      // Clear subscriptions
      this.subscriptions.clear();
      
      // Wait a short time to ensure unsubscribe is processed
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return true;
    } catch (error) {
      this.logger.error('Error unsubscribing from channels:', error);
      return false;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.websocket) {
      try {
        this.websocket.close(1000, 'Normal closure');
      } catch (error) {
        this.logger.error('Error closing WebSocket connection:', error);
      }
      this.websocket = null;
    }

    this.connected = false;
    this.subscriptions.clear();
  }

  /**
   * Handle WebSocket open event
   * @private
   */
  _handleOpen() {
    this.logger.info('WebSocket connection opened');
    this.connected = true;
    this.reconnectAttempts = 0;
    
    // Set up heartbeat
    this._setupHeartbeat();
  }

  /**
   * Handle WebSocket message event
   * @private
   */
  _handleMessage(event) {
    try {
      const data = event.data;
      
      // Handle plain string messages (like heartbeats)
      if (data === 'pong' || data === 'heartbeat') {
        this.logger.debug('Received raw heartbeat/pong message');
        return;
      }
      
      // Parse the message
      const message = JSON.parse(data);
      
      // Update connection status on any valid message
      this.connected = true;
      
      // Handle Kraken-specific message formats
      this.logger.info('Processing message type:', message.method || message.channel || 'unknown');
      
      // Skip heartbeat messages
      if (message.method === 'pong' || message.method === 'heartbeat') {
        this.logger.debug('Skipping heartbeat/pong message');
        return;
      }
      
      // Handle connection status message
      if (message.method === 'connected') {
        this.logger.info('Received connection status:', message);
        return;
      }
      
      // Handle subscription messages
      if (message.method === 'subscribe') {
        if (message.status === 'error') {
          this.logger.error('Subscription error:', message.error);
          return;
        }
        if (message.result) {
          this.logger.info(`Successfully subscribed to ${message.result.channel} for ${message.result.symbol}`);
          return;
        }
      }
      
      // Process orderbook data - Kraken v2 API format
      if (message.channel === 'book') {
        this._handleBookUpdate(message);
      } else {
        this.logger.warn('Unknown message format:', message);
      }
    } catch (error) {
      this.logger.error('Error processing WebSocket message:', error);
    }
  }

  /**
   * Handle book update messages
   * @private
   */
  _handleBookUpdate(message) {
    this.logger.info('Processing orderbook message:', message.type);
    
    // Check if data array exists
    if (!message.data || !Array.isArray(message.data)) {
      this.logger.warn('Invalid orderbook data format:', message);
      return;
    }
    
    // Process each orderbook update in the data array
    for (const update of message.data) {
      const krakenSymbol = update.symbol;
      
      // Create orderbook update in the expected format
      const orderbookData = {
        symbol: krakenSymbol,
        timestamp: update.timestamp,
        bids: update.bids || [],
        asks: update.asks || []
      };
      
      this.logger.info(`Processing orderbook data for ${krakenSymbol} at ${update.timestamp}`);
      
      // Emit the orderbook data to any listeners
      if (this.onOrderbookUpdate) {
        this.onOrderbookUpdate(orderbookData);
      }
    }
  }

  /**
   * Handle WebSocket close event
   * @private
   */
  _handleClose(event) {
    this.logger.warn(`WebSocket connection closed: ${event.code} - ${event.reason}`);
    this.connected = false;
    
    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Attempt to reconnect if not closed normally
    if (event.code !== 1000) {
      this._scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   * @private
   */
  _handleError(event) {
    let error = event.error || event;
    
    this.logger.error('WebSocket error:', error);
    
    // Check if the error is a rate limit error (HTTP 429) or SSL error (HTTP 526)
    const errorStr = String(error);
    const isRateLimitError = errorStr.includes('429') || errorStr.includes('rate limit');
    const isSSLError = errorStr.includes('526') || errorStr.includes('SSL') || errorStr.includes('handshake');
    
    if (isRateLimitError || isSSLError) {
      const errorType = isRateLimitError ? 'Rate limit (HTTP 429)' : 'SSL handshake failure (HTTP 526)';
      this.logger.warn(`${errorType} detected. Pausing reconnection attempts for 5 minutes.`);
      
      // For SSL errors, log more detailed information
      if (isSSLError) {
        this.logger.warn('SSL handshake failure detected. This is likely due to Cloudflare\'s strict SSL requirements.');
        this.logger.warn('Consider contacting Kraken support about this issue.');
      }
      
      // Close connection if it exists
      this.close();
      
      // Schedule a single reconnection attempt after a longer delay (5 minutes)
      setTimeout(() => {
        this.reconnectAttempts = 0;
        this.connect().catch(err => {
          this.logger.error('Reconnection failed:', err);
        });
      }, 5 * 60 * 1000);
    } else {
      // For other errors, proceed with normal reconnection strategy
      this.close();
      this._scheduleReconnect();
    }
  }

  /**
   * Set up heartbeat to keep connection alive
   * @private
   */
  _setupHeartbeat() {
    // Clear any existing interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Set up heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.websocket && this.connected) {
        try {
          // Kraken v2 API ping format
          this.websocket.send(JSON.stringify({ method: 'ping' }));
          this.logger.debug('Sent ping to keep connection alive');
        } catch (error) {
          this.logger.error('Error sending heartbeat:', error);
        }
      }
    }, 30000);
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    // Don't schedule if already at max attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Maximum reconnection attempts (${this.maxReconnectAttempts}) reached. Manual intervention required.`);
      return;
    }
    
    // Increment reconnection attempts
    this.reconnectAttempts++;
    
    // Calculate exponential backoff with jitter to prevent thundering herd
    const baseDelay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    const jitter = Math.random() * 1000; // Add up to 1 second of random jitter
    const delay = Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
    
    this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${Math.round(delay)}ms`);
    
    // Schedule reconnect
    setTimeout(() => {
      this.connect().catch(error => {
        this.logger.error('Reconnection failed:', error);
      });
    }, delay);
  }
}

export default KrakenWebSocketV2;
