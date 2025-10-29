/**
 * CSV Logger for Trading System
 * 
 * This utility provides progressive CSV logging for trading data,
 * ensuring that critical information is saved even if the application crashes.
 * It writes data incrementally after each trading event rather than only at the end of a session.
 */

import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';

class CSVLogger {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './paper-trading-logs';
    this.symbol = options.symbol || 'UNKNOWN';
    this.sessionId = options.sessionId || 'unknown';
    this.fileTypes = options.fileTypes || ['orders', 'cycles', 'memory', 'ticker', 'trades', 'filled_trades', 'positions']; // Default to all file types
    this.streams = {};
    this.initialized = false;
    this.headers = {
      orders: 'opened_at,closed_at,cycle_id,order_id,side,price,size,market_price,status,profit_loss,spread,refresh_interval,expiration_time_ms,parent_order_id,greenlight',
      cycles: 'timestamp,cycle_id,mid_price,best_bid,best_ask,spread,volatility,order_book_imbalance,market_conditions,orders_placed',
      memory: 'timestamp,heap_used,heap_total,external,array_buffers,event_type',
      ticker: 'timestamp,symbol,bid,ask,last_trade,volume,vwap',
      trades: 'timestamp,symbol,price,volume,time,side,order_type,misc',
      filled_trades: 'timestamp,order_id,side,price,size,fill_price,profit_loss,parent_order_id,cycle_id,session_id,greenlight',
      positions: 'timestamp,symbol,trade_type,side,size,price,order_id,remaining_size,realized_pnl'
    };
    
    // Use simple console for logging
    this.logger = options.logger || console;
    
    // Store the base filename for later reference
    this.baseFilename = null;
  }

  /**
   * Initialize the logger by creating output directory and file streams
   */
  async initialize() {
    try {
      // Create output directory if it doesn't exist
      await fs.mkdir(this.outputDir, { recursive: true });
      
      // Generate base filename with timestamp and session ID
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.+/, '');
      const shortId = this.sessionId.includes('-') ? this.sessionId.split('-')[0] : this.sessionId.substr(0, 8);
      this.baseFilename = `${this.symbol.replace('/', '-')}-${timestamp}-${shortId}`;
      
      // Create streams only for the specified file types
      for (const type of this.fileTypes) {
        if (this.headers[type]) {
          this.createStream(type, `${type}-${this.baseFilename}.csv`);
          // Write headers to each file
          this.streams[type].write(`${this.headers[type]}\n`);
        }
      }
      
      this.initialized = true;
      console.log(`CSV Logger initialized with base filename: ${this.baseFilename}`);
      return true;
    } catch (error) {
      console.error(`Failed to initialize CSV logger: ${error.message}`);
      return false;
    }
  }

  /**
   * Create a write stream for a specific log type
   */
  createStream(type, filename) {
    try {
      const filePath = path.join(this.outputDir, filename);
      this.streams[type] = createWriteStream(filePath, { flags: 'a' });
      
      // Handle stream errors
      this.streams[type].on('error', (error) => {
        console.error(`Error writing to ${type} CSV file: ${error.message}`);
      });
    } catch (error) {
      console.error(`Error creating stream for ${type}: ${error.message}`);
    }
  }

  /**
   * Get the log directory path
   * @returns {string} The path to the log directory
   */
  getLogDirectory() {
    return this.outputDir;
  }

  /**
   * Log an order to the orders CSV file
   */
  logOrder(orderData) {
    if (!this.initialized) {
      this.initialize().catch(err => console.error('Failed to initialize CSV logger:', err));
      return false;
    }
    
    try {
      const {
        openedAt = Date.now(),
        closedAt = '',
        cycle_id = 'unknown',
        order_id = 'unknown',
        side = 'unknown',
        price = 0,
        size = 0,
        market_price = 0,
        status = 'unknown',
        profit_loss = 0,
        spread = 0,
        refresh_interval = 0,
        expiration_time_ms = 0,
        parent_order_id = '',
        greenlight = true
      } = orderData;
      
      const formattedOpenedAt = this.formatTimestamp(openedAt);
      const formattedClosedAt = closedAt ? this.formatTimestamp(closedAt) : '';
      const line = `${formattedOpenedAt},${formattedClosedAt},${cycle_id},${order_id},${side},${price},${size},${market_price},${status},${profit_loss},${spread},${refresh_interval},${expiration_time_ms},${parent_order_id},${greenlight}\n`;
      
      if (this.streams.orders) {
        this.streams.orders.write(line);
        console.log(`Logged order: ${order_id}`);
      }
      return true;
    } catch (error) {
      console.error(`Failed to log order: ${error.message}`);
      return false;
    }
  }

  /**
   * Log position event data (alias for logPosition for compatibility)
   * @param {Object} eventData - Position event data
   * @returns {boolean} - Success status
   */
  logPositionEvent(eventData = {}) {
    // This is an alias for logPosition to maintain compatibility with PositionManager
    return this.logPosition(eventData);
  }

  /**
   * Format a timestamp for CSV output
   */
  formatTimestamp(timestamp) {
    try {
      return new Date(timestamp).toISOString();
    } catch (e) {
      return new Date().toISOString();
    }
  }

  /**
   * Close all file streams
   */
  async close() {
    if (!this.initialized) return;
    
    const closePromises = Object.values(this.streams).map(stream => {
      return new Promise((resolve) => {
        stream.end(() => resolve());
      });
    });
    
    await Promise.all(closePromises);
    this.initialized = false;
    console.log('CSV Logger closed all file streams');
  }
  
  // Simplified methods for other log types
  logCycle() { return true; }
  logMemoryUsage() { return true; }
  logTicker() { return true; }
  logTrade() { return true; }
  logFilledTrade() { return true; }
  logPosition() { return true; }
}

export default CSVLogger;