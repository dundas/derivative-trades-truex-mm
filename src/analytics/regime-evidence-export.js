const MAX_EXPORT_ROWS = 1_000_000;

function safeInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function positiveLimit(value, fallback, label) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_EXPORT_ROWS) {
    throw new Error(`${label} must be a positive safe integer at most ${MAX_EXPORT_ROWS}`);
  }
  return number;
}

function finiteNumber(value, label, { positive = false } = {}) {
  const number = value === null || value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(number) || (positive && number <= 0)) {
    throw new Error(`${label} must be ${positive ? 'positive and ' : ''}finite`);
  }
  return number;
}

function optionalNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function validateEvidenceExportOptions(options = {}) {
  const fromTimestamp = safeInteger(options.fromTimestamp, 'fromTimestamp');
  const toTimestamp = safeInteger(options.toTimestamp, 'toTimestamp');
  if (fromTimestamp > toTimestamp) throw new Error('fromTimestamp must not exceed toTimestamp');
  const maxFills = positiveLimit(options.maxFills, 100_000, 'maxFills');
  const maxReferences = positiveLimit(options.maxReferences, 500_000, 'maxReferences');
  const maxHorizonMs = safeInteger(options.maxHorizonMs ?? 3_600_000, 'maxHorizonMs');
  const referenceMaxAgeMs = safeInteger(options.referenceMaxAgeMs ?? 30_000,
    'referenceMaxAgeMs');
  const referenceToTimestamp = toTimestamp + maxHorizonMs + referenceMaxAgeMs;
  if (!Number.isSafeInteger(referenceToTimestamp)) throw new Error('reference export window overflows');
  return { fromTimestamp, toTimestamp, maxFills, maxReferences, maxHorizonMs,
    referenceMaxAgeMs, referenceToTimestamp };
}

export function buildValidatorSourceQuality(config = {}) {
  if (config.referenceMode !== 'cryptocom-direct') {
    throw new Error('regime evidence export currently requires cryptocom-direct mode');
  }
  return {
    referenceMode: config.referenceMode,
    promotionGradeSourceTypes: [config.sourceType],
    referenceProduct: config.product,
    quoteCurrency: config.quoteCurrency,
    sourceExchange: config.sourceExchange,
    maxSourceAgeMs: config.maxSourceAgeMs,
    maxAbsBasisAdjustmentBps: config.maxAbsBasisAdjustmentBps,
    sourceInstrument: config.sourceInstrument,
    sourceChannel: config.sourceChannel,
    sourceEndpointAllowlist: [...config.sourceEndpointAllowlist],
    basisSource: config.basisSource,
    basisRequestedPair: config.basisRequestedPair,
    basisResolvedPair: config.basisResolvedPair,
    basisBase: config.basisBase,
    basisQuote: config.basisQuote,
    basisSystem: config.basisSystem,
    basisVenueAllowlist: [...config.basisVenueAllowlist],
    maxBasisRttMs: config.maxBasisRttMs,
    maxBasisSourceAgeMs: config.maxSourceAgeMs,
  };
}

const DIRECT_REFERENCE_COLUMNS = `
  bid, ask, basis_adjustment_bps, product, quote_currency, source_exchange, source_type,
  source_timestamp, received_timestamp, promotion_grade, reference_mode, source_instrument,
  source_channel, source_sequence, source_generation, source_session_id, source_endpoint,
  source_book_hash, source_depth, source_bid_qty, source_ask_qty, source_bid_count,
  source_ask_count, source_book_update_timestamp`;

function mapFill(row) {
  if (Number(row.decision_timestamp_count) === 0 || row.decision_timestamp === null ||
      row.decision_timestamp === undefined) {
    throw new Error(`fill ${row.fill_id || '<unknown>'} is missing durable decision attribution`);
  }
  const invariants = ['fill_timestamp', 'decision_timestamp', 'side', 'fill_price', 'fill_size'];
  if (invariants.some(field => Number(row[`${field}_count`]) !== 1)) {
    throw new Error(`fill ${row.fill_id || '<unknown>'} has inconsistent horizon attribution`);
  }
  const side = String(row.side || '').toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw new Error(`fill ${row.fill_id} has invalid side`);
  return {
    fillId: String(row.fill_id),
    timestamp: safeInteger(row.fill_timestamp, `fill ${row.fill_id} timestamp`),
    decisionTimestamp: safeInteger(row.decision_timestamp,
      `fill ${row.fill_id} decisionTimestamp`),
    side,
    price: finiteNumber(row.fill_price, `fill ${row.fill_id} price`, { positive: true }),
    quantity: finiteNumber(row.fill_size, `fill ${row.fill_id} quantity`, { positive: true }),
  };
}

function mapReference(row) {
  return {
    timestamp: safeInteger(row.timestamp, 'reference timestamp'),
    bid: optionalNumber(row.bid), ask: optionalNumber(row.ask),
    basisAdjustmentBps: optionalNumber(row.basis_adjustment_bps),
    product: row.product, quoteCurrency: row.quote_currency,
    sourceExchange: row.source_exchange, sourceType: row.source_type,
    sourceTimestamp: optionalInteger(row.source_timestamp),
    receivedTimestamp: optionalInteger(row.received_timestamp),
    promotionGrade: row.promotion_grade === true,
    referenceMode: row.reference_mode, sourceInstrument: row.source_instrument,
    sourceChannel: row.source_channel, sourceSequence: optionalInteger(row.source_sequence),
    sourceGeneration: optionalInteger(row.source_generation),
    sourceSessionId: row.source_session_id, sourceEndpoint: row.source_endpoint,
    sourceBookHash: row.source_book_hash, sourceDepth: optionalInteger(row.source_depth),
    sourceBidQty: optionalNumber(row.source_bid_qty),
    sourceAskQty: optionalNumber(row.source_ask_qty),
    sourceBidCount: optionalInteger(row.source_bid_count),
    sourceAskCount: optionalInteger(row.source_ask_count),
    sourceBookUpdateTimestamp: optionalInteger(row.source_book_update_timestamp),
  };
}

