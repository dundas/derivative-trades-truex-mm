import { PostgreSQLAPI, createPostgreSQLAPIFromEnv } from '../../lib/postgresql-api/index.js';

const REFERENCE_BASIS_COLUMNS = [
  'basis_source', 'basis_requested_pair', 'basis_resolved_pair', 'basis_base', 'basis_quote',
  'basis_venue', 'basis_system', 'basis_request_timestamp', 'basis_received_timestamp',
  'basis_bid', 'basis_ask', 'basis_bid_qty', 'basis_ask_qty', 'basis_bid_count',
  'basis_ask_count', 'basis_bid_submission_timestamp', 'basis_bid_publication_timestamp',
  'basis_ask_submission_timestamp', 'basis_ask_publication_timestamp', 'promotion_grade',
];

const referenceBasisValues = value => [
  value.basisSource, value.basisRequestedPair, value.basisResolvedPair, value.basisBase,
  value.basisQuote, value.basisVenue, value.basisSystem, value.basisRequestTimestamp,
  value.basisReceivedTimestamp, value.basisBid, value.basisAsk, value.basisBidQty,
  value.basisAskQty, value.basisBidCount, value.basisAskCount,
  value.basisBidSubmissionTimestamp, value.basisBidPublicationTimestamp,
  value.basisAskSubmissionTimestamp, value.basisAskPublicationTimestamp,
  value.promotionGrade === true,
];
const REFERENCE_DIRECT_COLUMNS = [
  'reference_mode', 'source_instrument', 'source_channel', 'source_sequence',
  'source_generation', 'source_session_id', 'source_endpoint', 'source_book_hash',
  'source_depth', 'source_bid_qty', 'source_ask_qty', 'source_bid_count', 'source_ask_count',
  'source_book_update_timestamp',
];
const referenceDirectValues = value => value.referenceMode === 'cryptocom-direct' ? [
  'cryptocom-direct', value.sourceInstrument, value.sourceChannel, value.sourceSequence,
  value.sourceGeneration, value.sourceSessionId, value.sourceEndpoint, value.sourceBookHash,
  value.sourceDepth, value.sourceBidQty, value.sourceAskQty, value.sourceBidCount,
  value.sourceAskCount, value.sourceBookUpdateTimestamp,
] : [value.referenceMode === 'coinbase-basis' ? 'coinbase-basis' : null, ...Array(13).fill(null)];

/**
 * TrueX PostgreSQL Manager - Layer 3: Analytics & Long-term Storage
 *
 * Manages PostgreSQL persistence using the unified PostgreSQL API.
 * Provides batch migration from Redis to PostgreSQL for analytics and backup.
 *
 * Performance targets:
 * - Migration frequency: Every 5 minutes
 * - Batch size: 1000 records per bulk insert
 * - Deduplication: Via unique constraints (fills, ohlc)
 * - Query performance: Indexed on sessionId, timestamp, status
 */
