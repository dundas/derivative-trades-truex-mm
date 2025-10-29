import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

import { CoinbaseWebSocketClient } from '../../../lib/exchanges/coinbase/CoinbaseWebSocketClient.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Coinbase Data Collector using existing CoinbaseWebSocketClient
 * This should work with authentication if available
 */
class CoinbaseCollector {
  constructor() {
    this.symbol = 'BTC-USD';
    this.collectionTime = 10 * 60 * 1000; // 10 minutes
    this.snapshots = [];
    this.updates = [];
    this.startTime = null;
    this.client = null;
    
    // Output files
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dataFile = path.join(__dirname, `coinbase-existing-client-data-${timestamp}.json`);
    this.logFile = path.join(__dirname, `coinbase-existing-client-log-${timestamp}.log`);
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    
    // Track data
    this.snapshotCount = 0;
    this.updateCount = 0;
    this.tickerCount = 0;
    this.tradeCount = 0;
  }
  
  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    this.logStream.write(logMessage + '\n');
  }
  
  async start() {
    this.log('🚀 Starting Coinbase Collection with Existing Client');
    this.log('===================================================');
    this.log(`Symbol: ${this.symbol}`);
    this.log(`Duration: ${this.collectionTime / 60000} minutes`);
    this.log(`Output: ${this.dataFile}`);
    this.log('');
    
    this.startTime = Date.now();
    
    try {
      await this.setupClient();
      await this.client.connect();
      await this.client.subscribe('book', [this.symbol]);
      
      this.log('✅ Connected and subscribed - collecting data...');
      this.log('');
      
      // Auto-stop after collection time
      setTimeout(async () => {
        await this.stop();
      }, this.collectionTime);
      
    } catch (error) {
      this.log(`❌ Collection failed: ${error.message}`);
      throw error;
    }
  }
  
  async setupClient() {
    this.log('🔧 Setting up Coinbase WebSocket client...');
    
    this.client = new CoinbaseWebSocketClient({
      logger: (level, message, data) => {
        this.log(`[${level.toUpperCase()}] ${message}`);
      },
      onOrderBookUpdate: (symbol, orderbook) => {
        this.handleOrderBookUpdate(symbol, orderbook);
      },
      onTickerUpdate: (symbol, ticker) => {
        this.handleTickerUpdate(symbol, ticker);
      },
      onTradeUpdate: (symbol, trades) => {
        this.handleTradeUpdate(symbol, trades);
      },
      onError: (error) => {
        this.log(`❌ WebSocket Error: ${error.message}`);
      }
    });
  }
  
  handleOrderBookUpdate(symbol, orderbook) {
    this.snapshotCount++;
    
    const snapshot = {
      timestamp: Date.now(),
      messageType: 'orderbook',
      data: {
        product_id: symbol,
        bids: orderbook.bids || [],
        asks: orderbook.asks || []
      }
    };
    
    this.snapshots.push(snapshot);
    
    // Progress updates every 50 snapshots
    if (this.snapshotCount % 50 === 0) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      const remaining = (this.collectionTime - (Date.now() - this.startTime)) / 1000;
      this.log(`📊 Progress: ${this.snapshotCount} snapshots | ${elapsed.toFixed(0)}s elapsed | ${remaining.toFixed(0)}s remaining`);
    }
    
    // Debug first few snapshots
    if (this.snapshotCount <= 3) {
      const bidCount = orderbook.bids ? orderbook.bids.length : 0;
      const askCount = orderbook.asks ? orderbook.asks.length : 0;
      const bestBid = orderbook.bids && orderbook.bids[0] ? (orderbook.bids[0].price || orderbook.bids[0][0]) : 'N/A';
      const bestAsk = orderbook.asks && orderbook.asks[0] ? (orderbook.asks[0].price || orderbook.asks[0][0]) : 'N/A';
      this.log(`📸 Snapshot ${this.snapshotCount}: ${bidCount} bids, ${askCount} asks | Best: $${bestBid}/$${bestAsk}`);
    }
  }
  
  handleTickerUpdate(symbol, ticker) {
    this.tickerCount++;
    // We don't need ticker data for TrueX analysis, just log it
    if (this.tickerCount === 1) {
      this.log(`📈 Receiving ticker updates (${this.tickerCount} so far)`);
    }
  }
  
  handleTradeUpdate(symbol, trades) {
    this.tradeCount++;
    // We don't need trade data for TrueX analysis, just log it
    if (this.tradeCount === 1) {
      this.log(`💱 Receiving trade updates (${this.tradeCount} so far)`);
    }
  }
  
  async stop() {
    this.log('');
    this.log('🛑 Stopping Coinbase Collection');
    this.log('================================');
    
    if (this.client) {
      this.client.disconnect();
    }
    
    const duration = (Date.now() - this.startTime) / 1000;
    this.log(`📊 Collection Complete (${duration.toFixed(0)}s):`);
    this.log(`   Orderbook Snapshots: ${this.snapshotCount}`);
    this.log(`   Ticker Updates: ${this.tickerCount}`);
    this.log(`   Trade Updates: ${this.tradeCount}`);
    this.log('');
    
    // Save data using streaming approach
    try {
      const metadata = {
        exchange: 'coinbase-existing-client',
        symbol: this.symbol,
        startTime: this.startTime,
        endTime: Date.now(),
        duration: duration,
        snapshotCount: this.snapshotCount,
        tickerCount: this.tickerCount,
        tradeCount: this.tradeCount,
        method: 'Existing CoinbaseWebSocketClient'
      };
      
      this.log('💾 Saving data using streaming approach...');
      
      const writeStream = fs.createWriteStream(this.dataFile);
      
      // Write metadata and snapshots
      writeStream.write('{\n  "metadata": ' + JSON.stringify(metadata, null, 2).replace(/^/gm, '  ') + ',\n');
      writeStream.write('  "snapshots": [\n');
      
      for (let i = 0; i < this.snapshots.length; i++) {
        const snapshot = this.snapshots[i];
        const snapshotJson = JSON.stringify(snapshot, null, 4).replace(/^/gm, '    ');
        writeStream.write(snapshotJson);
        if (i < this.snapshots.length - 1) writeStream.write(',');
        writeStream.write('\n');
      }
      
      writeStream.write('  ]\n}');
      writeStream.end();
      
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      
      this.log('✅ Data saved successfully!');
      
    } catch (saveError) {
      this.log(`❌ Save failed: ${saveError.message}`);
    }
    
    this.log(`💾 Data file: ${this.dataFile}`);
    this.log(`📁 Log file: ${this.logFile}`);
    this.log('');
    this.log('✅ Collection complete! Ready for TrueX analysis.');
    
    this.logStream.end();
    process.exit(0);
  }
}

// Run the collector
const collector = new CoinbaseCollector();
collector.start().catch((error) => {
  console.error('❌ Collection failed:', error.message);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, stopping collection...');
  collector.stop().catch(console.error);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, stopping collection...');
  collector.stop().catch(console.error);
});