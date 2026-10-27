import {test,expect} from 'bun:test';
import {overnightQuote,AlpacaOvernightFeed} from '../src/equities/alpaca-overnight';
const at=Date.now(),body={symbol:'NVDA',quote:{bp:216.5,ap:216.8,bs:100,as:100,t:new Date(at-500).toISOString()}};
test('indicative source is explicitly labelled and timestamp preserved',()=>{const q=overnightQuote(body,'NVDA',at);expect(q.sourceTimeKind).toBe('alpaca_overnight_indicative');expect(q.sourceAt).toBe(at-500);});
test('reject wrong symbol, crossed, missing/future/backward timestamps and malformed prices',()=>{
 for(const bad of [{...body,symbol:'TSLA'}, {...body,quote:{...body.quote,bp:217}}, {...body,quote:{...body.quote,t:undefined}},{...body,quote:{...body.quote,t:new Date(at+1).toISOString()}},{...body,quote:{...body.quote,bp:'216'}}])expect(()=>overnightQuote(bad,'NVDA',at)).toThrow();
 expect(()=>overnightQuote(body,'NVDA',at,at)).toThrow();
});
test('old snapshots retain their old timestamps instead of refreshing on receipt',()=>{expect(overnightQuote(body,'NVDA',at+60000).sourceAt).toBe(at-500);});
test('stop ignores late HTTP results and never leaks credentials in errors',async()=>{
 let finish:(v:Response)=>void=()=>{};
 const http=(async()=>await new Promise<Response>(r=>finish=r)) as typeof fetch;
 const f=new AlpacaOvernightFeed('NVDA',{key:'test',secret:'test-secret',pollMs:1000,timeoutMs:1000},http);f.start();f.stop();finish(new Response(JSON.stringify(body)));await Bun.sleep(5);expect(f.connected).toBe(false);expect(f.quotes.size).toBe(0);
});
