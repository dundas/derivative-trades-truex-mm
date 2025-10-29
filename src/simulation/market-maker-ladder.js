#!/usr/bin/env node
/**
 * TrueX Market Maker Ladder Script
 *
 * Places limit orders on both sides of the order book (bids and asks) to create
 * a two-sided market. Tracks fills and builds OHLC candles from execution reports.
 *
 * Usage:
 *   node market-maker-ladder.js [--session-id=<id>] [--config=<path>]
 *
 * @module market-maker-ladder
 */

import { fileURLToPath } from 'url';
import path from 'path';
import WebSocket from 'ws';
import { FIXConnection } from '../fix-protocol/fix-connection.js';
import { TrueXOhlcBuilder } from '../data-pipeline/ohlc-builder.js';
import { getSimulationConfig, generateSenderCompID } from './simulation-config.js';
import RedisClient from '../../lib/utils/redis-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Market Maker state and tracking
 */
class MarketMaker {
  constructor(config, sessionId) {
    this.config = config;
    this.sessionId = sessionId;
    this.senderCompID = generateSenderCompID('MAKER', sessionId);

    // Connection managers
    this.coinbase = null;
    this.fix = null;
    this.redis = null;
    this.ohlcBuilder = null;

    // Market state
    this.currentPrice = null;
    this.orders = new Map(); // clOrdID -> order details

    // Tracking
    this.stats = {
      ordersPlaced: 0,
      ordersAccepted: 0,
      ordersRejected: 0,
      fills: 0,
      partialFills: 0,
      totalVolume: 0,
      ohlcCandles: 0
    };

    // Graceful shutdown
    this.isShuttingDown = false;
    this.setupShutdownHandlers();
  }

  /**
   * Initialize all connections (Coinbase, FIX, Redis, OHLC builder)
   */
  async initialize() {
    console.log('🚀 Initializing Market Maker...');
    console.log(`   Session ID: ${this.sessionId}`);
    console.log(`   Sender Comp ID: ${this.senderCompID}`);
    console.log(`   Symbol: ${this.config.maker.symbol}`);
    console.log('');

    // Connect to Coinbase for live price data
    await this.connectToCoinbase();
    console.log(`✅ Coinbase connected - Current price: $${this.currentPrice.toFixed(2)}`);
    console.log('');

    // Connect to TrueX FIX
    await this.connectToFIX();

    // Initialize OHLC builder
    this.ohlcBuilder = new TrueXOhlcBuilder({
      symbol: this.config.maker.symbol,
      exchange: 'truex',
      intervalMs: 60000, // 1 minute candles
      logger: console
    });
    console.log('✅ OHLC builder initialized');

    // Initialize Redis client
    this.redis = new RedisClient();
    console.log('✅ Redis client initialized');
    console.log('');
  }

