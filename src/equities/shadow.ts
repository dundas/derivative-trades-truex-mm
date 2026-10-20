export interface Bbo {
  symbol: string; bid: number; ask: number; bidSize: number; askSize: number;
  sourceAt: number; receivedAt: number;
}
export interface Mapping {
  verified: boolean; verifiedAt: number; evidence: string;
  sourceToken: string; targetToken: string;
  sourceSharesPerToken: number; targetSharesPerToken: number;
}
export interface Inventory {
  verified: boolean; at: number; availableBase: number; availableQuote: number; positionBase: number;
}
export interface SymbolConfig {
  symbol: string; sourceSymbol: string; mapping: Mapping; inventory: Inventory;
  tickSize: number; sizeStep: number; quoteSize: number; minSize: number;
  maxPosition: number; quoteBudget: number; bufferBps: number; inventorySkewBps: number;
}
export interface Limits {
  maxQuoteAgeMs: number; maxClockSkewMs: number; maxMappingAgeMs: number;
  maxInventoryAgeMs: number; maxReferenceSpreadBps: number; participation: number;
}
const positive = (v: number) => Number.isFinite(v) && v > 0;
const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
export function bboProblem(q: Bbo | undefined, now: number, limits: Limits): string | null {
  if (!q) return 'missing';
  if (![q.bid,q.ask,q.bidSize,q.askSize].every(positive) || q.bid >= q.ask) return 'invalid';
  if (![q.sourceAt,q.receivedAt].every(positive)) return 'missing_timestamp';
  if (q.sourceAt > now + limits.maxClockSkewMs || q.receivedAt > now + limits.maxClockSkewMs) return 'future';
  if (now-q.sourceAt > limits.maxQuoteAgeMs || now-q.receivedAt > limits.maxQuoteAgeMs) return 'stale';
  return null;
}
export function validateConfiguration(config: { limits: Limits; symbols: SymbolConfig[] }) {
  if (!config.symbols?.length) throw new Error('At least one symbol is required');
  for (const [key,value] of Object.entries(config.limits ?? {})) if (!positive(value)) throw new Error(`Invalid limit ${key}`);
  for (const key of ['maxQuoteAgeMs','maxClockSkewMs','maxMappingAgeMs','maxInventoryAgeMs','maxReferenceSpreadBps','participation']) {
    if (!positive(config.limits?.[key])) throw new Error(`Missing limit ${key}`);
  }
  if (config.limits.participation > 1) throw new Error('Participation must be <= 1');
  if (new Set(config.symbols.map(s=>s.symbol)).size !== config.symbols.length) throw new Error('Duplicate target symbols');
  for (const s of config.symbols) {
    if (!s.symbol || !s.sourceSymbol || !s.mapping || !s.inventory) throw new Error('Incomplete symbol configuration');
    for (const key of ['tickSize','sizeStep','quoteSize','minSize','maxPosition']) if (!positive(s[key])) throw new Error(`Invalid ${s.symbol}.${key}`);
    for (const key of ['quoteBudget','bufferBps','inventorySkewBps']) if (!nonnegative(s[key])) throw new Error(`Invalid ${s.symbol}.${key}`);
    if (s.minSize > s.quoteSize) throw new Error('minSize exceeds quoteSize');
  }
}
export function normalize(reference: Bbo, fx: Bbo, mapping: Mapping, now: number, limits: Limits) {
  for (const [name,q] of [['reference',reference],['fx',fx]] as const) {
    const problem=bboProblem(q,now,limits); if(problem) return {reason:`${name}_${problem}`} as const;
  }
  if (!mapping.verified || !mapping.evidence?.trim() || !mapping.sourceToken || !mapping.targetToken) return {reason:'mapping_unverified'} as const;
  if (!positive(mapping.verifiedAt) || mapping.verifiedAt > now+limits.maxClockSkewMs || now-mapping.verifiedAt > limits.maxMappingAgeMs) return {reason:'mapping_stale'} as const;
  if (![mapping.sourceSharesPerToken,mapping.targetSharesPerToken].every(positive)) return {reason:'mapping_invalid'} as const;
  const ratio=mapping.targetSharesPerToken/mapping.sourceSharesPerToken;
  const bid=reference.bid*ratio/fx.ask, ask=reference.ask*ratio/fx.bid;
  if (![bid,ask].every(positive) || bid>=ask) return {reason:'normalized_price_invalid'} as const;
  if ((ask-bid)/((ask+bid)/2)*10000 > limits.maxReferenceSpreadBps) return {reason:'reference_spread_excessive'} as const;
  return {quote:{bid,ask,bidSize:reference.bidSize/ratio,askSize:reference.askSize/ratio,ratio}} as const;
}
// Round outward to preserve the intended price bound despite binary float noise.
export const down = (value: number, step: number) => Math.floor(value/step)*step;
export const up = (value: number, step: number) => Math.ceil(value/step)*step;

