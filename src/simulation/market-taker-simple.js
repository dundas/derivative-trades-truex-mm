#!/usr/bin/env node
/**
 * TrueX Market Taker Script (Simple Delay-Based Strategy)
 *
 * Observes maker orders and hits them with aggressive limit orders to create
 * two-sided fills. Uses a simple delay-based strategy without market data subscription.
 *
 * Usage:
 *   node market-taker-simple.js [--session-id=<id>] [--reference-price=<price>] [--config=<path>]
 *
 * @module market-taker-simple
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { FIXConnection } from '../fix-protocol/fix-connection.js';
import { getSimulationConfig, generateSenderCompID } from './simulation-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Market Taker state and tracking
 */
class MarketTaker {
  constructor(config, sessionId, referencePrice) {
    this.config = config;
    this.sessionId = sessionId;
    this.referencePrice = referencePrice;
    this.senderCompID = generateSenderCompID('TAKER', sessionId);

    // Connection managers
    this.fix = null;

    // Market state
    this.makerPriceLevels = null; // Will be calculated from reference price
    this.orders = new Map(); // clOrdID -> order details

    // Tracking
    this.stats = {
      ordersPlaced: 0,
      ordersAccepted: 0,
      ordersRejected: 0,
      fills: 0,
      partialFills: 0,
      totalVolume: 0
    };

    this.isShuttingDown = false;
  }

  /**
   * Calculate maker's price levels based on reference price and spread
   * This allows taker to know where maker's orders are without market data subscription
   */
  calculateMakerPriceLevels() {
    const spread = this.config.maker.spread;
    const priceLevels = this.config.maker.priceLevels;
    const basePrice = this.referencePrice;

    const levels = {
      bids: [], // Maker's buy orders (we'll sell into these)
      asks: []  // Maker's sell orders (we'll buy from these)
    };

    // Calculate bid levels (below market)
    for (let level = 1; level <= priceLevels; level++) {
      const levelOffset = level * spread;
      const price = Math.floor((basePrice - levelOffset) / spread) * spread;
      levels.bids.push(price);
    }

    // Calculate ask levels (above market)
    for (let level = 1; level <= priceLevels; level++) {
      const levelOffset = level * spread;
      const price = Math.ceil((basePrice + levelOffset) / spread) * spread;
      levels.asks.push(price);
    }

    console.log(`📊 Calculated maker price levels:`);
    console.log(`   Bid levels (${levels.bids.length}): $${levels.bids[levels.bids.length - 1].toFixed(2)} - $${levels.bids[0].toFixed(2)}`);
    console.log(`   Ask levels (${levels.asks.length}): $${levels.asks[0].toFixed(2)} - $${levels.asks[levels.asks.length - 1].toFixed(2)}`);

    this.makerPriceLevels = levels;
  }

  /**
   * Select random price levels to hit
   * Returns array of {side, price} objects
   */
  selectOrdersToHit() {
    const targetFills = this.config.taker.targetFills;
    const ordersToHit = [];

    // Get all available levels
    const allLevels = [
      ...this.makerPriceLevels.bids.map(price => ({ side: 'sell', price })),
      ...this.makerPriceLevels.asks.map(price => ({ side: 'buy', price }))
    ];

    // Shuffle and select target number
    const shuffled = allLevels.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(targetFills, allLevels.length));

    console.log(`🎯 Selected ${selected.length} orders to hit (target: ${targetFills})`);
    console.log(`   Buy orders: ${selected.filter(o => o.side === 'buy').length}`);
    console.log(`   Sell orders: ${selected.filter(o => o.side === 'sell').length}`);

