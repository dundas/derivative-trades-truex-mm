#!/usr/bin/env node
/**
 * TrueX Two-Sided Market Simulation Configuration
 *
 * Centralized configuration for market maker, market taker, and orchestrator scripts.
 * Loads configuration from environment variables with sensible defaults.
 *
 * @module simulation-config
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from project root
dotenv.config({ path: path.join(__dirname, '../../../../../.env') });

/**
 * @typedef {Object} MakerConfig
 * @property {number} totalOrders - Total number of orders to place (default: 50)
 * @property {number} priceLevels - Number of price levels on each side (default: 8)
 * @property {number} spread - Price increment between levels in USD (default: 0.50)
 * @property {number} orderSize - Size of each order in BTC (default: 0.01)
 * @property {string} symbol - Trading pair symbol (default: 'BTC-PYUSD')
 * @property {number} orderPacingMs - Delay between order submissions in milliseconds (default: 20)
 * @property {number} heartbeatInterval - FIX heartbeat interval in seconds (default: 30)
 */

/**
 * @typedef {Object} TakerConfig
 * @property {string} strategy - Taker strategy: 'simple-delay' or 'market-data' (default: 'simple-delay')
 * @property {number} waitForMakerMs - Time to wait for maker orders to settle (default: 10000)
 * @property {number} targetFills - Target number of orders to hit (default: 20)
 * @property {number} minDelayMs - Minimum delay between orders (default: 500)
 * @property {number} maxDelayMs - Maximum delay between orders (default: 3000)
 * @property {number} orderSize - Size of each order in BTC (default: 0.01)
 * @property {string} symbol - Trading pair symbol (default: 'BTC-PYUSD')
 * @property {number} priceOffset - Price offset for aggressive orders (default: 0.1)
 * @property {number} heartbeatInterval - FIX heartbeat interval in seconds (default: 30)
 */

/**
 * @typedef {Object} OrchestratorConfig
 * @property {number} testDuration - Maximum test duration in milliseconds (default: 120000)
 * @property {number} minFillsForSuccess - Minimum fills required for test success (default: 15)
 * @property {string} sessionIdPrefix - Prefix for session IDs (default: 'two-sided-sim')
 * @property {number} makerReadyThreshold - Minimum maker accepts before starting taker (default: 25)
 * @property {number} makerReadyTimeout - Timeout waiting for maker ready (default: 30000)
 * @property {boolean} validateDataPipeline - Whether to validate Redis/PostgreSQL storage (default: true)
 * @property {boolean} verboseOutput - Enable verbose output (default: true)
 */

/**
 * @typedef {Object} TrueXConfig
 * @property {string} fixHost - TrueX FIX gateway host
 * @property {number} fixPort - TrueX FIX gateway port
 * @property {string} apiKey - TrueX API key
 * @property {string} apiSecret - TrueX API secret
 * @property {string} clientId - TrueX client ID for Party ID field (maker)
 * @property {string} clientId2 - TrueX client ID for Party ID field (taker)
 * @property {string} targetCompID - TrueX target comp ID (default: 'TRUEX_UAT_OE')
 */

/**
 * @typedef {Object} DataConfig
 * @property {string} redisUrl - Redis connection URL
 * @property {string} databaseUrl - PostgreSQL connection URL
 */

/**
 * @typedef {Object} SimulationConfig
 * @property {MakerConfig} maker - Market maker configuration
 * @property {TakerConfig} taker - Market taker configuration
 * @property {OrchestratorConfig} orchestrator - Orchestrator configuration
 * @property {TrueXConfig} truex - TrueX connection configuration
 * @property {DataConfig} data - Data storage configuration
 */

/**
 * Validates that all required environment variables are present
 *
 * @throws {Error} If any required environment variable is missing
 * @returns {void}
 */