export class TrueXPostgreSQLManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.referenceQueryOptions = options.referenceQueryOptions || null;

    // Create PostgreSQL API instance
    if (options.db) {
      this.db = options.db;
    } else if (options.pgUrl) {
      this.db = new PostgreSQLAPI({
        connectionString: options.pgUrl, logger: this.logger,
        sslCa: options.sslCa,
        connectionTimeoutMillis: options.referenceQueryOptions?.queryTimeoutMs,
      });
    } else {
      this.db = createPostgreSQLAPIFromEnv();
    }
    
    // Statistics
    this.stats = {
      sessionsMigrated: 0,
      ordersMigrated: 0,
      fillsMigrated: 0,
      ohlcMigrated: 0,
      migrationErrors: 0,
      lastMigrationTime: 0
    };

    // Advisory lock keys (two-int variant). Keep A constant by subsystem and vary B by scope.
    // Using fixed A ensures locks share the same namespace for TrueX; B distinguishes schema vs session.
    this.schemaLockA = 874521; // arbitrary constant namespace
    this.schemaLockB = 1001;   // schema changes
    this.migrationLockA = 874521; // same namespace, per-session B derived from sessionId
  }

  _referenceQuery(text, params = []) {
    if (this.referenceQueryOptions && typeof this.db.boundedQuery === 'function') {
      return this.db.boundedQuery(text, params, this.referenceQueryOptions);
    }
    return this.db.query(text, params);
  }

  getReferencePersistenceStats() {
    const stats = this.db.getStats?.() || {};
    return {
      activeQueries: Number(stats.activeQueries) || 0,
      waitingRequests: Number(stats.waitingRequests) || 0,
      lastQueryLatencyMs: Number.isFinite(stats.lastQueryLatencyMs) ? stats.lastQueryLatencyMs : null,
      maxQueryLatencyMs: Number(stats.maxQueryLatencyMs) || 0,
      queryErrors: Number(stats.queryErrors) || 0,
    };
  }
  
  /**
   * Initialize PostgreSQL connection and ensure schema exists
   */
  async initialize() {
    try {
      await this.db.initialize();
      
      // Ensure TrueX-specific schema additions exist
      await this.ensureTrueXSchema();
      
      this.logger.info('[TrueXPostgreSQLManager] PostgreSQL API initialized');
      return true;
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Initialization failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Ensure TrueX-specific schema additions exist
   * Adds columns for FIX protocol data if they don't exist
   */
  async ensureTrueXSchema() {
    return this.withAdvisoryLock(this.schemaLockA, this.schemaLockB, async () => {
      try {
        // Add msg_seq_num to orders table if it doesn't exist
        await this.db.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS msg_seq_num INTEGER
        `);
        
        // Add exec_reports JSONB column to orders if it doesn't exist
        await this.db.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS exec_reports JSONB DEFAULT '[]'::jsonb
        `);
        
        // Create OHLC table if it doesn't exist
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS ohlc (
            id SERIAL PRIMARY KEY,
            symbol TEXT NOT NULL,
            exchange TEXT NOT NULL,
            interval TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            open NUMERIC NOT NULL,
            high NUMERIC NOT NULL,
            low NUMERIC NOT NULL,
            close NUMERIC NOT NULL,
            volume NUMERIC NOT NULL,
            source TEXT,
            trade_count INTEGER,
            is_complete BOOLEAN DEFAULT false,
            data JSONB,
            created_at TIMESTAMP DEFAULT NOW(),
            CONSTRAINT unique_ohlc_candle UNIQUE (symbol, exchange, interval, timestamp)
          )
        `);
        
        // Create indexes for OHLC table
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_ohlc_symbol_interval_timestamp 
          ON ohlc(symbol, interval, timestamp)
        `);
        
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_ohlc_timestamp
          ON ohlc(timestamp)
        `);

        // Create balance_snapshots table if it doesn't exist
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS balance_snapshots (
            id                    SERIAL PRIMARY KEY,
            session_id            TEXT          NOT NULL,
            timestamp             BIGINT        NOT NULL,
            btc_qty               NUMERIC(18,8) NOT NULL,
            pyusd_qty             NUMERIC(18,4) NOT NULL,
            btc_mid_price         NUMERIC(18,2),
            portfolio_value_pyusd NUMERIC(18,4),
            created_at            TIMESTAMPTZ   DEFAULT NOW(),
            CONSTRAINT unique_balance_snapshot UNIQUE (session_id, timestamp)
          )
        `);

        // Create indexes for balance_snapshots table
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_balance_snapshots_session_ts
          ON balance_snapshots(session_id, timestamp DESC)
        `);

        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_balance_snapshots_timestamp
          ON balance_snapshots(timestamp DESC)
        `);

        // Immutable quote decision/lifecycle evidence. This is intentionally
        // additive: historical orders and fills remain unchanged.
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS quote_lifecycle_events (
            event_id TEXT PRIMARY KEY,
            schema_version TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_timestamp BIGINT NOT NULL,
            decision_timestamp BIGINT NOT NULL,
            session_id TEXT,
            quote_id TEXT,
            order_id TEXT,
            replaces_quote_id TEXT,
            execution_id TEXT,
            symbol TEXT,
            side TEXT,
            price NUMERIC,
            size NUMERIC,
            level INTEGER,
            action TEXT,
            reason TEXT,
            policy_id TEXT,
            policy_vector JSONB,
            target_inventory_btc NUMERIC,
            inventory_deviation_btc NUMERIC,
            committed_exposure_btc NUMERIC,
            context JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_quote_lifecycle_session_ts ON quote_lifecycle_events(session_id, event_timestamp DESC)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_quote_lifecycle_quote_ts ON quote_lifecycle_events(quote_id, event_timestamp ASC)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_quote_lifecycle_type_ts ON quote_lifecycle_events(event_type, event_timestamp DESC)`);
        await this.db.query(`ALTER TABLE quote_lifecycle_events ADD COLUMN IF NOT EXISTS policy_vector JSONB`);

        await this.db.query(`
          CREATE TABLE IF NOT EXISTS reference_quote_decisions (
            decision_id TEXT PRIMARY KEY,
            event_id TEXT,
            decision_timestamp BIGINT NOT NULL,
            session_id TEXT,
            quote_id TEXT NOT NULL,
            symbol TEXT,
            side TEXT,
            level INTEGER,
            policy_id TEXT,
            quote_price NUMERIC,
            quote_size NUMERIC,
            product TEXT NOT NULL,
            quote_currency TEXT NOT NULL,
            source_exchange TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_timestamp BIGINT,
            received_timestamp BIGINT,
            bid NUMERIC,
            ask NUMERIC,
            midpoint NUMERIC,
            basis_timestamp BIGINT,
            basis_price NUMERIC,
            basis_adjustment_bps NUMERIC,
            observed_edge_bps NUMERIC,
            available BOOLEAN NOT NULL,
            unavailable_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_decision_quote_ts ON reference_quote_decisions(quote_id, decision_timestamp DESC)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_decision_session_quote_ts ON reference_quote_decisions(session_id, quote_id, decision_timestamp DESC)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_decision_retention_v3 ON reference_quote_decisions(decision_timestamp, decision_id, session_id, quote_id)`);

        await this.db.query(`
          CREATE TABLE IF NOT EXISTS reference_market_observations (
            observation_id TEXT PRIMARY KEY,
            observation_timestamp BIGINT NOT NULL,
            product TEXT NOT NULL,
            quote_currency TEXT NOT NULL,
            source_exchange TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_timestamp BIGINT NOT NULL,
            received_timestamp BIGINT NOT NULL,
            bid NUMERIC NOT NULL,
            ask NUMERIC NOT NULL,
            midpoint NUMERIC NOT NULL,
            basis_timestamp BIGINT,
            basis_price NUMERIC,
            basis_adjustment_bps NUMERIC NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_market_window ON reference_market_observations(product, quote_currency, source_exchange, source_type, source_timestamp, received_timestamp)`);
        // New names are intentional migration hooks: changing the definition of
        // idx_reference_market_window in place would be ignored by IF NOT EXISTS
        // on databases that already created the original index.
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v2 ON reference_market_observations(product, quote_currency, source_exchange, source_type, observation_timestamp, source_timestamp, received_timestamp, basis_timestamp)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_market_retention_v3 ON reference_market_observations(received_timestamp, observation_timestamp, observation_id)`);
        // Direct BTC-PYUSD evidence has no conversion basis. Existing deployments
        // created these legacy basis columns as NOT NULL, so make the additive
        // migration explicit before direct observations can be inserted.
        await this.db.query(`ALTER TABLE reference_market_observations ALTER COLUMN basis_timestamp DROP NOT NULL`);
        await this.db.query(`ALTER TABLE reference_market_observations ALTER COLUMN basis_price DROP NOT NULL`);

        await this.db.query(`
          CREATE TABLE IF NOT EXISTS fill_reference_markout_work (
            fill_id TEXT NOT NULL,
            horizon_ms BIGINT NOT NULL,
            execution_id TEXT,
            quote_id TEXT,
            session_id TEXT,
            fill_timestamp BIGINT NOT NULL,
            decision_timestamp BIGINT,
            side TEXT,
            level INTEGER,
            policy_id TEXT,
            fill_price NUMERIC,
            fill_size NUMERIC,
            product TEXT NOT NULL,
            quote_currency TEXT NOT NULL,
            source_exchange TEXT NOT NULL,
            source_type TEXT NOT NULL,
            due_timestamp BIGINT NOT NULL,
            deadline_timestamp BIGINT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'completed')),
            claim_token TEXT,
            claim_expires_at BIGINT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_unavailable_reason TEXT,
            completed_at BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (fill_id, horizon_ms)
          )
        `);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_markout_due ON fill_reference_markout_work(state, due_timestamp, claim_expires_at)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_markout_grouping ON fill_reference_markout_work(side, level, policy_id, horizon_ms)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_markout_retention_v2 ON fill_reference_markout_work(completed_at, fill_id, horizon_ms) WHERE state = 'completed'`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_markout_attribution_v3 ON fill_reference_markout_work(session_id, quote_id)`);
        await this.db.query(`DROP INDEX IF EXISTS idx_reference_markout_pending_attribution_v2`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_markout_unfinished_window_v2 ON fill_reference_markout_work(due_timestamp, deadline_timestamp) WHERE state <> 'completed'`);

        await this.db.query(`
          CREATE TABLE IF NOT EXISTS fill_reference_markout_evidence (
            fill_id TEXT NOT NULL,
            horizon_ms BIGINT NOT NULL,
            observation_timestamp BIGINT NOT NULL,
            product TEXT NOT NULL,
            quote_currency TEXT NOT NULL,
            source_exchange TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_timestamp BIGINT,
            received_timestamp BIGINT,
            bid NUMERIC,
            ask NUMERIC,
            midpoint NUMERIC,
            basis_timestamp BIGINT,
            basis_price NUMERIC,
            basis_adjustment_bps NUMERIC,
            adjusted_midpoint NUMERIC,
            observed_edge_bps NUMERIC,
            available BOOLEAN NOT NULL,
            unavailable_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (fill_id, horizon_ms),
            FOREIGN KEY (fill_id, horizon_ms)
              REFERENCES fill_reference_markout_work(fill_id, horizon_ms)
          )
        `);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_evidence_availability ON fill_reference_markout_evidence(available, unavailable_reason)`);
        await this.db.query(`ALTER TABLE fill_reference_markout_evidence ADD COLUMN IF NOT EXISTS observed_edge_bps NUMERIC`);
        await this.db.query(`ALTER TABLE fill_reference_markout_evidence ADD COLUMN IF NOT EXISTS adjusted_midpoint NUMERIC`);
        // Direct provenance columns and their sole writer ship together in this
        // never-before-deployed schema version. New writes canonicalize the endpoint
        // before persistence. Do not rewrite immutable evidence for a hypothetical
        // pre-canonical writer; none exists on the production baseline.
        const provenanceTypes = {
          basis_request_timestamp: 'BIGINT', basis_received_timestamp: 'BIGINT',
          basis_bid: 'NUMERIC', basis_ask: 'NUMERIC', basis_bid_qty: 'NUMERIC',
          basis_ask_qty: 'NUMERIC', basis_bid_count: 'INTEGER', basis_ask_count: 'INTEGER',
          basis_bid_submission_timestamp: 'BIGINT', basis_bid_publication_timestamp: 'BIGINT',
          basis_ask_submission_timestamp: 'BIGINT', basis_ask_publication_timestamp: 'BIGINT',
          promotion_grade: 'BOOLEAN',
        };
        for (const table of ['reference_quote_decisions', 'reference_market_observations',
          'fill_reference_markout_evidence']) {
          for (const column of REFERENCE_BASIS_COLUMNS) {
            await this.db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${provenanceTypes[column] || 'TEXT'}`);
          }
          for (const column of REFERENCE_DIRECT_COLUMNS) {
            const type = ['source_sequence', 'source_generation', 'source_book_update_timestamp']
              .includes(column) ? 'BIGINT'
              : ['source_depth', 'source_bid_count', 'source_ask_count'].includes(column) ? 'INTEGER'
                : ['source_bid_qty', 'source_ask_qty'].includes(column) ? 'NUMERIC' : 'TEXT';
            await this.db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
          }
        }
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v3
          ON reference_market_observations(product, quote_currency, source_exchange, source_type,
            basis_source, basis_requested_pair, basis_resolved_pair, basis_base, basis_quote,
            basis_system, basis_venue, observation_timestamp, observation_id)`);
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v4_direct
          ON reference_market_observations(reference_mode, product, quote_currency,
            source_exchange, source_type, source_instrument, source_channel,
            source_endpoint, observation_timestamp, observation_id)`);

        // Create index on exec_id for fills deduplication
        await this.db.query(`
          CREATE INDEX IF NOT EXISTS idx_fills_execid 
          ON fills(execid)
        `);
        
        this.logger.info('[TrueXPostgreSQLManager] TrueX schema additions ensured');
        return true;
      } catch (error) {
        this.logger.error(`[TrueXPostgreSQLManager] Schema setup failed: ${error.message}`);
        throw error;
      }
    }, { timeoutMs: 30000 });
  }

  async recordQuoteLifecycleEvent(event) {
    const sql = `INSERT INTO quote_lifecycle_events (
      event_id, schema_version, event_type, event_timestamp, decision_timestamp,
      session_id, quote_id, order_id, replaces_quote_id, execution_id, symbol, side,
      price, size, level, action, reason, policy_id, policy_vector, target_inventory_btc,
      inventory_deviation_btc, committed_exposure_btc, context
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    ON CONFLICT (event_id) DO NOTHING`;
    try {
      await this.db.query(sql, [
        event.eventId, event.schemaVersion, event.eventType, event.timestamp, event.decisionTimestamp,
        event.sessionId, event.quoteId, event.orderId, event.replacesQuoteId, event.executionId,
        event.symbol, event.side, event.price, event.size, event.level, event.action, event.reason,
        event.policyId, JSON.stringify(event.policyVector), event.targetInventoryBTC, event.inventoryDeviationBTC,
        event.committedExposureBTC, JSON.stringify(event.context || {}),
      ]);
      return true;
    } catch (error) {
      this.logger.warn(`[TrueXPostgreSQLManager] quote telemetry write failed: ${error.message}`);
      throw error;
    }
  }

  async getQuoteLifecycleEvents({ sessionId, quoteId, fromTimestamp, toTimestamp, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    const add = (clause, value) => { params.push(value); where.push(`${clause} $${params.length}`); };
    if (sessionId) add('session_id =', sessionId);
    if (quoteId) add('quote_id =', quoteId);
    if (Number.isFinite(fromTimestamp)) add('event_timestamp >=', fromTimestamp);
    if (Number.isFinite(toTimestamp)) add('event_timestamp <=', toTimestamp);
    params.push(Math.max(1, Math.min(Number(limit) || 1000, 10000)));
    return this.db.query(`SELECT * FROM quote_lifecycle_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY event_timestamp ASC LIMIT $${params.length}`, params);
  }

  async pruneQuoteLifecycleEventsBefore(cutoffTimestamp) {
    if (!Number.isFinite(cutoffTimestamp)) throw new Error('cutoffTimestamp must be a finite epoch millisecond value');
    return this.db.query('DELETE FROM quote_lifecycle_events WHERE event_timestamp < $1', [cutoffTimestamp]);
  }

  async recordReferenceQuoteDecision(decision) {
    const decisionId = decision.eventId ||
      `${decision.sessionId || 'unknown'}:${decision.quoteId}:${decision.decisionTimestamp}`;
    const values = [
      decisionId, decision.eventId || null, decision.decisionTimestamp, decision.sessionId || null,
      decision.quoteId, decision.symbol || null, decision.side || null, decision.level ?? null,
      decision.policyId || null, decision.price ?? null, decision.size ?? null, decision.product,
      decision.quoteCurrency, decision.sourceExchange, decision.sourceType,
      decision.sourceTimestamp, decision.receivedTimestamp, decision.bid, decision.ask,
      decision.midpoint, decision.basisTimestamp, decision.basisPrice,
      decision.basisAdjustmentBps, decision.available, decision.unavailableReason,
      ...referenceBasisValues(decision), ...referenceDirectValues(decision),
    ];
    return this._referenceQuery(`INSERT INTO reference_quote_decisions (
      decision_id, event_id, decision_timestamp, session_id, quote_id, symbol, side, level,
      policy_id, quote_price, quote_size, product, quote_currency, source_exchange, source_type,
      source_timestamp, received_timestamp, bid, ask, midpoint, basis_timestamp, basis_price,
      basis_adjustment_bps, available, unavailable_reason, ${REFERENCE_BASIS_COLUMNS.join(', ')},
      ${REFERENCE_DIRECT_COLUMNS.join(', ')}
    ) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
    ON CONFLICT (decision_id) DO NOTHING`, values);
  }

  async scheduleReferenceMarkouts(fill) {
    const count = fill.horizonsMs.length;
    const repeat = value => Array(count).fill(value ?? null);
    const result = await this._referenceQuery(`WITH input AS (
      SELECT * FROM UNNEST(
        $1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::bigint[],
        $7::bigint[], $8::text[], $9::integer[], $10::text[], $11::numeric[],
        $12::numeric[], $13::text[], $14::text[], $15::text[], $16::text[],
        $17::bigint[], $18::bigint[]
      ) AS row(fill_id, horizon_ms, execution_id, quote_id, session_id, fill_timestamp,
        decision_timestamp, side, level, policy_id, fill_price, fill_size, product,
        quote_currency, source_exchange, source_type, due_timestamp, deadline_timestamp)
    ) INSERT INTO fill_reference_markout_work (
      fill_id, horizon_ms, execution_id, quote_id, session_id, fill_timestamp,
      decision_timestamp, side, level, policy_id, fill_price, fill_size, product,
      quote_currency, source_exchange, source_type, due_timestamp, deadline_timestamp
    ) SELECT input.fill_id, input.horizon_ms, input.execution_id, input.quote_id,
      input.session_id, input.fill_timestamp,
      COALESCE(input.decision_timestamp, decision.decision_timestamp), input.side, input.level,
      COALESCE(input.policy_id, decision.policy_id), input.fill_price, input.fill_size,
      input.product, input.quote_currency, input.source_exchange, input.source_type,
      input.due_timestamp, input.deadline_timestamp
    FROM input
    LEFT JOIN LATERAL (
      SELECT decision_timestamp, policy_id FROM reference_quote_decisions
      WHERE session_id = input.session_id AND quote_id = input.quote_id
        AND decision_timestamp <= input.fill_timestamp
      ORDER BY decision_timestamp DESC LIMIT 1
    ) decision ON TRUE
    ON CONFLICT (fill_id, horizon_ms) DO NOTHING`, [
      repeat(fill.fillId), fill.horizonsMs, repeat(fill.executionId), repeat(fill.quoteId),
      repeat(fill.sessionId), repeat(fill.fillTimestamp), repeat(fill.decisionTimestamp),
      repeat(fill.side), repeat(fill.level), repeat(fill.policyId), repeat(fill.price),
      repeat(fill.size), repeat(fill.product), repeat(fill.quoteCurrency),
      repeat(fill.sourceExchange), repeat(fill.sourceType), fill.dueTimestamps,
      fill.deadlineTimestamps,
    ]);
    return result.rowCount ?? 0;
  }

  async recordReferenceMarketObservation(observation) {
    const observationId = [
      observation.sourceExchange, observation.product, observation.observationTimestamp,
      observation.sourceTimestamp,
      observation.receivedTimestamp, observation.bid, observation.ask,
      observation.basisTimestamp, observation.basisPrice,
      ...referenceBasisValues(observation), ...referenceDirectValues(observation),
    ].join(':');
    const values = [
      observationId, observation.observationTimestamp, observation.product,
      observation.quoteCurrency, observation.sourceExchange, observation.sourceType,
      observation.sourceTimestamp, observation.receivedTimestamp, observation.bid,
      observation.ask, observation.midpoint, observation.basisTimestamp,
      observation.basisPrice, observation.basisAdjustmentBps,
      ...referenceBasisValues(observation), ...referenceDirectValues(observation),
    ];
    const result = await this._referenceQuery(`INSERT INTO reference_market_observations (
      observation_id, observation_timestamp, product, quote_currency, source_exchange,
      source_type, source_timestamp, received_timestamp, bid, ask, midpoint,
      basis_timestamp, basis_price, basis_adjustment_bps, ${REFERENCE_BASIS_COLUMNS.join(', ')},
      ${REFERENCE_DIRECT_COLUMNS.join(', ')}
    ) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
    ON CONFLICT (observation_id) DO NOTHING`, values);
    return (result.rowCount ?? 0) > 0;
  }

  async getFirstReferenceMarketObservation({ dueTimestamp, deadlineTimestamp, product,
    quoteCurrency, sourceExchange, sourceType, maxSourceAgeMs, maxAbsBasisAdjustmentBps,
    basisSource, basisRequestedPair, basisResolvedPair, basisBase, basisQuote, basisSystem,
    basisVenueAllowlist, maxBasisRttMs, referenceMode, sourceInstrument, sourceChannel,
    sourceEndpointAllowlist }) {
    if (referenceMode === 'cryptocom-direct') {
      const direct = await this._referenceQuery(`SELECT * FROM reference_market_observations
        WHERE reference_mode = 'cryptocom-direct'
          AND product = $1 AND quote_currency = $2 AND source_exchange = $3
          AND source_type = $4 AND source_instrument = $8 AND source_channel = $9
          AND source_endpoint = ANY($10::text[])
          AND observation_timestamp BETWEEN $5 AND $6
          AND observation_timestamp >= 0 AND source_timestamp >= 0 AND received_timestamp >= 0
          AND source_sequence >= 0 AND source_generation > 0
          AND source_session_id IS NOT NULL AND LENGTH(source_session_id) BETWEEN 8 AND 64
          AND source_book_hash ~ '^[a-f0-9]{64}$' AND source_depth = 10
          AND source_bid_qty > 0 AND source_ask_qty > 0
          AND source_bid_count > 0 AND source_ask_count > 0
          AND source_book_update_timestamp >= 0
          AND source_book_update_timestamp <= source_timestamp
          AND source_timestamp <= received_timestamp
          AND received_timestamp <= observation_timestamp
          AND received_timestamp - source_timestamp <= $7
          AND observation_timestamp - received_timestamp <= $7
          AND observation_timestamp - source_timestamp <= $7
          AND bid::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND ask::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND midpoint::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND bid > 0 AND ask > 0 AND bid <= ask AND midpoint = ((bid + ask) / 2)
          AND basis_adjustment_bps = 0 AND promotion_grade IS TRUE
        ORDER BY observation_timestamp, source_timestamp, received_timestamp, observation_id
        LIMIT 1`, [product, quoteCurrency, sourceExchange, sourceType, dueTimestamp,
        deadlineTimestamp, maxSourceAgeMs, sourceInstrument, sourceChannel,
        sourceEndpointAllowlist]);
      const row = direct.rows?.[0];
      if (!row) return null;
      return { available: true, unavailableReason: null,
        observationTimestamp: Number(row.observation_timestamp), product: row.product,
        quoteCurrency: row.quote_currency, sourceExchange: row.source_exchange,
        sourceType: row.source_type, sourceTimestamp: Number(row.source_timestamp),
        receivedTimestamp: Number(row.received_timestamp), bid: Number(row.bid),
        ask: Number(row.ask), midpoint: Number(row.midpoint), basisTimestamp: null,
        basisPrice: null, basisAdjustmentBps: 0, sourceInstrument: row.source_instrument,
        sourceChannel: row.source_channel, sourceSequence: Number(row.source_sequence),
        sourceGeneration: Number(row.source_generation),
        sourceSessionId: row.source_session_id,
        sourceEndpoint: row.source_endpoint, sourceBookHash: row.source_book_hash,
        sourceDepth: Number(row.source_depth), sourceBidQty: Number(row.source_bid_qty),
        sourceAskQty: Number(row.source_ask_qty), sourceBidCount: Number(row.source_bid_count),
        sourceAskCount: Number(row.source_ask_count),
        sourceBookUpdateTimestamp: Number(row.source_book_update_timestamp),
        referenceMode: row.reference_mode, promotionGrade: row.promotion_grade === true };
    }
    const result = await this._referenceQuery(`SELECT * FROM reference_market_observations
      WHERE product = $1 AND quote_currency = $2 AND source_exchange = $3 AND source_type = $4
        AND observation_timestamp >= $5 AND observation_timestamp <= $6
        AND observation_timestamp >= 0 AND source_timestamp >= 0
        AND received_timestamp >= 0 AND basis_timestamp >= 0
        AND basis_request_timestamp >= 0 AND basis_received_timestamp >= 0
        AND basis_bid_submission_timestamp >= 0 AND basis_bid_publication_timestamp >= 0
        AND basis_ask_submission_timestamp >= 0 AND basis_ask_publication_timestamp >= 0
        AND bid::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND ask::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND midpoint::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_adjustment_bps::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_bid::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_ask::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_bid_qty::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND basis_ask_qty::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND bid > 0 AND ask > 0 AND bid <= ask AND midpoint > 0
        AND basis_price > 0
        AND basis_bid > 0 AND basis_ask > 0 AND basis_bid <= basis_ask
        AND basis_bid_qty > 0 AND basis_ask_qty > 0
        AND basis_bid_count > 0 AND basis_ask_count > 0
        AND source_timestamp <= received_timestamp
        AND received_timestamp <= observation_timestamp
        AND source_timestamp <= observation_timestamp
        AND basis_timestamp <= observation_timestamp
        AND basis_source = $9 AND basis_requested_pair = $10 AND basis_resolved_pair = $11
        AND basis_base = $12 AND basis_quote = $13 AND basis_system = $14
        AND basis_venue = ANY($15::text[]) AND promotion_grade IS TRUE
        AND basis_request_timestamp <= basis_received_timestamp
        AND basis_received_timestamp <= observation_timestamp
        AND basis_received_timestamp - basis_request_timestamp <= $16
        AND basis_bid_submission_timestamp <= basis_bid_publication_timestamp
        AND basis_ask_submission_timestamp <= basis_ask_publication_timestamp
        AND basis_bid_publication_timestamp <= basis_received_timestamp
        AND basis_ask_publication_timestamp <= basis_received_timestamp
        AND basis_timestamp = LEAST(basis_bid_publication_timestamp, basis_ask_publication_timestamp)
        AND observation_timestamp - source_timestamp <= $7
        AND observation_timestamp - basis_bid_publication_timestamp <= $7
        AND observation_timestamp - basis_ask_publication_timestamp <= $7
        AND observation_timestamp - basis_received_timestamp <= $7
        AND ABS(basis_adjustment_bps) <= $8
        AND ABS(basis_price - ((basis_bid + basis_ask) / 2)) <= 0.000000000001
        AND ABS(basis_adjustment_bps - ((1 / basis_price - 1) * 10000)) <= 0.00000001
      ORDER BY observation_timestamp ASC,
        GREATEST(source_timestamp, received_timestamp, basis_timestamp) ASC,
        observation_id ASC
      LIMIT 1`, [product, quoteCurrency, sourceExchange, sourceType, dueTimestamp,
      deadlineTimestamp, maxSourceAgeMs, maxAbsBasisAdjustmentBps, basisSource,
      basisRequestedPair, basisResolvedPair, basisBase, basisQuote, basisSystem,
      basisVenueAllowlist, maxBasisRttMs]);
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      available: true, unavailableReason: null,
      observationTimestamp: Number(row.observation_timestamp), product: row.product,
      quoteCurrency: row.quote_currency, sourceExchange: row.source_exchange,
      sourceType: row.source_type, sourceTimestamp: Number(row.source_timestamp),
      receivedTimestamp: Number(row.received_timestamp), bid: Number(row.bid),
      ask: Number(row.ask), midpoint: Number(row.midpoint),
      basisTimestamp: Number(row.basis_timestamp), basisPrice: Number(row.basis_price),
      basisAdjustmentBps: Number(row.basis_adjustment_bps),
      basisSource: row.basis_source, basisRequestedPair: row.basis_requested_pair,
      basisResolvedPair: row.basis_resolved_pair, basisBase: row.basis_base,
      basisQuote: row.basis_quote, basisVenue: row.basis_venue, basisSystem: row.basis_system,
      basisRequestTimestamp: Number(row.basis_request_timestamp),
      basisReceivedTimestamp: Number(row.basis_received_timestamp),
      basisBid: Number(row.basis_bid), basisAsk: Number(row.basis_ask),
      basisBidQty: Number(row.basis_bid_qty), basisAskQty: Number(row.basis_ask_qty),
      basisBidCount: Number(row.basis_bid_count), basisAskCount: Number(row.basis_ask_count),
      basisBidSubmissionTimestamp: Number(row.basis_bid_submission_timestamp),
      basisBidPublicationTimestamp: Number(row.basis_bid_publication_timestamp),
      basisAskSubmissionTimestamp: Number(row.basis_ask_submission_timestamp),
      basisAskPublicationTimestamp: Number(row.basis_ask_publication_timestamp),
      promotionGrade: row.promotion_grade === true,
    };
  }

  async claimDueReferenceMarkouts({ now, claimToken, leaseMs, batchSize }) {
    const result = await this._referenceQuery(`WITH candidates AS (
      SELECT work.fill_id, work.horizon_ms,
        COALESCE(work.decision_timestamp, decision.decision_timestamp) AS recovered_decision_timestamp,
        COALESCE(work.policy_id, decision.policy_id) AS recovered_policy_id
      FROM fill_reference_markout_work work
      LEFT JOIN LATERAL (
        SELECT decision_timestamp, policy_id FROM reference_quote_decisions
        WHERE session_id = work.session_id AND quote_id = work.quote_id
          AND decision_timestamp <= work.fill_timestamp
        ORDER BY decision_timestamp DESC LIMIT 1
      ) decision ON TRUE
      WHERE due_timestamp <= $1
        AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= $1))
      ORDER BY due_timestamp ASC, fill_id ASC, horizon_ms ASC
      LIMIT $2
      FOR UPDATE OF work SKIP LOCKED
    )
    UPDATE fill_reference_markout_work AS work
    SET state = 'claimed', claim_token = $3, claim_expires_at = $1 + $4,
        attempt_count = work.attempt_count + 1,
        decision_timestamp = candidates.recovered_decision_timestamp,
        policy_id = candidates.recovered_policy_id
    FROM candidates
    WHERE work.fill_id = candidates.fill_id AND work.horizon_ms = candidates.horizon_ms
    RETURNING work.*`, [now, batchSize, claimToken, leaseMs]);
    return (result.rows || []).map(row => ({
      fillId: row.fill_id, horizonMs: Number(row.horizon_ms), executionId: row.execution_id,
      quoteId: row.quote_id, sessionId: row.session_id, fillTimestamp: Number(row.fill_timestamp),
      decisionTimestamp: row.decision_timestamp === null ? null : Number(row.decision_timestamp),
      side: row.side, level: row.level, policyId: row.policy_id,
      price: row.fill_price === null ? null : Number(row.fill_price),
      size: row.fill_size === null ? null : Number(row.fill_size),
      dueTimestamp: Number(row.due_timestamp), deadlineTimestamp: Number(row.deadline_timestamp),
    }));
  }

  async hasOpenReferenceMarkoutWindow(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative safe integer');
    const result = await this._referenceQuery(`SELECT EXISTS (
      SELECT 1 FROM fill_reference_markout_work
      WHERE state <> 'completed' AND due_timestamp <= $1 AND deadline_timestamp >= $1
      LIMIT 1
    ) AS has_open_window`, [now]);
    return result.rows?.[0]?.has_open_window === true;
  }

  async releaseReferenceMarkoutClaim(work, claimToken, reason) {
    const result = await this._referenceQuery(`UPDATE fill_reference_markout_work
      SET state = 'pending', claim_token = NULL, claim_expires_at = NULL,
          last_unavailable_reason = $4
      WHERE fill_id = $1 AND horizon_ms = $2 AND state = 'claimed' AND claim_token = $3`,
    [work.fillId, work.horizonMs, claimToken, reason]);
    return (result.rowCount ?? 0) > 0;
  }

  async completeReferenceMarkout(work, claimToken, observation) {
    const values = [
      work.fillId, work.horizonMs, claimToken, observation.observationTimestamp,
      observation.product, observation.quoteCurrency, observation.sourceExchange,
      observation.sourceType, observation.sourceTimestamp, observation.receivedTimestamp,
      observation.bid, observation.ask, observation.midpoint, observation.basisTimestamp,
      observation.basisPrice, observation.basisAdjustmentBps, observation.adjustedMidpoint,
      observation.observedEdgeBps, observation.available, observation.unavailableReason,
      ...referenceBasisValues(observation), ...referenceDirectValues(observation),
    ];
    const provenancePlaceholders = REFERENCE_BASIS_COLUMNS.map((_, index) => `$${21 + index}`);
    const directPlaceholders = REFERENCE_DIRECT_COLUMNS.map((_, index) =>
      `$${21 + REFERENCE_BASIS_COLUMNS.length + index}`);
    const result = await this._referenceQuery(`WITH eligible AS (
      SELECT fill_id, horizon_ms FROM fill_reference_markout_work
      WHERE fill_id = $1 AND horizon_ms = $2 AND state = 'claimed' AND claim_token = $3
      FOR UPDATE
    ), inserted AS (
      INSERT INTO fill_reference_markout_evidence (
        fill_id, horizon_ms, observation_timestamp, product, quote_currency,
        source_exchange, source_type, source_timestamp, received_timestamp, bid, ask,
        midpoint, basis_timestamp, basis_price, basis_adjustment_bps, adjusted_midpoint,
        observed_edge_bps, available, unavailable_reason, ${REFERENCE_BASIS_COLUMNS.join(', ')},
        ${REFERENCE_DIRECT_COLUMNS.join(', ')}
      ) SELECT $1,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        ${provenancePlaceholders.join(',')},${directPlaceholders.join(',')}
        FROM eligible
      ON CONFLICT (fill_id, horizon_ms) DO NOTHING
    )
    UPDATE fill_reference_markout_work AS work
    SET state = 'completed', completed_at = $4, claim_token = NULL, claim_expires_at = NULL,
        last_unavailable_reason = $20
    FROM eligible
    WHERE work.fill_id = eligible.fill_id AND work.horizon_ms = eligible.horizon_ms
    RETURNING work.fill_id`, values);
    return (result.rowCount ?? 0) > 0;
  }

  async pruneReferenceMarkoutEvidence(cutoffTimestamp, batchSize = 1_000) {
    if (!Number.isFinite(cutoffTimestamp)) throw new Error('cutoffTimestamp must be finite');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('batchSize must be a positive safe integer at most 10000');
    }
    return this._referenceQuery(`WITH eligible AS MATERIALIZED (
      SELECT work.fill_id, work.horizon_ms
      FROM fill_reference_markout_work work
      WHERE work.state = 'completed' AND work.completed_at < $1
      ORDER BY work.completed_at, work.fill_id, work.horizon_ms
      LIMIT $2
    ), deleted_evidence AS (
      DELETE FROM fill_reference_markout_evidence evidence
      USING eligible
      WHERE evidence.fill_id = eligible.fill_id AND evidence.horizon_ms = eligible.horizon_ms
    ) DELETE FROM fill_reference_markout_work work
      USING eligible
      WHERE work.fill_id = eligible.fill_id AND work.horizon_ms = eligible.horizon_ms`,
    [cutoffTimestamp, batchSize]);
  }

  async pruneReferenceQuoteDecisions(cutoffTimestamp, batchSize = 1_000) {
    if (!Number.isFinite(cutoffTimestamp)) throw new Error('cutoffTimestamp must be finite');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('batchSize must be a positive safe integer at most 10000');
    }
    return this._referenceQuery(`WITH eligible AS MATERIALIZED (
      SELECT decision.ctid
      FROM reference_quote_decisions decision
      WHERE decision.decision_timestamp < $1
        AND NOT EXISTS (
          SELECT 1 FROM fill_reference_markout_work work
          WHERE work.session_id = decision.session_id
            AND work.quote_id = decision.quote_id
        )
      ORDER BY decision.decision_timestamp, decision.decision_id
      LIMIT $2
    ) DELETE FROM reference_quote_decisions decision
      USING eligible WHERE decision.ctid = eligible.ctid`, [cutoffTimestamp, batchSize]);
  }

  async pruneReferenceMarketObservations(cutoffTimestamp, batchSize = 1_000) {
    if (!Number.isFinite(cutoffTimestamp)) throw new Error('cutoffTimestamp must be finite');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('batchSize must be a positive safe integer at most 10000');
    }
    return this._referenceQuery(`WITH eligible AS MATERIALIZED (
      SELECT observation.ctid
      FROM reference_market_observations observation
      WHERE observation.received_timestamp < $1
        AND NOT EXISTS (
          SELECT 1 FROM fill_reference_markout_work work
          WHERE work.state <> 'completed'
            AND observation.observation_timestamp BETWEEN work.due_timestamp AND work.deadline_timestamp
        )
      ORDER BY observation.received_timestamp, observation.observation_timestamp, observation.observation_id
      LIMIT $2
    ) DELETE FROM reference_market_observations observation
      USING eligible WHERE observation.ctid = eligible.ctid`, [cutoffTimestamp, batchSize]);
  }

  async getReferenceMarkoutCoverage({ fromTimestamp, toTimestamp, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const result = await this._referenceQuery(`WITH attributed AS (
      SELECT work.*, evidence.fill_id AS evidence_fill_id, evidence.available AS evidence_available,
        evidence.promotion_grade AS evidence_promotion_grade,
        evidence.reference_mode AS evidence_reference_mode,
        evidence.source_exchange AS evidence_source_exchange,
        evidence.source_type AS evidence_source_type,
        evidence.source_instrument AS evidence_source_instrument,
        evidence.source_channel AS evidence_source_channel,
        evidence.source_endpoint AS evidence_source_endpoint,
        evidence.unavailable_reason AS evidence_unavailable_reason,
        work.quote_id IS NOT NULL AND work.session_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM reference_quote_decisions decision
          WHERE decision.quote_id = work.quote_id
            AND decision.session_id = work.session_id
            AND decision.decision_timestamp <= work.fill_timestamp
        ) AS has_quote_attribution
      FROM fill_reference_markout_work work
      LEFT JOIN fill_reference_markout_evidence evidence
        ON evidence.fill_id = work.fill_id AND evidence.horizon_ms = work.horizon_ms
      WHERE ($1::bigint IS NULL OR work.fill_timestamp >= $1)
        AND ($2::bigint IS NULL OR work.fill_timestamp <= $2)
    ), classified AS (
      SELECT side, level, policy_id, horizon_ms,
        CASE
          WHEN NOT has_quote_attribution THEN 'unavailable'
          WHEN evidence_fill_id IS NOT NULL AND evidence_available AND evidence_promotion_grade IS TRUE
            AND evidence_reference_mode = 'cryptocom-direct'
            AND evidence_source_exchange = 'cryptocom' AND evidence_source_type = 'public-ws-book'
            AND evidence_source_instrument = 'BTC_PYUSD'
            AND evidence_source_channel = 'book.BTC_PYUSD.10'
            AND evidence_source_endpoint = 'wss://stream.crypto.com/exchange/v1/market'
            THEN 'promotion-grade'
          WHEN evidence_fill_id IS NOT NULL AND evidence_available THEN 'non-promotion-grade'
          WHEN evidence_fill_id IS NOT NULL THEN 'unavailable'
          WHEN state = 'claimed' THEN 'claimed'
          ELSE 'pending'
        END AS availability_status,
        CASE
          WHEN NOT has_quote_attribution THEN 'missing-quote-attribution'
          WHEN evidence_fill_id IS NOT NULL AND evidence_available AND evidence_promotion_grade IS TRUE
            AND evidence_reference_mode = 'cryptocom-direct'
            AND evidence_source_exchange = 'cryptocom' AND evidence_source_type = 'public-ws-book'
            AND evidence_source_instrument = 'BTC_PYUSD'
            AND evidence_source_channel = 'book.BTC_PYUSD.10'
            AND evidence_source_endpoint = 'wss://stream.crypto.com/exchange/v1/market'
            THEN 'promotion-grade'
          WHEN evidence_fill_id IS NOT NULL AND evidence_available
            THEN 'legacy-missing-basis-provenance'
          WHEN evidence_fill_id IS NOT NULL THEN COALESCE(evidence_unavailable_reason, 'unavailable-unspecified')
          WHEN last_unavailable_reason IS NOT NULL THEN last_unavailable_reason
          WHEN state = 'claimed' THEN 'claim-in-progress'
          ELSE 'awaiting-horizon'
        END AS availability_reason
      FROM attributed
    ) SELECT side, level, policy_id, horizon_ms, availability_status,
      availability_reason, COUNT(*)::bigint AS observation_count
      FROM classified
      GROUP BY side, level, policy_id, horizon_ms, availability_status, availability_reason
      ORDER BY side, level, policy_id, horizon_ms, availability_status, availability_reason
      LIMIT $3`, [fromTimestamp ?? null, toTimestamp ?? null, boundedLimit + 1]);
    const rows = result.rows || [];
    return {
      groups: rows.slice(0, boundedLimit),
      truncated: rows.length > boundedLimit,
      limit: boundedLimit,
    };
  }
  
  /**
   * Migrate data from Redis to PostgreSQL
   */
  async migrateFromRedis(redisManager, sessionId) {
    const results = {
      sessions: { success: 0, failed: 0 },
      orders: { success: 0, failed: 0 },
      fills: { success: 0, failed: 0, skipped: 0 },
      ohlc: { success: 0, failed: 0 }
    };
    
    const lockB = this.hashStringToInt32(`truex:${sessionId}:migration`);
    return this.withAdvisoryLock(this.migrationLockA, lockB, async () => {
      try {
        this.logger.info(`[TrueXPostgreSQLManager] Starting migration for session ${sessionId}`);
        
        // 1. Migrate session data
        const sessionResult = await this.migrateSession(redisManager, sessionId);
        results.sessions = sessionResult;
        
        // 2. Migrate orders with enhanced data preservation
        const ordersResult = await this.migrateOrders(redisManager, sessionId);
        results.orders = ordersResult;
        
        // 3. Migrate fills with deduplication
        const fillsResult = await this.migrateFills(redisManager, sessionId);
        results.fills = fillsResult;
        
        // 4. Migrate OHLC data
        const ohlcResult = await this.migrateOHLC(redisManager, sessionId);
        results.ohlc = ohlcResult;
        
        // 5. Mark session as migrated only if all parts succeeded without failures
        const totalFailed = (results.sessions.failed || 0)
          + (results.orders.failed || 0)
          + (results.fills.failed || 0)
          + (results.ohlc.failed || 0);
        if (totalFailed === 0) {
          await this.db.migration.markSessionAsMigrated(sessionId);
        } else {
          const err = new Error(`Partial migration detected (failed=${totalFailed}). Session will not be marked as migrated.`);
          err.migrationResults = results;
          throw err;
        }
        
        this.stats.lastMigrationTime = Date.now();
        this.logger.info(`[TrueXPostgreSQLManager] Migration completed:`, results);
        
        return results;
      } catch (error) {
        this.logger.error(`[TrueXPostgreSQLManager] Migration failed: ${error.message}`);
        this.stats.migrationErrors++;
        throw error;
      }
    }, { timeoutMs: 60000 });
  }

  /**
   * Acquire an advisory lock and run the provided async function, releasing the lock afterward.
   * Retries for up to timeoutMs if lock cannot be acquired immediately.
   */
  async withAdvisoryLock(lockA, lockB, fn, { timeoutMs = 15000, retryDelayMs = 250 } = {}) {
    const acquired = await this.tryAcquireLock(lockA, lockB, { timeoutMs, retryDelayMs });
    if (!acquired) {
      throw new Error(`Could not acquire advisory lock (${lockA}, ${lockB}) within ${timeoutMs}ms`);
    }
    try {
      return await fn();
    } finally {
      await this.releaseLock(lockA, lockB);
    }
  }

  async tryAcquireLock(lockA, lockB, { timeoutMs = 15000, retryDelayMs = 250 } = {}) {
    const start = Date.now();
    while (true) {
      const res = await this.db.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [lockA, lockB]);
      const locked = res?.rows?.[0]?.locked === true;
      if (locked) return true;
      if ((Date.now() - start) >= timeoutMs) return false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  async releaseLock(lockA, lockB) {
    try {
      await this.db.query('SELECT pg_advisory_unlock($1, $2)', [lockA, lockB]);
    } catch (e) {
      this.logger.warn(`[TrueXPostgreSQLManager] Failed to release advisory lock (${lockA}, ${lockB}): ${e.message}`);
    }
  }

  // Simple 32-bit hash for strings (deterministic per sessionId), for advisory lock key B
  hashStringToInt32(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0; // Convert to 32-bit integer
    }
    // Ensure non-negative by flipping sign bit if needed
    if (hash < 0) hash = Math.abs(hash);
    return hash;
  }
  
  /**
   * Migrate session data
   */
  async migrateSession(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      const sessionData = await redisManager.sessionManager.get();
      
      if (sessionData) {
        const session = {
          id: sessionId,
          sessionid: sessionId,
          ...sessionData,
          data: sessionData,  // Preserve complete Redis data
          last_updated: Date.now()
        };
        
        const saveResult = await this.db.bulk.sessions.save([session]);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        this.stats.sessionsMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Session migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate orders with FIX data preservation
   */
  async migrateOrders(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      const orders = await redisManager.getAllOrders();
      
      if (orders && orders.length > 0) {
        const enhancedOrders = orders.map(order => ({
          ...order,
          id: order.orderId,
          orderid: order.orderId,
          sessionid: sessionId,
          msg_seq_num: order.msgSeqNum,
          exec_reports: order.execReports || [],
          data: {
            // Store complete original Redis order
            originalRedisOrder: { ...order },
            
            // Migration metadata
            dataMigrationVersion: '1.2.0',
            dataMigratedAt: Date.now(),
            dataPreserved: true,
            
            // Preserve FIX-specific fields
            fixProtocolData: order.data?.allFIXMessages || [],
            execReports: order.execReports || [],
            truexMetadata: order.data?.truexMetadata
          }
        }));
        
        const saveResult = await this.db.bulk.orders.save(enhancedOrders);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        this.stats.ordersMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Orders migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate fills with deduplication
   */
  async migrateFills(redisManager, sessionId) {
    const results = { success: 0, failed: 0, skipped: 0 };
    
    try {
      const fills = await redisManager.getAllFills();
      
      if (fills && fills.length > 0) {
        const enhancedFills = fills.map(fill => ({
          ...fill,
          id: fill.fillId,
          fillid: fill.fillId,
          sessionid: sessionId,
          execid: fill.execID,
          orderid: fill.orderId,
          deduplication_key: fill.deduplicationKey || `${sessionId}_${fill.execID}`,
          data: {
            executionReport: fill.data?.executionReport,
            originalFIXMessage: fill.data?.originalFIXMessage,
            dataMigrationVersion: '1.2.0',
            dataMigratedAt: Date.now()
          }
        }));
        
        const saveResult = await this.db.bulk.fills.save(enhancedFills);
        results.success += saveResult.success || 0;
        results.failed += saveResult.failed || 0;
        results.skipped += saveResult.skipped || 0;
        this.stats.fillsMigrated += saveResult.success || 0;
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Fills migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Migrate OHLC data
   */
  async migrateOHLC(redisManager, sessionId) {
    const results = { success: 0, failed: 0 };
    
    try {
      // Get OHLC candles from Redis (assuming 1m interval for now)
      const candles = await redisManager.getOHLCCandles('1m');
      
      if (candles && candles.length > 0) {
        for (const candle of candles) {
          try {
            await this.db.query(`
              INSERT INTO ohlc (
                symbol, exchange, interval, timestamp,
                open, high, low, close, volume,
                source, trade_count, is_complete, data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (symbol, exchange, interval, timestamp) DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close = EXCLUDED.close,
                volume = EXCLUDED.volume,
                is_complete = EXCLUDED.is_complete,
                data = EXCLUDED.data
            `, [
              candle.symbol,
              candle.exchange || 'truex',
              candle.interval,
              candle.timestamp,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.volume,
              candle.source,
              candle.tradeCount || 0,
              candle.isComplete || false,
              JSON.stringify(candle.data || {})
            ]);
            
            results.success++;
            this.stats.ohlcMigrated++;
          } catch (error) {
            this.logger.error(`[TrueXPostgreSQLManager] OHLC candle migration failed: ${error.message}`);
            results.failed++;
          }
        }
      }
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] OHLC migration failed: ${error.message}`);
      results.failed++;
    }
    
    return results;
  }
  
  /**
   * Get OHLC candles for analysis
   */
  async getOHLCCandles(symbol, interval, startTime, endTime) {
    try {
      let query = `
        SELECT * FROM ohlc 
        WHERE symbol = $1 AND interval = $2
      `;
      const params = [symbol, interval];
      
      if (startTime) {
        query += ` AND timestamp >= $${params.length + 1}`;
        params.push(startTime);
      }
      
      if (endTime) {
        query += ` AND timestamp <= $${params.length + 1}`;
        params.push(endTime);
      }
      
      query += ` ORDER BY timestamp ASC`;
      
      const result = await this.db.query(query, params);
      return result.rows;
    } catch (error) {
      this.logger.error(`[TrueXPostgreSQLManager] Failed to get OHLC candles: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      dbStats: this.db.getStats()
    };
  }
  
  /**
   * Close PostgreSQL connection
   */
  async close() {
    await this.db.close();
    this.logger.info('[TrueXPostgreSQLManager] PostgreSQL connection closed');
  }
}
