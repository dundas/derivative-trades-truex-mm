/**
 * Unified PostgreSQL Schema Definitions
 * 
 * This is the single source of truth for all PostgreSQL table schemas
 * across the decisive_trades application. All database utilities, migrations,
 * and services should import and use these schema definitions.
 * 
 * Features:
 * - Comprehensive table schemas matching actual Neon PostgreSQL structure
 * - PostgreSQL-specific data types and constraints
 * - Schema validation and mapping utilities
 * - Bulk insert SQL generation
 * - Migration-friendly schema definitions
 */

/**
 * Sessions table schema - Complete PostgreSQL definition
 */
export const SESSIONS_SCHEMA = {
  tableName: 'sessions',
  description: 'Trading sessions with complete lifecycle tracking',
  columns: {
    // Primary identification
    id: { 
      type: 'TEXT', 
      nullable: false, 
      primaryKey: true,
      description: 'Unique session identifier'
    },
    sessionid: {
      type: 'TEXT',
      nullable: true,
      description: 'Session ID (same as id, for compatibility)'
    },
    
    // Trading configuration
    symbol: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading pair symbol (e.g., BTC/USDT)'
    },
    tradingpair: {
      type: 'TEXT',
      nullable: true,
      description: 'Trading pair (alternative to symbol)'
    },
    exchange: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Exchange name (coinbase, binance, etc.)'
    },
    exchangename: {
      type: 'TEXT',
      nullable: true,
      description: 'Full exchange name'
    },
    strategy: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading strategy identifier'
    },
    strategytype: {
      type: 'TEXT',
      nullable: true,
      description: 'Strategy type (alternative to strategy)'
    },
    tradingmode: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading mode (live, paper, simulation)'
    },
    
    // Session state
    status: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Current session status'
    },
    simulationmode: { 
      type: 'BOOLEAN', 
      nullable: true,
      description: 'Whether session is in simulation mode'
    },
    
    // Token information
    basetoken: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Base token (e.g., BTC)'
    },
    quotetoken: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Quote token (e.g., USDT)'
    },
    
    // Financial tracking
    budget: { 
      type: 'REAL', 
      nullable: true,
      description: 'Initial budget for the session'
    },
    
    // Timestamps (PostgreSQL BIGINT for epoch milliseconds) - lowercase names
    starttimestamp: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Session start timestamp from RecentSessionsManager (epoch ms)'
    },
    addedat: {
      type: 'BIGINT',
      nullable: true,
      description: 'Timestamp when session was added to recent sessions (epoch ms)'
    },
    starttime: {
      type: 'BIGINT',
      nullable: true,
      description: 'Session start time from Redis session data (epoch ms)'
    },
    startedat: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Session started timestamp from Redis session data (epoch ms)'
    },
    completedat: {
      type: 'BIGINT',
      nullable: true,
      description: 'Session completion timestamp from RecentSessionsManager (epoch ms)'
    },
    endedat: {
      type: 'BIGINT',
      nullable: true,
      description: 'Session end timestamp (epoch ms)'
    },
    endtime: {
      type: 'TEXT',
      nullable: true,
      description: 'End time from Redis (can be ISO string or timestamp)'
    },
    lastupdated: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last updated timestamp (epoch ms)'
    },
    lastmigratedat: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last migration timestamp (epoch ms)'
    },
    
    // Duration and performance
    duration: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Session duration in milliseconds'
    },
    sessionlength: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Configured session length in milliseconds'
    },
    
    // Session metadata
    cyclecount: { 
      type: 'INTEGER', 
      nullable: true,
      description: 'Number of trading cycles completed'
    },
    version: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Application version'
    },
    endreason: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Reason for session termination'
    },
    
    // Settlement tracking
    settlesession: {
      type: 'BOOLEAN',
      nullable: true,
      description: 'Whether session should be settled'
    },
    settledcomplete: { 
      type: 'BOOLEAN', 
      nullable: true,
      description: 'Whether settlement is complete'
    },
    lastsettleattempt: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last settlement attempt timestamp'
    },
    
    // Cleanup tracking
    earlycleanuptriggered: {
      type: 'BOOLEAN',
      nullable: true,
      description: 'Whether early cleanup was triggered'
    },
    earlycleanuptimestamp: {
      type: 'BIGINT',
      nullable: true,
      description: 'Timestamp when early cleanup was triggered'
    },
    
    // Trading configuration
    pricingstrategyname: {
      type: 'TEXT',
      nullable: true,
      description: 'Name of the pricing strategy used'
    },
    forcetradingenabled: {
      type: 'BOOLEAN',
      nullable: true,
      description: 'Whether force trading is enabled'
    },
    
    // PostgreSQL JSONB fields for complex data
    initialbalances: {
      type: 'JSONB',
      nullable: true,
      description: 'Initial account balances'
    },
    finalbalances: {
      type: 'JSONB',
      nullable: true,
      description: 'Final account balances'
    },
    initialpositions: {
      type: 'JSONB',
      nullable: true,
      description: 'Initial trading positions'
    },
    finalpositions: {
      type: 'JSONB',
      nullable: true,
      description: 'Final trading positions'
    },
    pricingstrategyconfig: {
      type: 'JSONB',
      nullable: true,
      description: 'Pricing strategy configuration'
    },
    cleanupresults: {
      type: 'JSONB',
      nullable: true,
      description: 'Session cleanup results and statistics'
    },
    settings: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Session configuration settings'
    },
    metrics: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Performance metrics and statistics'
    },
    commandlineargs: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Command line arguments used'
    },
    environment: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Environment configuration'
    },
    data: {
      type: 'JSONB',
      nullable: true,
      description: 'Raw session object from Redis for complete data preservation'
    }
  },
  
  // PostgreSQL-specific indexes
  indexes: [
    { name: 'idx_sessions_symbol', columns: ['symbol'] },
    { name: 'idx_sessions_status', columns: ['status'] },
    { name: 'idx_sessions_startedat', columns: ['startedat'] },
    { name: 'idx_sessions_starttimestamp', columns: ['starttimestamp'] },
    { name: 'idx_sessions_completedat', columns: ['completedat'] },
    { name: 'idx_sessions_exchange', columns: ['exchange'] },
    { name: 'idx_sessions_settlement', columns: ['settledcomplete', 'lastsettleattempt'] },
    { name: 'idx_sessions_tradingmode', columns: ['tradingmode'] }
  ]
};

