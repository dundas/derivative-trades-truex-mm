/**
 * PostgreSQL SQL Generation Utilities
 * 
 * This module provides PostgreSQL-specific SQL generation functions
 * that work with our centralized schema definitions.
 */

/**
 * Generate PostgreSQL CREATE TABLE statement from schema
 * @param {Object} schema - Schema definition
 * @returns {string} - PostgreSQL CREATE TABLE SQL
 */
export function generateCreateTableSQL(schema) {
  const { tableName, columns, indexes } = schema;
  
  // Generate column definitions
  const columnDefs = Object.entries(columns).map(([name, def]) => {
    let sql = `${name} ${def.type}`;
    
    if (!def.nullable) sql += ' NOT NULL';
    if (def.primaryKey) sql += ' PRIMARY KEY';
    if (def.default !== undefined) {
      sql += ` DEFAULT ${typeof def.default === 'string' ? `'${def.default}'` : def.default}`;
    }
    
    return sql;
  }).join(',\n  ');
  
  // Generate foreign key constraints
  const foreignKeys = Object.entries(columns)
    .filter(([_, def]) => def.foreignKey)
    .map(([name, def]) => {
      const { table, column } = def.foreignKey;
      return `CONSTRAINT fk_${tableName}_${name} FOREIGN KEY (${name}) REFERENCES ${table}(${column})`;
    });
  
  let sql = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${columnDefs}`;
  
  if (foreignKeys.length > 0) {
    sql += ',\n  ' + foreignKeys.join(',\n  ');
  }
  
  sql += '\n)';
  
  return sql;
}

/**
 * Generate PostgreSQL indexes from schema
 * @param {Object} schema - Schema definition
 * @returns {Array<string>} - Array of CREATE INDEX SQL statements
 */
export function generateIndexesSQL(schema) {
  const { tableName, indexes = [] } = schema;
  
  return indexes.map(index => {
    const { name, columns, unique = false } = index;
    const uniqueKeyword = unique ? 'UNIQUE ' : '';
    return `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${name} ON ${tableName} (${columns.join(', ')})`;
  });
}

/**
 * Generate PostgreSQL INSERT statement from schema
 * @param {Object} schema - Schema definition
 * @param {string} conflictResolution - How to handle conflicts ('UPDATE', 'IGNORE', 'ERROR')
 * @returns {string} - PostgreSQL INSERT SQL
 */
export function generateInsertSQL(schema, conflictResolution = 'UPDATE') {
  const { tableName, columns } = schema;
  const columnNames = Object.keys(columns);
  const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(', ');
  
  let sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders})`;
  
  if (conflictResolution === 'UPDATE') {
    const primaryKeys = Object.entries(columns)
      .filter(([_, def]) => def.primaryKey)
      .map(([name, _]) => name);
    
    if (primaryKeys.length > 0) {
      const updateClauses = columnNames
        .filter(name => !primaryKeys.includes(name))
        .map(name => `${name} = EXCLUDED.${name}`)
        .join(', ');
      
      if (updateClauses) {
        sql += ` ON CONFLICT (${primaryKeys.join(', ')}) DO UPDATE SET ${updateClauses}`;
      }
    }
  } else if (conflictResolution === 'IGNORE') {
    const primaryKeys = Object.entries(columns)
      .filter(([_, def]) => def.primaryKey)
      .map(([name, _]) => name);
    
    if (primaryKeys.length > 0) {
      sql += ` ON CONFLICT (${primaryKeys.join(', ')}) DO NOTHING`;
    }
  }
  
  return sql + ' RETURNING id';
}

/**
 * Generate PostgreSQL bulk INSERT statement from schema
 * @param {Object} schema - Schema definition
 * @param {number} recordCount - Number of records to insert
 * @param {string} conflictResolution - How to handle conflicts
 * @returns {string} - PostgreSQL bulk INSERT SQL
 */
