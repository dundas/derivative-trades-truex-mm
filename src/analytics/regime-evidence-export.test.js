import { describe, expect, test } from 'bun:test';
import {
  buildValidatorSourceQuality,
  loadRegimeValidatorEvidence,
  validateEvidenceExportOptions,
} from './regime-evidence-export.js';

const direct = {
  referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD', quoteCurrency: 'PYUSD',
  sourceExchange: 'cryptocom', sourceType: 'public-ws-book', maxSourceAgeMs: 5_000,
  maxAbsBasisAdjustmentBps: 25, sourceInstrument: 'BTC_PYUSD',
  sourceChannel: 'book.BTC_PYUSD.10',
  sourceEndpointAllowlist: ['wss://stream.crypto.com/exchange/v1/market'],
  basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
  basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
  basisSystem: 'CLOB', basisVenueAllowlist: [], maxBasisRttMs: 1_000,
};

function referenceRow(overrides = {}) {
  return {
    timestamp: '1000', bid: '99', ask: '101', basis_adjustment_bps: '0',
    product: 'BTC-PYUSD', quote_currency: 'PYUSD', source_exchange: 'cryptocom',
    source_type: 'public-ws-book', source_timestamp: '990', received_timestamp: '995',
    promotion_grade: true, reference_mode: 'cryptocom-direct',
    source_instrument: 'BTC_PYUSD', source_channel: 'book.BTC_PYUSD.10',
    source_sequence: '7', source_generation: '1', source_session_id: 'session-1',
    source_endpoint: 'wss://stream.crypto.com/exchange/v1/market',
    source_book_hash: 'a'.repeat(64), source_depth: 10, source_bid_qty: '0.2',
    source_ask_qty: '0.3', source_bid_count: 2, source_ask_count: 3,
    source_book_update_timestamp: '980', ...overrides,
  };
}

