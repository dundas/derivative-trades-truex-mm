import { describe, it, expect, jest, beforeEach, mock } from 'bun:test';

// Mock PostgreSQL API
const mockDb = {
  initialize: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (/pg_try_advisory_lock/i.test(text)) {
      return { rows: [{ locked: true }] };
    }
    if (/pg_advisory_unlock/i.test(text)) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    // Default simulate success for DDL/DML queries
    return { rows: [] };
  }),
  boundedQuery: jest.fn().mockResolvedValue({ rows: [] }),
  bulk: {
    sessions: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0 })
    },
    orders: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0 })
    },
    fills: {
      save: jest.fn().mockResolvedValue({ success: 1, failed: 0, skipped: 0 })
    }
  },
  migration: {
    markSessionAsMigrated: jest.fn().mockResolvedValue(true)
  },
  getStats: jest.fn().mockReturnValue({ totalConnections: 5 }),
  close: jest.fn().mockResolvedValue(true)
};
let lastPostgreSQLConfig = null;

mock.module('../../lib/postgresql-api/index.js', () => ({
  PostgreSQLAPI: class PostgreSQLAPI {
    constructor(config) { lastPostgreSQLConfig = config; return mockDb; }
  },
  createPostgreSQLAPIFromEnv: jest.fn(() => mockDb)
}));

// Import after mocking
const { TrueXPostgreSQLManager } = await import('./truex-postgresql-manager.js');