/**
 * Orders table schema - Complete PostgreSQL definition
 */
export const ORDERS_SCHEMA = {
  tableName: 'orders',
  description: 'Trading orders with complete lifecycle tracking',
  columns: {
    // Primary identification
    id: { 
      type: 'TEXT', 
      nullable: false, 
      primaryKey: true,
      description: 'Unique order identifier'
    },
    
    // Foreign keys
    sessionid: { 
      type: 'TEXT', 
      nullable: true,
      foreignKey: { table: 'sessions', column: 'id' },
      description: 'Reference to parent session'
    },
    parentorderid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Reference to parent order (for order chains)'
    },
    clientorderid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Client-side order identifier'
    },
    
    // Order specification
    symbol: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading pair symbol'
    },
    side: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Order side (buy/sell)'
    },
    type: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Order type (market/limit/stop)'
    },
    status: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Current order status'
    },
    
    // Quantities and pricing
    size: { 
      type: 'REAL', 
      nullable: true,
      description: 'Order size/amount'
    },
    filledsize: { 
      type: 'REAL', 
      nullable: true,
      description: 'Amount filled so far'
    },
    filled: { 
      type: 'REAL', 
      nullable: true,
      description: 'Alternative filled amount field'
    },
    remaining: { 
      type: 'REAL', 
      nullable: true,
      description: 'Remaining unfilled amount'
    },
    price: { 
      type: 'REAL', 
      nullable: true,
      description: 'Order price'
    },
    marketprice: { 
      type: 'REAL', 
      nullable: true,
      description: 'Market price at order creation'
    },
    
    // Financial information
    fee: { 
      type: 'REAL', 
      nullable: true,
      description: 'Trading fees'
    },
    usdvalue: { 
      type: 'REAL', 
      nullable: true,
      description: 'USD value of the order'
    },
    
    // Timestamps
    timestamp: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Order creation/execution timestamp'
    },
    lastupdated: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last update timestamp'
    },
    filledat: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Order fill timestamp'
    },
    canceledat: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Order cancellation timestamp'
    },
    lastfilltimestamp: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last fill event timestamp'
    },
    
    // Order context
    exchange: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Exchange where order was placed'
    },
    tradingmode: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading mode when order was created'
    },
    positionid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Position identifier'
    },
    purpose: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Order purpose or strategy'
    },
    cancelreason: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Reason for order cancellation'
    },
    
    // Metadata
    openordersatcreation: { 
      type: 'INTEGER', 
      nullable: true,
      description: 'Number of open orders when this was created'
    },
    
    // PostgreSQL JSONB for complex data
    data: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Additional order data and metadata'
    }
  },
  
  // PostgreSQL-specific indexes
  indexes: [
    { name: 'idx_orders_sessionid', columns: ['sessionid'] },
    { name: 'idx_orders_status', columns: ['status'] },
    { name: 'idx_orders_side', columns: ['side'] },
    { name: 'idx_orders_symbol', columns: ['symbol'] },
    { name: 'idx_orders_timestamp', columns: ['timestamp'] },
    { name: 'idx_orders_clientorderid', columns: ['clientorderid'] },
    { name: 'idx_orders_composite', columns: ['sessionid', 'status', 'side'] }
  ]
};

