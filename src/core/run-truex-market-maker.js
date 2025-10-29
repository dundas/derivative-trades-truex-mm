#!/usr/bin/env node

import { TrueXMarketMaker } from './TrueXMarketMaker.js';
// Simple logger implementation
function createLogger(config = {}) {
    const prefix = `[${config.component || 'TrueXRunner'}${config.symbol ? ':' + config.symbol : ''}]`;
    
    return {
        info: (message, meta) => console.log(`${prefix} INFO:`, message, meta ? JSON.stringify(meta) : ''),
        error: (message, meta) => console.error(`${prefix} ERROR:`, message, meta ? JSON.stringify(meta) : ''),
        warn: (message, meta) => console.warn(`${prefix} WARN:`, message, meta ? JSON.stringify(meta) : ''),
        debug: (message, meta) => console.log(`${prefix} DEBUG:`, message, meta ? JSON.stringify(meta) : '')
    };
}
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../../../../.env') });

/**
 * Run TrueX Market Maker
 * 
 * This script demonstrates how to use the TrueX market maker
 */
async function run() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const symbol = args[0] || 'BTC-PYUSD';
    const verbose = args.includes('--verbose');
    
    // Create logger
    const logger = createLogger({
        component: 'TrueXMarketMakerRunner',
        level: verbose ? 'debug' : 'info'
    });
    
    logger.info('Starting TrueX Market Maker', {
        symbol,
        environment: process.env.TRUEX_ENVIRONMENT || 'uat'
    });
    
    // Validate environment variables
    const requiredEnvVars = ['TRUEX_API_KEY', 'TRUEX_API_SECRET', 'TRUEX_ORGANIZATION_ID'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    
    if (missingVars.length > 0) {
        logger.error('Missing required environment variables', { missing: missingVars });
        logger.info('Required environment variables:');
        logger.info('  TRUEX_API_KEY - Your TrueX API key');
        logger.info('  TRUEX_API_SECRET - Your TrueX API secret');
        logger.info('  TRUEX_ORGANIZATION_ID - Your TrueX organization ID');
        logger.info('  TRUEX_ENVIRONMENT - Environment (uat/production), defaults to uat');
        process.exit(1);
    }
    
    // Configuration
    const config = {
        // Symbol
        symbol,
        
        // API credentials
        apiKey: process.env.TRUEX_API_KEY,
        apiSecret: process.env.TRUEX_API_SECRET,
        organizationId: process.env.TRUEX_ORGANIZATION_ID,
        environment: process.env.TRUEX_ENVIRONMENT || 'uat',
        
        // Order configuration
        orderPairs: parseInt(process.env.TRUEX_ORDER_PAIRS) || 6,
        orderStartSize: parseFloat(process.env.TRUEX_ORDER_START_SIZE) || 0.1,
        orderStepSize: parseFloat(process.env.TRUEX_ORDER_STEP_SIZE) || 0.1,
        interval: parseFloat(process.env.TRUEX_INTERVAL) || 0.01,
        minSpread: parseFloat(process.env.TRUEX_MIN_SPREAD) || 0.005,
        maintainSpreads: process.env.TRUEX_MAINTAIN_SPREADS !== 'false',
        
        // Position limits
        checkPositionLimits: process.env.TRUEX_CHECK_POSITION_LIMITS === 'true',
        minPosition: parseFloat(process.env.TRUEX_MIN_POSITION) || -10000,
        maxPosition: parseFloat(process.env.TRUEX_MAX_POSITION) || 10000,
        
        // Trading behavior
        postOnly: process.env.TRUEX_POST_ONLY === 'true',
        cancelOrdersOnStart: process.env.TRUEX_CANCEL_ORDERS_ON_START === 'true',
        cancelOrdersOnExit: process.env.TRUEX_CANCEL_ORDERS_ON_EXIT !== 'false',
        
        // Operational
        loopInterval: parseInt(process.env.TRUEX_LOOP_INTERVAL) || 5000,
        
        // Logger
        logger
    };
    
    // Create market maker instance
    const marketMaker = new TrueXMarketMaker(config);
    
    // Set up graceful shutdown
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);
        try {
            await marketMaker.stop();
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown', { error: error.message });
            process.exit(1);
        }
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    try {
        // Start the market maker
        await marketMaker.start();
        
        logger.info('Market maker is running. Press Ctrl+C to stop.');
        
    } catch (error) {
        logger.error('Failed to start market maker', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

// Show usage if --help is passed
if (process.argv.includes('--help')) {
    console.log(`
TrueX Market Maker

Usage: node run-truex-market-maker.js [SYMBOL] [OPTIONS]

Arguments:
  SYMBOL          Trading symbol (default: BTC-PYUSD)

Options:
  --dry-run       Run in paper trading mode
  --verbose       Enable verbose logging
  --help          Show this help message

Environment Variables:
  TRUEX_API_KEY              Your TrueX API key (required)
  TRUEX_API_SECRET           Your TrueX API secret (required)
  TRUEX_ORGANIZATION_ID      Your TrueX organization ID (required)
  TRUEX_ENVIRONMENT          Environment: uat or production (default: uat)
  
  TRUEX_ORDER_PAIRS          Number of order pairs (default: 6)
  TRUEX_ORDER_START_SIZE     Initial order size (default: 0.1)
  TRUEX_ORDER_STEP_SIZE      Size increment per level (default: 0.1)
  TRUEX_INTERVAL             Price interval between orders (default: 0.01)
  TRUEX_MIN_SPREAD           Minimum spread to maintain (default: 0.005)
  TRUEX_MAINTAIN_SPREADS     Maintain existing spreads (default: true)
  
  TRUEX_CHECK_POSITION_LIMITS  Enable position limits (default: false)
  TRUEX_MIN_POSITION           Minimum position size (default: -10000)
  TRUEX_MAX_POSITION           Maximum position size (default: 10000)
  
  TRUEX_POST_ONLY            Post-only orders (default: false)
  TRUEX_CANCEL_ORDERS_ON_START Cancel orders on start (default: false)
  TRUEX_CANCEL_ORDERS_ON_EXIT  Cancel orders on exit (default: true)
  TRUEX_LOOP_INTERVAL          Main loop interval in ms (default: 5000)

Examples:
  # Run market maker on BTC-PYUSD in dry-run mode
  node run-truex-market-maker.js BTC-PYUSD --dry-run
  
  # Run market maker on ETH-PYUSD with verbose logging
  node run-truex-market-maker.js ETH-PYUSD --verbose
  
  # Run with custom configuration via environment variables
  TRUEX_ORDER_PAIRS=10 TRUEX_INTERVAL=0.005 node run-truex-market-maker.js
`);
    process.exit(0);
}

// Run the market maker
run().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});