import { test, expect } from 'bun:test';
import { bboProblem, evaluateShadow, normalize, validateConfiguration, down, up, type Bbo } from '../src/equities/shadow';
import example from '../config/equity-shadow.example.json';
const now=1000000000;
const limits={...example.limits,maxReferenceSpreadBps:500};
function quote(symbol:string): Bbo {return {symbol,bid:100,ask:101,bidSize:10,askSize:10,sourceAt:now,receivedAt:now};}
function fixture() {
  const config=structuredClone(example.symbols[0]);
  config.mapping={verified:true,verifiedAt:now,evidence:'test-only verified fixture',sourceToken:'fixture:x',targetToken:'fixture:c',sourceSharesPerToken:1,targetSharesPerToken:1};
  config.inventory={verified:true,at:now,availableBase:0.02,availableQuote:10,positionBase:0.02};
  return {config,limits,now,reference:quote(config.sourceSymbol),target:{...quote(config.symbol),bid:99,ask:102},
    fx:{...quote('USDC/USD'),bid:0.9999,ask:1.0001},sourceConnected:true,targetConnected:true,targetActive:true};
}
test('example config still requires inventory despite authorized parity assumptions',()=>{
  validateConfiguration(example);
  const input=fixture();input.config=structuredClone(example.symbols[0]);
  const r=evaluateShadow(input);expect(r.quotes).toEqual([]);expect(r.reasons).toContain('inventory_unverified');
});
test('explicit market parity uses ratio one without asserting mapping verification',()=>{
  const i=fixture();i.config.mapping={...i.config.mapping,mode:'market_parity',verified:false,sourceSharesPerToken:0,targetSharesPerToken:0} as any;
  const r=evaluateShadow({...i,fx:undefined,fxPolicy:{mode:'usd_parity'}});
  expect(r.reference.bid).toBe(100);expect(r.reference.bidSize).toBe(10);
  expect(r.unitAssumption).toBe('market_parity');expect(r.quotes.length).toBe(2);
  expect(i.config.mapping.verified).toBe(false);
  i.config.inventory.verified=false;
  expect(evaluateShadow({...i,fx:undefined,fxPolicy:{mode:'usd_parity'}}).reasons).toContain('inventory_unverified');
});
test('normalization uses token ratio and conservative USD/USDC sides',()=>{
  const i=fixture();i.config.mapping.targetSharesPerToken=2;
  const r=normalize(i.reference,i.fx,i.config.mapping,now,limits);
  expect('quote' in r).toBe(true);
  if('quote' in r){expect(r.quote!.bid).toBeCloseTo(200/1.0001);expect(r.quote!.ask).toBeCloseTo(202/0.9999);expect(r.quote!.bidSize).toBe(5);}
});
for(const [name,mutate,reason] of [
  ['disconnect',(i:any)=>i.sourceConnected=false,'source_disconnected'],
  ['target disconnect',(i:any)=>i.targetConnected=false,'target_disconnected'],
  ['halt',(i:any)=>i.targetActive=false,'target_not_active'],
  ['source stale',(i:any)=>i.reference.sourceAt=now-16000,'reference_stale'],
  ['receipt stale',(i:any)=>i.reference.receivedAt=now-16000,'reference_stale'],
  ['clock future',(i:any)=>i.fx.sourceAt=now+1001,'fx_future'],
  ['crossed book',(i:any)=>i.reference.bid=102,'reference_invalid'],
  ['zero depth',(i:any)=>i.reference.askSize=0,'reference_invalid'],
  ['wrong symbol',(i:any)=>i.reference.symbol='BTC/USD','symbol_mismatch'],
  ['unverified mapping',(i:any)=>i.config.mapping.verified=false,'mapping_unverified'],
  ['stale mapping',(i:any)=>i.config.mapping.verifiedAt=now-limits.maxMappingAgeMs-1,'mapping_stale'],
  ['invalid ratio',(i:any)=>i.config.mapping.sourceSharesPerToken=0,'mapping_invalid'],
  ['missing evidence',(i:any)=>i.config.mapping.evidence='','mapping_unverified'],
  ['inventory unknown',(i:any)=>i.config.inventory.verified=false,'inventory_unverified'],
  ['inventory stale',(i:any)=>i.config.inventory.at=now-limits.maxInventoryAgeMs-1,'inventory_stale'],
  ['negative inventory',(i:any)=>i.config.inventory.positionBase=-1,'inventory_invalid'],
] as const) test(`${name} suppresses proposals`,()=>{
  const i=fixture();mutate(i);const r=evaluateShadow(i);expect(r.quotes).toEqual([]);expect(r.reasons).toContain(reason);
});
test('wide source market suppresses proposals',()=>{
  const i=fixture();i.reference.ask=200;expect(evaluateShadow(i).reasons).toContain('reference_spread_excessive');
});
test('proposal rounds outward and does not cross the target book',()=>{
  const i=fixture();const r=evaluateShadow(i);expect(r.quotes.length).toBe(2);
  const bid=r.quotes.find((q:any)=>q.side==='buy'),ask=r.quotes.find((q:any)=>q.side==='sell');
  expect(bid.price).toBeLessThan(i.target.ask);expect(ask.price).toBeGreaterThan(i.target.bid);
  expect(bid.price).toBeLessThanOrEqual(r.reference.bid);expect(ask.price).toBeGreaterThan(bid.price);
  expect(bid.size*bid.price).toBeLessThanOrEqual(i.config.quoteBudget);
  expect(ask.size).toBeLessThanOrEqual(i.config.inventory.availableBase);
});
test('capital and position limits cannot be exceeded; no naked sells',()=>{
  const i=fixture();i.config.inventory={verified:true,at:now,positionBase:0,availableBase:0,availableQuote:0};
  expect(evaluateShadow(i).quotes).toEqual([]);
  i.config.inventory={verified:true,at:now,positionBase:i.config.maxPosition,availableBase:0.001,availableQuote:100};
  const r=evaluateShadow(i);expect(r.quotes.some((q:any)=>q.side==='buy')).toBe(false);
  expect(r.quotes.every((q:any)=>q.size<=0.001)).toBe(true);
});
test('live FX mode never silently falls back to parity',()=>{
  const i=fixture();i.fx=undefined as any;expect(evaluateShadow(i).reasons).toContain('fx_missing');
});
test('explicit USD parity permits quotes without FX and records the assumption',()=>{
  const i=fixture();
  const r=evaluateShadow({...i,fx:undefined,fxPolicy:{mode:'usd_parity'}});
  expect(r.quotes.length).toBe(2);expect(r.currencyAssumption).toBe('usd_parity');
  expect(r.reference.bid).toBe(100);expect(r.reference.ask).toBe(101);
  expect(r.reasons.some((reason:string)=>reason.startsWith('fx_'))).toBe(false);
  // Parity also ignores an available rate: selecting this mode is deliberate.
  const changed=evaluateShadow({...i,fx:{...i.fx,bid:0.8,ask:0.9},fxPolicy:{mode:'usd_parity'}});
  expect(changed.reference).toEqual(r.reference);
});
test('parity still applies token conversion and suppresses unverified or stale market inputs',()=>{
  const i=fixture();i.config.mapping.targetSharesPerToken=2;
  const r=normalize(i.reference,undefined,i.config.mapping,now,limits,{mode:'usd_parity'});
  expect('quote' in r).toBe(true);
  if('quote' in r){expect(r.quote!.bid).toBe(200);expect(r.quote!.bidSize).toBe(5);}
  i.config.mapping.verified=false;
  expect(evaluateShadow({...i,fx:undefined,fxPolicy:{mode:'usd_parity'}}).reasons).toContain('mapping_unverified');
  i.config.mapping.verified=true;i.target.sourceAt=now-16000;
  expect(evaluateShadow({...i,fx:undefined,fxPolicy:{mode:'usd_parity'}}).reasons).toContain('target_stale');
});
test('invalid FX policy fails closed in configuration and evaluator',()=>{
  expect(()=>validateConfiguration({...example,fx:{mode:'unknown'} as any})).toThrow('Invalid FX mode');
  expect(evaluateShadow({...fixture(),fxPolicy:{mode:'unknown'} as any}).reasons).toContain('fx_policy_invalid');
});
test('configuration rejects unsafe limits and duplicate allocations',()=>{
  const c=structuredClone(example);c.limits.participation=2;expect(()=>validateConfiguration(c)).toThrow();
  c.limits.participation=0.1;c.symbols[1].symbol=c.symbols[0].symbol;expect(()=>validateConfiguration(c)).toThrow();
});
test('outward rounding does not weaken price bounds',()=>{
  for(const price of [1.00000000001,100.049999999,0.00999999999,999.123456]){
    expect(down(price,0.01)).toBeLessThanOrEqual(price);expect(up(price,0.01)).toBeGreaterThanOrEqual(price);
  }
  expect(bboProblem(undefined,now,limits)).toBe('missing');
});