/**
 * Fills table schema - Complete PostgreSQL definition
 */
export const FILLS_SCHEMA = {
  tableName: 'fills',
  description: 'Order fill events with complete execution details',
  columns: {
    // Primary identification
    id: { 
      type: 'TEXT', 
      nullable: false, 
      primaryKey: true,
      description: 'Unique fill identifier'
    },
    
    // Foreign keys
    orderid: { 
      type: 'TEXT', 
      nullable: true,
      foreignKey: { table: 'orders', column: 'id' },
      description: 'Reference to parent order'
    },
    sessionid: { 
      type: 'TEXT', 
      nullable: true,
      foreignKey: { table: 'sessions', column: 'id' },
      description: 'Reference to trading session'
    },
    clientorderid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Client-side order identifier'
    },
    
    // Fill specification
    symbol: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Trading pair symbol'
    },
    side: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Fill side (buy/sell)'
    },
    
    // Quantities and pricing
    size: { 
      type: 'REAL', 
      nullable: true,
      description: 'Fill size/amount'
    },
    amount: { 
      type: 'REAL', 
      nullable: true,
      description: 'Alternative amount field'
    },
    price: { 
      type: 'REAL', 
      nullable: true,
      description: 'Fill price'
    },
    
    // Financial information
    fee: { 
      type: 'REAL', 
      nullable: true,
      description: 'Trading fees for this fill'
    },
    feeamount: { 
      type: 'REAL', 
      nullable: true,
      description: 'Fee amount in USD'
    },
    cost: { 
      type: 'REAL', 
      nullable: true,
      description: 'Total cost of the fill'
    },
    fees: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Fees array from exchange'
    },
    
    // Exchange-specific fields
    exchangeorderid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Exchange order identifier'
    },
    execid: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Exchange execution ID'
    },
    tradeid: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Exchange trade ID'
    },
    liquidityind: { 
      type: 'TEXT', 
      nullable: true,
      description: 'Liquidity indicator (maker/taker)'
    },
    quantity: { 
      type: 'REAL', 
      nullable: true,
      description: 'Fill quantity (alternative to size)'
    },
    createdat: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Creation timestamp'
    },
    
    // Timestamps
    timestamp: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Fill execution timestamp'
    },
    lastupdated: { 
      type: 'BIGINT', 
      nullable: true,
      description: 'Last update timestamp'
    },
    
    // PostgreSQL JSONB for complex data
    data: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Additional fill data and metadata'
    },
    feedata: { 
      type: 'JSONB', 
      nullable: true,
      description: 'Detailed fee information'
    }
  },
  
  // PostgreSQL-specific indexes
  indexes: [
    { name: 'idx_fills_orderid', columns: ['orderid'] },
    { name: 'idx_fills_sessionid', columns: ['sessionid'] },
    { name: 'idx_fills_symbol', columns: ['symbol'] },
    { name: 'idx_fills_timestamp', columns: ['timestamp'] },
    { name: 'idx_fills_composite', columns: ['sessionid', 'orderid', 'timestamp'] }
  ]
};

/**
 * Export all schemas as a collection
 */
export const POSTGRESQL_SCHEMAS = {
  sessions: SESSIONS_SCHEMA,
  orders: ORDERS_SCHEMA,
  fills: FILLS_SCHEMA
};

/**
 * Export column names for easy access
 */
export const COLUMN_NAMES = {
  sessions: Object.keys(SESSIONS_SCHEMA.columns),
  orders: Object.keys(ORDERS_SCHEMA.columns),
  fills: Object.keys(FILLS_SCHEMA.columns)
};

/**
 * Export primary keys
 */
export const PRIMARY_KEYS = {
  sessions: Object.entries(SESSIONS_SCHEMA.columns)
    .filter(([_, def]) => def.primaryKey)
    .map(([name, _]) => name),
  orders: Object.entries(ORDERS_SCHEMA.columns)
    .filter(([_, def]) => def.primaryKey)
    .map(([name, _]) => name),
  fills: Object.entries(FILLS_SCHEMA.columns)
    .filter(([_, def]) => def.primaryKey)
    .map(([name, _]) => name)
}; 