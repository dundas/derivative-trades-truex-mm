import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeySigner, TokenManager, type Fetcher } from '../src/truemarkets/auth';
import { TrueMarketsClient, type LimitOrder } from '../src/truemarkets/client';
import { TradingRuntime } from '../src/truemarkets/runtime';
import { decimal, ExecutionController, OrderJournal, type OrderIntent, type TradingPolicy } from '../src/truemarkets/execution';

const NOW = 1793033600000;
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const signer = new ApiKeySigner('key-id', pair.privateKey.export({ format: 'jwk' }));
const response = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const jwt = (claims: any = {}) => `header.${Buffer.from(JSON.stringify({ uid: 'user', tm: { client_id: '1' }, exp: NOW / 1000 + 3600, ...claims })).toString('base64url')}.signature`;
const env = { auth: 'https://api.truemarkets.co/v1/auth', gateway: 'https://api.truemarkets.co/v1/gateway', cefi: 'https://api.truex.co' };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'tm-trading-test-')); dirs.push(d); return d; };
const tokenManager = (fetcher: Fetcher, extra = {}) => new TokenManager({ baseUrl: env.auth, expectedUserId: 'user', expectedClientId: '1', signer, fetch: fetcher, now: () => NOW, ...extra });
function fixture() {
  let now = NOW;
  const requests: { url: string; method: string; body: any; headers: Headers }[] = [];
  const orders = new Map<string, any>();
  let failure: 'timeout_after_accept' | '401' | undefined;
  let stockAllowed = true, freeQuote = '100', baseBalance = '0', bookAge = 0;
  const fetcher: Fetcher = async (url, init) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body, headers: new Headers(init?.headers) });
    const path = new URL(url).pathname;
    const data = (rows: any[]) => response({ data: rows, pagination: { next_cursor: null } });
    if (path === '/v1/auth/api-key/token' || path === '/v1/auth/token/refresh') return response({ access_token: jwt(), refresh_token: 'refresh-test' });
    if (path === '/v1/gateway/assets/availability') return response({ country: 'XX', allowed_asset_classes: stockAllowed ? ['stock'] : ['crypto'], allowed_product_types: ['spot'] });
    if (path === '/v1/cefi/instruments') return data([{ id: '2', status: 'ACTIVE', info: { symbol: 'NVDAC-USDC', base_asset_id: '3', quote_asset_id: '4' } }]);
    if (path === '/v1/cefi/clients/fees') return response({ data: { client_id: '1', maker_fee_rate: '0.001', taker_fee_rate: '0.003' }, pagination: { next_cursor: null } });
    if (path === '/v1/cefi/balances') return data([{ id: '1', fees_hold: '0', unsettled_fees: '0', balances: [
      { asset_id: '3', balance: baseBalance, order_hold: '0', transfer_hold: '0', state: 'OPEN' },
      { asset_id: '4', balance: freeQuote, order_hold: '0', transfer_hold: '0', state: 'OPEN' },
    ] }]);
    if (path === '/v1/cefi/market/quote') {
      expect(new URL(url).searchParams.get('instrument_id')).toBe('2');
      return response([{ id: '2', info: { best_bid: { price: '100' }, best_ask: { price: '100.2' }, last_update: String(BigInt(now - bookAge) * 1000000n) } }]);
    }
    if (path === '/v1/cefi/orders/active') return data([...orders.values()].filter(x => !['CANCELED','FILLED'].includes(x.status)));
    if (path.startsWith('/v1/cefi/orders/status/')) {
      const id = path.split('/').at(-1)!; return orders.has(id) ? data([orders.get(id)]) : response({ error: { code: 'not_found' } }, 404);
    }
    if (path === '/v1/cefi/orders' && method === 'POST') {
      if (failure === '401') return response({ error: { code: 'unauthorized' } }, 401);
      const row = { id: '99', external_id: body.external_id, order_info: body.info, executed_qty: '0', leaves_qty: body.info.qty, status: 'ACTIVE' };
      orders.set(row.external_id, row);
      if (failure === 'timeout_after_accept') throw new Error('Timeout');
      return data([row]);
    }
    if (path === '/v1/cefi/orders' && method === 'PATCH') {
      const row = orders.get(body.external_id); row.order_info = { ...row.order_info, qty: body.info.new_qty, price: body.info.new_price };
      row.leaves_qty = body.info.new_qty; return data([row]);
    }
    if (path.startsWith('/v1/cefi/orders/') && method === 'DELETE') {
      const row = orders.get(path.split('/').at(-1)!); row.status = 'CANCELED'; row.leaves_qty = '0'; return data([row]);
    }
    if (path === '/v1/cefi/markets/quote') { expect(body.qty_unit).toBe('BASE'); return response({ data: [{ qty: body.qty }] }); }
    return data([]);
  };
  const auth = tokenManager(fetcher, { now: () => now });
  const client = new TrueMarketsClient({ auth, gatewayUrl: env.gateway, cefiUrl: env.cefi, expectedClientId: '1', writesEnabled: true, fetch: fetcher, now: () => now });
  const dir = directory(), journal = new OrderJournal(dir, 'scope');
  const policy: TradingPolicy = { enabled: true, eligibleUntil: new Date(NOW + 3600000).toISOString(), maxOpenOrders: 2,
    maxQuoteAgeMs: 15000, maxDeviationBps: 25, feeReserveBps: 50, instruments: [
      { symbol: 'NVDAC-USDC', referenceSymbol: 'NVDA', instrumentId: '2', baseAssetId: '3', quoteAssetId: '4',
        tickSize: '0.001', lotSize: '0.001', minNotional: '1', maxOrderNotional: '5', maxPositionQty: '1', unitsVerified: true, tokenToShareRatio: '1', usdToUsdc: '1' },
    ] };
  const intent: OrderIntent = { symbol: 'NVDAC-USDC', side: 'BUY', qty: '0.02', price: '99.9',
    reference: { symbol: 'NVDA', bid: '99.9', ask: '100.1', sourceAt: NOW, receivedAt: NOW, tokenToShareRatio: '1', usdToUsdc: '1' } };
  const controller = new ExecutionController(client, journal, policy, () => now);
  return { client, journal, dir, policy, intent, controller, requests, orders, setFailure: (v: typeof failure) => { failure = v; },
    setNow: (v: number) => { now = v; }, setStock: (v: boolean) => { stockAllowed = v; }, setQuote: (v: string) => { freeQuote = v; },
    setBase: (v: string) => { baseBalance = v; }, setBookAge: (v: number) => { bookAge = v; } };
}
describe('authentication and contracts', () => {
  test('uses raw ES256 for auth and DER stamp over exact UTF-8 payload bytes', () => {
    const sig = signer.challenge(NOW / 1000); expect(Buffer.from(sig, 'base64url').length).toBe(64);
    expect(verify('sha256', Buffer.from(`key-id.${NOW / 1000}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    const payload = '{"activity":"test"}\n', stamp = JSON.parse(Buffer.from(signer.stamp(payload), 'base64url').toString());
    expect(stamp.scheme).toBe('SIGNATURE_SCHEME_TK_API_P256'); expect(stamp.publicKey.length).toBe(66);
    expect(verify('sha256', Buffer.from(payload), pair.publicKey, Buffer.from(stamp.signature, 'hex'))).toBe(true);
    expect(verify('sha256', Buffer.from(payload.trim()), pair.publicKey, Buffer.from(stamp.signature, 'hex'))).toBe(false);
  });
  test('coalesces token minting and accepts nested tm.client_id', async () => {
    let calls = 0;
    const auth = tokenManager(async () => { calls++; return response({ access_token: jwt() }); });
    await Promise.all([auth.token(), auth.token(), auth.token()]); expect(calls).toBe(1); expect(auth.identity).toEqual({ userId: 'user', clientId: '1' });
  });
  test('refreshes before expiry; 401 refresh remints without leaking tokens', async () => {
    let now = NOW, calls: string[] = [];
    const auth = tokenManager(async (url) => { calls.push(url); return url.endsWith('/token/refresh') ? response({}, 401) : response({ access_token: jwt({ exp: now / 1000 + 3600 }), refresh_token: 'secret' }); }, { now: () => now });
    await auth.token(); now += 3590000; await auth.token(); expect(calls.map(x => x.split('/').at(-1))).toEqual(['token','refresh','token']);
  });
  test.each([{ uid: 'wrong' }, { tm: { client_id: 'wrong' } }, { client_id: 'other' }, { exp: 0 }])('rejects wrong identity or invalid expiry %j', async claims => {
    const auth = tokenManager(async () => response({ access_token: jwt(claims) })); await expect(auth.token()).rejects.toThrow();
  });
  test('rejects unexpected endpoints before any request', () => {
    expect(() => tokenManager(fetch, { baseUrl: 'https://attacker.example/v1/auth' })).toThrow('endpoint');
  });
  test('uses new paths, version, timestamp and BASE preview without order creation', async () => {
    const f = fixture();
    try { await f.client.preview('2','BUY','0.02');
      const req = f.requests.at(-1)!; expect(req.url).toBe(env.cefi + '/v1/cefi/markets/quote');
      expect(req.headers.get('X-Truex-Version')).toBe('v2026_01_23'); expect(req.headers.get('x-truex-auth-timestamp')).toBe(String(NOW / 1000));
      expect(f.orders.size).toBe(0);
    } finally { f.journal.close(); }
  });
  test('follows cursors and refuses repeated cursor or legacy array', async () => {
    for (const mode of ['normal','repeat','legacy']) {
      const paths: string[] = [];
      const fetcher: Fetcher = async url => {
        if (url.includes('/auth/')) return response({ access_token: jwt() });
        paths.push(url);
        return response(mode === 'legacy' ? [] : { data: [{ id: String(paths.length) }], pagination: { next_cursor: paths.length === 1 || mode === 'repeat' ? 'a+/=' : null } });
      };
      const client = new TrueMarketsClient({ auth: tokenManager(fetcher), gatewayUrl: env.gateway, cefiUrl: env.cefi, expectedClientId: '1', fetch: fetcher });
      if (mode === 'normal') { expect((await client.activeOrders()).length).toBe(2); expect(paths[1]).toContain('cursor=a%2B%2F%3D'); }
      else await expect(client.activeOrders()).rejects.toThrow();
    }
  });
  test('checks live object fee envelope and rejects mixed auth/API environments', async () => {
    const f = fixture();
    try { expect((await f.client.fees())[0].maker_fee_rate).toBe('0.001'); } finally { f.journal.close(); }
    const auth = tokenManager(fetch);
    expect(() => new TrueMarketsClient({ auth, gatewayUrl: 'https://api.uat.truemarkets.co/v1/gateway', cefiUrl: 'https://api.uat.truex.co', expectedClientId: '1' })).toThrow('Mixed');
  });
  test('custody allocation/release mutations use new paths, never legacy cefi paths', async () => {
    const f = fixture();
    try {
      await f.client.allocate('defi-listing', '2'); await f.client.releaseFunds('defi-listing', '1');
      expect(f.requests.at(-2)?.url).toBe(env.gateway + '/custody/allocations');
      expect(f.requests.at(-1)?.url).toBe(env.gateway + '/custody/releases');
      expect(() => f.client.allocate('defi-listing', '-1')).toThrow();
    } finally { f.journal.close(); }
  });
  test('low-level mutations disabled by default and no 401 mutation replay', async () => {
    const fetcher: Fetcher = async () => { throw new Error('Should not fetch'); };
    const client = new TrueMarketsClient({ auth: tokenManager(fetcher), gatewayUrl: env.gateway, cefiUrl: env.cefi, expectedClientId: '1' });
    await expect(client.cancel('id')).rejects.toThrow('disabled');
    const f = fixture();
    try { f.setFailure('401'); await expect(f.controller.submit(f.intent)).rejects.toThrow('unresolved');
      expect(f.requests.filter(x => x.method === 'POST' && x.url.endsWith('/cefi/orders')).length).toBe(1);
    } finally { f.journal.close(); }
  });
});
describe('order execution and recovery', () => {
  test('persists intent, submits bounded post-only order, modifies and cancels owned order', async () => {
    const f = fixture();
    try {
      const row = await f.controller.submit(f.intent), id = row.external_id;
      expect(row.order_info.exec_inst_flags).toEqual(['ALO']); expect(row.order_info.stp).toBe('CANCEL_AGGRESSIVE');
      expect(JSON.parse(readFileSync(join(f.dir,'orders.jsonl'),'utf8').split('\n')[0]).kind).toBe('intent');
      const replaced = await f.controller.replace(id, { ...f.intent, price: '99.95' }); expect(replaced.order_info.price).toBe('99.95');
      f.policy.enabled = false; f.policy.eligibleUntil = ''; // cancellation stays available when entry gates close
      expect((await f.controller.cancel(id)).status).toBe('CANCELED'); expect((await f.controller.cancelOwned()).length).toBe(0);
      expect(f.requests.some(x => x.url.endsWith('/orders/all'))).toBe(false);
    } finally { f.journal.close(); }
  });
  test('timeout after acceptance recovers by external ID across restart; never duplicates order', async () => {
    const f = fixture();
    f.setFailure('timeout_after_accept'); await expect(f.controller.submit(f.intent)).rejects.toThrow('unresolved');
    const id = [...f.orders.keys()][0]; f.journal.close();
    const journal = new OrderJournal(f.dir, 'scope');
    try {
      expect(journal.states.get(id)?.uncertain).toBe(true);
      const controller = new ExecutionController(f.client, journal, f.policy, () => NOW);
      await controller.reconcile(); expect(journal.states.get(id)?.uncertain).toBe(false);
      expect(f.requests.filter(x => x.method === 'POST' && x.url.endsWith('/cefi/orders')).length).toBe(1);
    } finally { journal.close(); }
  });
  test('404 on uncertain order does not establish absence or permit resubmit', async () => {
    const f = fixture();
    try { f.setFailure('401'); await expect(f.controller.submit(f.intent)).rejects.toThrow('unresolved');
      await expect(f.controller.submit(f.intent)).rejects.toThrow('Reconciliation incomplete');
      expect(f.requests.filter(x => x.method === 'POST' && x.url.endsWith('/cefi/orders')).length).toBe(1);
    } finally { f.journal.close(); }
  });
  test('retains partial fills during cancellation and refuses foreign cancellation', async () => {
    const f = fixture();
    try { const row = await f.controller.submit(f.intent); f.orders.get(row.external_id).executed_qty = '0.01';
      const canceled = await f.controller.cancel(row.external_id); expect(canceled.executed_qty).toBe('0.01');
      await expect(f.controller.cancel('foreign-order')).rejects.toThrow('not owned');
    } finally { f.journal.close(); }
  });
  test('owned kill switch attempts remaining orders after one cancellation fails', async () => {
    const f = fixture();
    try {
      const a = await f.controller.submit(f.intent), b = await f.controller.submit(f.intent);
      const original = f.client.cancel.bind(f.client);
      f.client.cancel = async id => { if (id === a.external_id) throw new Error('Disconnected'); return original(id); };
      await expect(f.controller.cancelOwned()).rejects.toThrow('remain unresolved');
      expect(f.orders.get(b.external_id).status).toBe('CANCELED');
      expect(f.journal.states.get(a.external_id)?.uncertain).toBe(true);
    } finally { f.journal.close(); }
  });
  test('enforces exclusive journal ownership, scope and complete durable tape', () => {
    const dir = directory(), j = new OrderJournal(dir,'scope'); expect(() => new OrderJournal(dir,'scope')).toThrow(); j.close();
    writeFileSync(join(dir,'orders.jsonl'),'{'); expect(() => new OrderJournal(dir,'scope')).toThrow('Incomplete');
    writeFileSync(join(dir,'orders.jsonl'),JSON.stringify({ seq: 1, scope: 'other', kind: 'intent', externalId: 'x' })+'\n');
    expect(() => new OrderJournal(dir,'scope')).toThrow('scope');
  });
  test('serializes concurrent execution calls', async () => {
    const f = fixture();
    try { const first = f.controller.submit(f.intent); await expect(f.controller.submit(f.intent)).rejects.toThrow('in progress'); await first; expect(f.orders.size).toBe(1); }
    finally { f.journal.close(); }
  });
  test.each(['disabled','eligibility','units','tick','lot','notional','reference-age','future','crossed-reference','conversion','deviation','location','cash','position','venue-age','sell','ioc'])(
    'blocks %s before order creation', async guard => {
      const f = fixture();
      try {
        switch(guard) {
          case 'disabled': f.policy.enabled = false; break;
          case 'eligibility': f.policy.eligibleUntil = ''; break;
          case 'units': f.policy.instruments[0].unitsVerified = false; break;
          case 'tick': f.intent.price = '99.9001'; break;
          case 'lot': f.intent.qty = '0.0201'; break;
          case 'notional': f.intent.qty = '1'; break;
          case 'reference-age': f.intent.reference.sourceAt -= 15001; break;
          case 'future': f.intent.reference.sourceAt += 1; break;
          case 'crossed-reference': f.intent.reference.bid = '101'; break;
          case 'conversion': f.intent.reference.tokenToShareRatio = '2'; break;
          case 'deviation': f.intent.price = '99'; break;
          case 'location': f.setStock(false); break;
          case 'cash': f.setQuote('1.999'); break;
          case 'position': f.setBase('0.99'); break;
          case 'venue-age': f.setBookAge(15001); break;
          case 'sell': f.intent.side = 'SELL'; f.intent.price = '100.1'; break;
          case 'ioc': f.intent.tif = 'IOC'; break;
        }
        await expect(f.controller.submit(f.intent)).rejects.toThrow(); expect(f.orders.size).toBe(0);
      } finally { f.journal.close(); }
    });
  test('counts resting buys toward position cap and enforces account-wide open-order cap', async () => {
    const f = fixture();
    try {
      await f.controller.submit(f.intent); f.policy.instruments[0].maxPositionQty = '0.03';
      await expect(f.controller.submit(f.intent)).rejects.toThrow('Position');
      f.policy.instruments[0].maxPositionQty = '1'; f.policy.maxOpenOrders = 1;
      await expect(f.controller.submit(f.intent)).rejects.toThrow('Maximum open');
      expect(f.orders.size).toBe(1);
    } finally { f.journal.close(); }
  });
  test('records pending replace/cancel outcomes without treating old ACTIVE snapshots as confirmation', async () => {
    const f = fixture();
    try {
      const row = await f.controller.submit(f.intent), id = row.external_id;
      const changed: LimitOrder = { external_id: id, info: { ...row.order_info, price: '99.95' } };
      f.journal.append({ kind: 'intent', externalId: id, action: 'replace', order: changed });
      await expect(f.controller.reconcile()).rejects.toThrow('Reconciliation incomplete');
      expect(f.journal.states.get(id)?.uncertain).toBe(true);
      f.orders.get(id).order_info.price = '99.95'; await f.controller.reconcile();
      f.journal.append({ kind: 'intent', externalId: id, action: 'cancel' });
      await expect(f.controller.reconcile()).rejects.toThrow('Reconciliation incomplete');
      f.orders.get(id).status = 'CANCELED'; f.orders.get(id).leaves_qty = '0'; await f.controller.reconcile();
      expect(f.journal.states.get(id)?.uncertain).toBe(false);
    } finally { f.journal.close(); }
  });
  test('exact decimal accounting rejects exponent/NaN and preserves sub-cent increments', () => {
    expect(decimal('0.001') * 1000n).toBe(decimal('1'));
    expect(() => decimal('1e3')).toThrow(); expect(() => decimal('NaN')).toThrow();
    expect(decimal('9007199254740993')).toBe(9007199254740993n * 10n ** 18n);
  });
});

describe('feed bridge and runtime watchdog', () => {
  function runtimeFixture(f: ReturnType<typeof fixture>) {
    const source = { connected: true, quotes: new Map([['NVDA', { symbol: 'NVDA', bid: 99.9, ask: 100.1, sourceAt: NOW, receivedAt: NOW, sourceTimeKind: 'provider_updated_at' }]]) };
    const venue = { connected: true, active: new Set(['NVDAC-USDC']), quotes: new Map([['NVDAC-USDC', { symbol: 'NVDAC-USDC', bid: 100, ask: 100.2, sourceAt: NOW, receivedAt: NOW }]]) };
    let now = NOW;
    return { source, venue, advance: (ms: number) => { now += ms; f.setNow(now); },
      runtime: new TradingRuntime(f.controller, f.journal, f.policy, source, venue, () => now) };
  }
  test('consumes current adapter quote, cancels owned orders on stale feed and blocks further entries', async () => {
    const f = fixture(), r = runtimeFixture(f);
    try {
      expect((await r.runtime.tick())?.healthy).toBe(true);
      const { reference, ...signal } = f.intent;
      const row = await r.runtime.submit(signal); r.advance(15001);
      expect((await r.runtime.tick())?.healthy).toBe(false);
      expect(f.orders.get(row.external_id).status).toBe('CANCELED');
      await expect(r.runtime.submit(signal)).rejects.toThrow('not accepting');
    } finally { await r.runtime.stop(); f.journal.close(); }
  });
  test('disconnect, inactive venue, unknown source timestamp or eligibility expiry fails health', () => {
    const f = fixture(), r = runtimeFixture(f);
    try {
      r.source.connected = false; expect(r.runtime.health().healthy).toBe(false); r.source.connected = true;
      r.venue.active.clear(); expect(r.runtime.health().healthy).toBe(false); r.venue.active.add('NVDAC-USDC');
      r.source.quotes.get('NVDA')!.sourceTimeKind = 'receipt_only'; expect(r.runtime.health().healthy).toBe(false);
      r.source.quotes.get('NVDA')!.sourceTimeKind = 'provider_updated_at'; f.policy.eligibleUntil = '';
      expect(r.runtime.health().issues).toContain('account_eligibility_expired');
    } finally { f.journal.close(); }
  });
  test('shutdown drains submissions and cancels owned order; read-only mode never mutates', async () => {
    const f = fixture(), r = runtimeFixture(f);
    try {
      await r.runtime.tick(); const { reference, ...signal } = f.intent;
      const submitting = r.runtime.submit(signal); const stopping = r.runtime.stop();
      await expect(submitting).rejects.toThrow('not accepting'); await stopping; expect(f.orders.size).toBe(0);
      f.policy.enabled = false; r.source.connected = false; await r.runtime.tick(); await r.runtime.stop();
      expect(f.requests.filter(x => ['POST','DELETE','PATCH'].includes(x.method) && !x.url.includes('/auth/')).length).toBe(0);
    } finally { f.journal.close(); }
  });
  test('active shutdown cancels live owned order and does not submit another', async () => {
    const f = fixture(), r = runtimeFixture(f);
    try { await r.runtime.tick(); const { reference, ...signal } = f.intent; const row = await r.runtime.submit(signal);
      await r.runtime.stop(); expect(f.orders.get(row.external_id).status).toBe('CANCELED');
      await expect(r.runtime.submit(signal)).rejects.toThrow('not accepting');
    } finally { f.journal.close(); }
  });
});

describe('external maker policy',()=>{
 test('old venue BBO is allowed with explicit maker mode and exchange post-only',async()=>{
  const f=fixture();f.policy.pricingMode='external_maker';f.setBookAge(3600000);
  try{await f.controller.submit(f.intent);expect([...f.orders.values()][0].order_info.exec_inst_flags).toEqual(['ALO']);}finally{f.journal.close();}
 });
 test('maker mode cannot submit taker orders',async()=>{
  const f=fixture();f.policy.pricingMode='external_maker';try{await expect(f.controller.submit({...f.intent,postOnly:false})).rejects.toThrow('requires post-only');expect(f.orders.size).toBe(0);}finally{f.journal.close();}
 });
 test('expired deadline forbids any new order',async()=>{
  const f=fixture();f.policy.entryDeadline=NOW;try{await expect(f.controller.submit(f.intent)).rejects.toThrow('deadline');expect(f.orders.size).toBe(0);}finally{f.journal.close();}
 });
 test('explicit user parity assumption does not mislabel units as verified',async()=>{
  const f=fixture();f.policy.instruments[0].unitsVerified=false;f.policy.instruments[0].mappingAssumption='market_parity';
  try{await f.controller.submit(f.intent);expect(f.policy.instruments[0].unitsVerified).toBe(false);}finally{f.journal.close();}
 });
 test('empty venue quote allowed only with live connection and active instrument',()=>{
  const f=fixture();f.policy.pricingMode='external_maker';
  const external={connected:true,quotes:new Map([['NVDA',{symbol:'NVDA',bid:100,ask:100.1,sourceAt:NOW,receivedAt:NOW,sourceTimeKind:'provider_updated_at'}]])};
  const venue={connected:true,active:new Set(['NVDAC-USDC']),quotes:new Map()};
  const runtime=new TradingRuntime(f.controller,f.journal,f.policy,external,venue,()=>NOW);
  try{expect(runtime.health().healthy).toBe(true);venue.connected=false;expect(runtime.health().healthy).toBe(false);venue.connected=true;venue.active.clear();expect(runtime.health().healthy).toBe(false);}finally{f.journal.close();}
 });
});

test('entry guard runs after asynchronous token refresh and blocks dispatch while cancel remains possible',async()=>{
 const requests:string[]=[];
 const auth=tokenManager(async(url)=>{requests.push(url);return response({access_token:jwt()});});
 let expired=false;
 auth.token=async()=>{await Promise.resolve();expired=true;return jwt();};
 const client=new TrueMarketsClient({auth,gatewayUrl:env.gateway,cefiUrl:env.cefi,expectedClientId:'1',writesEnabled:true,
   fetch:async(url)=>{requests.push(url);return response({data:[]});}});
 // Account identity is ordinarily established by token(); isolate the asynchronous dispatch race.
 Object.defineProperty(auth,'identity',{value:{userId:'user',clientId:'1'}});
 const order:LimitOrder={external_id:'test',info:{client_id:'1',instrument_id:'2',qty:'0.01',price:'100',side:'BUY',type:'LIMIT',tif:'GTC',stp:'CANCEL_AGGRESSIVE'}};
 await expect(client.create(order,()=>{if(expired)throw Error('deadline');})).rejects.toThrow('before HTTP dispatch');
 expect(requests).toEqual([]);
 await client.cancel('test');expect(requests.length).toBe(1);
});

 test('proven pre-dispatch rejection does not poison the durable journal',async()=>{
  const f=fixture();
  (f.client as any).options.entryGuard=()=>{throw Error('deadline');};
  try {
    await expect(f.controller.submit(f.intent)).rejects.toThrow('before HTTP dispatch');
    expect(f.orders.size).toBe(0);
    expect([...f.journal.states.values()].every(s=>!s.uncertain&&s.latest?.status==='REJECTED'&&s.latest.local_not_sent)).toBe(true);
    await f.controller.reconcile();
  }finally{f.journal.close();}
 });

test('indicative feed must be explicitly selected and wide references fail health',()=>{
 const f=fixture();f.policy.pricingMode='external_maker';f.policy.maxReferenceSpreadBps=25;
 const quote={symbol:'NVDA',bid:100,ask:100.1,sourceAt:NOW,receivedAt:NOW,sourceTimeKind:'alpaca_overnight_indicative'};
 const external={connected:true,quotes:new Map([['NVDA',quote]])},venue={connected:true,active:new Set(['NVDAC-USDC']),quotes:new Map()};
 const runtime=new TradingRuntime(f.controller,f.journal,f.policy,external,venue,()=>NOW);
 try{expect(runtime.health().healthy).toBe(false);f.policy.referenceTimeKind='alpaca_overnight_indicative';expect(runtime.health().healthy).toBe(true);quote.ask=101;expect(runtime.health().issues).toContain('NVDAC-USDC:external_spread_excessive');}finally{f.journal.close();}
});

test('terminal response may reference original UUID only with matching known exchange identity',async()=>{
 const f=fixture();try{
 const placed=await f.controller.submit(f.intent);
 const row={...placed,external_id:'0',ref_external_id:placed.external_id,status:'CANCELED',leaves_qty:'0'};
 f.client.order=async()=>[row];await f.controller.reconcile();
 expect([...f.journal.states.values()][0].latest?.status).toBe('CANCELED');
 }finally{f.journal.close();}
});
test('client-id 404 falls back to known exchange ID, never interprets absence as canceled',async()=>{
 const requests:string[]=[];
 const http:Fetcher=async(url)=>{requests.push(url);if(url.includes('/token'))return response({access_token:jwt()});if(url.includes('id_type=client'))return response({},404);return response({data:[{id:'99',status:'CANCELED'}],pagination:{next_cursor:null}});};
 const auth=tokenManager(http),client=new TrueMarketsClient({auth,gatewayUrl:env.gateway,cefiUrl:env.cefi,expectedClientId:'1',fetch:http});
 expect((await client.order('abc','99'))[0].status).toBe('CANCELED');expect(requests.some(u=>u.endsWith('/99?id_type=exchange'))).toBe(true);
 await expect(client.order('unknown')).rejects.toThrow();
});

test('ref_external_id cannot bind a different exchange order to the journal',async()=>{
 const f=fixture();try{
 const placed=await f.controller.submit(f.intent);
 f.client.order=async()=>[{...placed,id:'123456',external_id:'0',ref_external_id:placed.external_id,status:'CANCELED',leaves_qty:'0'}];
 await expect(f.controller.reconcile()).rejects.toThrow('Reconciliation incomplete');
 }finally{f.journal.close();}
});

for(const bad of ['unknown_exchange_id','wrong_ref'])test('rejects terminal reference identity '+bad,async()=>{
 const f=fixture();try{
 const placed=await f.controller.submit(f.intent);
 const state=[...f.journal.states.values()][0];
 const row={...placed,external_id:'0',ref_external_id:bad==='wrong_ref'?'foreign':placed.external_id,status:'CANCELED',leaves_qty:'0'};
 if(bad==='unknown_exchange_id'){delete state.latest!.id;delete row.id;}
 f.client.order=async()=>[row];await expect(f.controller.reconcile()).rejects.toThrow('Reconciliation incomplete');
 }finally{f.journal.close();}
});
