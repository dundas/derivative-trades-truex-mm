/**
 * Kraken Private WebSocket Adapter
 * 
 * This module provides a specialized adapter for Kraken's private WebSocket API v2,
 * which allows for authenticated order operations with lower latency than REST APIs.
 * 
 * Reference: https://docs.kraken.com/api/docs/websocket-v2/add_order
 */

import { TradingLogger } from '../../../utils/trading-logger.js';
import { ExchangeWebSocketAdapter } from './ExchangeWebSocketAdapter.js';
import { KrakenRefreshTokenService } from './KrakenRefreshTokenService.js';
import WebSocket from 'ws';

/**
 * Kraken Private WebSocket Adapter for authenticated order operations
 * 
 * @extends ExchangeWebSocketAdapter
 */
export class KrakenPrivateWebSocketAdapter {
  /**
   * Create a new KrakenPrivateWebSocketAdapter
   * 
   * @param {Object} config - Configuration options
   * @param {Object} [config.logger] - Logger object, will create TradingLogger if not provided
   * @param {string} [config.sessionId] - Session ID for logging
   * @param {Function} [config.onOrderUpdate] - Callback for order updates
   * @param {Function} [config.onConnect] - Callback for connection establishment
   * @param {Function} [config.onError] - Callback for errors
   * @param {Function} [config.onClose] - Callback for connection close
   * @param {Object} [additionalConfig] - Additional Kraken-specific config
   * @param {string} [additionalConfig.token] - WebSocket authentication token
   * @param {string} [additionalConfig.apiKey] - API key for authentication (used for token refresh)
   * @param {string} [additionalConfig.apiSecret] - API secret for authentication (used for token refresh)
   * @param {boolean} [additionalConfig.testMode] - Whether to use test mode
   */
  constructor(config = {}, additionalConfig = {}) {
    // Initialize logger
    this.logger = config.logger || new TradingLogger({
      sessionId: config.sessionId || 'kraken-private-ws',
      component: 'KrakenPrivateWS'
    });
    
    // Store configuration
    this.config = config;
    this.sessionId = config.sessionId || 'kraken-private-ws';
    
    // Authentication
    this.token = additionalConfig.token;
    this.apiKey = additionalConfig.apiKey;
    this.apiSecret = additionalConfig.apiSecret;
    this.testMode = additionalConfig.testMode || false;
    
    // Initialize token refresh service
    if (this.apiKey && this.apiSecret) {
      this.tokenRefreshService = new KrakenRefreshTokenService({
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        logger: this.logger,
        testMode: this.testMode
      });
      
      // Set initial token in the service if we have one
      if (this.token) {
        this.tokenRefreshService.token = this.token;
        this.tokenRefreshService.tokenExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes
      }
    }
    
    // Token refresh timer
    this.tokenRefreshTimer = null;
    
    // Health monitoring
    this.lastActivityTimestamp = Date.now();
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = additionalConfig.healthCheckIntervalMs || 30000; // 30 seconds
    this.maxInactivityPeriodMs = additionalConfig.maxInactivityPeriodMs || 300000; // 5 minutes
    
    // WebSocket URL
    this.wsUrl = 'wss://ws-auth.kraken.com/v2';
    
    // WebSocket connection
    this.ws = null;
    this.isConnected = false;
    this.connectionStatus = 'disconnected';
    
    // Request tracking
    this.pendingRequests = new Map();
    this.requestIdCounter = 1;
    this.requestTimeout = 30000; // 30 seconds
    
    // Connection management
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 5;
    this.reconnectDelay = config.reconnectDelay || 5000;
    
    // Event callbacks
    this.onOrderUpdate = config.onOrderUpdate || (() => {});
    this.onConnect = config.onConnect || (() => {});
    this.onError = config.onError || (() => {});
    this.onClose = config.onClose || (() => {});
    
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);
    this.handleError = this.handleError.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.addOrder = this.addOrder.bind(this);
    this.cancelOrder = this.cancelOrder.bind(this);
    this._sendRequest = this._sendRequest.bind(this);
    this._generateRequestId = this._generateRequestId.bind(this);
    this._handleOrderExecution = this._handleOrderExecution.bind(this);
    
