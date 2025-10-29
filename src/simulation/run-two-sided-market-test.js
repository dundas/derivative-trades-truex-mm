#!/usr/bin/env node
/**
 * TrueX Two-Sided Market Test Orchestrator
 *
 * Coordinates market maker and market taker scripts to create a two-sided
 * market simulation. Validates execution matching and data pipeline.
 *
 * Usage:
 *   node run-two-sided-market-test.js [--session-id=<id>] [--dry-run] [--timeout=<ms>]
 *
 * @module run-two-sided-market-test
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { getSimulationConfig, generateSessionId } from './simulation-config.js';
import RedisClient from '../../lib/utils/redis-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Orchestrator for two-sided market test
 */
class TwoSidedMarketOrchestrator {
  constructor(config, sessionId, options = {}) {
    this.config = config;
    this.sessionId = sessionId;
    this.options = {
      dryRun: options.dryRun || false,
      timeout: options.timeout || config.orchestrator.testDuration,
      verbose: options.verbose !== undefined ? options.verbose : config.orchestrator.verboseOutput
    };

    // Process handles
    this.makerProcess = null;
    this.takerProcess = null;

    // Process output buffers
    this.makerOutput = [];
    this.takerOutput = [];

    // State tracking
    this.makerReady = false;
    this.makerAccepts = 0;
    this.referencePrice = null;
    this.testStartTime = null;
    this.testEndTime = null;

    // Results
    this.makerResults = null;
    this.takerResults = null;

    // Cleanup flag
    this.isCleaningUp = false;
  }

