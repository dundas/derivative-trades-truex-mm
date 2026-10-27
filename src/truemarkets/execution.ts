import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrueMarketsClient, EntryNotDispatched, type LimitOrder, type Row } from './client';

const SCALE = 10n ** 18n;
export function decimal(value: string): bigint {
  if (typeof value !== 'string' || value.length > 60 || !/^-?\d+(\.\d{1,18})?$/.test(value)) throw new Error('Expected decimal string (up to 18 fractional digits)');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'))) * (negative ? -1n : 1n);
}
export function positive(value: string): bigint {
  const n = decimal(value); if (n <= 0n) throw new Error('Expected positive decimal'); return n;
}
const terminal = (status: string) => ['FILLED', 'CANCELED', 'REJECTED'].includes(status);
const knownStatus = (status: string) => ['INITIALIZED','NEW_PENDING','REJECTED','ACTIVE','FILLED','CANCEL_PENDING','CANCELED','MODIFY_PENDING'].includes(status);
export interface InstrumentPolicy {
  symbol: string; instrumentId: string; baseAssetId: string; quoteAssetId: string;
  tickSize: string; lotSize: string; minNotional: string; maxOrderNotional: string; maxPositionQty: string;
  unitsVerified: boolean; mappingAssumption?: 'market_parity'; referenceSymbol: string; tokenToShareRatio: string; usdToUsdc: string;
}
export interface TradingPolicy {
  enabled: boolean; eligibleUntil: string; maxOpenOrders: number; maxQuoteAgeMs: number;
  pricingMode?: 'venue_bbo' | 'external_maker'; entryDeadline?: number;
  maxDeviationBps: number; feeReserveBps: number; instruments: InstrumentPolicy[];
}
export interface ReferenceQuote {
  symbol: string; bid: string; ask: string; sourceAt: number; receivedAt: number;
  // Explicit conversion from underlying USD per share to USDC per token.
  tokenToShareRatio: string; usdToUsdc: string;
}
export interface OrderIntent {
  symbol: string; side: 'BUY' | 'SELL'; qty: string; price: string;
  tif?: 'GTC' | 'IOC'; postOnly?: boolean; reference: ReferenceQuote;
}
interface State { externalId: string; order: LimitOrder; uncertain: boolean; latest?: Row; action?: string }
interface Event { scope: string; seq: number; at: string; kind: 'intent' | 'observed'; externalId: string; order?: LimitOrder; latest?: Row; action?: string }
export class OrderJournal {
  readonly states = new Map<string, State>();
  private fd: number; private lockFd: number; private seq = 0; private lockPath: string;
  constructor(directory: string, private scope: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(directory, 'execution.lock');
    this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    writeSync(this.lockFd, JSON.stringify({ pid: process.pid, scope, acquiredAt: new Date().toISOString() })); fsyncSync(this.lockFd);
    try {
      const path = join(directory, 'orders.jsonl');
      if (existsSync(path)) {
        const tape = readFileSync(path, 'utf8');
        if (tape && !tape.endsWith('\n')) throw new Error('Incomplete journal tail: reconcile before recovery');
        for (const line of tape.split('\n').filter(Boolean)) this.apply(JSON.parse(line));
      }
      this.fd = openSync(path, 'a', 0o600);
    } catch (error) { closeSync(this.lockFd); unlinkSync(this.lockPath); throw error; }
  }
  private apply(event: Event) {
    if (event.scope !== this.scope || event.seq !== this.seq + 1 || !event.externalId) throw new Error('Journal scope/sequence mismatch');
    const previous = this.states.get(event.externalId);
    if (event.kind === 'intent') {
      if (!previous && (!event.order || event.action !== 'create')) throw new Error('Journal has intent for an unowned order');
      this.states.set(event.externalId, { ...(previous ?? { externalId: event.externalId, order: event.order! }),
        ...(event.order ? { order: event.order } : {}), action: event.action, uncertain: true });
    } else if (event.kind === 'observed' && previous && event.latest && knownStatus(event.latest.status)) {
      previous.latest = event.latest; previous.uncertain = false;
    } else throw new Error('Invalid journal event');
    this.seq = event.seq;
  }
  append(event: Omit<Event, 'scope' | 'seq' | 'at'>) {
    const entry: Event = { ...event, scope: this.scope, seq: this.seq + 1, at: new Date().toISOString() };
    // Intent must be durable before sending. A crash leaves uncertainty, never a retry instruction.
    writeFileSync(this.fd, JSON.stringify(entry) + '\n'); fsyncSync(this.fd); this.apply(entry);
  }
  close() { closeSync(this.fd); closeSync(this.lockFd); unlinkSync(this.lockPath); }
}
export class ExecutionController {
  private busy = false;
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Another execution operation is in progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  constructor(private client: TrueMarketsClient, private journal: OrderJournal, private policy: TradingPolicy, private now = Date.now) {
    if (!Number.isInteger(policy.maxOpenOrders) || policy.maxOpenOrders < 1 || !Number.isFinite(policy.maxQuoteAgeMs) || policy.maxQuoteAgeMs <= 0 ||
      !Number.isFinite(policy.maxDeviationBps) || policy.maxDeviationBps < 0 || !Number.isFinite(policy.feeReserveBps) || policy.feeReserveBps < 0)
      throw new Error('Invalid trading policy');
  }
  private enabled() {
    if (this.policy.enabled !== true) throw new Error('Trading is disabled');
    if (this.policy.entryDeadline !== undefined && this.now() >= this.policy.entryDeadline) throw new Error('Entry deadline reached');
    if (!(Date.parse(this.policy.eligibleUntil) > this.now())) throw new Error('Account eligibility confirmation missing/expired');
  }
  private owned(id: string): State {
    const state = this.journal.states.get(id); if (!state) throw new Error('Order is not owned by this journal'); return state;
  }
  private observed(state: State, body: any): Row {
    const data = body?.data ?? body;
    const row = Array.isArray(data) ? (data.length === 1 ? data[0] : undefined) : data;
    if (!row || row.external_id !== state.externalId || row.order_info?.client_id !== this.client.clientId ||
      row.order_info?.instrument_id !== state.order.info.instrument_id || row.order_info.side !== state.order.info.side || !knownStatus(row.status)) throw new Error('Order response identity/status mismatch');
    if (state.uncertain && !terminal(row.status)) {
      if (state.action === 'cancel' && row.status !== 'CANCEL_PENDING') throw new Error('Cancellation not yet confirmed');
      if (state.action === 'replace' && row.status !== 'MODIFY_PENDING' &&
        (row.order_info.qty !== state.order.info.qty || row.order_info.price !== state.order.info.price)) throw new Error('Replacement not yet confirmed');
    }
    const executed = decimal(row.executed_qty);
    if (executed > positive(row.order_info.qty) || decimal(row.leaves_qty) > positive(row.order_info.qty)) throw new Error('Execution quantity exceeds order quantity');
    if (executed < 0n || decimal(row.leaves_qty) < 0n || (state.latest && executed < decimal(state.latest.executed_qty))) throw new Error('Invalid/regressing execution quantities');
    this.journal.append({ kind: 'observed', externalId: state.externalId, latest: row });
    return row;
  }
  reconcile() { return this.exclusive(() => this.reconcileInternal()); }
  private async reconcileInternal(): Promise<Row[]> {
    const results: Row[] = [];
    for (const state of this.journal.states.values()) {
      if (!state.uncertain && state.latest && terminal(state.latest.status)) continue;
      try { results.push(this.observed(state, await this.client.order(state.externalId))); }
      catch { throw new Error(`Reconciliation incomplete for ${state.externalId}; do not resubmit`); }
    }
    return results;
  }
  private async validate(intent: OrderIntent, replacing?: State): Promise<LimitOrder['info']> {
    this.enabled();
    if ([...this.journal.states.values()].some(x => x.uncertain || !x.latest || (!terminal(x.latest.status) && x.latest.status !== 'ACTIVE'))) throw new Error('Unresolved order outcome blocks new exposure');
    const p = this.policy.instruments.find(x => x.symbol === intent.symbol);
    if (!p || (p.unitsVerified !== true && !(p.mappingAssumption === 'market_parity' && p.tokenToShareRatio === '1' && p.usdToUsdc === '1'))) throw new Error('Instrument/unit mapping not verified');
    const qty = positive(intent.qty), price = positive(intent.price), lot = positive(p.lotSize), tick = positive(p.tickSize);
    if (qty % lot || price % tick) throw new Error('Order does not fit configured tick/lot increments');
    const cost = (qty * price + SCALE - 1n) / SCALE;
    if (cost < positive(p.minNotional) || cost > positive(p.maxOrderNotional)) throw new Error('Order notional outside configured bounds');
    if (!['BUY','SELL'].includes(intent.side) || (intent.tif !== undefined && !['GTC','IOC'].includes(intent.tif))) throw new Error('Unsupported side/time-in-force');
    const postOnly = intent.postOnly ?? true, tif = intent.tif ?? 'GTC';
    if (this.policy.pricingMode === 'external_maker' && !postOnly) throw new Error('External maker mode requires post-only');
    if (postOnly && tif === 'IOC') throw new Error('Post-only cannot use IOC');
    const r = intent.reference;
    if (!r || r.symbol !== p.referenceSymbol) throw new Error('External reference missing/wrong symbol');
    for (const at of [r.sourceAt, r.receivedAt]) {
      const age = this.now() - at;
      if (!Number.isFinite(at) || age < 0 || age > this.policy.maxQuoteAgeMs) throw new Error('External reference stale/future');
    }
    if (r.sourceAt > r.receivedAt) throw new Error('External source time is after receipt time');
    const bid = positive(r.bid), ask = positive(r.ask);
    if (bid > ask) throw new Error('External reference crossed');
    if (r.tokenToShareRatio !== p.tokenToShareRatio || r.usdToUsdc !== p.usdToUsdc) throw new Error('Reference conversion differs from configured policy');
    const ratio = positive(p.tokenToShareRatio), fx = positive(p.usdToUsdc);
    const mid = ((bid + ask) / 2n) * ratio / SCALE * fx / SCALE;
    if (mid <= 0n || (price > mid ? price - mid : mid - price) * 10000n > mid * BigInt(Math.floor(this.policy.maxDeviationBps)))
      throw new Error('Price outside external reference band');
    const [availability, instruments, accounts, active, fees, markets] = await Promise.all([
      this.client.availability(), this.client.instruments(p.symbol), this.client.balances(), this.client.activeOrders(), this.client.fees(), this.client.market(p.instrumentId),
    ]);
    if (!availability.allowed_asset_classes?.includes('stock') || !availability.allowed_product_types?.includes('spot')) throw new Error('Stock/spot trading unavailable from current location');
    const instrument = instruments.find(x => x.id === p.instrumentId && x.info?.symbol === p.symbol);
    if (instrument?.status !== 'ACTIVE' || instrument.info.base_asset_id !== p.baseAssetId || instrument.info.quote_asset_id !== p.quoteAssetId)
      throw new Error('Instrument inactive or asset IDs changed');
    if (this.policy.pricingMode !== 'external_maker') {
      const book = markets.find(x => x.id === p.instrumentId)?.info;
      if (!book || !/^\d+$/.test(book.last_update)) throw new Error('Venue book timestamp missing');
      const age = this.now() - Number(BigInt(book.last_update) / 1000000n);
      if (age < 0 || age > this.policy.maxQuoteAgeMs) throw new Error('Venue book stale/future');
      const venueBid = positive(book.best_bid?.price), venueAsk = positive(book.best_ask?.price);
      if (venueBid > venueAsk || (postOnly && (intent.side === 'BUY' ? price >= venueAsk : price <= venueBid))) throw new Error('Crossed book/post-only would cross');
    }
    // External-maker pricing is independent of competing/own resting quotes.
    // A successful venue API read, active instrument, and exchange-enforced ALO remain required.
    if (!replacing && active.length >= this.policy.maxOpenOrders) throw new Error('Maximum open orders reached');
    const account = accounts.find(x => x.id === this.client.clientId);
    if (!account || !Array.isArray(account.balances)) throw new Error('CeFi balance account missing');
    const base = account.balances.find((x: Row) => x.asset_id === p.baseAssetId);
    const quote = account.balances.find((x: Row) => x.asset_id === p.quoteAssetId);
    const available = (balance: Row | undefined) => {
      if (!balance || balance.state !== 'OPEN') throw new Error('Balance unavailable/locked');
      return decimal(balance.balance) - decimal(balance.order_hold) - decimal(balance.transfer_hold);
    };
    let pendingBuys = 0n;
    for (const order of active) {
      if (order.order_info?.client_id !== this.client.clientId) throw new Error('Active-order client mismatch');
      if (order.order_info.instrument_id === p.instrumentId && order.order_info.side === 'BUY' && order.external_id !== replacing?.externalId)
        pendingBuys += positive(order.leaves_qty);
    }
    if (intent.side === 'BUY') {
      if (!base || decimal(base.balance) < 0n || decimal(base.balance) + pendingBuys + qty > positive(p.maxPositionQty)) throw new Error('Position limit exceeded');
      const fee = fees.find(x => x.client_id === this.client.clientId);
      if (!fee) throw new Error('Fee schedule missing');
      const feeRate = decimal(fee.maker_fee_rate) > decimal(fee.taker_fee_rate) ? decimal(fee.maker_fee_rate) : decimal(fee.taker_fee_rate);
      const reserveRate = BigInt(Math.ceil(this.policy.feeReserveBps)) * SCALE / 10000n;
      const reserve = feeRate > reserveRate ? feeRate : reserveRate;
      if (available(quote) - decimal(account.fees_hold) - (decimal(account.unsettled_fees) > 0n ? decimal(account.unsettled_fees) : 0n) < cost + (cost * reserve + SCALE - 1n) / SCALE)
        throw new Error('Insufficient free quote balance including fees');
    } else if (available(base) < qty) throw new Error('Insufficient free base balance; shorting disabled');
    // Recheck freshness after network reads, immediately before durable intent and send.
    if (this.now() - r.sourceAt > this.policy.maxQuoteAgeMs || this.now() - r.receivedAt > this.policy.maxQuoteAgeMs)
      throw new Error('External reference expired during validation');
    this.enabled(); // Deadline/stop may change while network validation is in flight.
    return { client_id: this.client.clientId, instrument_id: p.instrumentId, qty: intent.qty, price: intent.price,
      side: intent.side, type: 'LIMIT', tif, ...(postOnly ? { exec_inst_flags: ['ALO'] as ['ALO'] } : {}), stp: 'CANCEL_AGGRESSIVE' };
  }
  private dispatchGuard(intent: OrderIntent) {
    this.enabled();
    for (const at of [intent.reference.sourceAt, intent.reference.receivedAt]) {
      if (!Number.isFinite(at) || this.now() < at || this.now() - at > this.policy.maxQuoteAgeMs) throw new Error('Reference expired before dispatch');
    }
  }
  submit(intent: OrderIntent) { return this.exclusive(async () => {
    await this.reconcileInternal();
    const info = await this.validate(intent), externalId = randomUUID();
    const order = { external_id: externalId, info };
    this.journal.append({ kind: 'intent', action: 'create', externalId, order });
    const state = this.owned(externalId);
    try { return this.observed(state, await this.client.create(order, () => this.dispatchGuard(intent))); }
    catch (error) {
      if (error instanceof EntryNotDispatched) {
        this.observed(state, { external_id: externalId, order_info: info, status: 'REJECTED', executed_qty: '0', leaves_qty: '0', local_not_sent: true });
        throw error;
      }
      throw new Error(`Submit outcome unresolved for ${externalId}; reconcile before any retry`);
    }
  }); }
  replace(id: string, intent: OrderIntent) { return this.exclusive(async () => {
    await this.reconcileInternal();
    const state = this.owned(id);
    if (state.latest?.status !== 'ACTIVE' || intent.side !== state.order.info.side) throw new Error('Only an active order with unchanged side can be replaced');
    const previousOrder = state.order, previousLatest = state.latest;
    const info = await this.validate(intent, state);
    if (info.instrument_id !== state.order.info.instrument_id || info.tif !== state.order.info.tif ||
      JSON.stringify(info.exec_inst_flags) !== JSON.stringify(state.order.info.exec_inst_flags)) throw new Error('Replace cannot change instrument, TIF or post-only mode');
    this.journal.append({ kind: 'intent', action: 'replace', externalId: id, order: { external_id: id, info } });
    try { return this.observed(state, await this.client.modify(id, intent.qty, intent.price, () => this.dispatchGuard(intent))); }
    catch (error) {
      if (error instanceof EntryNotDispatched) {
        this.journal.append({kind:'intent',action:'replace',externalId:id,order:previousOrder});
        this.observed(state, previousLatest);
        throw error;
      }
      throw new Error(`Replace outcome unresolved for ${id}; reconcile before any retry`);
    }
  }); }
  cancel(id: string) { return this.exclusive(() => this.cancelInternal(id)); }
  private async cancelInternal(id: string) {
    // Risk-reducing cancellation remains available after entry eligibility expires.
    const state = this.owned(id);
    if (!state.uncertain && state.latest && terminal(state.latest.status)) return state.latest;
    this.journal.append({ kind: 'intent', action: 'cancel', externalId: id });
    try { return this.observed(state, await this.client.cancel(id)); }
    catch { throw new Error(`Cancel outcome unresolved for ${id}; fills may still arrive`); }
  }
  cancelOwned() { return this.exclusive(async () => {
    const result: Row[] = [], errors: string[] = [];
    for (const state of this.journal.states.values()) {
      if (state.uncertain || !state.latest || !terminal(state.latest.status)) {
        try { result.push(await this.cancelInternal(state.externalId)); } catch { errors.push(state.externalId); }
      }
    }
    if (errors.length) throw new Error('Some owned cancellations remain unresolved: ' + errors.join(', '));
    return result;
  }); }
}