export function evaluateShadow(input: {
  config: SymbolConfig; limits: Limits; reference?: Bbo; target?: Bbo; fx?: Bbo;
  sourceConnected: boolean; targetConnected: boolean; targetActive: boolean; now: number;
}) {
  const {config:c,limits,now}=input;
  const reasons: string[]=[];
  const result: any={symbol:c.symbol,at:now,mode:'shadow',reasons,quotes:[]};
  if (!input.sourceConnected) reasons.push('source_disconnected');
  if (!input.targetConnected) reasons.push('target_disconnected');
  if (!input.targetActive) reasons.push('target_not_active');
  for (const [name,q] of [['reference',input.reference],['target',input.target],['fx',input.fx]] as const) {
    const problem=bboProblem(q,now,limits); if(problem) reasons.push(`${name}_${problem}`);
  }
  if(reasons.length) return result;
  if (input.reference!.symbol!==c.sourceSymbol || input.target!.symbol!==c.symbol || input.fx!.symbol!=='USDC/USD') {
    reasons.push('symbol_mismatch'); return result;
  }
  const normalized=normalize(input.reference!,input.fx!,c.mapping,now,limits);
  if('reason' in normalized) { reasons.push(normalized.reason!); return result; }
  result.reference=normalized.quote;
  const inv=c.inventory;
  if (!inv.verified) { reasons.push('inventory_unverified'); return result; }
  if (!positive(inv.at) || inv.at>now+limits.maxClockSkewMs || now-inv.at>limits.maxInventoryAgeMs) {reasons.push('inventory_stale');return result;}
  if (![inv.availableBase,inv.availableQuote,inv.positionBase].every(nonnegative)) {reasons.push('inventory_invalid');return result;}
  const skew=Math.min(inv.positionBase/c.maxPosition,1)*c.inventorySkewBps/10000;
  const bid=down(Math.min(normalized.quote.bid*(1-c.bufferBps/10000-skew),input.target!.ask-c.tickSize),c.tickSize);
  const ask=up(Math.max(normalized.quote.ask*(1+c.bufferBps/10000-skew),input.target!.bid+c.tickSize),c.tickSize);
  if (![bid,ask].every(positive) || bid>=ask) {reasons.push('proposed_price_invalid');return result;}
  const buySize=down(Math.min(c.quoteSize, Math.max(0,c.maxPosition-inv.positionBase),
    Math.min(c.quoteBudget,inv.availableQuote)/bid,normalized.quote.bidSize*limits.participation),c.sizeStep);
  const sellSize=down(Math.min(c.quoteSize,inv.availableBase,inv.positionBase,normalized.quote.askSize*limits.participation),c.sizeStep);
  if (buySize>=c.minSize && buySize*bid<=Math.min(c.quoteBudget,inv.availableQuote)) result.quotes.push({side:'buy',price:bid,size:buySize});
  else reasons.push('buy_capital_inventory_or_depth_limit');
  if (sellSize>=c.minSize && sellSize<=inv.availableBase) result.quotes.push({side:'sell',price:ask,size:sellSize});
  else reasons.push('sell_inventory_or_depth_limit');
  result.basisBps=((input.target!.bid+input.target!.ask)/(normalized.quote.bid+normalized.quote.ask)-1)*10000;
  return result;
}
