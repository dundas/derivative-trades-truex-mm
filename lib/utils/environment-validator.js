/**
 * Environment Variable Validation Utility
 * 
 * This utility provides centralized environment variable validation
 * to ensure all services start with proper configuration and prevent
 * deployment failures due to missing or deprecated environment variables.
 * 
 * Usage:
 * ```javascript
 * import { validateEnvironment, validateServiceEnvironment } from './environment-validator.js';
 * 
 * // Validate core environment
 * await validateEnvironment();
 * 
 * // Validate specific service environment
 * await validateServiceEnvironment('market-maker');
 * ```
 */

import { createPostgreSQLAPIFromEnv } from '../postgresql-api/index.js';

// Define required environment variables for each service type
const SERVICE_REQUIREMENTS = {
  'core': {
    required: [
      'DATABASE_URL' // PostgreSQL connection (Supabase)
    ],
    optional: [
      'POSTGRES_URL', // Alternative PostgreSQL connection
      'POSTGRESQL_URL' // Alternative PostgreSQL connection
    ],
    deprecated: [
      'NEON_CONN', // Deprecated Neon connection
      'NEON_DATABASE_URL', // Deprecated Neon connection
      'DO_REDIS_TOKEN', // Use REDIS_TOKEN instead
      'UPSTASH_REDIS_URL', // Use REDIS_URL instead
      'UPSTASH_REDIS_TOKEN' // Use REDIS_TOKEN instead
    ]
  },
  'market-maker': {
    required: [
      'DATABASE_URL',
      'REDIS_URL',
      'REDIS_TOKEN', // Required for health checks and Redis operations
      'KRAKEN_API_KEY',
      'KRAKEN_API_SECRET'
    ],
    optional: [
      'DEFAULT_TRADING_PAIR'
    ],
    deprecated: [
      'NEON_CONN',
      'NEON_DATABASE_URL',
      'DO_REDIS_TOKEN', // Use REDIS_TOKEN instead
      'UPSTASH_REDIS_URL', // Use REDIS_URL instead
      'UPSTASH_REDIS_TOKEN' // Use REDIS_TOKEN instead
    ]
  },
  'trading-agent': {
    required: [
      'DATABASE_URL',
      'REDIS_URL',
      'REDIS_TOKEN', // Required for workflow processor and Redis operations
      'KRAKEN_API_KEY',
      'KRAKEN_API_SECRET'
    ],
    optional: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY'
    ],
    deprecated: [
      'NEON_CONN',
      'NEON_DATABASE_URL',
      'DO_REDIS_TOKEN', // Use REDIS_TOKEN instead
      'UPSTASH_REDIS_URL', // Use REDIS_URL instead
      'UPSTASH_REDIS_TOKEN' // Use REDIS_TOKEN instead
    ]
  },
  'migration': {
    required: [
      'DATABASE_URL',
      'REDIS_URL',
      'REDIS_TOKEN' // Required for migration operations
    ],
    optional: [],
    deprecated: [
      'NEON_CONN',
      'NEON_DATABASE_URL',
      'DO_REDIS_TOKEN', // Use REDIS_TOKEN instead
      'UPSTASH_REDIS_URL', // Use REDIS_URL instead
      'UPSTASH_REDIS_TOKEN' // Use REDIS_TOKEN instead
    ]
  },
  'frontend': {
    required: [
      'DATABASE_URL'
    ],
    optional: [
      'POSTGRES_URL',
      'POSTGRESQL_URL'
    ],
    deprecated: [
      'NEON_CONN',
      'NEON_DATABASE_URL',
      'DO_REDIS_TOKEN', // Use REDIS_TOKEN instead
      'UPSTASH_REDIS_URL', // Use REDIS_URL instead
      'UPSTASH_REDIS_TOKEN' // Use REDIS_TOKEN instead
    ]
  }
};

/**
 * Validate environment variables for a specific service
 * @param {string} serviceType - The service type to validate ('core', 'market-maker', etc.)
 * @param {object} env - Environment object (defaults to process.env)
 * @returns {object} Validation result
 */