  /**
   * Connect to Coinbase WebSocket for live price data
   */
  async connectToCoinbase() {
    console.log('📊 Connecting to Coinbase WebSocket...');

    return new Promise((resolve, reject) => {
      const wsUrl = 'wss://ws-feed.exchange.coinbase.com';
      this.coinbase = new WebSocket(wsUrl);

      // Connection timeout
      const timeout = setTimeout(() => {
        reject(new Error('Coinbase WebSocket connection timeout'));
      }, 10000);

      this.coinbase.on('open', () => {
        console.log('✅ Connected to Coinbase WebSocket');

        // Subscribe to ticker channel for BTC-USD
        const subscribeMessage = {
          type: 'subscribe',
          product_ids: ['BTC-USD'],
          channels: ['ticker']
        };

        this.coinbase.send(JSON.stringify(subscribeMessage));
        console.log('📡 Subscribed to BTC-USD ticker channel');
      });

      this.coinbase.on('message', (data) => {
        try {
          const message = JSON.parse(data);

          // Handle ticker updates
          if (message.type === 'ticker' && message.product_id === 'BTC-USD') {
            const price = parseFloat(message.price);

            if (price && !isNaN(price)) {
              this.currentPrice = price;

              // Resolve promise on first price update
              if (timeout) {
                clearTimeout(timeout);
                resolve();
              }

              // Log periodic price updates (every 5 seconds)
              const now = Date.now();
              if (!this._lastPriceLog || now - this._lastPriceLog > 5000) {
                console.log(`💰 BTC Price: $${price.toFixed(2)}`);
                this._lastPriceLog = now;
              }
            }
          }
        } catch (error) {
          console.error('Error processing Coinbase message:', error);
        }
      });

      this.coinbase.on('error', (error) => {
        console.error('❌ Coinbase WebSocket error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      this.coinbase.on('close', () => {
        console.log('🔌 Coinbase WebSocket closed');
      });
    });
  }

  /**
   * Connect to TrueX via FIX protocol
   */
  async connectToFIX() {
    console.log('🔗 Connecting to TrueX FIX...');
    console.log(`   Host: ${this.config.truex.fixHost}:${this.config.truex.fixPort}`);
    console.log(`   Sender: ${this.senderCompID}`);
    console.log(`   Target: ${this.config.truex.targetCompID}`);
    console.log('');

    this.fix = new FIXConnection({
      host: this.config.truex.fixHost,
      port: this.config.truex.fixPort,
      senderCompID: this.senderCompID,
      targetCompID: this.config.truex.targetCompID,
      apiKey: this.config.truex.apiKey,
      apiSecret: this.config.truex.apiSecret,
      heartbeatInterval: this.config.maker.heartbeatInterval,
      logger: console
    });

    // Setup execution report handlers before connecting
    this.setupExecutionReportHandlers();

    // Connect and authenticate
    await this.fix.connect();
    console.log('✅ FIX connection established and logged on');
    console.log('');
  }

  /**
   * Setup execution report event handlers
   */
  setupExecutionReportHandlers() {
    this.fix.on('message', (message) => {
      const msgType = message.fields['35'];

      // Handle Execution Reports (MsgType = '8')
      if (msgType === '8') {
        this.handleExecutionReport(message);
      }
    });

    this.fix.on('error', (error) => {
      console.error('❌ FIX connection error:', error.message);
    });
  }

  /**
   * Handle execution report message
   */
  handleExecutionReport(message) {
    const clOrdID = message.fields['11'];
    const execType = message.fields['150']; // ExecType
    const ordStatus = message.fields['39'];  // OrdStatus
    const price = parseFloat(message.fields['44'] || '0');
    const qty = parseFloat(message.fields['38'] || '0');
    const side = message.fields['54'] === '1' ? 'BUY' : 'SELL';

    // ExecType values:
    // '0' = New (order accepted)
    // '1' = Partial Fill
    // '2' = Fill (completely filled)
    // '4' = Canceled
    // '8' = Rejected

    // Update order tracking
    if (this.orders.has(clOrdID)) {
      const order = this.orders.get(clOrdID);
      order.status = ordStatus;
      order.execType = execType;
    }

    // Handle based on ExecType
    if (execType === '0') {
      // New (order accepted)
      this.stats.ordersAccepted++;
      console.log(`✅ Order Accepted: ${side} ${qty} @ $${price.toFixed(2)} (${this.stats.ordersAccepted}/${this.stats.ordersPlaced})`);

    } else if (execType === '1') {
      // Partial Fill
      this.stats.partialFills++;
      this.stats.totalVolume += qty;
      console.log(`🟡 Partial Fill: ${side} ${qty} @ $${price.toFixed(2)}`);
      this.updateOHLC({ price, qty, timestamp: Date.now(), side, clOrdID });

    } else if (execType === '2') {
      // Fill (completely filled)
      this.stats.fills++;
      this.stats.totalVolume += qty;
      console.log(`🟢 Fill: ${side} ${qty} @ $${price.toFixed(2)} (Total fills: ${this.stats.fills})`);
      this.updateOHLC({ price, qty, timestamp: Date.now(), side, clOrdID });

    } else if (execType === '8') {
      // Rejected
      this.stats.ordersRejected++;
      const rejectReason = message.fields['58'] || 'Unknown reason';
      console.log(`❌ Order Rejected: ${rejectReason}`);

    } else if (execType === '4') {
      // Canceled
      console.log(`⚪ Order Canceled: ${clOrdID}`);
    }
  }

  /**
   * Generate order ladder around current Coinbase price
   */
  generateOrderLadder(basePrice) {
    const totalOrders = this.config.maker.totalOrders;
    const priceLevels = this.config.maker.priceLevels;
    const increment = this.config.maker.spread;
    const orderSize = this.config.maker.orderSize;

    const ordersPerSide = Math.floor(totalOrders / 2);
    const orders = [];

    console.log(`📊 Generating ${totalOrders} orders around $${basePrice.toFixed(2)}`);
    console.log(`   ${ordersPerSide} buys below market`);
    console.log(`   ${ordersPerSide} sells above market`);
    console.log('');

    // Buy orders (below market)
    for (let level = 1; level <= priceLevels; level++) {
      const ordersAtLevel = Math.ceil(ordersPerSide / priceLevels);

      for (let i = 0; i < ordersAtLevel && orders.filter(o => o.side === 'buy').length < ordersPerSide; i++) {
        const levelOffset = level * increment;
        const price = Math.floor((basePrice - levelOffset) / increment) * increment;

        orders.push({
          side: 'buy',
          price: price,
          size: orderSize,
          level: level
        });
      }
    }

    // Sell orders (above market)
    for (let level = 1; level <= priceLevels; level++) {
      const ordersAtLevel = Math.ceil(ordersPerSide / priceLevels);

      for (let i = 0; i < ordersAtLevel && orders.filter(o => o.side === 'sell').length < ordersPerSide; i++) {
        const levelOffset = level * increment;
        const price = Math.ceil((basePrice + levelOffset) / increment) * increment;

        orders.push({
          side: 'sell',
          price: price,
          size: orderSize,
          level: level
        });
      }
    }

    const finalOrders = orders.slice(0, totalOrders);

    // Log order distribution summary
    const buyOrders = finalOrders.filter(o => o.side === 'buy');
    const sellOrders = finalOrders.filter(o => o.side === 'sell');
    const minBuyPrice = Math.min(...buyOrders.map(o => o.price));
    const maxBuyPrice = Math.max(...buyOrders.map(o => o.price));
    const minSellPrice = Math.min(...sellOrders.map(o => o.price));
    const maxSellPrice = Math.max(...sellOrders.map(o => o.price));

    console.log(`✅ Generated ${finalOrders.length} orders:`);
    console.log(`   ${buyOrders.length} buys: $${minBuyPrice.toFixed(2)} - $${maxBuyPrice.toFixed(2)}`);
    console.log(`   ${sellOrders.length} sells: $${minSellPrice.toFixed(2)} - $${maxSellPrice.toFixed(2)}`);
    console.log(`   Spread: $${(minSellPrice - maxBuyPrice).toFixed(2)}`);
    console.log('');

    return finalOrders;
  }

  /**
   * Place all orders on TrueX
   */
  async placeOrders(orders) {
    console.log(`📤 Placing ${orders.length} orders...`);
    console.log('');

    const partyIDFields = this.buildPartyIDFields();
    const testId = Date.now();

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const clOrdID = `MAKER-${testId}-${i}`.slice(0, 18); // Limit to 18 chars for TrueX

      const fixOrder = {
        '35': 'D',                                // MsgType = New Order Single
        '11': clOrdID,                            // ClOrdID
        '55': this.config.maker.symbol,           // Symbol
        '54': order.side === 'buy' ? '1' : '2',   // Side (1=Buy, 2=Sell)
        '38': order.size.toString(),              // OrderQty
        '40': '2',                                // OrdType = Limit
        '44': order.price.toFixed(1),             // Price
        '59': '1',                                // TimeInForce = GTC
        ...partyIDFields                          // Party ID fields (453/448/452)
      };

      // Track order
      this.orders.set(clOrdID, {
        clOrdID,
        side: order.side,
        price: order.price,
        size: order.size,
        level: order.level,
        status: 'sent',
        sentAt: Date.now()
      });

      // Submit order via FIX
      await this.fix.sendMessage(fixOrder);
      this.stats.ordersPlaced++;

      // Progress logging every 10 orders
      if ((i + 1) % 10 === 0) {
        console.log(`   ✅ ${i + 1}/${orders.length} orders sent...`);
      }

      // Pacing: wait 20ms between orders
      if (i < orders.length - 1) {
        await new Promise(resolve => setTimeout(resolve, this.config.maker.orderPacingMs));
      }
    }

    console.log('');
    console.log(`✅ All ${orders.length} orders submitted`);
    console.log('');
  }