    return selected;
  }

  /**
   * Calculate aggressive limit price to ensure fill
   *
   * For buy orders (lifting maker's asks): price = maker's ask + offset
   * For sell orders (hitting maker's bids): price = maker's bid - offset
   */
  calculateAggressivePrice(side, makerPrice) {
    const offset = this.config.taker.priceOffset;

    if (side === 'buy') {
      // Lifting maker's ask - pay slightly more
      return makerPrice + offset;
    } else {
      // Hitting maker's bid - sell slightly lower
      return makerPrice - offset;
    }
  }

  /**
   * Build Party ID fields for TrueX compliance
   * Fields: 453 (NoPartyIDs), 448 (PartyID), 452 (PartyIDSource)
   */
  buildPartyIDFields() {
    return {
      '453': '1', // NoPartyIDs
      '448': this.config.truex.clientId2, // PartyID (taker uses clientId2)
      '452': 'D' // PartyIDSource (proprietary)
    };
  }

  /**
   * Initialize FIX connection
   */
  async connectToFIX() {
    console.log('🔌 Connecting to TrueX FIX gateway...');

    this.fix = new FIXConnection({
      host: this.config.truex.fixHost,
      port: this.config.truex.fixPort,
      senderCompID: this.senderCompID,
      targetCompID: this.config.truex.targetCompID,
      apiKey: this.config.truex.apiKey,
      apiSecret: this.config.truex.apiSecret,
      heartbeatInterval: this.config.taker.heartbeatInterval,
      logger: console
    });

    // Setup execution report handlers
    this.setupExecutionReportHandlers();

    // Connect
    await this.fix.connect();
    console.log('✅ FIX connection established and logged on');
  }

  /**
   * Setup execution report event handlers
   */
  setupExecutionReportHandlers() {
    this.fix.on('executionReport', (message) => {
      this.handleExecutionReport(message);
    });
  }

  /**
   * Handle execution report from TrueX
   *
   * ExecType values:
   *   '0' = New (order accepted)
   *   '1' = Partial Fill
   *   '2' = Fill
   *   '4' = Canceled
   *   '8' = Rejected
   */
  handleExecutionReport(message) {
    const clOrdID = message.fields['11'];
    const execType = message.fields['150'];
    const ordStatus = message.fields['39'];
    const side = message.fields['54'];
    const price = parseFloat(message.fields['44'] || '0');
    const qty = parseFloat(message.fields['38'] || '0');
    const cumQty = parseFloat(message.fields['14'] || '0');

    const order = this.orders.get(clOrdID);
    if (!order) {
      console.warn(`⚠️  Received execution report for unknown order: ${clOrdID}`);
      return;
    }

    // Update order state
    order.execType = execType;
    order.ordStatus = ordStatus;
    order.cumQty = cumQty;

    // Handle different execution types
    if (execType === '0') {
      // Order accepted
      this.stats.ordersAccepted++;
      const sideStr = side === '1' ? 'BUY' : 'SELL';
      console.log(`✅ Order Accepted: ${sideStr} ${qty} @ $${price.toFixed(2)} (${this.stats.ordersAccepted}/${this.stats.ordersPlaced})`);
    } else if (execType === '1') {
      // Partial fill
      this.stats.partialFills++;
      this.stats.totalVolume += parseFloat(message.fields['32'] || '0'); // LastQty
      const sideStr = side === '1' ? 'BUY' : 'SELL';
      console.log(`📈 Partial Fill: ${sideStr} ${cumQty}/${qty} @ $${price.toFixed(2)}`);
    } else if (execType === '2') {
      // Full fill
      this.stats.fills++;
      this.stats.totalVolume += parseFloat(message.fields['32'] || '0'); // LastQty
      const sideStr = side === '1' ? 'BUY' : 'SELL';
      console.log(`💰 Fill: ${sideStr} ${qty} @ $${price.toFixed(2)} (${this.stats.fills}/${this.config.taker.targetFills})`);
    } else if (execType === '8') {
      // Rejected
      this.stats.ordersRejected++;
      const reason = message.fields['103'] || 'Unknown';
      console.log(`❌ Order Rejected: ${reason}`);
    }
  }

  /**
   * Place aggressive orders to hit maker's orders
   */
  async placeOrders(ordersToHit) {
    console.log(`📤 Placing ${ordersToHit.length} aggressive orders...`);

    const partyIDFields = this.buildPartyIDFields();
    const testId = Date.now();

    for (let i = 0; i < ordersToHit.length; i++) {
      const order = ordersToHit[i];

      // Calculate aggressive price to ensure fill
      const aggressivePrice = this.calculateAggressivePrice(order.side, order.price);

      // Generate unique ClOrdID (max 18 chars for TrueX)
      const clOrdID = `TAKER-${testId}-${i}`.slice(0, 18);

      // Build FIX order message (NewOrderSingle)
      const fixOrder = {
        '35': 'D', // MsgType = NewOrderSingle
        '11': clOrdID, // ClOrdID
        '55': this.config.taker.symbol, // Symbol
        '54': order.side === 'buy' ? '1' : '2', // Side (1=Buy, 2=Sell)
        '38': this.config.taker.orderSize.toString(), // OrderQty
        '40': '2', // OrdType = Limit
        '44': aggressivePrice.toFixed(1), // Price (1 decimal for TrueX)
        '59': '1', // TimeInForce = GTC
        ...partyIDFields
      };

      // Track order
      this.orders.set(clOrdID, {
        clOrdID,
        side: order.side,
        price: aggressivePrice,
        targetPrice: order.price,
        size: this.config.taker.orderSize,
        status: 'pending',
        timestamp: Date.now()
      });

      // Send order
      await this.fix.sendMessage(fixOrder);
      this.stats.ordersPlaced++;

      const sideStr = order.side === 'buy' ? 'BUY' : 'SELL';
      console.log(`   ${i + 1}/${ordersToHit.length}: ${sideStr} ${this.config.taker.orderSize} @ $${aggressivePrice.toFixed(2)} (targeting maker @ $${order.price.toFixed(2)})`);

      // Random pacing between orders (unless last order)
      if (i < ordersToHit.length - 1) {
        const delay = Math.floor(
          Math.random() * (this.config.taker.maxDelayMs - this.config.taker.minDelayMs) +
          this.config.taker.minDelayMs
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.log('');
    console.log(`✅ All ${ordersToHit.length} orders submitted`);
    console.log('');
  }

  /**
   * Check if exit criteria met
   */
  shouldExit() {
    // Exit if target fills achieved
    if (this.stats.fills >= this.config.taker.targetFills) {
      console.log(`🎯 Target fills achieved: ${this.stats.fills}/${this.config.taker.targetFills}`);
      return true;
    }

    // Exit if all orders are in terminal state
    const allTerminal = Array.from(this.orders.values()).every(order => {
      return order.ordStatus === '2' || // Filled
             order.ordStatus === '4' || // Canceled
             order.ordStatus === '8';   // Rejected
    });

    if (allTerminal && this.stats.ordersPlaced > 0) {
      console.log('✅ All orders in terminal state');
      return true;
    }

    return false;
  }

  /**
   * Export results for orchestrator consumption
   */
  exportResults() {
    return {
      sessionId: this.sessionId,
      senderCompID: this.senderCompID,
      referencePrice: this.referencePrice,
      stats: {
        ordersPlaced: this.stats.ordersPlaced,
        ordersAccepted: this.stats.ordersAccepted,
        ordersRejected: this.stats.ordersRejected,
        fills: this.stats.fills,
        partialFills: this.stats.partialFills,
        totalVolume: this.stats.totalVolume
      },
      orders: Array.from(this.orders.values()),
      success: this.stats.fills >= this.config.orchestrator.minFillsForSuccess
    };
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupShutdownHandlers() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log('');
      console.log(`🛑 Received ${signal}, shutting down gracefully...`);

      // Close FIX connection
      if (this.fix) {
        await this.fix.disconnect();
        console.log('🔌 Closed FIX connection');
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
      console.log('');

      // Export results
      const results = this.exportResults();
      console.log('📦 Results:');
      console.log(JSON.stringify(results, null, 2));
      console.log('');

      console.log('✅ Market Taker shutdown complete');
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
      console.log('🎬 Market Taker starting...');
      console.log(`   Session ID: ${this.sessionId}`);
      console.log(`   Reference Price: $${this.referencePrice.toFixed(2)}`);
      console.log(`   Target Fills: ${this.config.taker.targetFills}`);
      console.log('');

      // Calculate maker price levels
      this.calculateMakerPriceLevels();
      console.log('');

      // Wait for maker orders to settle
      const waitTime = this.config.taker.waitForMakerMs;
      console.log(`⏳ Waiting ${waitTime / 1000}s for maker orders to settle...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      console.log('✅ Wait period complete');
      console.log('');

      // Connect to TrueX FIX
      await this.connectToFIX();
      console.log('');

      // Select orders to hit
      const ordersToHit = this.selectOrdersToHit();
      console.log('');

      // Place aggressive orders
      await this.placeOrders(ordersToHit);

      // Monitor for fills
      console.log('⏳ Monitoring for fills...');
      console.log(`   Will exit after ${this.config.taker.targetFills} fills or all orders complete`);
      console.log('');

      // Poll for exit criteria
      const checkInterval = 2000; // Check every 2 seconds
      while (!this.shouldExit() && !this.isShuttingDown) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      // Natural exit (criteria met)
      if (!this.isShuttingDown) {
        console.log('');
        console.log('✅ Exit criteria met, shutting down...');
        await this.fix.disconnect();
        console.log('🔌 Closed FIX connection');

        // Log final stats
        console.log('');
        console.log('📊 Final Stats:');
        console.log(`   Orders Placed: ${this.stats.ordersPlaced}`);
        console.log(`   Orders Accepted: ${this.stats.ordersAccepted}`);
        console.log(`   Orders Rejected: ${this.stats.ordersRejected}`);
        console.log(`   Fills: ${this.stats.fills}`);
        console.log(`   Partial Fills: ${this.stats.partialFills}`);
        console.log(`   Total Volume: ${this.stats.totalVolume.toFixed(4)} BTC`);
        console.log('');

        // Export results
        const results = this.exportResults();
        console.log('📦 Results:');
        console.log(JSON.stringify(results, null, 2));
        console.log('');

        console.log('✅ Market Taker completed successfully');
        process.exit(0);
      }

    } catch (error) {
      console.error('❌ Market Taker error:', error);
      process.exit(1);
    }
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = {
    sessionId: null,
    referencePrice: null,
    configPath: null
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--session-id=')) {
      args.sessionId = arg.split('=')[1];
    } else if (arg.startsWith('--reference-price=')) {
      args.referencePrice = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--config=')) {
      args.configPath = arg.split('=')[1];
    }
  }

  return args;
}

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs();

  // Load configuration
  const config = getSimulationConfig();

  // Validate required arguments
  if (!args.referencePrice) {
    console.error('❌ Error: --reference-price is required');
    console.error('Usage: node market-taker-simple.js --reference-price=<price> [--session-id=<id>]');
    process.exit(1);
  }

  // Generate or use provided session ID
  const sessionId = args.sessionId || `taker-${Date.now()}`;

  // Create and run market taker
  const taker = new MarketTaker(config, sessionId, args.referencePrice);
  taker.setupShutdownHandlers();
  await taker.run();
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { MarketTaker };
