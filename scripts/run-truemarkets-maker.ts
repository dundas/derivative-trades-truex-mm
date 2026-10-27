import {mkdirSync,appendFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {ApiKeySigner,TokenManager} from '../src/truemarkets/auth';
import {TrueMarketsClient,EntryNotDispatched} from '../src/truemarkets/client';
import {decimal,ExecutionController,OrderJournal, type TradingPolicy} from '../src/truemarkets/execution';
import {TradingRuntime} from '../src/truemarkets/runtime';
import {planQuotes,cancelAndConfirm,type MakerLimits} from '../src/truemarkets/maker';
import {AlpacaOvernightFeed} from '../src/equities/alpaca-overnight';
import {TastytradeFeed} from '../src/equities/tastytrade';
import {PublicFeed} from '../src/equities/feeds';
const args=process.argv.slice(2), flag=(n:string,d:string)=>{const i=args.indexOf(n);return i<0?d:args[i+1];};
const required=(n:string)=>{const v=process.env[n];if(!v)throw Error(`Missing ${n}`);return v;};
const c=await Bun.file(resolve(flag('--config','config/truemarkets-maker.local.json'))).json();
const live=args.includes('--live');
const policy=c.policy as TradingPolicy, limits=c.maker as MakerLimits;
if(policy.instruments.length!==1 || !Number.isInteger(c.durationSeconds) || c.durationSeconds<1 || c.durationSeconds>900 ||
 !Number.isInteger(c.requoteMs) || c.requoteMs<5000 || c.requoteMs>15000 || c.timeoutMs>3000 || c.timeoutMs<100 ||
 c.watch.referencePollMs<1000 || c.watch.referencePollMs>5000 || policy.maxQuoteAgeMs>15000 ||
 policy.pricingMode!=='external_maker' || policy.maxOpenOrders!==2 || policy.feeReserveBps!==0 ||
 decimal(limits.capital)>decimal('10') || decimal(limits.lossStop)>decimal('1')) throw Error('Invalid bounded canary configuration');
const p=policy.instruments[0];
if(p.symbol!=='NVDAC-USDC')throw Error('This authorization covers NVDAC only');
// Validate all strategy inputs before authentication or mutation.
planQuotes(p,limits,limits.capital,'0','100','100.1');
const clientId=required('TM_EXPECTED_CLIENT_ID');
if(clientId!==c.expectedClientId)throw Error('Account differs from authorized configuration');
policy.enabled=live;
const out=resolve(flag('--out',`logs/truemarkets-maker/${new Date().toISOString().replace(/[:.]/g,'-')}`));
if(existsSync(out))throw Error('Output directory already exists; use a new run directory');
mkdirSync(out,{recursive:true,mode:0o700});
const emit=(data:any)=>appendFileSync(join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n',{mode:0o600});
const auth=new TokenManager({baseUrl:c.authUrl,expectedUserId:required('TM_EXPECTED_USER_ID'),expectedClientId:clientId,signer:ApiKeySigner.fromFile(required('TM_KEY_FILE')),timeoutMs:c.timeoutMs});
const client=new TrueMarketsClient({auth,gatewayUrl:c.gatewayUrl,cefiUrl:c.cefiUrl,expectedClientId:clientId,writesEnabled:live,timeoutMs:c.timeoutMs,entryGuard:()=>{const health=runtime.health();if(stopping || !health.healthy){emit({type:"dispatch_blocked",stopping,health,reference:source.quotes.get(p.referenceSymbol)});throw Error("Entry health changed before dispatch");}}});
if(!['tastytrade','alpaca_overnight'].includes(c.watch.referenceProvider??'tastytrade'))throw Error('Unknown reference provider');
if(c.watch.referenceProvider==='alpaca_overnight' && policy.referenceTimeKind!=='alpaca_overnight_indicative')throw Error('Indicative feed requires explicit policy');
if(policy.maxReferenceSpreadBps!==undefined)throw Error('This maker uses spread-aware pricing, not a reference spread cutoff');
const source=c.watch.referenceProvider==='alpaca_overnight' ? new AlpacaOvernightFeed(p.referenceSymbol,{key:required('APCA_API_KEY_ID'),secret:required('APCA_API_SECRET_KEY'),pollMs:c.watch.referencePollMs,timeoutMs:c.timeoutMs}) : new TastytradeFeed([p.referenceSymbol],{url:c.watch.tastytradeUrl,clientSecret:required('TASTYTRADE_CLIENT_SECRET'),refreshToken:required('TASTYTRADE_REFRESH_TOKEN'),clientId:process.env.TASTYTRADE_CLIENT_ID,pollMs:c.watch.referencePollMs,requestTimeoutMs:c.timeoutMs,silenceTimeoutMs:15000,retryMaxMs:30000,quoteSizeMultiplier:1});
if(c.watch.venueWsUrl!=='wss://api.truemarkets.co/v1/cefi/market' || c.cefiUrl!=='https://api.truex.co')throw Error('Unexpected venue/environment');
const venue=new PublicFeed('truemarkets',[p.symbol],{url:c.watch.venueWsUrl,connectTimeoutMs:10000,silenceTimeoutMs:15000,reconnectMinMs:1000,reconnectMaxMs:5000});
// Shared account journal prevents concurrent runs. Never discard prior unresolved orders.
const journal=new OrderJournal(resolve(c.journalDir),`${c.cefiUrl}|${clientId}`);
const controller=new ExecutionController(client,journal,policy), runtime=new TradingRuntime(controller,journal,policy,source,venue);
let stopping=false, reason='preflight', started:number|undefined, submitted=0, lastPnl:string|undefined, finalActive:number|undefined;
const stop=(why:string)=>{stopping=true;policy.enabled=false;reason=why;};
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
const balances=async()=>{
 const rows=await client.balances(), a=rows.find(x=>x.id===clientId);
 if(!a || decimal(a.fees_hold)!==0n || decimal(a.unsettled_fees)!==0n)throw Error('Account or fees changed');
 const get=(id:string)=>{const r=a.balances.find((b:any)=>b.asset_id===id);if(!r||r.state!=='OPEN'||decimal(r.unsettled)!==0n||decimal(r.transfer_hold)!==0n)throw Error('Balance locked or unsettled');return r;};
 return {cash:get(p.quoteAssetId),base:get(p.baseAssetId)};
};
const drain=async()=>{if(live)await cancelAndConfirm(controller,()=>[...journal.states.values()].map(s=>({uncertain:s.uncertain,latest:s.latest?{status:String(s.latest.status)}:undefined})));};
let timer:ReturnType<typeof setTimeout>|undefined;
let endingBalances:any, finalPnl:string|undefined;
try {
 await controller.reconcile();
 if((await client.activeOrders()).length)throw Error('Pre-existing orders require reconciliation before this run');
 const funds=await balances();
 if(decimal(funds.cash.balance)!==decimal(limits.capital)||decimal(funds.base.balance)!==0n || decimal(funds.cash.order_hold)!==0n||decimal(funds.base.order_hold)!==0n)throw Error('Initial balance differs from approved cash-only capital');
 const fees=await client.fees();
 if(fees.length!==1||decimal(fees[0].maker_fee_rate)!==0n||decimal(fees[0].taker_fee_rate)!==0n)throw Error('Zero-fee assumption no longer holds');
 source.start();venue.start();
 const startup=Date.now();
 while(!stopping && Date.now()-startup<30000){if(runtime.health().healthy)break;await Bun.sleep(500);}
 if(stopping)throw Error('Stopped during preflight');
 if(!runtime.health().healthy){emit({type:'preflight_blocked',health:runtime.health(),reference:source.quotes.get(p.referenceSymbol)});throw Error('Fresh reference/venue preflight failed');}
 started=Date.now();policy.entryDeadline=started+c.durationSeconds*1000;
 timer=setTimeout(()=>stop('duration_complete'),c.durationSeconds*1000);
 emit({type:'started',live,limits,durationSeconds:c.durationSeconds,mappingAssumption:p.mappingAssumption});
 let nextQuote=0, paused=false;
 const pauseQuotes=async()=>{
   await drain();
   if(!paused)emit({type:'quotes_paused',health:runtime.health(),reference:source.quotes.get(p.referenceSymbol)});
   paused=true;nextQuote=0;await Bun.sleep(500);
 };
 sessionLoop: while(!stopping && Date.now()<policy.entryDeadline){
   const health=await runtime.tick();
   if(!health?.healthy){await pauseQuotes();continue;}
   if(paused){emit({type:'quotes_resumed'});paused=false;}
   const funds=await balances();
   if(!runtime.health().healthy){await pauseQuotes();continue;}
   const q=source.quotes.get(p.referenceSymbol)!;
   const marked=planQuotes(p,limits,funds.cash.balance,funds.base.balance,String(q.bid),String(q.ask));
   lastPnl=marked.pnl;
   if(marked.stop){stop('loss_stop');break;}
   if(Date.now()>=nextQuote){
     await drain();
     if(stopping)break;
     const clean=await balances();
     if(decimal(clean.cash.order_hold)!==0n||decimal(clean.base.order_hold)!==0n)throw Error('Order holds remain after cancellation');
     const fresh=source.quotes.get(p.referenceSymbol)!;
     if(!runtime.health().healthy){await pauseQuotes();continue;}
     const plan=planQuotes(p,limits,clean.cash.balance,clean.base.balance,String(fresh.bid),String(fresh.ask));
     lastPnl=plan.pnl;
     if(plan.stop){stop('loss_stop');break;}
     emit({type:'quote_plan',...plan,reference:fresh});
     for(const order of plan.orders){if(stopping||Date.now()>=policy.entryDeadline)break;
       if(live){
         const before=await balances();
         if(stopping)break sessionLoop;
         if(!runtime.health().healthy){await pauseQuotes();continue sessionLoop;}
         const reference=source.quotes.get(p.referenceSymbol)!;
         const check=planQuotes(p,limits,before.cash.balance,before.base.balance,String(reference.bid),String(reference.ask));
         if(check.stop){stop('loss_stop');break;}
         try{await runtime.submit({symbol:p.symbol,...order,postOnly:true,tif:'GTC'});}
         catch(error){
           // Only proven unsent health/deadline rejections may resume. Network outcomes never replay.
           if(error instanceof EntryNotDispatched){await pauseQuotes();continue sessionLoop;}
           throw error;
         }
         submitted++;emit({type:'submitted',order});}
     }
     nextQuote=Date.now()+c.requoteMs;
   }
   await Bun.sleep(500);
 }
 if(!stopping)stop('duration_complete');
} catch(e){stop(e instanceof Error?e.message:'Run failed');emit({type:'stopped',reason,health:runtime.health(),reference:source.quotes.get(p.referenceSymbol)});process.exitCode=1;}
finally {
 clearTimeout(timer);policy.enabled=false;
 try{await drain();const active=await client.activeOrders();finalActive=active.length;if(active.some(x=>journal.states.has(x.external_id)))throw Error('Owned active orders remain');}
 catch(e){emit({type:'cleanup_unresolved',reason:e instanceof Error?e.message:'Cleanup failed'});reason+='; cleanup_unresolved';process.exitCode=1;}
 try {
   const ending=await balances();endingBalances={cash:ending.cash.balance,inventory:ending.base.balance,cashHeld:ending.cash.order_hold,inventoryHeld:ending.base.order_hold};
   if(runtime.health().healthy){const q=source.quotes.get(p.referenceSymbol)!;finalPnl=planQuotes(p,limits,ending.cash.balance,ending.base.balance,String(q.bid),String(q.ask)).pnl;}
 }catch{emit({type:'ending_balance_unavailable'});}
 source.stop();venue.stop();journal.close();
 const report={live,startedAt:started?new Date(started).toISOString():null,stoppedAt:new Date().toISOString(),reason,submitted,preCleanupPnl:lastPnl,finalPnl,endingBalances,finalActive,limits,note:'PnL marked at external bid; residual inventory retained, no forced liquidation. No PYUSD conversion.'};
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({out,...report},null,2));
}