describe('TrueXPostgreSQLManager', () => {
  let pgManager;
  let mockLogger;
  let mockRedisManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    lastPostgreSQLConfig = null;
    
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    mockRedisManager = {
      sessionManager: {
        get: jest.fn().mockResolvedValue({
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          status: 'active'
        })
      },
      getAllOrders: jest.fn().mockResolvedValue([]),
      getAllFills: jest.fn().mockResolvedValue([]),
      getOHLCCandles: jest.fn().mockResolvedValue([])
    };
    
    pgManager = new TrueXPostgreSQLManager({
      db: mockDb,
      logger: mockLogger
    });
  });
  
  describe('Constructor', () => {
    it('should initialize with provided db', () => {
      expect(pgManager.db).toBe(mockDb);
      expect(pgManager.logger).toBe(mockLogger);
    });
    
    it('should initialize stats', () => {
      const stats = pgManager.getStats();
      expect(stats.sessionsMigrated).toBe(0);
      expect(stats.ordersMigrated).toBe(0);
      expect(stats.fillsMigrated).toBe(0);
      expect(stats.ohlcMigrated).toBe(0);
    });

    it('propagates an operator-supplied TLS CA to the PostgreSQL adapter', () => {
      const manager = new TrueXPostgreSQLManager({
        pgUrl: 'postgresql://db.example.com/app', sslCa: 'trusted-ca', logger: mockLogger,
      });
      expect(manager.db).toBe(mockDb);
      expect(lastPostgreSQLConfig).toMatchObject({
        connectionString: 'postgresql://db.example.com/app', sslCa: 'trusted-ca',
      });
    });

    it('routes reference persistence through the bounded database contract', async () => {
      const options = { lockTimeoutMs: 100, statementTimeoutMs: 500, queryTimeoutMs: 750 };
      const bounded = new TrueXPostgreSQLManager({
        db: mockDb, logger: mockLogger, referenceQueryOptions: options,
      });
      await bounded.hasOpenReferenceMarkoutWindow(1_000);
      expect(mockDb.boundedQuery).toHaveBeenCalledWith(
        expect.stringContaining('fill_reference_markout_work'), [1_000], options,
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });
  
  describe('initialize()', () => {
    it('should initialize PostgreSQL connection', async () => {
      await pgManager.initialize();
      
      expect(mockDb.initialize).toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalled(); // Schema setup queries
    });

    it('adds immutable quote lifecycle storage without altering orders or fills', async () => {
      await pgManager.initialize();
      const sql = mockDb.query.mock.calls.map(([query]) => String(query)).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS quote_lifecycle_events');
      expect(sql).toContain('idx_quote_lifecycle_quote_ts');
      expect(sql).not.toContain('ALTER TABLE fills ADD COLUMN');
    });

    it('adds restart-safe reference decision, work, and immutable evidence storage', async () => {
      await pgManager.initialize();
      const sql = mockDb.query.mock.calls.map(([query]) => String(query)).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS reference_quote_decisions');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS reference_market_observations');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS fill_reference_markout_work');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS fill_reference_markout_evidence');
      expect(sql).toContain("CHECK (state IN ('pending', 'claimed', 'completed'))");
      expect(sql).toContain('idx_reference_markout_due');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v2');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_reference_market_selector_v3');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS basis_bid_publication_timestamp BIGINT');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS basis_bid_submission_timestamp BIGINT');
      expect(sql).not.toContain('basis_bid_submission_timestamp BIGINT NOT NULL');
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS promotion_grade BOOLEAN');
      expect(sql).toContain('(product, quote_currency, source_exchange, source_type, observation_timestamp');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_reference_market_retention_v3');
      expect(sql).toContain('(received_timestamp, observation_timestamp, observation_id)');
      expect(sql).toContain('reference_market_observations ALTER COLUMN basis_timestamp DROP NOT NULL');
      expect(sql).toContain('reference_market_observations ALTER COLUMN basis_price DROP NOT NULL');
      expect(sql).not.toContain('basis_timestamp BIGINT NOT NULL');
      expect(sql).not.toContain('basis_price NUMERIC NOT NULL');
      expect(sql).toContain('idx_reference_decision_retention_v3');
      expect(sql).toContain('(decision_timestamp, decision_id, session_id, quote_id)');
      expect(sql).toContain('idx_reference_markout_retention_v2');
      expect(sql).toContain('(completed_at, fill_id, horizon_ms)');
      expect(sql).toContain('idx_reference_markout_attribution_v3');
      expect(sql).toContain('ON fill_reference_markout_work(session_id, quote_id)');
      expect(sql).toContain('DROP INDEX IF EXISTS idx_reference_markout_pending_attribution_v2');
      expect(sql).not.toMatch(/UPDATE\s+(reference_market_observations|fill_reference_markout_evidence)/i);
    });
    
    it('should create TrueX-specific schema', async () => {
      await pgManager.initialize();
      
      // Check that schema queries were executed
      const queryCalls = mockDb.query.mock.calls;
      const queries = queryCalls.map(call => call[0]);
      
      expect(queries.some(q => q.includes('ALTER TABLE orders'))).toBe(true);
      expect(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS ohlc'))).toBe(true);
    });
    
    it('should handle initialization errors', async () => {
      mockDb.initialize.mockRejectedValueOnce(new Error('Connection failed'));
      
      await expect(pgManager.initialize()).rejects.toThrow('Connection failed');
    });
  });

  describe('quote lifecycle persistence', () => {
    const event = {
      eventId: 'event-1', schemaVersion: '1.0', eventType: 'create', timestamp: 1000,
      decisionTimestamp: 999, sessionId: 's-1', quoteId: 'Q-1', orderId: 'Q-1',
      symbol: 'BTC-PYUSD', side: 'buy', price: 100, size: 0.1, level: 1,
      action: 'place', policyId: 'default', context: { fairValue: 101 },
    };

    it('persists events append-only and offers bounded query/prune helpers', async () => {
      await pgManager.recordQuoteLifecycleEvent(event);
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO quote_lifecycle_events'), expect.arrayContaining(['event-1', '1.0']));
      await pgManager.getQuoteLifecycleEvents({ sessionId: 's-1', quoteId: 'Q-1', limit: 10 });
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM quote_lifecycle_events'), ['s-1', 'Q-1', 10]);
      await pgManager.pruneQuoteLifecycleEventsBefore(500);
      expect(mockDb.query).toHaveBeenCalledWith('DELETE FROM quote_lifecycle_events WHERE event_timestamp < $1', [500]);
    });

    it('surfaces persistence errors for the telemetry caller to handle', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('isolated db unavailable'));
      await expect(pgManager.recordQuoteLifecycleEvent(event)).rejects.toThrow('isolated db unavailable');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('quote telemetry write failed'));
    });
  });

  describe('reference mark-out persistence', () => {
    const decision = {
      eventId: 'event-1', decisionTimestamp: 1000, sessionId: 's-1', quoteId: 'Q-1',
      symbol: 'BTC-PYUSD', side: 'buy', level: 1, policyId: 'maker-v1', price: 100,
      size: 0.1, product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
      sourceType: 'top-of-book', sourceTimestamp: 990, receivedTimestamp: 995,
      bid: 99, ask: 101, midpoint: 100, basisTimestamp: 990, basisPrice: 1,
      basisAdjustmentBps: 0, available: true, unavailableReason: null,
      basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
      basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
      basisVenue: 'PDSL', basisSystem: 'CLOB', basisRequestTimestamp: 970,
      basisReceivedTimestamp: 995, basisBid: 0.9999, basisAsk: 1.0001,
      basisBidQty: 10, basisAskQty: 11, basisBidCount: 1, basisAskCount: 2,
      basisBidSubmissionTimestamp: 980, basisBidPublicationTimestamp: 990,
      basisAskSubmissionTimestamp: 981, basisAskPublicationTimestamp: 991,
      promotionGrade: true,
    };

    it('stores decisions and schedules every horizon idempotently', async () => {
      await pgManager.recordReferenceQuoteDecision(decision);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (decision_id) DO NOTHING'),
        expect.arrayContaining(['event-1', 'Q-1', 'BTC-USD']),
      );
      await pgManager.scheduleReferenceMarkouts({
        fillId: 'F-1', executionId: 'E-1', quoteId: 'Q-1', sessionId: 's-1',
        fillTimestamp: 2000, decisionTimestamp: 1000, side: 'buy', level: 1,
        policyId: 'maker-v1', price: 100, size: 0.1, product: 'BTC-USD',
        quoteCurrency: 'USD', sourceExchange: 'coinbase', sourceType: 'top-of-book',
        horizonsMs: [60_000, 300_000], dueTimestamps: [62_000, 302_000],
        deadlineTimestamps: [92_000, 332_000],
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (fill_id, horizon_ms) DO NOTHING'),
        expect.arrayContaining([[60_000, 300_000], [62_000, 302_000]]),
      );
    });

    it('claims due work atomically with expired-lease recovery and skip-locked overlap safety', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{
        fill_id: 'F-1', horizon_ms: '60000', fill_timestamp: '2000', due_timestamp: '62000',
        deadline_timestamp: '92000', fill_price: '100', fill_size: '0.1', level: 1,
        has_quote_attribution: true,
      }] });
      const rows = await pgManager.claimDueReferenceMarkouts({
        now: 62_001, claimToken: 'owner-1', leaseMs: 5000, batchSize: 10,
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/session_id = work\.session_id[\s\S]*FOR UPDATE OF work SKIP LOCKED[\s\S]*state = 'claimed'[\s\S]*RETURNING work\.\*, candidates\.has_quote_attribution/),
        [62_001, 10, 'owner-1', 5000],
      );
      expect(rows[0]).toMatchObject({ fillId: 'F-1', horizonMs: 60_000, dueTimestamp: 62_000,
        hasQuoteAttribution: true });
    });

    it('checks an indexed unfinished window without mutating work', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ has_open_window: true }] });
      await expect(pgManager.hasOpenReferenceMarkoutWindow(1_000)).resolves.toBe(true);
      const [sql, values] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain("state <> 'completed'");
      expect(sql).toContain('due_timestamp <= $1');
      expect(sql).toContain('deadline_timestamp >= $1');
      expect(sql).not.toContain('UPDATE');
      expect(values).toEqual([1_000]);
    });

    it('checks whether a named policy has unresolved markouts without mutating work', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ has_unresolved_markouts: true }] });
      await expect(pgManager.hasUnresolvedReferenceMarkouts({
        policyId: 'minimal-live-canary-v1', horizonMs: 60_000,
      })).resolves.toBe(true);
      const [sql, values] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain("state <> 'completed'");
      expect(sql).toContain('policy_id = $1');
      expect(sql).toContain('horizon_ms = $2');
      expect(sql).not.toContain('UPDATE');
      expect(values).toEqual(['minimal-live-canary-v1', 60_000]);
    });

    it('claims each operator canary run ID at most once', async () => {
      mockDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ run_id: 'canary-run-0001' }] });
      await expect(pgManager.claimMinimalLiveCanaryRun({
        runId: 'canary-run-0001', sessionId: 'session-1', claimedAt: 1_000,
      })).resolves.toBe(true);
      const [sql, values] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain('minimal_live_canary_runs');
      expect(sql).toContain('ON CONFLICT (run_id) DO NOTHING');
      expect(values).toEqual(['canary-run-0001', 'session-1', 1_000]);
    });

    it('persists immutable market samples and selects the earliest sample in the due window', async () => {
      await pgManager.recordReferenceMarketObservation({ ...decision, observationTimestamp: 995 });
      const firstObservationId = mockDb.query.mock.calls.at(-1)[1][0];
      await pgManager.recordReferenceMarketObservation({ ...decision, observationTimestamp: 996 });
      const secondObservationId = mockDb.query.mock.calls.at(-1)[1][0];
      expect(firstObservationId).not.toBe(secondObservationId);
      await pgManager.recordReferenceMarketObservation({
        ...decision, observationTimestamp: 997, basisBidQty: 10,
      });
      const firstBookIdentity = mockDb.query.mock.calls.at(-1)[1][0];
      await pgManager.recordReferenceMarketObservation({
        ...decision, observationTimestamp: 997, basisBidQty: 12,
      });
      expect(mockDb.query.mock.calls.at(-1)[1][0]).not.toBe(firstBookIdentity);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (observation_id) DO NOTHING'),
        expect.arrayContaining(['BTC-USD', 990, 995]),
      );
      mockDb.query.mockResolvedValueOnce({ rows: [{
        observation_timestamp: '995', product: 'BTC-USD', quote_currency: 'USD',
        source_exchange: 'coinbase', source_type: 'top-of-book', source_timestamp: '990',
        received_timestamp: '995', bid: '99', ask: '101', midpoint: '100',
        basis_timestamp: '990', basis_price: '1', basis_adjustment_bps: '0',
        basis_source: 'kraken-pretrade', basis_requested_pair: 'PYUSD/USD',
        basis_resolved_pair: 'PYUSD/USD', basis_base: 'PYUSD', basis_quote: 'USD',
        basis_venue: 'PDSL', basis_system: 'CLOB', basis_request_timestamp: '970',
        basis_received_timestamp: '995', basis_bid: '0.9999', basis_ask: '1.0001',
        basis_bid_qty: '10', basis_ask_qty: '11', basis_bid_count: 1, basis_ask_count: 2,
        basis_bid_submission_timestamp: '980', basis_bid_publication_timestamp: '990',
        basis_ask_submission_timestamp: '981', basis_ask_publication_timestamp: '991',
        promotion_grade: true,
      }] });
      const sample = await pgManager.getFirstReferenceMarketObservation({
        dueTimestamp: 980, deadlineTimestamp: 1000, product: 'BTC-USD',
        quoteCurrency: 'USD', sourceExchange: 'coinbase', sourceType: 'top-of-book',
        maxSourceAgeMs: 100, maxAbsBasisAdjustmentBps: 25,
        basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
        basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
        basisSystem: 'CLOB', basisVenueAllowlist: ['PDSL'], maxBasisRttMs: 50,
      });
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/basis_bid_submission_timestamp >= 0[\s\S]*basis_ask_submission_timestamp >= 0[\s\S]*basis_source = \$9[\s\S]*basis_venue = ANY\(\$15::text\[\]\)[\s\S]*promotion_grade IS TRUE[\s\S]*basis_received_timestamp - basis_request_timestamp <= \$16[\s\S]*basis_timestamp = LEAST[\s\S]*basis_price - \(\(basis_bid \+ basis_ask\) \/ 2\)/),
        ['BTC-USD', 'USD', 'coinbase', 'top-of-book', 980, 1000, 100, 25,
          'kraken-pretrade', 'PYUSD/USD', 'PYUSD/USD', 'PYUSD', 'USD', 'CLOB', ['PDSL'], 50],
      );
      expect(sample).toMatchObject({ available: true, promotionGrade: true,
        sourceTimestamp: 990, receivedTimestamp: 995, basisVenue: 'PDSL' });
    });

    it('persists publication-only diagnostic provenance without promoting it', async () => {
      const diagnostic = {
        ...decision, available: false,
        unavailableReason: 'missing-basis-submission-provenance', promotionGrade: false,
        basisBidSubmissionTimestamp: null, basisAskSubmissionTimestamp: null,
      };
      const expectedProvenance = [
        'kraken-pretrade', 'PYUSD/USD', 'PYUSD/USD', 'PYUSD', 'USD', 'PDSL', 'CLOB',
        970, 995, 0.9999, 1.0001, 10, 11, 1, 2, null, 990, null, 991, false,
      ];

      await pgManager.recordReferenceQuoteDecision(diagnostic);
      expect(mockDb.query.mock.calls.at(-1)[1].slice(-34, -14)).toEqual(expectedProvenance);

      await pgManager.recordReferenceMarketObservation({
        ...diagnostic, observationTimestamp: 1000,
      });
      expect(mockDb.query.mock.calls.at(-1)[1].slice(-34, -14)).toEqual(expectedProvenance);

      await pgManager.completeReferenceMarkout(
        { fillId: 'F-diagnostic', horizonMs: 60_000 }, 'owner-diagnostic',
        { ...diagnostic, observationTimestamp: 62_001 },
      );
      const [sql, values] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain('promotion_grade');
      expect(values.slice(-34, -14)).toEqual(expectedProvenance);
    });

    it('persists and selects only complete direct Crypto.com provenance', async () => {
      const direct = { ...decision, referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD',
        quoteCurrency: 'PYUSD', sourceExchange: 'cryptocom', sourceType: 'public-ws-book',
        sourceInstrument: 'BTC_PYUSD', sourceChannel: 'book.BTC_PYUSD.10',
        sourceSequence: 41, sourceGeneration: 2, sourceSessionId: 'session-123',
        sourceEndpoint: 'wss://stream.crypto.com/exchange/v1/market',
        sourceBookHash: 'a'.repeat(64), sourceDepth: 10, sourceBidQty: 2, sourceAskQty: 3,
        sourceBidCount: 1, sourceAskCount: 1, sourceBookUpdateTimestamp: 900,
        basisTimestamp: null, basisPrice: null, basisAdjustmentBps: 0, promotionGrade: true,
        observationTimestamp: 1000 };
      await pgManager.recordReferenceMarketObservation(direct);
      expect(mockDb.query.mock.calls.at(-1)[1].slice(-14)).toEqual([
        'cryptocom-direct', 'BTC_PYUSD', 'book.BTC_PYUSD.10', 41, 2, 'session-123',
        'wss://stream.crypto.com/exchange/v1/market', 'a'.repeat(64), 10, 2, 3, 1, 1, 900,
      ]);
      await pgManager.recordReferenceMarketObservation({ ...direct, referenceMode: undefined });
      expect(mockDb.query.mock.calls.at(-1)[1].slice(-14)).toEqual(Array(14).fill(null));
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      await pgManager.getFirstReferenceMarketObservation({ referenceMode: 'cryptocom-direct',
        dueTimestamp: 900, deadlineTimestamp: 1100, product: 'BTC-PYUSD',
        quoteCurrency: 'PYUSD', sourceExchange: 'cryptocom', sourceType: 'public-ws-book',
        maxSourceAgeMs: 5000, sourceInstrument: 'BTC_PYUSD',
        sourceChannel: 'book.BTC_PYUSD.10',
        sourceEndpointAllowlist: ['wss://stream.crypto.com/exchange/v1/market'] });
      const [sql, values] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain("reference_mode = 'cryptocom-direct'");
      expect(sql).toContain('source_endpoint = ANY($10::text[])');
      expect(sql).toContain("source_book_hash ~ '^[a-f0-9]{64}$'");
      expect(sql).toContain('observation_timestamp - source_timestamp <= $7');
      expect(sql).toContain('promotion_grade IS TRUE');
      expect(sql).not.toContain('basis_source =');
      expect(values.at(-1)).toEqual(['wss://stream.crypto.com/exchange/v1/market']);

      await pgManager.completeReferenceMarkout({ fillId: 'F-direct', horizonMs: 60_000 },
        'owner-direct', { ...direct, adjustedMidpoint: 100, observedEdgeBps: 100 });
      const [completionSql, completionValues] = mockDb.query.mock.calls.at(-1);
      expect(completionSql).toContain('INSERT INTO fill_reference_markout_evidence');
      expect(completionValues).toEqual(expect.arrayContaining([
        'F-direct', 60_000, null, 100, 100,
      ]));
    });

    it('binds release and terminal evidence completion to the claim owner', async () => {
      await pgManager.releaseReferenceMarkoutClaim({ fillId: 'F-1', horizonMs: 60_000 }, 'owner-1', 'before-due');
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining("state = 'claimed' AND claim_token = $3"),
        ['F-1', 60_000, 'owner-1', 'before-due'],
      );
      await pgManager.completeReferenceMarkout(
        { fillId: 'F-1', horizonMs: 60_000 }, 'owner-1',
        { ...decision, observationTimestamp: 62_001 },
      );
      const sql = String(mockDb.query.mock.calls.at(-1)[0]);
      expect(sql).toContain('INSERT INTO fill_reference_markout_evidence');
      expect(sql).toContain("state = 'claimed' AND claim_token = $3");
      expect(sql).toContain("SET state = 'completed'");
    });

    it('retains quote decisions while completed evidence remains and returns a bounded grouped coverage audit', async () => {
      await pgManager.pruneReferenceMarkoutEvidence(1000, 250);
      const pruneSql = String(mockDb.query.mock.calls.at(-1)[0]);
      expect(pruneSql).toContain("work.state = 'completed'");
      expect(pruneSql).toContain('LIMIT $2');
      expect(mockDb.query).toHaveBeenLastCalledWith(expect.any(String), [1000, 250]);
      await pgManager.pruneReferenceQuoteDecisions(1000, 250);
      const decisionPruneSql = String(mockDb.query.mock.calls.at(-1)[0]);
      expect(decisionPruneSql).toContain('WHERE work.session_id = decision.session_id');
      expect(decisionPruneSql).toContain('AND work.quote_id = decision.quote_id');
      expect(decisionPruneSql).not.toContain("work.state <> 'completed'");
      expect(decisionPruneSql).toContain('LIMIT $2');
      await pgManager.pruneReferenceMarketObservations(1000, 250);
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/work\.state <> 'completed'[\s\S]*observation\.observation_timestamp BETWEEN work\.due_timestamp AND work\.deadline_timestamp[\s\S]*LIMIT \$2/),
        [1000, 250],
      );
      await expect(pgManager.pruneReferenceMarkoutEvidence(1000, 0)).rejects.toThrow('batchSize');
      const audit = await pgManager.getReferenceMarkoutCoverage({ fromTimestamp: 1, toTimestamp: 2, limit: 5000 });
      expect(mockDb.query).toHaveBeenLastCalledWith(expect.stringContaining('availability_reason'), [1, 2, 1001]);
      expect(String(mockDb.query.mock.calls.at(-1)[0])).toContain('legacy-missing-basis-provenance');
      expect(String(mockDb.query.mock.calls.at(-1)[0]))
        .toContain("evidence_source_endpoint = 'wss://stream.crypto.com/exchange/v1/market'");
      expect(audit).toEqual({ groups: [], truncated: false, limit: 1000 });
    });

    it('classifies missing quote attribution explicitly without expanding the audit bound', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{
        side: 'buy', level: 1, policy_id: 'maker-v1', horizon_ms: '60000',
        availability_status: 'unavailable', availability_reason: 'missing-quote-attribution',
        observation_count: '2',
      }] });

      const audit = await pgManager.getReferenceMarkoutCoverage({ limit: 1 });
      const [sql, params] = mockDb.query.mock.calls.at(-1);
      expect(sql).toContain("THEN 'missing-quote-attribution'");
      expect(sql).toContain('AS has_quote_attribution');
      expect(sql.match(/AS has_quote_attribution/g)).toHaveLength(1);
      expect(sql).toContain('FROM reference_quote_decisions decision');
      expect(sql).toContain('GROUP BY side, level, policy_id, horizon_ms, availability_status, availability_reason');
      expect(sql).toContain('LIMIT $3');
      expect(params).toEqual([null, null, 2]);
      expect(audit).toEqual({
        groups: [expect.objectContaining({ availability_reason: 'missing-quote-attribution' })],
        truncated: false,
        limit: 1,
      });
    });
  });
  
  describe('migrateFromRedis()', () => {
    beforeEach(async () => {
      await pgManager.initialize();
      jest.clearAllMocks();
    });
    
    it('should migrate all data types', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      mockRedisManager.getAllFills.mockResolvedValue([
        { fillId: 'fill-1', execID: 'EXEC-1', orderId: 'order-1', sessionId: 'session-123' }
      ]);
      mockRedisManager.getOHLCCandles.mockResolvedValue([
        { symbol: 'BTC/USD', interval: '1m', timestamp: Date.now(), open: 50000, close: 50050 }
      ]);
      
      const results = await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      expect(results.sessions.success).toBe(1);
      expect(results.orders.success).toBe(1);
      expect(results.fills.success).toBe(1);
      expect(results.ohlc.success).toBe(1);
      expect(mockDb.migration.markSessionAsMigrated).toHaveBeenCalledWith('session-123');
    });
    
    it('should preserve FIX message data in orders', async () => {
      const order = {
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        msgSeqNum: 5,
        execReports: [{ execID: 'EXEC-1' }],
        data: {
          allFIXMessages: ['msg1', 'msg2'],
          truexMetadata: { senderCompID: 'CLI_CLIENT' }
        }
      };
      
      mockRedisManager.getAllOrders.mockResolvedValue([order]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const savedOrders = mockDb.bulk.orders.save.mock.calls[0][0];
      expect(savedOrders[0].msg_seq_num).toBe(5);
      expect(savedOrders[0].exec_reports).toHaveLength(1);
      expect(savedOrders[0].data.fixProtocolData).toHaveLength(2);
      expect(savedOrders[0].data.dataMigrationVersion).toBe('1.2.0');
    });
    
    it('should set deduplication keys for fills', async () => {
      const fill = {
        fillId: 'fill-1',
        execID: 'EXEC-1',
        orderId: 'order-1',
        sessionId: 'session-123',
        symbol: 'BTC/USD'
      };
      
      mockRedisManager.getAllFills.mockResolvedValue([fill]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const savedFills = mockDb.bulk.fills.save.mock.calls[0][0];
      expect(savedFills[0].deduplication_key).toBe('session-123_EXEC-1');
    });
    
    it('should handle empty data gracefully', async () => {
      const results = await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      expect(results.sessions.success).toBe(1);
      expect(results.orders.success).toBe(0);
      expect(results.fills.success).toBe(0);
      expect(results.ohlc.success).toBe(0);
    });
    
    it('should track migration statistics', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const stats = pgManager.getStats();
      expect(stats.sessionsMigrated).toBe(1);
      expect(stats.ordersMigrated).toBe(1);
      expect(stats.lastMigrationTime).toBeGreaterThan(0);
    });
  });
  
  describe('migrateSession()', () => {
    it('should migrate session data', async () => {
      const sessionData = {
        sessionId: 'session-123',
        symbol: 'BTC/USD',
        status: 'active',
        metrics: { ordersPlaced: 10 }
      };
      
      mockRedisManager.sessionManager.get.mockResolvedValue(sessionData);
      
      const results = await pgManager.migrateSession(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      expect(mockDb.bulk.sessions.save).toHaveBeenCalled();
      
      const savedSession = mockDb.bulk.sessions.save.mock.calls[0][0][0];
      expect(savedSession.id).toBe('session-123');
      expect(savedSession.data).toEqual(sessionData);
    });
    
    it('should handle missing session data', async () => {
      mockRedisManager.sessionManager.get.mockResolvedValue(null);
      
      const results = await pgManager.migrateSession(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(0);
      expect(mockDb.bulk.sessions.save).not.toHaveBeenCalled();
    });
  });
  
  describe('migrateOrders()', () => {
    it('should migrate orders with enhanced data', async () => {
      const orders = [
        {
          orderId: 'order-1',
          sessionId: 'session-123',
          symbol: 'BTC/USD',
          msgSeqNum: 5,
          execReports: []
        }
      ];
      
      mockRedisManager.getAllOrders.mockResolvedValue(orders);
      
      const results = await pgManager.migrateOrders(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      const savedOrders = mockDb.bulk.orders.save.mock.calls[0][0];
      expect(savedOrders[0].data.originalRedisOrder).toBeDefined();
      expect(savedOrders[0].data.dataPreserved).toBe(true);
    });
  });
  
  describe('migrateFills()', () => {
    it('should migrate fills with deduplication keys', async () => {
      const fills = [
        {
          fillId: 'fill-1',
          execID: 'EXEC-1',
          orderId: 'order-1',
          sessionId: 'session-123',
          data: {
            executionReport: { execType: '2' }
          }
        }
      ];
      
      mockRedisManager.getAllFills.mockResolvedValue(fills);
      
      const results = await pgManager.migrateFills(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      const savedFills = mockDb.bulk.fills.save.mock.calls[0][0];
      expect(savedFills[0].execid).toBe('EXEC-1');
      expect(savedFills[0].data.executionReport).toBeDefined();
    });
  });
  
  describe('migrateOHLC()', () => {
    it('should migrate OHLC candles', async () => {
      const candles = [
        {
          symbol: 'BTC/USD',
          exchange: 'truex',
          interval: '1m',
          timestamp: 1696723200000,
          open: 50000,
          high: 50100,
          low: 49900,
          close: 50050,
          volume: 10,
          source: 'truex_executions',
          tradeCount: 5,
          isComplete: true,
          data: {}
        }
      ];
      
      mockRedisManager.getOHLCCandles.mockResolvedValue(candles);
      
      const results = await pgManager.migrateOHLC(mockRedisManager, 'session-123');
      
      expect(results.success).toBe(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ohlc'),
        expect.arrayContaining(['BTC/USD', 'truex', '1m', 1696723200000])
      );
    });
    
    it('should handle OHLC upsert on conflict', async () => {
      const candles = [
        {
          symbol: 'BTC/USD',
          interval: '1m',
          timestamp: Date.now(),
          open: 50000,
          high: 50000,
          low: 50000,
          close: 50000,
          volume: 1
        }
      ];
      
      mockRedisManager.getOHLCCandles.mockResolvedValue(candles);
      
      await pgManager.migrateOHLC(mockRedisManager, 'session-123');
      
      const query = mockDb.query.mock.calls[0][0];
      expect(query).toContain('ON CONFLICT');
      expect(query).toContain('DO UPDATE SET');
    });
  });
  
  describe('getOHLCCandles()', () => {
    it('should retrieve OHLC candles', async () => {
      const candles = [
        { symbol: 'BTC/USD', interval: '1m', timestamp: 1696723200000 },
        { symbol: 'BTC/USD', interval: '1m', timestamp: 1696723260000 }
      ];
      
      mockDb.query.mockResolvedValue({ rows: candles });
      
      const result = await pgManager.getOHLCCandles('BTC/USD', '1m');
      
      expect(result).toHaveLength(2);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM ohlc'),
        ['BTC/USD', '1m']
      );
    });
    
    it('should filter by time range', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await pgManager.getOHLCCandles('BTC/USD', '1m', 1696723200000, 1696723300000);
      
      const [query, params] = mockDb.query.mock.calls[0];
      expect(query).toContain('timestamp >=');
      expect(query).toContain('timestamp <=');
      expect(params).toContain(1696723200000);
      expect(params).toContain(1696723300000);
    });
    
    it('should return empty array on error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Query failed'));
      
      const result = await pgManager.getOHLCCandles('BTC/USD', '1m');
      
      expect(result).toEqual([]);
    });
  });
  
  describe('getStats()', () => {
    beforeEach(() => {
      // Ensure advisory lock does not cause delays in this block
      jest.spyOn(pgManager, 'tryAcquireLock').mockResolvedValue(true);
      jest.spyOn(pgManager, 'releaseLock').mockResolvedValue();
    });
    
    it('should return statistics with db stats', async () => {
      mockRedisManager.getAllOrders.mockResolvedValue([
        { orderId: 'order-1', sessionId: 'session-123', symbol: 'BTC/USD' }
      ]);
      
      await pgManager.migrateFromRedis(mockRedisManager, 'session-123');
      
      const stats = pgManager.getStats();
      
      expect(stats.sessionsMigrated).toBe(1);
      expect(stats.ordersMigrated).toBe(1);
      expect(stats.dbStats).toBeDefined();
      expect(stats.dbStats.totalConnections).toBe(5);
    });
  });
  
  describe('close()', () => {
    it('should close PostgreSQL connection', async () => {
      await pgManager.close();
      
      expect(mockDb.close).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[TrueXPostgreSQLManager] PostgreSQL connection closed'
      );
    });
  });
});
