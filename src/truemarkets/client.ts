import { ApiError, officialBase, readResponse, TokenManager, type Fetcher } from './auth';

export type Row = Record<string, any>;
export interface ClientOptions {
  auth: TokenManager; gatewayUrl: string; cefiUrl: string; expectedClientId: string;
  schemaVersion?: string; fetch?: Fetcher; now?: () => number; timeoutMs?: number;
  writesEnabled?: boolean;
}
export interface LimitOrder {
  external_id: string;
  info: { client_id: string; instrument_id: string; qty: string; price: string;
    side: 'BUY' | 'SELL'; type: 'LIMIT'; tif: 'GTC' | 'IOC'; exec_inst_flags?: ('ALO')[];
    stp: 'CANCEL_AGGRESSIVE' | 'CANCEL_BOTH' };
}
export class TrueMarketsClient {
  private gateway: string; private cefi: string;
  constructor(private options: ClientOptions) {
    this.gateway = officialBase(options.gatewayUrl, ['https://api.truemarkets.co/v1/gateway', 'https://api.uat.truemarkets.co/v1/gateway']);
    this.cefi = officialBase(options.cefiUrl, ['https://api.truex.co', 'https://api.uat.truex.co']);
    if (!/^\d+$/.test(options.expectedClientId)) throw new Error('Expected CeFi client ID is required');
    if ((this.gateway.includes('.uat.')) !== (this.cefi.includes('.uat.')) ||
      (this.gateway.includes('.uat.') ? 'uat' : 'production') !== options.auth.environment) throw new Error('Mixed API environments');
    if (options.schemaVersion && options.schemaVersion !== 'v2026_01_23') throw new Error('Unsupported CeFi schema version');
  }
  get clientId() { return this.options.expectedClientId; }
  private async request(area: 'gateway' | 'cefi', path: string, method = 'GET', body?: any, preview = false): Promise<any> {
    if (method !== 'GET' && !preview && this.options.writesEnabled !== true) throw new Error('Trading/account writes are disabled');
    const token = await this.options.auth.token();
    if (area === 'cefi' && this.options.auth.identity?.clientId !== this.clientId) throw new Error('CeFi client identity mismatch');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (area === 'cefi') Object.assign(headers, { 'X-Truex-Version': 'v2026_01_23',
      'x-truex-auth-timestamp': String(Math.floor((this.options.now ?? Date.now)() / 1000)) });
    try {
      return await readResponse(await (this.options.fetch ?? fetch)((area === 'gateway' ? this.gateway : this.cefi) + path, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
      }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.options.auth.invalidate();
      // Never replay a mutation after a timeout, 401, conflict or 5xx: reconcile first.
      throw error;
    }
  }
  private async list(area: 'gateway' | 'cefi', path: string, maxPages = 1000): Promise<Row[]> {
    const result: Row[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.request(area, path + (cursor ? sep + 'cursor=' + encodeURIComponent(cursor) : ''));
      if (!Array.isArray(body?.data)) throw new Error('Expected current-schema data envelope');
      result.push(...body.data);
      const next = body.pagination?.next_cursor;
      if (next == null || next === '') return result;
      if (typeof next !== 'string' || seen.has(next)) throw new Error('Invalid/repeated pagination cursor');
      seen.add(next); cursor = next;
    }
    throw new Error('Pagination incomplete: page limit reached');
  }
  availability() { return this.request('gateway', '/assets/availability'); }
  assets(query = 'asset_class=stock&product_type=spot') { return this.list('gateway', '/assets?' + query); }
  walletBalances() { return this.list('gateway', '/balances'); }
  allocations() { return this.list('gateway', '/custody/allocations'); }
  releases() { return this.list('gateway', '/custody/releases'); }
  allocation(id: string) { return this.request('gateway', '/custody/allocations/' + encodeURIComponent(id)); }
  release(id: string) { return this.request('gateway', '/custody/releases/' + encodeURIComponent(id)); }
  allocate(assetId: string, amount: string) { validateAmount(amount); return this.request('gateway', '/custody/allocations', 'POST', { asset_id: assetId, amount }); }
  releaseFunds(assetId: string, amount: string) { validateAmount(amount); return this.request('gateway', '/custody/releases', 'POST', { asset_id: assetId, amount }); }
  clients() { return this.list('cefi', '/v1/cefi/clients'); }
  async fees(): Promise<Row[]> {
    const body = await this.request('cefi', '/v1/cefi/clients/fees');
    if (body?.data && !Array.isArray(body.data) && body.data.client_id === this.clientId) return [body.data];
    if (Array.isArray(body?.data)) return body.data;
    throw new Error('Invalid fee envelope');
  }
  balances() { return this.list('cefi', '/v1/cefi/balances'); }
  instruments(symbol: string) { return this.list('cefi', '/v1/cefi/instruments?symbol=' + encodeURIComponent(symbol)); }
  market(instrumentId: string) { return this.list('cefi', '/v1/cefi/market/quote?instrument_id=' + encodeURIComponent(instrumentId)); }
  activeOrders() { return this.list('cefi', '/v1/cefi/orders/active'); }
  trades(beforeNs = (BigInt((this.options.now ?? Date.now)()) * 1000000n).toString()) {
    return this.list('cefi', '/v1/cefi/orders/trade?timestamp=' + beforeNs + '&size=100');
  }
  order(externalId: string) {
    return this.list('cefi', '/v1/cefi/orders/status/' + encodeURIComponent(externalId) + '?id_type=client');
  }
  preview(instrumentId: string, side: 'BUY' | 'SELL', qty: string) {
    validateAmount(qty);
    if (!/^[1-9][0-9]*$/.test(instrumentId) || !['BUY','SELL'].includes(side)) throw new Error('Invalid preview instrument/side');
    return this.request('cefi', '/v1/cefi/markets/quote', 'POST', { instrument_id: instrumentId, side, qty, qty_unit: 'BASE' }, true);
  }
  create(order: LimitOrder) {
    if (order.info.client_id !== this.clientId || order.info.type !== 'LIMIT') throw new Error('Wrong client or unsupported order type');
    return this.request('cefi', '/v1/cefi/orders', 'POST', order);
  }
  modify(externalId: string, qty: string, price: string) {
    return this.request('cefi', '/v1/cefi/orders', 'PATCH', { external_id: externalId,
      info: { client_id: this.clientId, new_qty: qty, new_price: price } });
  }
  cancel(externalId: string) {
    return this.request('cefi', '/v1/cefi/orders/' + encodeURIComponent(externalId) + '?id_type=client', 'DELETE');
  }
}

function validateAmount(value: string) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,18})?$/.test(value) || !/[1-9]/.test(value) || value.length > 60) throw new Error('Expected positive decimal amount');
}