describe('regime evidence export', () => {
  test('validates immutable bounds and rejects unsafe row limits', () => {
    expect(validateEvidenceExportOptions({ fromTimestamp: 1, toTimestamp: 2 })).toMatchObject({
      fromTimestamp: 1, toTimestamp: 2,
    });
    for (const options of [
      { fromTimestamp: 2, toTimestamp: 1 },
      { fromTimestamp: -1, toTimestamp: 2 },
      { fromTimestamp: 1, toTimestamp: 2, maxFills: 0 },
      { fromTimestamp: 1, toTimestamp: 2, maxReferences: 1_000_001 },
    ]) expect(() => validateEvidenceExportOptions(options)).toThrow();
  });

  test('maps durable fills and exact direct provenance into validator input', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('fill_reference_markout_work')) return { rows: [{
        fill_id: 'fill-1', fill_timestamp: '1000', decision_timestamp: '999',
        side: 'buy', fill_price: '100', fill_size: '0.01',
        fill_timestamp_count: 1, decision_timestamp_count: 1, side_count: 1,
        fill_price_count: 1, fill_size_count: 1,
      }] };
      return { rows: [referenceRow()] };
    } };
    const result = await loadRegimeValidatorEvidence(db, {
      fromTimestamp: 900, toTimestamp: 1_100, maxFills: 10, maxReferences: 20,
      maxHorizonMs: 3_600_000, referenceMaxAgeMs: 30_000, sourceQuality: direct,
    });

    expect(result.candidateId).toBeNull();
    expect(result.shadowEvidence).toBeNull();
    expect(result.candidateBuffersBps).toEqual([]);
    expect(result.fills).toEqual([{
      fillId: 'fill-1', timestamp: 1000, decisionTimestamp: 999,
      side: 'buy', price: 100, quantity: 0.01,
    }]);
    expect(result.references[0]).toMatchObject({
      timestamp: 1000, bid: 99, ask: 101, promotionGrade: true,
      referenceMode: 'cryptocom-direct', sourceSequence: 7, sourceGeneration: 1,
      sourceSessionId: 'session-1', sourceBookUpdateTimestamp: 980,
    });
    expect(result.config.sourceQuality).toEqual(buildValidatorSourceQuality(direct));
    expect(calls).toHaveLength(2);
    expect(calls[0].params.at(-1)).toBe(11);
    expect(calls[1].params.at(-1)).toBe(21);
    expect(calls[0].params.slice(2, 6)).toEqual([
      'BTC-PYUSD', 'PYUSD', 'cryptocom', ['public-ws-book'],
    ]);
  });

  test('fails closed on missing fill attribution or silent truncation', async () => {
    const missingAttribution = { query: async sql => sql.includes('fill_reference_markout_work')
      ? { rows: [{ fill_id: 'fill-1', fill_timestamp: '1000', decision_timestamp: null,
        side: 'buy', fill_price: '100', fill_size: '0.01', fill_timestamp_count: 1,
        decision_timestamp_count: 0, side_count: 1, fill_price_count: 1,
        fill_size_count: 1 }] }
      : { rows: [] } };
    await expect(loadRegimeValidatorEvidence(missingAttribution, {
      fromTimestamp: 1, toTimestamp: 2, maxFills: 10, maxReferences: 10,
      maxHorizonMs: 60_000, referenceMaxAgeMs: 30_000, sourceQuality: direct,
    })).rejects.toThrow('missing durable decision attribution');

    const truncated = { query: async sql => sql.includes('fill_reference_markout_work')
      ? { rows: Array.from({ length: 3 }, (_, index) => ({ fill_id: `f-${index}`,
        fill_timestamp: '1000', decision_timestamp: '999', side: 'buy',
        fill_price: '100', fill_size: '0.01', fill_timestamp_count: 1,
        decision_timestamp_count: 1, side_count: 1, fill_price_count: 1,
        fill_size_count: 1 })) }
      : { rows: [] } };
    await expect(loadRegimeValidatorEvidence(truncated, {
      fromTimestamp: 1, toTimestamp: 2, maxFills: 2, maxReferences: 10,
      maxHorizonMs: 60_000, referenceMaxAgeMs: 30_000, sourceQuality: direct,
    })).rejects.toThrow('fill export exceeds maxFills=2');
  });

  test('rejects conflicting cross-horizon attribution and keeps contradictory references', async () => {
    const calls = [];
    const db = { query: async sql => {
      calls.push(sql);
      if (sql.includes('fill_reference_markout_work')) return { rows: [] };
      return { rows: [referenceRow(), referenceRow(), referenceRow({ ask: '102' })] };
    } };
    const evidence = await loadRegimeValidatorEvidence(db, {
      fromTimestamp: 1, toTimestamp: 2, maxFills: 10, maxReferences: 10,
      maxHorizonMs: 60_000, referenceMaxAgeMs: 30_000, sourceQuality: direct,
    });
    expect(evidence.references).toHaveLength(2);
    expect(evidence.references.map(reference => reference.ask)).toEqual([101, 102]);
    expect(calls[1]).not.toContain('DISTINCT ON');
  });

  test('rejects inconsistent cross-horizon fill attribution', async () => {
    const db = { query: async sql => sql.includes('fill_reference_markout_work')
      ? { rows: [{ fill_id: 'fill-1', fill_timestamp: '1000', decision_timestamp: '999',
        side: 'buy', fill_price: '100', fill_size: '0.01', fill_timestamp_count: 1,
        decision_timestamp_count: 2, side_count: 1, fill_price_count: 1,
        fill_size_count: 1 }] }
      : { rows: [] } };
    await expect(loadRegimeValidatorEvidence(db, {
      fromTimestamp: 1, toTimestamp: 2, maxFills: 10, maxReferences: 10,
      maxHorizonMs: 60_000, referenceMaxAgeMs: 30_000, sourceQuality: direct,
    })).rejects.toThrow('inconsistent horizon attribution');
  });
});
