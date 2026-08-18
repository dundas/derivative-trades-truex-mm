import { describe, expect, test } from 'bun:test';
import { buildOrderReconciliationScope } from './order-reconciliation-scope-config.js';

describe('production order reconciliation scope', () => {
  test('requires an explicit stable instrument and maker namespace', () => {
    expect(() => buildOrderReconciliationScope({})).toThrow('TRUEX_INSTRUMENT_ID');
    expect(() => buildOrderReconciliationScope({
      TRUEX_INSTRUMENT_ID: 'btc-pyusd', TRUEX_ORDER_ID_NAMESPACE: 'bad!',
    })).toThrow('TRUEX_ORDER_ID_NAMESPACE');
  });

  test('returns validated scope unchanged', () => {
    expect(buildOrderReconciliationScope({
      TRUEX_INSTRUMENT_ID: '123456789', TRUEX_ORDER_ID_NAMESPACE: 'MM001',
    })).toEqual({ truexInstrumentId: '123456789', orderIdNamespace: 'MM001' });
  });
});