export function validateServiceEnvironment(serviceType = 'core', env = process.env) {
  const requirements = SERVICE_REQUIREMENTS[serviceType];
  if (!requirements) {
    throw new Error(`Unknown service type: ${serviceType}. Available: ${Object.keys(SERVICE_REQUIREMENTS).join(', ')}`);
  }

  const result = {
    valid: true,
    missing: [],
    deprecated: [],
    warnings: [],
    errors: []
  };

  // Check required variables
  for (const varName of requirements.required) {
    if (!env[varName]) {
      result.missing.push(varName);
      result.errors.push(`Missing required environment variable: ${varName}`);
      result.valid = false;
    }
  }

  // Check for deprecated variables
  for (const varName of requirements.deprecated) {
    if (env[varName]) {
      result.deprecated.push(varName);
      result.warnings.push(`Deprecated environment variable detected: ${varName}. Please remove and use modern alternatives.`);
    }
  }

  // Add specific validation messages
  if (serviceType === 'market-maker' && !env.REDIS_TOKEN) {
    result.errors.push('Market Maker API requires REDIS_TOKEN for health checks and Redis operations');
  }

  if (serviceType === 'migration' && !env.REDIS_TOKEN) {
    result.errors.push('Migration service requires REDIS_TOKEN for Redis data access');
  }

  return result;
}

/**
 * Test database connectivity
 * @param {object} env - Environment object
 * @returns {object} Connection test result
 */
export async function testDatabaseConnection(env = process.env) {
  const result = {
    success: false,
    error: null,
    provider: null
  };

  try {
    const db = createPostgreSQLAPIFromEnv(env);
    await db.initialize();
    
    // Identify provider from connection string
    const connectionString = env.DATABASE_URL || env.POSTGRES_URL;
    if (connectionString) {
      if (connectionString.includes('supabase')) {
        result.provider = 'Supabase';
      } else if (connectionString.includes('neon')) {
        result.provider = 'Neon (deprecated)';
      } else {
        result.provider = 'PostgreSQL';
      }
    }
    
    result.success = true;
  } catch (error) {
    result.error = error.message;
  }

  return result;
}

/**
 * Test Redis connectivity
 * @param {object} env - Environment object
 * @returns {object} Connection test result
 */
export async function testRedisConnection(env = process.env) {
  const result = {
    success: false,
    error: null,
    provider: null
  };

  if (!env.REDIS_URL) {
    result.error = 'REDIS_URL not provided';
    return result;
  }

  try {
    // Simple Redis connection test using ioredis
    const { default: Redis } = await import('ioredis');
    
    const redisOptions = {
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    };

    // Add token if available
    if (env.REDIS_TOKEN) {
      redisOptions.password = env.REDIS_TOKEN;
    }

    const redis = new Redis(env.REDIS_URL, redisOptions);
    
    await redis.ping();
    await redis.quit();

    // Identify provider
    if (env.REDIS_URL.includes('digitalocean')) {
      result.provider = 'DigitalOcean Managed Redis';
    } else if (env.REDIS_URL.includes('upstash')) {
      result.provider = 'Upstash Redis';
    } else {
      result.provider = 'Redis';
    }

    result.success = true;
  } catch (error) {
    result.error = error.message;
  }

  return result;
}

/**
 * Comprehensive environment validation with connectivity tests
 * @param {string} serviceType - Service type to validate
 * @param {object} env - Environment object
 * @returns {object} Complete validation result
 */