  /**
   * Validate environment variables
   */
  validateEnvironment() {
    const required = [
      'TRUEX_API_KEY',
      'TRUEX_CLIENT_ID',
      'DO_REDIS_URL'
    ];

    // Check for API secret
    if (!process.env.TRUEX_API_SECRET && !process.env.TRUEX_SECRET_KEY) {
      required.push('TRUEX_API_SECRET or TRUEX_SECRET_KEY');
    }

    const missing = required.filter(key => {
      if (key === 'TRUEX_API_SECRET or TRUEX_SECRET_KEY') {
        return false; // Already checked above
      }
      return !process.env[key];
    });

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}\n` +
        `Please ensure these are defined in your .env file.`
      );
    }

    this.log('✅ Environment validation passed');
  }

  /**
   * Log with optional verbose control
   */
  log(message, force = false) {
    if (this.options.verbose || force) {
      console.log(message);
    }
  }

  /**
   * Spawn market maker process
   */
  spawnMaker() {
    return new Promise((resolve, reject) => {
      this.log('');
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('  Starting Market Maker', true);
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('');

      const scriptPath = path.join(__dirname, 'market-maker-ladder.js');
      const args = [`--session-id=${this.sessionId}`];

      if (this.options.dryRun) {
        this.log(`[DRY RUN] Would spawn: node ${scriptPath} ${args.join(' ')}`, true);
        this.makerReady = true;
        this.referencePrice = 119000; // Mock price for dry run
        resolve();
        return;
      }

      this.makerProcess = spawn('node', [scriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });

      // Capture stdout
      this.makerProcess.stdout.on('data', (data) => {
        const output = data.toString();
        this.makerOutput.push(output);

        if (this.options.verbose) {
          process.stdout.write(`[MAKER] ${output}`);
        }

        // Check for Coinbase price
        const priceMatch = output.match(/Current price: \$([0-9,]+\.\d+)/);
        if (priceMatch && !this.referencePrice) {
          this.referencePrice = parseFloat(priceMatch[1].replace(/,/g, ''));
          this.log(`📊 Captured reference price: $${this.referencePrice.toFixed(2)}`, true);
        }

        // Check for order accepts
        const acceptMatch = output.match(/Order Accepted:.*\((\d+)\/\d+\)/);
        if (acceptMatch) {
          this.makerAccepts = parseInt(acceptMatch[1], 10);
        }

        // Check for readiness threshold
        if (this.makerAccepts >= this.config.orchestrator.makerReadyThreshold && !this.makerReady) {
          this.makerReady = true;
          this.log(`✅ Maker ready: ${this.makerAccepts} orders accepted`, true);
          resolve();
        }
      });

      // Capture stderr
      this.makerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        this.makerOutput.push(output);
        if (this.options.verbose) {
          process.stderr.write(`[MAKER ERROR] ${output}`);
        }
      });

      // Handle process exit
      this.makerProcess.on('exit', (code, signal) => {
        if (!this.makerReady && !this.isCleaningUp) {
          reject(new Error(`Maker process exited prematurely (code: ${code}, signal: ${signal})`));
        }
      });

      // Timeout for maker readiness
      const readyTimeout = setTimeout(() => {
        if (!this.makerReady) {
          reject(new Error(
            `Maker readiness timeout: Only ${this.makerAccepts}/${this.config.orchestrator.makerReadyThreshold} orders accepted`
          ));
        }
      }, this.config.orchestrator.makerReadyTimeout);

      // Clear timeout if resolved
      this.makerProcess.on('exit', () => clearTimeout(readyTimeout));
    });
  }

  /**
   * Spawn market taker process
   */
  spawnTaker() {
    return new Promise((resolve, reject) => {
      this.log('');
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('  Starting Market Taker', true);
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('');

      if (!this.referencePrice) {
        reject(new Error('Cannot start taker: No reference price captured from maker'));
        return;
      }

      const scriptPath = path.join(__dirname, 'market-taker-simple.js');
      const args = [
        `--session-id=${this.sessionId}`,
        `--reference-price=${this.referencePrice}`
      ];

      if (this.options.dryRun) {
        this.log(`[DRY RUN] Would spawn: node ${scriptPath} ${args.join(' ')}`, true);
        resolve();
        return;
      }

      this.takerProcess = spawn('node', [scriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });

      // Capture stdout
      this.takerProcess.stdout.on('data', (data) => {
        const output = data.toString();
        this.takerOutput.push(output);

        if (this.options.verbose) {
          process.stdout.write(`[TAKER] ${output}`);
        }
      });

      // Capture stderr
      this.takerProcess.stderr.on('data', (data) => {
        const output = data.toString();
        this.takerOutput.push(output);
        if (this.options.verbose) {
          process.stderr.write(`[TAKER ERROR] ${output}`);
        }
      });

      // Handle process exit
      this.takerProcess.on('exit', (code, signal) => {
        this.log(`📊 Taker process exited (code: ${code}, signal: ${signal})`, true);
        resolve();
      });

      // Resolve immediately - we'll wait for natural exit
      setTimeout(() => resolve(), 1000);
    });
  }

  /**
   * Monitor both processes until completion or timeout
   */
  async monitorProcesses() {
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('  Monitoring Test Execution', true);
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('');

    if (this.options.dryRun) {
      this.log('[DRY RUN] Would monitor processes', true);
      return;
    }

    return new Promise((resolve, reject) => {
      // Track process states
      let makerExited = false;
      let takerExited = false;

      // Listen for exits
      this.makerProcess.on('exit', () => {
        makerExited = true;
        if (takerExited) resolve();
      });

      this.takerProcess.on('exit', () => {
        takerExited = true;
        if (makerExited) resolve();
      });

      // Global timeout
      const timeout = setTimeout(() => {
        this.log('⏰ Test duration timeout reached', true);
        resolve();
      }, this.options.timeout);

      // Clear timeout if both exit naturally
      const checkCompletion = setInterval(() => {
        if (makerExited && takerExited) {
          clearTimeout(timeout);
          clearInterval(checkCompletion);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Parse results from process output
   */
  parseResults(output, processName) {
    const joined = output.join('');

    // Look for JSON results export
    const resultsMatch = joined.match(/📦 Results:\s*(\{[\s\S]*?\})\s*(?=\n\n|$)/);
    if (resultsMatch) {
      try {
        return JSON.parse(resultsMatch[1]);
      } catch (error) {
        this.log(`⚠️  Failed to parse ${processName} results JSON: ${error.message}`);
      }
    }

    // Fallback: Parse stats from final output
    const stats = {};
    const statsMatch = joined.match(/📊 Final Stats:([\s\S]*?)(?=\n\n|$)/);
    if (statsMatch) {
      const statsText = statsMatch[1];
      stats.ordersPlaced = this.extractNumber(statsText, /Orders Placed:\s*(\d+)/);
      stats.ordersAccepted = this.extractNumber(statsText, /Orders Accepted:\s*(\d+)/);
      stats.ordersRejected = this.extractNumber(statsText, /Orders Rejected:\s*(\d+)/);
      stats.fills = this.extractNumber(statsText, /Fills:\s*(\d+)/);
      stats.partialFills = this.extractNumber(statsText, /Partial Fills:\s*(\d+)/);
      stats.totalVolume = this.extractNumber(statsText, /Total Volume:\s*([\d.]+)/);
    }

    return stats;
  }

  /**
   * Extract number from regex match
   */
  extractNumber(text, regex) {
    const match = text.match(regex);
    return match ? parseFloat(match[1]) : 0;
  }

  /**
   * Collect results from Redis
   */
  async collectRedisResults() {
    if (this.options.dryRun) {
      this.log('[DRY RUN] Would query Redis', true);
      return { ohlcCandles: 0 };
    }

    try {
      const redis = new RedisClient();
      await redis.connect();

      const ohlcKey = `session:${this.sessionId}:ohlc:1m`;
      const ohlcData = await redis.hgetall(ohlcKey);
      const candleCount = Object.keys(ohlcData).length;

      await redis.quit();

      return {
        ohlcCandles: candleCount,
        ohlcData: ohlcData
      };
    } catch (error) {
      this.log(`⚠️  Redis query error: ${error.message}`);
      return { ohlcCandles: 0, error: error.message };
    }
  }

  /**
   * Validate test results
   */
  validateResults() {
    const validation = {
      passed: true,
      checks: [],
      warnings: []
    };

    // Check 1: Both sides received execution reports
    const makerFills = this.makerResults?.stats?.fills || this.makerResults?.fills || 0;
    const takerFills = this.takerResults?.stats?.fills || this.takerResults?.fills || 0;

    if (makerFills > 0 && takerFills > 0) {
      validation.checks.push({
        name: 'Both sides received fills',
        status: 'PASS',
        details: `Maker: ${makerFills}, Taker: ${takerFills}`
      });
    } else {
      validation.passed = false;
      validation.checks.push({
        name: 'Both sides received fills',
        status: 'FAIL',
        details: `Maker: ${makerFills}, Taker: ${takerFills} (expected > 0 for both)`
      });
    }

    // Check 2: Minimum fills threshold
    const totalFills = makerFills + takerFills;
    const minFills = this.config.orchestrator.minFillsForSuccess * 2; // Each fill shows on both sides

    if (totalFills >= minFills) {
      validation.checks.push({
        name: 'Minimum fills achieved',
        status: 'PASS',
        details: `${totalFills} fills (threshold: ${minFills})`
      });
    } else {
      validation.passed = false;
      validation.checks.push({
        name: 'Minimum fills achieved',
        status: 'FAIL',
        details: `${totalFills}/${minFills} fills`
      });
    }

    // Check 3: No excessive rejections
    const makerRejects = this.makerResults?.stats?.ordersRejected || this.makerResults?.ordersRejected || 0;
    const takerRejects = this.takerResults?.stats?.ordersRejected || this.takerResults?.ordersRejected || 0;
    const totalRejects = makerRejects + takerRejects;

    if (totalRejects === 0) {
      validation.checks.push({
        name: 'No order rejections',
        status: 'PASS',
        details: 'All orders accepted'
      });
    } else if (totalRejects < 5) {
      validation.warnings.push(`${totalRejects} order(s) rejected`);
      validation.checks.push({
        name: 'Low rejection rate',
        status: 'WARN',
        details: `${totalRejects} rejections`
      });
    } else {
      validation.passed = false;
      validation.checks.push({
        name: 'Acceptable rejection rate',
        status: 'FAIL',
        details: `${totalRejects} rejections (too many)`
      });
    }

    // Check 4: Test completed within time limit
    const duration = this.testEndTime - this.testStartTime;
    if (duration <= this.options.timeout) {
      validation.checks.push({
        name: 'Completed within time limit',
        status: 'PASS',
        details: `${(duration / 1000).toFixed(1)}s / ${(this.options.timeout / 1000).toFixed(0)}s`
      });
    } else {
      validation.warnings.push('Test exceeded time limit');
      validation.checks.push({
        name: 'Completed within time limit',
        status: 'WARN',
        details: `${(duration / 1000).toFixed(1)}s (timeout: ${(this.options.timeout / 1000).toFixed(0)}s)`
      });
    }

    return validation;
  }

  /**
   * Generate summary report
   */
  generateReport() {
    const duration = (this.testEndTime - this.testStartTime) / 1000;

    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('  Test Summary', true);
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('');

    // Session info
    this.log(`Session ID:        ${this.sessionId}`, true);
    this.log(`Reference Price:   $${this.referencePrice?.toFixed(2) || 'N/A'}`, true);
    this.log(`Duration:          ${duration.toFixed(1)}s`, true);
    this.log('');

    // Maker stats
    this.log('Market Maker:', true);
    const makerStats = this.makerResults?.stats || this.makerResults || {};
    this.log(`  Orders Placed:   ${makerStats.ordersPlaced || 0}`, true);
    this.log(`  Orders Accepted: ${makerStats.ordersAccepted || 0}`, true);
    this.log(`  Fills:           ${makerStats.fills || 0}`, true);
    this.log(`  Rejected:        ${makerStats.ordersRejected || 0}`, true);
    this.log(`  Volume:          ${(makerStats.totalVolume || 0).toFixed(4)} BTC`, true);
    this.log('');

    // Taker stats
    this.log('Market Taker:', true);
    const takerStats = this.takerResults?.stats || this.takerResults || {};
    this.log(`  Orders Placed:   ${takerStats.ordersPlaced || 0}`, true);
    this.log(`  Orders Accepted: ${takerStats.ordersAccepted || 0}`, true);
    this.log(`  Fills:           ${takerStats.fills || 0}`, true);
    this.log(`  Rejected:        ${takerStats.ordersRejected || 0}`, true);
    this.log(`  Volume:          ${(takerStats.totalVolume || 0).toFixed(4)} BTC`, true);
    this.log('');

    // Validation results
    const validation = this.validateResults();

    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('  Validation Results', true);
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('');

    for (const check of validation.checks) {
      const icon = check.status === 'PASS' ? '✅' : check.status === 'WARN' ? '⚠️ ' : '❌';
      this.log(`${icon} ${check.name}`, true);
      this.log(`   ${check.details}`, true);
    }

    if (validation.warnings.length > 0) {
      this.log('');
      this.log('Warnings:', true);
      for (const warning of validation.warnings) {
        this.log(`⚠️  ${warning}`, true);
      }
    }

    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    if (validation.passed) {
      this.log('  ✅ TEST PASSED', true);
    } else {
      this.log('  ❌ TEST FAILED', true);
    }
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
    this.log('');

    return validation.passed;
  }

  /**
   * Cleanup processes
   */
  async cleanup() {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    this.log('🧹 Cleaning up processes...', true);

    if (this.makerProcess && !this.makerProcess.killed) {
      this.makerProcess.kill('SIGINT');
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!this.makerProcess.killed) {
        this.makerProcess.kill('SIGKILL');
      }
    }

    if (this.takerProcess && !this.takerProcess.killed) {
      this.takerProcess.kill('SIGINT');
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!this.takerProcess.killed) {
        this.takerProcess.kill('SIGKILL');
      }
    }

    this.log('✅ Cleanup complete', true);
  }

  /**
   * Main execution flow
   */
  async run() {
    try {
      this.log('');
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('  TrueX Two-Sided Market Test', true);
      this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', true);
      this.log('');
      this.log(`Session ID: ${this.sessionId}`, true);
      this.log(`Timeout:    ${this.options.timeout / 1000}s`, true);
      this.log(`Dry Run:    ${this.options.dryRun ? 'Yes' : 'No'}`, true);
      this.log('');

      // Validate environment
      this.validateEnvironment();

      // Start test timer
      this.testStartTime = Date.now();

      // Step 1: Start maker
      await this.spawnMaker();

      // Step 2: Start taker
      await this.spawnTaker();

      // Step 3: Monitor until completion
      await this.monitorProcesses();

      // Stop test timer
      this.testEndTime = Date.now();

      // Step 4: Collect results
      this.log('');
      this.log('📊 Collecting results...', true);

      this.makerResults = this.parseResults(this.makerOutput, 'maker');
      this.takerResults = this.parseResults(this.takerOutput, 'taker');

      if (this.config.orchestrator.validateDataPipeline) {
        const redisResults = await this.collectRedisResults();
        this.log(`   Redis OHLC candles: ${redisResults.ohlcCandles}`, true);
      }

      // Step 5: Generate report
      const passed = this.generateReport();

      // Step 6: Cleanup
      await this.cleanup();

      // Exit with appropriate code
      process.exit(passed ? 0 : 1);

    } catch (error) {
      console.error('');
      console.error('❌ Test failed with error:', error.message);
      console.error('');

      await this.cleanup();
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
    dryRun: false,
    timeout: null,
    verbose: null
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--session-id=')) {
      args.sessionId = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--timeout=')) {
      args.timeout = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--quiet') {
      args.verbose = false;
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

  // Generate session ID
  const sessionId = args.sessionId || generateSessionId(config.orchestrator.sessionIdPrefix);

  // Create orchestrator
  const orchestrator = new TwoSidedMarketOrchestrator(config, sessionId, {
    dryRun: args.dryRun,
    timeout: args.timeout,
    verbose: args.verbose
  });

  // Setup cleanup on interrupt
  process.on('SIGINT', async () => {
    console.log('');
    console.log('⚠️  Interrupted by user');
    await orchestrator.cleanup();
    process.exit(130);
  });

  // Run test
  await orchestrator.run();
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { TwoSidedMarketOrchestrator };