function deduplicateIdenticalReferencePayloads(rows) {
  const fields = ['timestamp', 'bid', 'ask', 'basis_adjustment_bps', 'product',
    'quote_currency', 'source_exchange', 'source_type', 'source_timestamp',
    'received_timestamp', 'promotion_grade', 'reference_mode', 'source_instrument',
    'source_channel', 'source_sequence', 'source_generation', 'source_session_id',
    'source_endpoint', 'source_book_hash', 'source_depth', 'source_bid_qty',
    'source_ask_qty', 'source_bid_count', 'source_ask_count',
    'source_book_update_timestamp'];
  const seen = new Set();
  return rows.filter(row => {
    const key = JSON.stringify(fields.map(field => row[field] ?? null));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadRegimeValidatorEvidence(db, inputOptions = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('db.query is required');
  const options = validateEvidenceExportOptions(inputOptions);
  const sourceQuality = buildValidatorSourceQuality(inputOptions.sourceQuality);
  const fillsResult = await db.query(`WITH scoped AS (
      SELECT * FROM fill_reference_markout_work
      WHERE fill_timestamp BETWEEN $1 AND $2
      AND product = $3 AND quote_currency = $4
      AND source_exchange = $5 AND source_type = ANY($6::text[])
    ) SELECT fill_id, MIN(fill_timestamp) AS fill_timestamp,
      MIN(decision_timestamp) AS decision_timestamp, MIN(side) AS side,
      MIN(fill_price) AS fill_price, MIN(fill_size) AS fill_size,
      COUNT(DISTINCT fill_timestamp)::int AS fill_timestamp_count,
      COUNT(DISTINCT decision_timestamp)::int AS decision_timestamp_count,
      COUNT(DISTINCT side)::int AS side_count,
      COUNT(DISTINCT fill_price)::int AS fill_price_count,
      COUNT(DISTINCT fill_size)::int AS fill_size_count
    FROM scoped GROUP BY fill_id ORDER BY fill_id
    LIMIT $7`, [options.fromTimestamp, options.toTimestamp, sourceQuality.referenceProduct,
    sourceQuality.quoteCurrency, sourceQuality.sourceExchange,
    sourceQuality.promotionGradeSourceTypes, options.maxFills + 1]);
  const fillRows = fillsResult.rows || [];
  if (fillRows.length > options.maxFills) {
    throw new Error(`fill export exceeds maxFills=${options.maxFills}`);
  }

  const referencesResult = await db.query(`WITH combined AS (
      SELECT decision_timestamp AS timestamp, decision_id AS stable_id, 1 AS source_rank,
        ${DIRECT_REFERENCE_COLUMNS}
      FROM reference_quote_decisions
      WHERE reference_mode = 'cryptocom-direct' AND decision_timestamp BETWEEN $1 AND $2
        AND product = $3 AND quote_currency = $4
        AND source_exchange = $5 AND source_type = ANY($6::text[])
      UNION ALL
      SELECT observation_timestamp AS timestamp, observation_id AS stable_id, 0 AS source_rank,
        ${DIRECT_REFERENCE_COLUMNS}
      FROM reference_market_observations
      WHERE reference_mode = 'cryptocom-direct' AND observation_timestamp BETWEEN $1 AND $2
        AND product = $3 AND quote_currency = $4
        AND source_exchange = $5 AND source_type = ANY($6::text[])
    ) SELECT * FROM combined
      ORDER BY timestamp, source_type, product, quote_currency, source_rank, stable_id
      LIMIT $7`, [Math.max(0, options.fromTimestamp - options.referenceMaxAgeMs),
    options.referenceToTimestamp, sourceQuality.referenceProduct, sourceQuality.quoteCurrency,
    sourceQuality.sourceExchange, sourceQuality.promotionGradeSourceTypes,
    options.maxReferences + 1]);
  const rawReferenceRows = referencesResult.rows || [];
  if (rawReferenceRows.length > options.maxReferences) {
    throw new Error(`reference export exceeds maxReferences=${options.maxReferences}`);
  }
  // Collapse only byte-equivalent market payloads. A quote decision and sampled observation can
  // legitimately persist the same source frame at the same millisecond; contradictory payloads
  // remain separate so the validator's duplicate-key gate excludes rather than chooses between them.
  const referenceRows = deduplicateIdenticalReferencePayloads(rawReferenceRows);

  return {
    candidateId: null,
    fills: fillRows.map(mapFill).sort((left, right) => left.timestamp - right.timestamp ||
      left.fillId.localeCompare(right.fillId)),
    references: referenceRows.map(mapReference),
    candidateBuffersBps: [],
    shadowEvidence: null,
    config: { sourceQuality },
    exportMetadata: {
      fromTimestamp: options.fromTimestamp, toTimestamp: options.toTimestamp,
      fillCount: fillRows.length, referenceCount: referenceRows.length,
      truncated: false, source: 'postgresql-read-only',
    },
  };
}