function validateRequiredEnvVars() {
  const required = [
    'TRUEX_API_KEY',
    'TRUEX_CLIENT_ID',
    'TRUEX_CLIENT_ID_2',
    'DO_REDIS_URL'
  ];

  const missing = required.filter(key => !process.env[key]);

  // Check for API secret (either TRUEX_API_SECRET or TRUEX_SECRET_KEY)
  if (!process.env.TRUEX_API_SECRET && !process.env.TRUEX_SECRET_KEY) {
    missing.push('TRUEX_API_SECRET or TRUEX_SECRET_KEY');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Please ensure these are defined in your .env file.`
    );
  }
}

/**
 * Creates and returns the simulation configuration
 *
 * Loads configuration from environment variables and provides sensible defaults.
 * Validates that required environment variables are present.
 *
 * @param {Object} [overrides={}] - Optional configuration overrides
 * @param {Partial<MakerConfig>} [overrides.maker] - Maker config overrides
 * @param {Partial<TakerConfig>} [overrides.taker] - Taker config overrides
 * @param {Partial<OrchestratorConfig>} [overrides.orchestrator] - Orchestrator config overrides
 * @returns {SimulationConfig} Complete simulation configuration
 * @throws {Error} If required environment variables are missing
 *
 * @example
 * // Use default configuration
 * const config = getSimulationConfig();
 *
 * @example
 * // Override specific values
 * const config = getSimulationConfig({
 *   maker: { totalOrders: 100 },
 *   taker: { targetFills: 30 }
 * });
 */
export function getSimulationConfig(overrides = {}) {
  // Validate required environment variables
  validateRequiredEnvVars();

  /** @type {SimulationConfig} */
  const config = {
    // Market Maker Configuration
    maker: {
      totalOrders: 50,
      priceLevels: 8,
      spread: 0.50,
      orderSize: 0.01,
      symbol: 'BTC-PYUSD',
      orderPacingMs: 20,
      heartbeatInterval: 30,
      ...overrides.maker
    },

    // Market Taker Configuration
    taker: {
      strategy: 'simple-delay',
      waitForMakerMs: 10000,
      targetFills: 20,
      minDelayMs: 500,
      maxDelayMs: 3000,
      orderSize: 0.01,
      symbol: 'BTC-PYUSD',
      priceOffset: 0.1,
      heartbeatInterval: 30,
      ...overrides.taker
    },

    // Orchestrator Configuration
    orchestrator: {
      testDuration: 120000,
      minFillsForSuccess: 15,
      sessionIdPrefix: 'two-sided-sim',
      makerReadyThreshold: 25,
      makerReadyTimeout: 30000,
      validateDataPipeline: true,
      verboseOutput: true,
      ...overrides.orchestrator
    },

    // TrueX Connection Configuration
    truex: {
      fixHost: process.env.TRUEX_FIX_HOST || '129.212.145.83',
      fixPort: parseInt(process.env.TRUEX_FIX_PORT || '3004', 10),
      apiKey: process.env.TRUEX_API_KEY,
      apiSecret: process.env.TRUEX_API_SECRET || process.env.TRUEX_SECRET_KEY,
      clientId: process.env.TRUEX_CLIENT_ID,
      clientId2: process.env.TRUEX_CLIENT_ID_2,
      targetCompID: process.env.TRUEX_TARGET_COMP_ID || 'TRUEX_UAT_OE'
    },

    // Data Storage Configuration
    data: {
      redisUrl: process.env.DO_REDIS_URL,
      databaseUrl: process.env.DATABASE_URL || process.env.NEON_DATABASE_URL
    }
  };

  return config;
}

/**
 * Generates a unique session ID for a simulation run
 *
 * @param {string} [prefix='two-sided-sim'] - Prefix for the session ID
 * @returns {string} Unique session ID in format: prefix-timestamp
 *
 * @example
 * const sessionId = generateSessionId('test-run');
 * // Returns: 'test-run-1696518400000'
 */
export function generateSessionId(prefix = 'two-sided-sim') {
  const timestamp = Date.now();
  return `${prefix}-${timestamp}`;
}

/**
 * Generates a unique SenderCompID for FIX connections
 *
 * @param {string} role - Role identifier ('MAKER' or 'TAKER')
 * @param {string} [sessionId] - Optional session ID to include
 * @returns {string} Unique SenderCompID
 *
 * @example
 * const senderCompID = generateSenderCompID('MAKER', 'sim-12345');
 * // Returns: 'MAKER_sim_12345'
 */
export function generateSenderCompID(role, sessionId) {
  if (sessionId) {
    // Replace hyphens with underscores for FIX compatibility
    const sanitizedSessionId = sessionId.replace(/-/g, '_');
    return `${role}_${sanitizedSessionId}`;
  }
  return `${role}_${Date.now()}`;
}

// Default export for convenience
export default {
  getSimulationConfig,
  generateSessionId,
  generateSenderCompID
};
