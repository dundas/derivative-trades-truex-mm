import WebSocket from 'ws';
import {mkdirSync,appendFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';

// Read-only probe: OAuth, instruments and quotes only. Credentials stay in memory.
const args=process.argv.slice(2);
const flag=(key:string,fallback:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const out=resolve(flag('--out','logs/tastytrade-feed-check'));
if(existsSync(join(out,'summary.json'))||existsSync(join(out,'observations.jsonl')))throw new Error('Choose a fresh output directory');
const duration=Number(flag('--duration-seconds','60'));
if(!Number.isFinite(duration)||duration<=0||duration>600)throw new Error('Duration must be 1..600 seconds');
const base=(process.env.TASTYTRADE_API_URL??'https://api.tastyworks.com').replace(/\/$/,'');
if(!['https://api.tastyworks.com','https://api.cert.tastyworks.com'].includes(base))throw new Error('Unsupported tastytrade API host');
const secret=process.env.TASTYTRADE_CLIENT_SECRET,refresh=process.env.TASTYTRADE_REFRESH_TOKEN;
if(!secret||!refresh)throw new Error('Missing tastytrade OAuth environment credentials');
const headers:any={'User-Agent':'true-markets-equity-research/1.0','Content-Type':'application/json','Accept':'application/json'};
async function request(path:string,body?:any){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)throw new Error(`tastytrade ${path.split('?')[0]} HTTP ${response.status}`);
 return response.json() as Promise<any>;
}
async function main(){
 const auth=await request('/oauth/token',{grant_type:'refresh_token',refresh_token:refresh,client_secret:secret,...(process.env.TASTYTRADE_CLIENT_ID?{client_id:process.env.TASTYTRADE_CLIENT_ID}:{}),scope:'read'});
 const access=auth.access_token??auth.data?.access_token;if(!access)throw new Error('OAuth response missing access token');
 headers.Authorization=`Bearer ${access}`;
 const rest=await request('/market-data/by-type?equity=NVDA,TSLA');
 const restQuotes=(rest.data?.items??[]).map((q:any)=>Object.fromEntries(['symbol','instrument-type','updated-at','bid','ask','bid-size','ask-size','last','is-trading-halted'].map(k=>[k,q[k]])));
 const instruments=[];
 for(const symbol of ['NVDA','TSLA']){const r=await request('/instruments/equities/'+symbol);const d=r.data?.items?.[0]??r.data;instruments.push({symbol,streamerSymbol:d?.['streamer-symbol']??d?.symbol});}
 if(instruments.some(i=>!i.streamerSymbol))throw new Error('Instrument missing streamer symbol');
 const token=(await request('/api-quote-tokens')).data;
 if(!token?.token||!token['dxlink-url'])throw new Error('Quote token response incomplete');
 const url=new URL(token['dxlink-url']);
 if(url.protocol!=='wss:' || !['tasty-openapi-ws.dxfeed.com','tasty-openapi-ws.cert.dxfeed.com','tasty-openapi-dxlink-md-ws.dxfeed.com'].includes(url.host)||url.username||url.password||url.search)throw new Error('Unrecognized DXLink TLS host: '+url.hostname+'; query present: '+Boolean(url.search));
 mkdirSync(out,{recursive:true});
 const startedAt=Date.now();const counts:Record<string,number>={},latest:any={},fields:Record<string,string[]>={},states:string[]=[];let authorized=false,subscribed=false,authSent=false;
 const ws=new WebSocket(url.toString());
 let failure:string|undefined;let ending=false;let keepalive:ReturnType<typeof setInterval>|undefined;
 const record=(r:any)=>appendFileSync(join(out,'observations.jsonl'),JSON.stringify(r)+'\n');
 const send=(m:any)=>ws.send(JSON.stringify(m));
 const result=await new Promise<any>((done)=>{
 const finish=()=>{if(ending)return;ending=true;clearTimeout(end);clearTimeout(deadline);clearInterval(keepalive);ws.terminate();
  const report={startedAt:new Date(startedAt).toISOString(),finishedAt:new Date().toISOString(),durationSeconds:(Date.now()-startedAt)/1000,apiHost:base,streamHost:url.origin,entitlementLevel:token.level,restQuotes,instruments,authorized,subscribed,states,counts,fields,latest,failure,passed:!failure&&authorized&&subscribed&&instruments.every(i=>latest[i.streamerSymbol]?.quote),note:'Quote and Trade event messages observed. Trade events represent last-trade state, not an independently deduplicated execution tape. No account/order endpoints called.'};
  writeFileSync(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');done(report);
 };
 const end=setTimeout(finish,duration*1000);
 const deadline=setTimeout(()=>{failure='Streaming authentication/subscription timeout';finish();},15000);
 ws.on('open',()=>{send({type:'SETUP',channel:0,version:'0.1-DXF-JS/0.3.0',keepaliveTimeout:60,acceptKeepaliveTimeout:60});keepalive=setInterval(()=>send({type:'KEEPALIVE',channel:0}),25000);});
 ws.on('error',()=>{failure='DXLink socket error';finish();});
 ws.on('close',()=>{if(!ending){failure='DXLink closed before observation deadline';finish();}});
 ws.on('message',(raw:any)=>{try{
  const m=JSON.parse(raw.toString());counts[m.type]=(counts[m.type]??0)+1;
  if(m.type==='ERROR'){failure='DXLink protocol error';finish();return;}
  if(m.type==='AUTH_STATE'){
   states.push(m.state);
   if(m.state==='UNAUTHORIZED'&&!authSent){authSent=true;send({type:'AUTH',channel:0,token:token.token});}
   if(m.state==='AUTHORIZED'){authorized=true;send({type:'CHANNEL_REQUEST',channel:3,service:'FEED',parameters:{contract:'AUTO'}});}
  }
  if(m.type==='CHANNEL_OPENED'&&m.channel===3)send({type:'FEED_SETUP',channel:3,acceptAggregationPeriod:0.1,acceptDataFormat:'COMPACT',acceptEventFields:{Quote:['eventType','eventSymbol','bidPrice','askPrice','bidSize','askSize','bidTime','askTime'],Trade:['eventType','eventSymbol','price','size','time','dayVolume']}});
  if(m.type==='FEED_CONFIG'&&m.channel===3){Object.assign(fields,m.eventFields??{});if(!subscribed){send({type:'FEED_SUBSCRIPTION',channel:3,reset:true,add:instruments.flatMap(i=>[{type:'Quote',symbol:i.streamerSymbol},{type:'Trade',symbol:i.streamerSymbol}])});subscribed=true;clearTimeout(deadline);}}
  if(m.type==='FEED_DATA'&&m.channel===3){
   const at=Date.now();
   for(let j=0;j<m.data.length;j+=2){const type=m.data[j],values=m.data[j+1],schema=fields[type];if(!schema||!Array.isArray(values)||values.length%schema.length!==0)throw Error('Invalid event format');
    for(let i=0;i<values.length;i+=schema.length){const data=Object.fromEntries(schema.map((k,index)=>[k,values[i+index]]));if(!instruments.some(v=>v.streamerSymbol===data.eventSymbol))continue;record({at,type,data});counts[type]=(counts[type]??0)+1;latest[data.eventSymbol]??={};latest[data.eventSymbol][type==='Quote'?'quote':'lastTrade']={receivedAt:at,...data};}
   }
  }
 }catch{failure='Invalid DXLink message';finish();}});
 });
 console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Read-only tastytrade test failed');process.exitCode=1;});
