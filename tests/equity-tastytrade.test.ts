import {test,expect} from 'bun:test';
import {TastytradeFeed,type TastytradeOptions} from '../src/equities/tastytrade';
import example from '../config/equity-shadow.example.json';
const options:TastytradeOptions={url:'https://api.tastyworks.com',clientSecret:'fixture-secret',refreshToken:'fixture-refresh',pollMs:1000,requestTimeoutMs:200,silenceTimeoutMs:2000,retryMaxMs:1000,quoteSizeMultiplier:1};
const row=(symbol='NVDA',at=Date.now())=>({symbol,'instrument-type':'Equity','updated-at':new Date(at).toISOString(),bid:'200',ask:'201','bid-size':'5','ask-size':'6','is-trading-halted':false});
const json=(v:any,status=200)=>new Response(JSON.stringify(v),{status});
async function until(predicate:()=>boolean){const end=Date.now()+3500;while(!predicate()){if(Date.now()>end)throw Error('Test deadline exceeded');await Bun.sleep(5);}}
test('REST feed batches equities, restricts OAuth scope and preserves provider/receipt timestamps',async()=>{
 const calls:any[]=[];const at=Date.now()-500;
 const http=(async(url:any,init:any)=>{calls.push({url,init});return String(url).endsWith('/oauth/token')?json({access_token:'fixture-access',expires_in:900}):json({data:{items:[row('NVDA',at),row('TSLA',at)]}});}) as typeof fetch;
 const f=new TastytradeFeed(['NVDA','TSLA'],options,()=>{},http);
 try{f.start();await until(()=>f.quotes.size===2);expect(f.connected).toBe(true);expect(f.quotes.get('NVDA')).toMatchObject({sourceAt:at,sourceTimeKind:'provider_updated_at',bidSize:5,askSize:6});expect(f.quotes.get('NVDA')!.receivedAt).toBeGreaterThan(at);
 expect(JSON.parse(calls[0].init.body).scope).toBe('read');expect(calls[1].url).toContain('equity=NVDA%2CTSLA');expect(calls[1].init.headers.Authorization).toBe('Bearer fixture-access');expect(calls.length).toBe(2);
 }finally{f.stop();}
});
test('live polling does not make a stale provider quote timestamp fresh',async()=>{
 const at=Date.now()-60000;const http=(async(url:any)=>String(url).endsWith('/oauth/token')?json({access_token:'a'}):json({data:{items:[row('NVDA',at)]}})) as typeof fetch;
 const f=new TastytradeFeed(['NVDA'],options,()=>{},http);
 try{f.start();await until(()=>f.quotes.size===1);const h=f.observe('NVDA',Date.now(),example.limits);expect(h.transportAlive).toBe(true);expect(h.quoteProblem).toBe('stale');expect(h.quoteAgeMs).toBeGreaterThan(59000);expect(h.receiptAgeMs!).toBeLessThan(500);}finally{f.stop();}
});
test('a new poll clears halted and missing symbols instead of retaining prior prices',async()=>{
 let polls=0;const http=(async(url:any)=>String(url).endsWith('/oauth/token')?json({access_token:'a'}):json({data:{items:++polls===1?[row(),row('TSLA')]:[{...row(),'is-trading-halted':true}]}})) as typeof fetch;
 const f=new TastytradeFeed(['NVDA','TSLA'],options,()=>{},http);
 try{f.start();await until(()=>f.quotes.size===2);await until(()=>polls===2);await until(()=>f.quotes.size===0);expect(f.connected).toBe(true);}finally{f.stop();}
});
test('401 invalidates prices and reauthenticates without logging returned credential text',async()=>{
 let auths=0,polls=0;const events:any[]=[];const http=(async(url:any)=>String(url).endsWith('/oauth/token')?json({access_token:'fixture-access-'+(++auths)}):++polls===1?json({error:'fixture-secret fixture-refresh'},401):json({data:{items:[row()]}})) as typeof fetch;
 const f=new TastytradeFeed(['NVDA'],options,e=>events.push(e),http);
 try{f.start();await until(()=>events.some(e=>e.code===401));expect(f.quotes.size).toBe(0);expect(f.connected).toBe(false);await until(()=>f.quotes.size===1);expect(auths).toBe(2);expect(JSON.stringify(events)).not.toContain('fixture-secret');expect(JSON.stringify(events)).not.toContain('fixture-refresh');}finally{f.stop();}
});
test('forbidden market-data response stops retries and invalidates the cache',async()=>{
 let polls=0;const events:any[]=[];const http=(async(url:any)=>String(url).endsWith('/oauth/token')?json({access_token:'a'}):++polls===1?json({data:{items:[row()]}}):json({},403)) as typeof fetch;
 const f=new TastytradeFeed(['NVDA'],options,e=>events.push(e),http);
 try{f.start();await until(()=>f.quotes.size===1);await until(()=>events.some(e=>e.code===403));expect(f.connected).toBe(false);expect(f.quotes.size).toBe(0);await Bun.sleep(30);expect(polls).toBe(2);}finally{f.stop();}
});
test('stop discards late in-flight responses and clears cached data',async()=>{
 let resolveQuote:(r:Response)=>void=()=>{};let pending=false;
 const http=(async(url:any)=>{if(String(url).endsWith('/oauth/token'))return json({access_token:'a'});pending=true;return new Promise<Response>(r=>resolveQuote=r);}) as typeof fetch;
 const f=new TastytradeFeed(['NVDA'],options,()=>{},http);f.start();await until(()=>pending);f.stop();resolveQuote(json({data:{items:[row()]}}));await Bun.sleep(10);expect(f.quotes.size).toBe(0);expect(f.connected).toBe(false);
});
test('missing quote timestamp is rejected instead of fabricated from receipt time',async()=>{
 const r:any=row();delete r['updated-at'];const events:any[]=[];
 const http=(async(url:any)=>String(url).endsWith('/oauth/token')?json({access_token:'a'}):json({data:{items:[r]}})) as typeof fetch;
 const f=new TastytradeFeed(['NVDA'],options,e=>events.push(e),http);
 try{f.start();await until(()=>events.some(e=>e.type==='invalid_quote'));expect(f.quotes.size).toBe(0);}finally{f.stop();}
});
test('OAuth credentials are restricted to official REST hosts and poll limits are explicit',()=>{
 expect(()=>new TastytradeFeed(['NVDA'],{...options,url:'https://other.invalid'})).toThrow('host');expect(()=>new TastytradeFeed(['NVDA'],{...options,pollMs:1})).toThrow('intervals');expect(()=>new TastytradeFeed(['NVDA'],{...options,refreshToken:''})).toThrow('credentials');
});
