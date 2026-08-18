const INSTRUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORDER_NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{4,6}$/;

export function buildOrderReconciliationScope(env = process.env) {
  const instrumentId = String(env.TRUEX_INSTRUMENT_ID ?? '').trim();
  const orderIdNamespace = String(env.TRUEX_ORDER_ID_NAMESPACE ?? '').trim();
  if (!INSTRUMENT_ID_PATTERN.test(instrumentId)) {
    throw new Error('TRUEX_INSTRUMENT_ID must be a nonempty valid TrueX instrument identifier');
  }
  if (!ORDER_NAMESPACE_PATTERN.test(orderIdNamespace)) {
    throw new Error('TRUEX_ORDER_ID_NAMESPACE must contain 4-6 URL-safe characters');
  }
  return { truexInstrumentId: instrumentId, orderIdNamespace };
}
