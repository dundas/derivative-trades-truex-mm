import {test,expect} from 'bun:test';
import {planQuotes,format} from '../src/truemarkets/maker';
import {decimal,type InstrumentPolicy} from '../src/truemarkets/execution';
const p:InstrumentPolicy={symbol:'NVDAC-USDC',referenceSymbol:'NVDA',instrumentId:'2',baseAssetId:'3',quoteAssetId:'4',tickSize:'0.001',lotSize:'0.001',minNotional:'1',maxOrderNotional:'2',maxPositionQty:'0.04',unitsVerified:false,mappingAssumption:'market_parity',tokenToShareRatio:'1',usdToUsdc:'1'};
const l={capital:'10',lossStop:'1',orderNotional:'2',halfSpreadBps:10,inventorySkewBps:5};
test('cash-only start has one bid, no short sell, tick/lot and notional limits',()=>{
 const r=planQuotes(p,l,'10','0','216.5','216.55');expect(r.orders.length).toBe(1);expect(r.orders[0].side).toBe('BUY');
 const o=r.orders[0];expect(decimal(o.qty)%decimal(p.lotSize)).toBe(0n);expect(decimal(o.price)%decimal(p.tickSize)).toBe(0n);
 expect(Number(o.qty)*Number(o.price)).toBeLessThanOrEqual(2);expect(Number(o.price)).toBeLessThan(216.5);
});
test('acquired inventory enables ask without overselling',()=>{
 const r=planQuotes(p,l,'8.052','0.009','216.5','216.55');expect(r.orders.some(o=>o.side==='SELL')).toBe(true);
 expect(Number(r.orders.find(o=>o.side==='SELL')!.qty)).toBeLessThanOrEqual(.009);
});
test('marked loss threshold stops all entries including exact boundary',()=>{
 const r=planQuotes(p,l,'7','0.01','200','200.1');expect(r.stop).toBe(true);expect(r.pnl).toBe('-1');expect(r.orders).toEqual([]);
});
test('position cap prevents further bids',()=>{expect(planQuotes(p,l,'2','0.04','210','210.1').orders.every(o=>o.side==='SELL')).toBe(true);});
test('dust is never posted below minimum notional',()=>{expect(planQuotes(p,l,'9.8','0.001','216.5','216.55').orders.some(o=>o.side==='SELL')).toBe(false);});
test('higher cash does not expand capital allocation',()=>{const r=planQuotes(p,l,'100','0.039','216.5','216.55');expect(r.orders.filter(o=>o.side==='BUY').every(o=>Number(o.qty)<=.001)).toBe(true);});
test('invalid prices and risk settings rejected',()=>{
 expect(()=>planQuotes(p,l,'10','0','217','216')).toThrow();expect(()=>planQuotes(p,{...l,lossStop:'11'},'10','0','216','217')).toThrow();
});
test('decimal formatting preserves value',()=>{for(const n of ['0','10','-1','0.009','216.5'])expect(decimal(format(decimal(n)))).toBe(decimal(n));});

import {cancelAndConfirm} from '../src/truemarkets/maker';
test('ambiguous cancellation still reconciles a filled order',async()=>{
 let state:any={uncertain:true,latest:{status:'ACTIVE'}},reads=0;
 await cancelAndConfirm({cancelOwned:async()=>{throw Error('timeout');},reconcile:async()=>{reads++;state={uncertain:false,latest:{status:'FILLED'}};}},()=>[state],2,async()=>{});
 expect(reads).toBe(1);
});
test('cleanup never declares success while an order might still rest',async()=>{
 let reads=0,cancels=0;
 await expect(cancelAndConfirm({cancelOwned:async()=>{cancels++;throw Error('timeout');},reconcile:async()=>{reads++;throw Error('unreachable');}},()=>[{uncertain:true}],3,async()=>{})).rejects.toThrow('unresolved');
 expect(reads).toBe(3);expect(cancels).toBe(3);
});