  /**
   * Build Party ID fields for TrueX orders
   */
  buildPartyIDFields() {
    return {
      '453': '1',                           // NoPartyIDs
      '448': this.config.truex.clientId,    // PartyID
      '452': '3'                            // PartyRole (3 = Client ID)
    };
  }

  /**
   * Update OHLC candles from fill execution report
   */
  updateOHLC(executionReport) {
    const { price, qty, timestamp, side, clOrdID } = executionReport;

    // Update OHLC builder with fill
    const candle = this.ohlcBuilder.updateWithTrade({
      timestamp,
      price,
      volume: qty,
      symbol: this.config.maker.symbol
    });

    if (candle) {
      this.stats.ohlcCandles++;
      console.log(`📊 OHLC updated: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume.toFixed(4)}`);
    }
  }

  /**
   * Store OHLC candles to Redis
   */
  async storeOHLCToRedis() {
    if (!this.ohlcBuilder || !this.redis) {
      console.log('⚠️  OHLC builder or Redis not initialized, skipping storage');
      return;
    }

    console.log('💾 Storing OHLC candles to Redis...');

    const candles = Array.from(this.ohlcBuilder.candles.values());

    if (candles.length === 0) {
      console.log('   No candles to store');
      return;
    }

    const redisKey = `session:${this.sessionId}:ohlc:1m`;

    for (const candle of candles) {
      const field = `${candle.symbol}:${candle.timestamp}`;
      await this.redis.hset(redisKey, field, JSON.stringify(candle));
    }

    console.log(`✅ Stored ${candles.length} OHLC candles to Redis: ${redisKey}`);
  }