export function generateBulkInsertSQL(schema, recordCount, conflictResolution = 'UPDATE') {
  const { tableName, columns } = schema;
  const columnNames = Object.keys(columns);
  const columnCount = columnNames.length;
  
  // Generate VALUE clauses for bulk insert
  const valuesClauses = [];
  for (let i = 0; i < recordCount; i++) {
    const placeholders = [];
    for (let j = 0; j < columnCount; j++) {
      placeholders.push(`$${i * columnCount + j + 1}`);
    }
    valuesClauses.push(`(${placeholders.join(', ')})`);
  }
  
  let sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES ${valuesClauses.join(', ')}`;
  
  if (conflictResolution === 'UPDATE') {
    const primaryKeys = Object.entries(columns)
      .filter(([_, def]) => def.primaryKey)
      .map(([name, _]) => name);
    
    if (primaryKeys.length > 0) {
      const updateClauses = columnNames
        .filter(name => !primaryKeys.includes(name))
        .map(name => `${name} = EXCLUDED.${name}`)
        .join(', ');
      
      if (updateClauses) {
        sql += ` ON CONFLICT (${primaryKeys.join(', ')}) DO UPDATE SET ${updateClauses}`;
      }
    }
  } else if (conflictResolution === 'IGNORE') {
    const primaryKeys = Object.entries(columns)
      .filter(([_, def]) => def.primaryKey)
      .map(([name, _]) => name);
    
    if (primaryKeys.length > 0) {
      sql += ` ON CONFLICT (${primaryKeys.join(', ')}) DO NOTHING`;
    }
  }
  
  return sql + ' RETURNING id';
}

/**
 * Map data object to ordered array matching schema columns
 * @param {Object} schema - Schema definition
 * @param {Object} dataObject - Data to map
 * @returns {Array} - Ordered array of values
 */
export function mapDataToSchema(schema, dataObject) {
  const { columns } = schema;
  return Object.keys(columns).map(columnName => {
    const value = dataObject[columnName];
    const columnDef = columns[columnName];
    
    // Handle null/undefined values
    if (value === null || value === undefined) {
      return null;
    }
    
    // PostgreSQL type conversions
    switch (columnDef.type) {
      case 'REAL':
        return parseFloat(value) || null;
      case 'BIGINT':
      case 'INTEGER':
        return parseInt(value) || null;
      case 'BOOLEAN':
        return Boolean(value);
      case 'JSONB':
        return typeof value === 'object' ? value : null;
      case 'TEXT':
      default:
        return String(value);
    }
  });
}

/**
 * Normalize field names from various sources to match schema
 * This handles the differences between services (e.g., sessionId vs sessionid)
 * @param {Object} schema - Schema definition
 * @param {Object} dataObject - Data to normalize
 * @returns {Object} - Normalized data object
 */
export function normalizeDataToSchema(schema, dataObject) {
  const { columns } = schema;
  const normalized = {};
  
  // Create mapping from camelCase Redis fields to lowercase PostgreSQL fields
  const fieldMappings = {
    // Basic field name mappings (camelCase -> lowercase)
    sessionId: 'sessionid',
    tradingPair: 'tradingpair',
    exchangeName: 'exchangename',
    strategyType: 'strategytype',
    tradingMode: 'tradingmode',
    simulationMode: 'simulationmode',
    baseToken: 'basetoken',
    quoteToken: 'quotetoken',
    
    // Order field mappings
    parentOrderId: 'parentorderid',
    clientOrderId: 'clientorderid',
    positionId: 'positionid',
    filledSize: 'filledsize',
    marketPrice: 'marketprice',
    usdValue: 'usdvalue',
    openOrdersAtCreation: 'openordersatcreation',
    cancelReason: 'cancelreason',
    canceledAt: 'canceledat',
    filledAt: 'filledat',
    createdAt: 'createdat',
    updatedAt: 'updatedat',
    lastFillTimestamp: 'lastfilltimestamp',
    
    // Timestamp mappings
    startTimestamp: 'starttimestamp',
    addedAt: 'addedat',
    startTime: 'starttime',
    startedAt: 'startedat',
    completedAt: 'completedat',
    endTime: 'endtime',
    lastUpdated: 'lastupdated',
    lastMigratedAt: 'lastmigratedat',
    
    // Other field mappings
    sessionLength: 'sessionlength',
    cycleCount: 'cyclecount',
    endReason: 'endreason',
    settleSession: 'settlesession',
    settledComplete: 'settledcomplete',
    lastSettleAttempt: 'lastsettleattempt',
    earlyCleanupTriggered: 'earlycleanuptriggered',
    earlyCleanupTimestamp: 'earlycleanuptimestamp',
    pricingStrategyName: 'pricingstrategyname',
    forceTradingEnabled: 'forcetradingenabled',
    
    // JSONB field mappings
    initialBalances: 'initialbalances',
    finalBalances: 'finalbalances',
    initialPositions: 'initialpositions',
    finalPositions: 'finalpositions',
    pricingStrategyConfig: 'pricingstrategyconfig',
    cleanupResults: 'cleanupresults',
    commandLineArgs: 'commandlineargs'
  };
  
  // First, copy exact matches (already lowercase)
  Object.keys(columns).forEach(columnName => {
    if (dataObject.hasOwnProperty(columnName)) {
      normalized[columnName] = dataObject[columnName];
    }
  });
  
  // Then, handle camelCase -> lowercase conversions
  Object.entries(fieldMappings).forEach(([sourceField, targetField]) => {
    if (dataObject.hasOwnProperty(sourceField) && columns.hasOwnProperty(targetField)) {
      normalized[targetField] = dataObject[sourceField];
    }
  });
  
  return normalized;
}

/**
 * Validate data object against schema
 * @param {Object} schema - Schema definition
 * @param {Object} dataObject - Data to validate
 * @returns {Array<string>} - Array of validation errors
 */
export function validateData(schema, dataObject) {
  const { columns } = schema;
  const errors = [];
  
  Object.entries(columns).forEach(([columnName, columnDef]) => {
    const value = dataObject[columnName];
    
    // Check required fields
    if (!columnDef.nullable && (value === null || value === undefined)) {
      errors.push(`Required field '${columnName}' is missing or null`);
    }
    
    // Check primary key
    if (columnDef.primaryKey && !value) {
      errors.push(`Primary key '${columnName}' cannot be empty`);
    }
    
    // Type validation
    if (value !== null && value !== undefined) {
      switch (columnDef.type) {
        case 'REAL':
          if (isNaN(parseFloat(value))) {
            errors.push(`Field '${columnName}' must be a valid number`);
          }
          break;
        case 'BIGINT':
        case 'INTEGER':
          if (isNaN(parseInt(value))) {
            errors.push(`Field '${columnName}' must be a valid integer`);
          }
          break;
        case 'BOOLEAN':
          if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
            errors.push(`Field '${columnName}' must be a boolean value`);
          }
          break;
        case 'JSONB':
          if (typeof value !== 'object') {
            errors.push(`Field '${columnName}' must be a valid JSON object`);
          }
          break;
      }
    }
  });
  
  return errors;
}

/**
 * Generate PostgreSQL UPDATE statement from schema
 * @param {Object} schema - Schema definition
 * @param {Array<string>} updateFields - Fields to update
 * @returns {string} - PostgreSQL UPDATE SQL
 */
export function generateUpdateSQL(schema, updateFields) {
  const { tableName, columns } = schema;
  const primaryKeys = Object.entries(columns)
    .filter(([_, def]) => def.primaryKey)
    .map(([name, _]) => name);
  
  const setClauses = updateFields.map((field, i) => `${field} = $${i + 1}`).join(', ');
  const whereClause = primaryKeys.map((key, i) => `${key} = $${updateFields.length + i + 1}`).join(' AND ');
  
  return `UPDATE ${tableName} SET ${setClauses} WHERE ${whereClause} RETURNING id`;
}

/**
 * Generate PostgreSQL SELECT statement from schema
 * @param {Object} schema - Schema definition
 * @param {Object} options - Query options
 * @returns {string} - PostgreSQL SELECT SQL
 */
export function generateSelectSQL(schema, options = {}) {
  const { tableName, columns } = schema;
  const { 
    fields = Object.keys(columns),
    where = [],
    orderBy = [],
    limit = null,
    offset = null 
  } = options;
  
  let sql = `SELECT ${fields.join(', ')} FROM ${tableName}`;
  
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  
  if (orderBy.length > 0) {
    sql += ` ORDER BY ${orderBy.join(', ')}`;
  }
  
  if (limit !== null) {
    sql += ` LIMIT ${limit}`;
  }
  
  if (offset !== null) {
    sql += ` OFFSET ${offset}`;
  }
  
  return sql;
} 