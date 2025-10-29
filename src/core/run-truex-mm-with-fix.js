#!/usr/bin/env node
/**
 * Run TrueX Market Maker with FIXConnection
 * 
 * This runner uses the sophisticated truex-market-maker.js orchestrator
 * with proper FIX protocol handling including:
 * - Sequence number management
 * - Resend Request handling
 * - Data pipeline (Redis, PostgreSQL)
 * - Recovery mechanisms
 */

import { TrueXMarketMaker } from './truex-market-maker.js';
import { RedisClient } from '../../../lib/utils/redis-client.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables from root .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '../../../../.env');

console.log('📄 Loading .env from:', envPath);
const dotenvResult = dotenv.config({ path: envPath });
if (dotenvResult.error) {
  console.error('❌ Failed to load .env:', dotenvResult.error);
  process.exit(1);
}

console.log('✅ .env loaded successfully');
console.log('🔑 TRUEX_API_KEY:', process.env.TRUEX_API_KEY ? 'FOUND' : 'MISSING');
console.log('🔑 TRUEX_SECRET_KEY:', process.env.TRUEX_SECRET_KEY ? 'FOUND' : 'MISSING');
console.log('🔑 REDIS_URL:', process.env.REDIS_URL ? 'FOUND' : 'MISSING');

// Validate required environment variables
const required = ['TRUEX_API_KEY', 'TRUEX_SECRET_KEY', 'REDIS_URL'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('❌ Missing required environment variables:', missing);
  process.exit(1);
}

/**
 * Create Redis client using existing singleton
 */
async function createRedisClient() {
  console.log('🔌 Connecting to Redis (Valkey/DO)...');
  const client = new RedisClient();
  
  // Wait for connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
    
    if (client.ioredisClient.status === 'ready') {
      clearTimeout(timeout);
      resolve();
    } else {
      client.ioredisClient.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.ioredisClient.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    }
  });
  
  console.log('✅ Redis connected and ready');
  return client;
}

/**
 * Main function
 */
async function main() {
  console.log('\n🚀 Starting TrueX Market Maker with FIXConnection');
  console.log('================================================\n');

  // Create Redis client
  console.log('📡 Connecting to Redis...');
  const redisClient = await createRedisClient();

  // Configuration
  const config = {
    sessionId: process.env.TRUEX_SESSION_ID || `truex-fix-${Date.now()}`,
    symbol: 'BTC/USD',
    
    // Redis client (required)
    redisClient,
    
    // FIX configuration
    fix: {
      host: process.env.TRUEX_FIX_HOST || '129.212.145.83',  // DigitalOcean proxy
      port: parseInt(process.env.TRUEX_FIX_PORT || '3004'),
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_SECRET_KEY,
      senderCompID: 'CLI_CLIENT',
      targetCompID: 'TRUEX_UAT_OE',
      heartbeatInterval: 30
    },
    
    // Logger
    logger: {
      info: (msg, meta) => console.log('ℹ️ ', msg, meta ? JSON.stringify(meta, null, 2) : ''),
      warn: (msg, meta) => console.warn('⚠️ ', msg, meta ? JSON.stringify(meta, null, 2) : ''),
      error: (msg, meta) => console.error('❌', msg, meta ? JSON.stringify(meta, null, 2) : ''),
      debug: (msg, meta) => process.env.DEBUG && console.log('🔍', msg, meta ? JSON.stringify(meta, null, 2) : '')
    }
  };

  console.log('📋 Configuration:');
  console.log('  Session ID:', config.sessionId);
  console.log('  Symbol:', config.symbol);
  console.log('  FIX Host:', config.fix.host);
  console.log('  FIX Port:', config.fix.port);
  console.log('  Sender CompID:', config.fix.senderCompID);
  console.log('  Target CompID:', config.fix.targetCompID);
  console.log('');

  // Create market maker instance
  console.log('🏗️  Creating TrueXMarketMaker instance...');
  const marketMaker = new TrueXMarketMaker(config);

  // Setup graceful shutdown
  setupGracefulShutdown(marketMaker, redisClient);

  // Start the market maker
  console.log('▶️  Starting market maker...\n');
  try {
    await marketMaker.start();
    console.log('\n✅ Market maker started successfully');
    console.log('📊 Session ID:', config.sessionId);
    console.log('🔌 FIX connection active');
    console.log('📡 Listening for market data and execution reports...\n');
    
    // Setup event handlers after start (when FIX connection is available)
    if (marketMaker.fix) {
      setupEventHandlers(marketMaker);
    }
  } catch (error) {
    console.error('\n❌ Failed to start market maker:', error);
    await cleanup(marketMaker, redisClient);
    process.exit(1);
  }
}

/**
 * Setup event handlers for monitoring
 */
function setupEventHandlers(marketMaker) {
  // FIX connection events
  if (marketMaker.fix) {
    marketMaker.fix.on('loggedOn', () => {
      console.log('✅ FIX Logon accepted');
    });

    marketMaker.fix.on('executionReport', (report) => {
      const orderId = report.fields['11'];
      const execType = report.fields['150'];
      const ordStatus = report.fields['39'];
      const lastQty = report.fields['32'];
      const lastPx = report.fields['31'];
      
      console.log(`📊 Execution Report: ExecType=${execType} | Order: ${orderId} | Status: ${ordStatus}` + 
                  (lastQty ? ` | Filled: ${lastQty} @ ${lastPx}` : ''));
    });

    marketMaker.fix.on('reject', ({ reason, refSeqNum }) => {
      console.log(`❌ Reject: ${reason} (RefSeqNum: ${refSeqNum})`);
    });

    marketMaker.fix.on('sent', ({ msgSeqNum, fields }) => {
      const msgType = fields['35'];
      if (msgType === 'D') { // New Order
        console.log(`📤 Order Sent: SeqNum=${msgSeqNum}`);
      }
    });

    marketMaker.fix.on('error', (error) => {
      console.error('❌ FIX Connection Error:', error);
    });

    marketMaker.fix.on('disconnected', () => {
      console.log('🔌 FIX Disconnected');
    });
  }
}

/**
 * Setup graceful shutdown
 */
function setupGracefulShutdown(marketMaker, redisClient) {
  const shutdown = async (signal) => {
    console.log(`\n\n🛑 Received ${signal} - initiating graceful shutdown`);
    await cleanup(marketMaker, redisClient);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught Exception:', error);
    await cleanup(marketMaker, redisClient);
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
    await cleanup(marketMaker, redisClient);
    process.exit(1);
  });
}

/**
 * Cleanup resources
 */
async function cleanup(marketMaker, redisClient) {
  console.log('🧹 Cleaning up resources...');
  
  try {
    if (marketMaker) {
      console.log('  Stopping market maker...');
      await marketMaker.stop();
    }
  } catch (error) {
    console.error('  Error stopping market maker:', error);
  }

  try {
    if (redisClient && redisClient.ioredisClient) {
      console.log('  Disconnecting Redis...');
      await redisClient.ioredisClient.quit();
    }
  } catch (error) {
    console.error('  Error disconnecting Redis:', error);
  }

  console.log('✅ Cleanup complete');
}

// Run the market maker
main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});

