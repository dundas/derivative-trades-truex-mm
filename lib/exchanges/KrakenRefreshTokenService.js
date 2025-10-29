/**
 * Kraken Token Refresh Service
 * 
 * This module provides specialized functionality for managing WebSocket authentication tokens
 * for the Kraken exchange.
 */

import { KrakenRESTClient } from '../KrakenRESTClient.js';
import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Service for refreshing Kraken WebSocket authentication tokens
 */
export class KrakenRefreshTokenService {
  /**
   * Create a new KrakenRefreshTokenService
   * 
   * @param {Object} config - Configuration options
   * @param {string} config.apiKey - Kraken API key
   * @param {string} config.apiSecret - Kraken API secret
   * @param {Object} [config.logger] - Logger instance
   * @param {boolean} [config.testMode=false] - Whether to use test mode
   */
  constructor(config) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('API key and secret are required for token refresh service');
    }
    
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.testMode = config.testMode || false;
    
    // Initialize logger
    this.logger = config.logger || new TradingLogger({
      sessionId: 'kraken-token-refresh',
      component: 'KrakenTokenRefresh'
    });
    
    // Token state management
    this.token = null;
    this.tokenExpiry = null;
    this.refreshAttempts = 0;
    this.maxRefreshAttempts = 5;
    this.lastRefreshTimestamp = null;
    this.refreshInProgress = false;
  }
  
  /**
   * Get a valid WebSocket token, refreshing if necessary
   * 
   * @returns {Promise<string>} WebSocket authentication token
   * @throws {Error} If token refresh fails
   */
  async getToken() {
    // In test mode, return a mock token
    if (this.testMode) {
      this.logger.info('[MOCK] Generated WebSocket token');
      return `mock-token-${Date.now()}`;
    }
    
    // Check if we need to refresh the token
    const now = Date.now();
    const needsRefresh = !this.token || !this.tokenExpiry || now >= this.tokenExpiry - (60 * 1000); // 1 minute buffer
    
    if (needsRefresh) {
      try {
        await this.refreshToken();
      } catch (error) {
        this.logger.error(`Failed to refresh token: ${error.message}`, { error });
        
        // If we have a valid token that will expire soon, use it anyway
        if (this.token && this.tokenExpiry && now < this.tokenExpiry) {
          this.logger.warn(`Using existing token that expires in ${Math.round((this.tokenExpiry - now) / 1000)}s`);
          return this.token;
        }
        
        throw error;
      }
    }
    
    return this.token;
  }
  
  /**
   * Refresh the WebSocket token
   * 
   * @private
   * @returns {Promise<void>}
   * @throws {Error} If token refresh fails
   */
  async refreshToken() {
    // Prevent concurrent refresh attempts
    if (this.refreshInProgress) {
      this.logger.debug('Token refresh already in progress');
      
      // Wait for the ongoing refresh to complete
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.refreshInProgress) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
      
      return;
    }
    
    this.refreshInProgress = true;
    
    try {
      // If we've exceeded max attempts, reset and wait before trying again
      if (this.refreshAttempts >= this.maxRefreshAttempts) {
        this.logger.warn(`Max refresh attempts (${this.maxRefreshAttempts}) reached, resetting counter and waiting 30s`);
        this.refreshAttempts = 0;
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      
      this.refreshAttempts++;
      this.logger.info(`Refreshing WebSocket token (attempt ${this.refreshAttempts}/${this.maxRefreshAttempts})`);
      
      // Create REST client for token retrieval
      const restClient = new KrakenRESTClient({
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        logger: this.logger
      });
      
      // Get new token
      const response = await restClient.getWebSocketToken();
      
      // Check for valid response
      if (!response || !response.result || !response.result.token) {
        throw new Error('Invalid token response from Kraken API');
      }
      
      // Update token and expiry
      this.token = response.result.token;
      const expirySeconds = response.result.expires || 900; // Default 15 minutes
      this.tokenExpiry = Date.now() + (expirySeconds * 1000);
      this.lastRefreshTimestamp = Date.now();
      this.refreshAttempts = 0;
      
      this.logger.info(`Successfully refreshed WebSocket token, expires in ${expirySeconds}s`);
    } catch (error) {
      this.logger.error(`Token refresh failed: ${error.message}`, { error });
      throw error;
    } finally {
      this.refreshInProgress = false;
    }
  }
  
  /**
   * Schedule a token refresh before expiry
   * 
   * @param {Function} [callback] - Callback to be called with the new token
   * @returns {number} Timer ID
   */
  scheduleRefresh(callback) {
    if (!this.tokenExpiry) {
      return null;
    }
    
    // Calculate when to refresh - default to 1 minute before expiry but at least 30s from now
    const now = Date.now();
    const expiresInMs = this.tokenExpiry - now;
    const refreshInMs = Math.max(expiresInMs - (60 * 1000), 30000); // At least 30s from now
    
    this.logger.debug(`Scheduling token refresh in ${Math.round(refreshInMs / 1000)}s (token expires in ${Math.round(expiresInMs / 1000)}s)`);
    
    // Schedule the refresh
    return setTimeout(async () => {
      try {
        await this.refreshToken();
        
        if (callback && typeof callback === 'function') {
          callback(this.token);
        }
        
        // Schedule next refresh
        this.scheduleRefresh(callback);
      } catch (error) {
        this.logger.error(`Scheduled token refresh failed: ${error.message}`, { error });
        
        // Try again sooner if this refresh failed
        setTimeout(() => this.scheduleRefresh(callback), 30000);
      }
    }, refreshInMs);
  }
  
  /**
   * Cancel scheduled token refresh
   * 
   * @param {number} timerId - Timer ID from scheduleRefresh
   */
  cancelScheduledRefresh(timerId) {
    if (timerId) {
      clearTimeout(timerId);
      this.logger.debug('Cancelled scheduled token refresh');
    }
  }
}