export async function validateEnvironment(serviceType = 'core', env = process.env) {
  console.log(`🔍 Validating environment for service: ${serviceType}`);
  
  // Basic environment validation
  const envResult = validateServiceEnvironment(serviceType, env);
  
  const result = {
    service: serviceType,
    environment: envResult,
    database: { success: false, error: 'Not tested' },
    redis: { success: false, error: 'Not tested' },
    overall: {
      valid: envResult.valid,
      ready: false
    }
  };

  // Test database connection if DATABASE_URL is available
  if (env.DATABASE_URL || env.POSTGRES_URL) {
    console.log('🔗 Testing database connection...');
    result.database = await testDatabaseConnection(env);
    
    if (result.database.success) {
      console.log(`✅ Database connected: ${result.database.provider}`);
    } else {
      console.log(`❌ Database connection failed: ${result.database.error}`);
      result.overall.valid = false;
    }
  }

  // Test Redis connection for services that require it
  const requiresRedis = ['market-maker', 'migration', 'trading-agent'].includes(serviceType);
  if (requiresRedis && env.REDIS_URL) {
    console.log('🔗 Testing Redis connection...');
    result.redis = await testRedisConnection(env);
    
    if (result.redis.success) {
      console.log(`✅ Redis connected: ${result.redis.provider}`);
    } else {
      console.log(`❌ Redis connection failed: ${result.redis.error}`);
      result.overall.valid = false;
    }
  }

  // Determine if service is ready to start
  result.overall.ready = result.overall.valid && 
                          result.database.success && 
                          (!requiresRedis || result.redis.success);

  // Print summary
  console.log('📋 Environment Validation Summary:');
  console.log(`   Service: ${serviceType}`);
  console.log(`   Environment: ${envResult.valid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`   Database: ${result.database.success ? '✅ Connected' : '❌ Failed'}`);
  if (requiresRedis) {
    console.log(`   Redis: ${result.redis.success ? '✅ Connected' : '❌ Failed'}`);
  }
  console.log(`   Ready: ${result.overall.ready ? '✅ Yes' : '❌ No'}`);

  if (result.environment.deprecated.length > 0) {
    console.log('⚠️  Deprecated variables detected:');
    result.environment.deprecated.forEach(varName => {
      console.log(`     - ${varName}`);
    });
  }

  if (result.environment.missing.length > 0) {
    console.log('❌ Missing required variables:');
    result.environment.missing.forEach(varName => {
      console.log(`     - ${varName}`);
    });
  }

  return result;
}

/**
 * Generate environment validation report
 * @param {string} serviceType - Service type
 * @returns {string} Markdown report
 */
export async function generateValidationReport(serviceType = 'core') {
  const result = await validateEnvironment(serviceType);
  
  const report = `# Environment Validation Report

**Service**: ${serviceType}  
**Date**: ${new Date().toISOString()}  
**Status**: ${result.overall.ready ? '✅ READY' : '❌ NOT READY'}

## Environment Variables
- **Valid**: ${result.environment.valid ? '✅' : '❌'}
- **Missing**: ${result.environment.missing.length} variables
- **Deprecated**: ${result.environment.deprecated.length} variables

${result.environment.missing.length > 0 ? `
### Missing Variables
${result.environment.missing.map(v => `- \`${v}\``).join('\\n')}
` : ''}

${result.environment.deprecated.length > 0 ? `
### Deprecated Variables (Remove These)
${result.environment.deprecated.map(v => `- \`${v}\``).join('\\n')}
` : ''}

## Connectivity Tests
- **Database**: ${result.database.success ? '✅' : '❌'} ${result.database.provider || result.database.error}
- **Redis**: ${result.redis.success ? '✅' : '❌'} ${result.redis.provider || result.redis.error}

## Recommendations
${!result.overall.ready ? `
⚠️ **Service is not ready for deployment**

${result.environment.missing.length > 0 ? '1. Set missing environment variables\\n' : ''}
${result.environment.deprecated.length > 0 ? '2. Remove deprecated environment variables\\n' : ''}
${!result.database.success ? '3. Fix database connectivity issues\\n' : ''}
${!result.redis.success ? '4. Fix Redis connectivity issues\\n' : ''}
` : '✅ **Service is ready for deployment**'}
`;

  return report;
}

// Export requirements for external use
export { SERVICE_REQUIREMENTS };