    this.logger.info('Initialized KrakenPrivateWebSocketAdapter', {
      testMode: this.testMode,
      hasToken: !!this.token,
      hasApiKey: !!this.apiKey,
      hasApiSecret: !!this.apiSecret
    });
  }
  
  /**
   * Generate a unique request ID
   * 
   * @private
   * @returns {number} Unique request ID
   */
  _generateRequestId() {
    return this.requestIdCounter++;
  }
  
  /**
   * Refresh the authentication token
   * 
   * @returns {Promise<string>} New authentication token
   */
  async refreshToken() {
    if (!this.tokenRefreshService) {
      throw new Error('Cannot refresh token without token refresh service (API key and secret required)');
    }
    
    try {
      this.logger.info('Refreshing WebSocket authentication token...');
      const newToken = await this.tokenRefreshService.getToken();
      
      // Update token in this adapter
      this.token = newToken;
      
      // If connected, set up token refresh timer
      if (this.isConnected && !this.tokenRefreshTimer) {
        this.setupTokenRefreshTimer();
      }
      
      return newToken;
    } catch (error) {
      this.logger.error(`Failed to refresh WebSocket authentication token: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Setup token refresh timer
   * 
   * @private
   */
  setupTokenRefreshTimer() {
    // Clear existing timer if any
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    
    if (this.tokenRefreshService) {
      this.tokenRefreshTimer = this.tokenRefreshService.scheduleRefresh(async (newToken) => {
        this.token = newToken;
        this.logger.info('Token refreshed successfully via scheduled refresh');
        
        // If not connected, try to reconnect with the new token
        if (!this.isConnected) {
          this.logger.info('Reconnecting with new token after refresh...');
          try {
            await this.connect();
          } catch (error) {
            this.logger.error(`Failed to reconnect after token refresh: ${error.message}`, { error });
          }
        }
      });
    }
  }
  
  /**
   * Connect to Kraken private WebSocket API
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) {
      this.logger.info('Already connected to Kraken private WebSocket API');
      return;
    }
    
    try {
      // Get token if we don't have one
      if (!this.token && this.tokenRefreshService) {
        this.token = await this.refreshToken();
      } else if (!this.token) {
        throw new Error('Authentication token is required for connecting to Kraken private WebSocket API');
      }
      
      this.logger.info('Connecting to Kraken private WebSocket API...');
      
      // Create WebSocket
      this.ws = new WebSocket(this.wsUrl);
      
      // Set up event handlers
      this.ws.on('open', this.handleOpen);
      this.ws.on('message', this.handleMessage);
      this.ws.on('error', this.handleError);
      this.ws.on('close', this.handleClose);
      
      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);
        
        this.ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        this.ws.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Setup token refresh timer
      this.setupTokenRefreshTimer();
      
      // Start health check monitoring
      this.startHealthCheck();
      
      // Subscribe to execution feed if token is available
      await this._subscribeToExecutionFeed();
      
      this.logger.info('Connected to Kraken private WebSocket API');
    } catch (error) {
      this.logger.error(`Failed to connect to Kraken private WebSocket API: ${error.message}`, { error });
      this.reconnect();
      throw error;
    }
  }
  
  /**
   * Start health check monitoring
   * 
   * @private
   */
  startHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, this.healthCheckIntervalMs);
    
    this.logger.debug(`Started WebSocket health monitoring (interval: ${this.healthCheckIntervalMs}ms, max inactivity: ${this.maxInactivityPeriodMs}ms)`);
  }
  
  /**
   * Stop health check monitoring
   * 
   * @private
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.logger.debug('Stopped WebSocket health monitoring');
    }
  }
  
  /**
   * Check WebSocket connection health
   * 
   * @private
   */
  checkConnectionHealth() {
    const now = Date.now();
    const inactivityPeriod = now - this.lastActivityTimestamp;
    
    if (inactivityPeriod > this.maxInactivityPeriodMs) {
      this.logger.warn(`WebSocket connection inactive for ${inactivityPeriod}ms, exceeding ${this.maxInactivityPeriodMs}ms threshold. Performing health check ping...`);
      
      // Send ping to check if connection is alive
      this.ping().catch(error => {
        this.logger.error(`Health check ping failed: ${error.message}. Reconnecting...`, { error });
        this.reconnect();
      });
    }
  }
  
  /**
   * Send ping message to check WebSocket connection
   * 
   * @returns {Promise<Object>} Pong response
   */
  async ping() {
    const requestId = this._generateRequestId();
    
    try {
      const message = {
        method: 'ping',
        req_id: requestId
      };
      
      this.logger.debug('Sending WebSocket ping');
      return await this._sendRequest(message, requestId);
    } catch (error) {
      this.logger.error(`Ping failed: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Disconnect from Kraken private WebSocket API
   */
  disconnect() {
    if (!this.isConnected && !this.ws) {
      this.logger.info('Not connected to Kraken private WebSocket API');
      return;
    }
    
    this.logger.info('Disconnecting from Kraken private WebSocket API...');
    
    // Stop health check monitoring
    this.stopHealthCheck();
    
    // Cancel token refresh timer
    if (this.tokenRefreshTimer) {
      if (this.tokenRefreshService) {
        this.tokenRefreshService.cancelScheduledRefresh(this.tokenRefreshTimer);
      } else {
        clearTimeout(this.tokenRefreshTimer);
      }
      this.tokenRefreshTimer = null;
    }
    
    // Clean up WebSocket
    if (this.ws) {
      // Unsubscribe from executions channel gracefully if possible
      try {
        // Don't await - just try to send unsubscribe message
        if (this.isConnected) {
          this._sendMessage({
            method: 'unsubscribe',
            params: { channel: 'executions' }
          }).catch(() => {});
        }
      } catch (error) {
        // Ignore errors during unsubscribe
      }
      
      // Close the socket
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (error) {
        // Ignore errors during socket termination
      }
      this.ws = null;
    }
    
    this.isConnected = false;
    this.connectionStatus = 'disconnected';
    
    // Cancel pending requests
    for (const [id, { reject }] of this.pendingRequests.entries()) {
      reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }
    
    this.logger.info('Disconnected from Kraken private WebSocket API');
    this.onClose();
  }
  
  /**
   * Reconnect to Kraken private WebSocket API with exponential backoff
   * 
   * @private
   */
  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }
    
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
    
    this.logger.info(`Reconnecting to Kraken private WebSocket API in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(error => {
        this.logger.error(`Reconnect attempt failed: ${error.message}`, { error });
      });
    }, delay);
  }
  
  /**
   * Handle WebSocket open event
   * 
   * @private
   */
  handleOpen() {
    this.isConnected = true;
    this.connectionStatus = 'connected';
    this.reconnectAttempts = 0;
    this.logger.info('WebSocket connection opened');
    this.onConnect();
  }
  
  /**
   * Handle WebSocket message event
   * 
   * @private
   * @param {string} data - Message data
   */
  handleMessage(data) {
    try {
      // Update activity timestamp for health monitoring
      this.lastActivityTimestamp = Date.now();
      
      const message = JSON.parse(data);
      this.logger.debug('Received WebSocket message', { message });
      
      // Skip heartbeat messages in logs (they're too noisy)
      if (message.channel === 'heartbeat') {
        return;
      }
      
      // Handle different message types
      if (message.req_id) {
        // Response to a request
        this._handleRequestResponse(message);
      } else if (message.method === 'subscription') {
        // Subscription status
        this._handleSubscriptionStatus(message);
      } else if (message.channel === 'executions') {
        // Execution update
        this._handleOrderExecution(message.data);
      } else if (message.channel === 'status') {
        // System status update
        this._handleStatusUpdate(message);
      }
    } catch (error) {
      this.logger.error(`Failed to process WebSocket message: ${error.message}`, { error, data });
    }
  }
  
  /**
   * Handle status update messages
   * 
   * @private
   * @param {Object} message - Status message
   */
  _handleStatusUpdate(message) {
    if (message.type === 'update') {
      const statusData = message.data;
      
      if (Array.isArray(statusData) && statusData.length > 0) {
        const status = statusData[0];
        
        if (status.status === 'online') {
          this.logger.info('Kraken WebSocket API status: ONLINE');
        } else if (status.status === 'maintenance') {
          this.logger.warn('Kraken WebSocket API status: MAINTENANCE');
        } else if (status.status === 'cancel_only') {
          this.logger.warn('Kraken WebSocket API status: CANCEL_ONLY - Only order cancellations allowed');
        }
      }
    }
  }
  
  /**
   * Handle WebSocket error event
   * 
   * @private
   * @param {Error} error - WebSocket error
   */
  handleError(error) {
    this.logger.error(`WebSocket error: ${error.message}`, { error });
    this.onError(error);
  }
  
  /**
   * Handle WebSocket close event
   * 
   * @private
   * @param {number} code - Close code
   * @param {string} reason - Close reason
   */
  handleClose(code, reason) {
    this.isConnected = false;
    this.connectionStatus = 'disconnected';
    this.logger.info(`WebSocket connection closed: ${code} ${reason || ''}`);
    this.onClose();
    this.reconnect();
  }
  
  /**
   * Handle request response
   * 
   * @private
   * @param {Object} message - Response message
   */
  _handleRequestResponse(message) {
    const request = this.pendingRequests.get(message.req_id);
    if (request) {
      if (message.error) {
        request.reject(new Error(`Kraken API error: ${message.error}`));
      } else {
        request.resolve(message.result);
      }
      this.pendingRequests.delete(message.req_id);
    } else {
      this.logger.warn(`Received response for unknown request ID: ${message.req_id}`, { message });
    }
  }
  
  /**
   * Handle subscription status
   * 
   * @private
   * @param {Object} message - Subscription status message
   */
  _handleSubscriptionStatus(message) {
    if (message.success) {
      this.logger.info(`Successfully subscribed to ${message.channel}`, { message });
    } else {
      this.logger.error(`Failed to subscribe to ${message.channel}: ${message.error}`, { message });
    }
  }
  
  /**
   * Handle order execution update
   * 
   * @private
   * @param {Object} execution - Execution data
   */
  _handleOrderExecution(execution) {
    try {
      this.logger.debug('Received order execution update', { execution });
      
      // Extract fields from the execution message
      const {
        order_id,
        cl_ord_id,
        status,
        symbol,
        side,
        ord_type,
        ord_qty,
        price,
        avg_price,
        filled_qty,
        leaves_qty,
        timestamp,
        last_fill_qty,   // Amount filled in this event
        last_fill_px      // Price of this fill
      } = execution;
      
      // Parse order quantities
      const totalSize = parseFloat(ord_qty);  
      const filledSize = parseFloat(filled_qty || 0);
      const remainingSize = parseFloat(leaves_qty || 0);
      const lastFillSize = parseFloat(last_fill_qty || 0);
      const lastFillPrice = parseFloat(last_fill_px || avg_price || price || 0);
      
      // Calculate fill percentage for detecting partial fills
      const fillPercentage = totalSize > 0 ? (filledSize / totalSize) * 100 : 0;
      
      // Determine if this is a partial fill
      const isPartialFill = filledSize > 0 && remainingSize > 0;
      
      // Determine actual status (override Kraken status if we detect partial fill)
      let orderStatus = this._mapKrakenStatus(status, isPartialFill, fillPercentage);
      
      // Format the order update for the callback
      const orderUpdate = {
        exchangeOrderId: order_id,
        clientOrderId: cl_ord_id,
        status: orderStatus,
        symbol,
        side,
        type: this._mapKrakenOrderType(ord_type),
        amount: totalSize,
        price: price ? parseFloat(price) : undefined,
        filledAmount: filledSize,
        remainingAmount: remainingSize,
        avgFillPrice: avg_price ? parseFloat(avg_price) : 0,
        timestamp: timestamp || Date.now(),
        
        // Add partial fill data
        fillPercentage,
        isPartialFill,
        lastFillSize,
        lastFillPrice
      };
      
      // Log partial fills with appropriate level
      if (isPartialFill) {
        this.logger.info(
          `Detected PARTIAL FILL: ${side.toUpperCase()} ${symbol} - ` +
          `${filledSize}/${totalSize} (${fillPercentage.toFixed(2)}%) filled @ $${lastFillPrice}`, 
          { orderId: order_id, clientOrderId: cl_ord_id }
        );
      }
      
      // Forward to callback
      this.onOrderUpdate(orderUpdate);
    } catch (error) {
      this.logger.error(`Error handling execution update: ${error.message}`, { error, execution });
    }
  }
  
  /**
   * Map Kraken order status to our internal status
   * 
   * @private
   * @param {string} krakenStatus - Kraken order status
   * @param {boolean} isPartialFill - Whether this is a partial fill
   * @param {number} fillPercentage - Percentage of order filled
   * @returns {string} Internal order status
   */
  _mapKrakenStatus(krakenStatus, isPartialFill = false, fillPercentage = 0) {
    // If explicitly detected as a partial fill, override the status
    if (isPartialFill) {
      return 'partial';
    }
    
    // Standard Kraken status mapping
    const statusMap = {
      'created': 'created',
      'pending': 'created',
      'open': 'open',
      'closed': 'filled',
      'canceled': 'cancelled',
      'expired': 'cancelled',
      'rejected': 'rejected'
    };
    
    // Get the mapped status
    const mappedStatus = statusMap[krakenStatus] || krakenStatus;
    
    // Another safety check for partial fills based on fill percentage
    // Consider an order partial if it's marked as open but has some fills
    if (mappedStatus === 'open' && fillPercentage > 0) {
      return 'partial';
    }
    
    return mappedStatus;
  }
  
  /**
   * Map Kraken order type to our internal type
   * 
   * @private
   * @param {string} krakenOrderType - Kraken order type
   * @returns {string} Internal order type
   */
  _mapKrakenOrderType(krakenOrderType) {
    const typeMap = {
      'market': 'market',
      'limit': 'limit',
      'stop-loss': 'stop',
      'stop-loss-limit': 'stop-limit',
      'take-profit': 'take-profit',
      'take-profit-limit': 'take-profit-limit'
    };
    
    return typeMap[krakenOrderType] || krakenOrderType;
  }
  
  /**
   * Subscribe to execution feed
   * 
   * @private
   * @returns {Promise<void>}
   */
  async _subscribeToExecutionFeed() {
    try {
      const requestId = this._generateRequestId();
      const message = {
        method: 'subscribe',
        params: {
          channel: 'executions',
          token: this.token
        },
        req_id: requestId
      };
      
      const result = await this._sendRequest(message, requestId);
      this.logger.info('Subscribed to execution feed', { result });
      return result;
    } catch (error) {
      this.logger.error(`Failed to subscribe to execution feed: ${error.message}`, { error });
      throw error;
    }
  }
  
  /**
   * Send a request and wait for response
   * 
   * @private
   * @param {Object} message - Request message
   * @param {number} requestId - Request ID
   * @param {Object} [options] - Request options
   * @param {number} [options.timeoutMs] - Custom timeout in milliseconds
   * @param {number} [options.retries=1] - Number of retries on failure
   * @param {number} [options.retryDelayMs=500] - Delay between retries in milliseconds
   * @returns {Promise<Object>} Response result
   */
  /**
   * Send a request and wait for response
   * 
   * @private
   * @param {Object} message - Request message
   * @param {number} requestId - Request ID
   * @param {Object} [options] - Request options
   * @param {number} [options.timeoutMs] - Custom timeout in milliseconds
   * @param {number} [options.retries=2] - Number of retries on failure
   * @param {number} [options.retryDelayMs=500] - Delay between retries in milliseconds
   * @returns {Promise<Object>} Response result
   */
  _sendRequest(message, requestId, options = {}) {
    const timeoutMs = options.timeoutMs || this.requestTimeout;
    const maxRetries = options.retries !== undefined ? options.retries : 2;
    const retryDelayMs = options.retryDelayMs || 500;
    let retryCount = 0;
    
    // Define the self-retrying request function
    const attemptRequest = async () => {
      // Verify connection state before sending
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (retryCount < maxRetries) {
          retryCount++;
          this.logger.warn(`Connection not ready, retrying request in ${retryDelayMs}ms (${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          
          // Try to reconnect if needed
          if (!this.isConnected) {
            try {
              await this.connect();
            } catch (error) {
              this.logger.warn(`Failed to connect during retry: ${error.message}`);
            }
          }
          
          // Retry the request
          return attemptRequest();
        } else {
          throw new Error(`Not connected to WebSocket API after ${maxRetries} reconnection attempts`);
        }
      }
      
      // Send the actual request
      return new Promise((resolve, reject) => {
        // Store the request with callbacks
        this.pendingRequests.set(requestId, {
          message,
          resolve,
          reject,
          timestamp: Date.now(),
          retryCount
        });
        
        // Set timeout for the request
        const timeoutId = setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            
            if (retryCount < maxRetries) {
              // Don't reject yet, we'll retry
              retryCount++;
              this.logger.warn(`Request ${requestId} timed out after ${timeoutMs}ms, retrying (${retryCount}/${maxRetries})`);
              
              // Retry the request after delay
              setTimeout(async () => {
                try {
                  const result = await attemptRequest();
                  resolve(result);
                } catch (retryError) {
                  reject(retryError);
                }
              }, retryDelayMs);
            } else {
              reject(new Error(`Request timeout after ${timeoutMs}ms, max retries (${maxRetries}) exceeded`));
            }
            return;
          }
        }, timeoutMs);
        
        try {
          // Update activity timestamp
          this.lastActivityTimestamp = Date.now();
          
          // Send message through WebSocket
          this.logger.debug(`Sending WebSocket request ${requestId}`, { message });
          this.ws.send(JSON.stringify(message));
          
          // Store timeout ID for cleanup
          const pendingRequest = this.pendingRequests.get(requestId);
          if (pendingRequest) {
            pendingRequest.timeoutId = timeoutId;
          }
        } catch (error) {
          // Clean up on error
          clearTimeout(timeoutId);
          this.pendingRequests.delete(requestId);
          
          if (retryCount < maxRetries) {
            retryCount++;
            this.logger.warn(`Send error for request ${requestId}: ${error.message}, retrying (${retryCount}/${maxRetries})`);
            
            // Retry the request after delay
            setTimeout(async () => {
              try {
                const result = await attemptRequest();
                resolve(result);
              } catch (retryError) {
                reject(retryError);
              }
            }, retryDelayMs);
          } else {
            this.logger.error(`Failed to send request after ${maxRetries} attempts: ${error.message}`);
            reject(error);
          }
        }
      });
    };
    
    // Start the request process
    return attemptRequest();
  }
  
  /**
   * Place an order via WebSocket
   * 
   * @param {Object} orderParams - Order parameters
   * @param {string} orderParams.type - Order type (market, limit, etc.)
   * @param {string} orderParams.symbol - Trading pair symbol
   * @param {string} orderParams.side - Order side (buy/sell)
   * @param {number|string} orderParams.amount - Order quantity
   * @param {number|string} [orderParams.price] - Order price (for limit orders)
   * @param {string} [orderParams.clientOrderId] - Client order ID
   * @returns {Promise<Object>} Order response
   */
  async addOrder(orderParams) {
    try {
      if (this.testMode) {
        // Generate mock order result in test mode
        this.logger.info(`[MOCK] Placing ${orderParams.side} ${orderParams.type} order for ${orderParams.amount} ${orderParams.symbol}`);
        
        return {
          order_id: `mock-order-${Date.now()}`,
          status: 'pending',
          description: 'Order placed successfully',
          type: orderParams.type,
          side: orderParams.side,
          quantity: orderParams.amount,
          price: orderParams.price,
          cl_ord_id: orderParams.clientOrderId // Include the client order ID
        };
      }
      
      const requestId = this._generateRequestId();
      
      // Format order parameters according to Kraken WebSocket API v2 specs
      // Reference: https://docs.kraken.com/websockets/#message-addOrder
      // Documentation: https://docs.kraken.com/api/docs/websocket-v2/private-add_order
      const params = {
        // Order type must be one of: limit, market, stop-loss, take-profit, stop-loss-limit, take-profit-limit
        ordertype: orderParams.type === 'limit' ? 'limit' : 'market',
        
        // Trading pair - no slash in Kraken format
        pair: orderParams.symbol.replace('/', ''),
        
        // Order direction - must be "buy" or "sell"
        type: orderParams.side,
        
        // Order quantity in base asset
        volume: orderParams.amount.toString(),
        
        // Authentication token
        token: this.token
      };
      
      // Add client order ID (userref in Kraken terminology)
      // Must be a 32-bit unsigned integer
      if (orderParams.clientOrderId) {
        // If clientOrderId is a string that can be parsed as an integer, use it
        // Otherwise, generate a numeric ID based on current timestamp
        const numericId = /^\d+$/.test(orderParams.clientOrderId) ? 
          parseInt(orderParams.clientOrderId, 10) : 
          Date.now() % 2147483647; // Ensure it fits in 32-bit unsigned int
        
        params.userref = numericId;
      }
      
      // Add price for limit orders (required for limit orders)
      if (orderParams.type === 'limit' && orderParams.price !== undefined) {
        params.price = orderParams.price.toString();
      }
      
      // Add additional optional parameters if needed
      // - leverage: leverage level to use for this order
      // - oflags: order flags, comma-delimited list (post, fcib, fciq, etc)
      // - timeinforce: time-in-force of the order (GTC, IOC, GTD)
      
      // Create complete message
      const message = {
        method: 'add_order',
        params,
        req_id: requestId
      };
      
      // Log operation (excluding token)
      const logParams = { ...params };
      delete logParams.token;
      this.logger.info(`Placing ${orderParams.side} ${orderParams.type} order for ${orderParams.amount} ${orderParams.symbol}`, logParams);
      
      // Send request and wait for response
      const result = await this._sendRequest(message, requestId);
      
      this.logger.info(`Order placed successfully: ${result.txid?.[0] || 'unknown'}`, {
        exchangeOrderId: result.txid?.[0] || 'unknown',
        clientOrderId: orderParams.clientOrderId,
        status: 'open'
      });
      
      // Map the response to our expected format
      return {
        order_id: result.txid?.[0] || 'unknown',
        status: 'open',
        description: 'Order placed successfully',
        cl_ord_id: orderParams.clientOrderId
      };
    } catch (error) {
      this.logger.error(`Failed to place order: ${error.message}`, { error, orderParams });
      throw error;
    }
  }
  
  /**
   * Cancel orders via WebSocket
   * 
   * @param {Object} cancelParams - Cancel parameters
   * @param {string|Array<string>} [cancelParams.order_id] - Exchange order ID(s) to cancel
   * @param {string|Array<string>} [cancelParams.cl_ord_id] - Client order ID(s) to cancel
   * @returns {Promise<Object>} Cancel response
   */
  async cancelOrder(cancelParams) {
    try {
      if (this.testMode) {
        // Generate mock cancel result in test mode
        this.logger.info(`[MOCK] Cancelling order`, cancelParams);
        
        return {
          count: 1,
          status: 'success',
          description: 'Order cancelled successfully',
          canceled: [cancelParams.order_id || `mock-order-${Date.now()}`]
        };
      }
      
      const requestId = this._generateRequestId();
      
      // Format cancel parameters according to Kraken WebSocket API v2 specs
      // Reference: https://docs.kraken.com/websockets/#message-cancelOrder
      // Documentation: https://docs.kraken.com/api/docs/websocket-v2/private-cancel_order
      const params = {
        token: this.token
      };
      
      // Kraken uses 'txid' for exchange order IDs
      // This must be an array of order IDs
      if (cancelParams.order_id) {
        params.txid = Array.isArray(cancelParams.order_id)
          ? cancelParams.order_id
          : [cancelParams.order_id];
      }
      
      // Kraken uses 'userref' for client order IDs
      // This must be a 32-bit unsigned integer, not an array
      if (cancelParams.cl_ord_id) {
        // If we have multiple client order IDs, just use the first one
        // Kraken only allows a single userref per cancel request
        const clientOrderId = Array.isArray(cancelParams.cl_ord_id)
          ? cancelParams.cl_ord_id[0]
          : cancelParams.cl_ord_id;
        
        // Ensure userref is a 32-bit unsigned integer
        const numericId = /^\d+$/.test(clientOrderId) ? 
          parseInt(clientOrderId, 10) : 
          Date.now() % 2147483647;
          
        params.userref = numericId;
      }
      
      // Validate that at least one ID type is provided
      if (!params.txid && !params.userref) {
        throw new Error('Either order_id or cl_ord_id must be provided');
      }
      
      // Create complete message
      const message = {
        method: 'cancel_order',
        params,
        req_id: requestId
      };
      
      // Log operation (excluding token)
      const logParams = { ...params };
      delete logParams.token;
      this.logger.info(`Cancelling orders`, logParams);
      
      // Send request and wait for response
      const result = await this._sendRequest(message, requestId);
      
      this.logger.info(`Orders cancelled successfully`, {
        count: result.count || 0,
        orderIds: result.txid
      });
      
      // Map the response to our expected format
      return {
        success: true,
        count: result.count || 0,
        canceled: result.txid || [],
        description: 'Orders cancelled successfully'
      };
    } catch (error) {
      this.logger.error(`Failed to cancel orders: ${error.message}`, { error, cancelParams });
      throw error;
    }
  }
}

export default KrakenPrivateWebSocketAdapter;