  /**
   * Export results for orchestrator
   */
  exportResults() {
    const candles = this.ohlcBuilder
      ? Array.from(this.ohlcBuilder.candles.values())
      : [];

    return {
      sessionId: this.sessionId,
      senderCompID: this.senderCompID,
      stats: {
        ...this.stats,
        currentPrice: this.currentPrice
      },
      orders: Array.from(this.orders.values()),
      ohlcCandles: candles,
      success: this.stats.ordersAccepted >= this.config.orchestrator.makerReadyThreshold,
      timestamp: Date.now()
    };
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupShutdownHandlers() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

      // Disconnect Coinbase WebSocket
      if (this.coinbase) {
        this.coinbase.close();
        console.log('🔌 Closed Coinbase WebSocket');
      }

      // Disconnect FIX connection
      if (this.fix) {
        await this.fix.disconnect();
        console.log('🔌 Closed FIX connection');
      }

      // Store OHLC candles to Redis before shutdown
      await this.storeOHLCToRedis();

      // Close Redis connection
      if (this.redis) {
        await this.redis.quit();
        console.log('🔌 Closed Redis connection');
      }

      // Log final stats
      console.log('');
      console.log('📊 Final Stats:');
      console.log(`   Orders Placed: ${this.stats.ordersPlaced}`);
      console.log(`   Orders Accepted: ${this.stats.ordersAccepted}`);
      console.log(`   Orders Rejected: ${this.stats.ordersRejected}`);
      console.log(`   Fills: ${this.stats.fills}`);
      console.log(`   Partial Fills: ${this.stats.partialFills}`);
      console.log(`   Total Volume: ${this.stats.totalVolume.toFixed(4)} BTC`);
      console.log(`   OHLC Candles: ${this.stats.ohlcCandles}`);
      console.log('');

      console.log('✅ Market Maker shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  /**
   * Main execution loop
   */
  async run() {
    try {
      // Initialize connections (includes Coinbase connection and price wait)
      await this.initialize();

      // Generate order ladder based on current Coinbase price
      const orders = this.generateOrderLadder(this.currentPrice);

      // Place orders on TrueX
      await this.placeOrders(orders);

      // Wait for execution reports
      console.log('⏳ Monitoring for execution reports...');
      console.log(`   Ready signal will fire when ${this.config.orchestrator.makerReadyThreshold}+ orders accepted`);
      console.log('');

      // Keep running until shutdown
      // The orchestrator will send SIGTERM when test is complete
      await new Promise(() => {}); // Keep alive

    } catch (error) {
      console.error('❌ Market Maker error:', error);
      process.exit(1);
    }
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    sessionId: null,
    configPath: null
  };

  args.forEach(arg => {
    if (arg.startsWith('--session-id=')) {
      parsed.sessionId = arg.split('=')[1];
    } else if (arg.startsWith('--config=')) {
      parsed.configPath = arg.split('=')[1];
    }
  });

  return parsed;
}

/**
 * Main entry point
 */
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         TrueX Market Maker - Two-Sided Simulation             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Parse arguments
  const args = parseArgs();

  // Load configuration
  const config = getSimulationConfig();

  // Generate or use provided session ID
  const sessionId = args.sessionId || `maker-${Date.now()}`;

  // Create and run market maker
  const maker = new MarketMaker(config, sessionId);
  await maker.run();
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { MarketMaker };
