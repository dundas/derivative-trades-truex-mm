import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicFeed } from '../src/equities/feeds';
import { bboProblem, evaluateShadow, validateConfiguration } from '../src/equities/shadow';
import { ObservationRecorder, acquireOutputLock } from '../src/equities/recorder';

const args=process.argv.slice(2);
const flag=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const path=resolve(flag('--config','config/equity-shadow.example.json'));
const out=resolve(flag('--out','logs/equity-shadow/current'));
const duration=Number(flag('--duration-seconds','60'));
if(!Number.isFinite(duration)||duration<=0||duration>604800)throw new Error('Duration must be positive and at most seven days');
const config=JSON.parse(readFileSync(path,'utf8'));
validateConfiguration(config);
if(config.mode!=='shadow')throw new Error('Only shadow mode is supported');
for(const key of ['sampleMs','maxSampleGapMs','requiredHealthyHours'])if(!Number.isFinite(config[key])||config[key]<=0)throw new Error(`Invalid ${key}`);
if(config.sampleMs>config.maxSampleGapMs)throw new Error('Sampling interval exceeds maximum gap');
const fxPolicy=config.fx??{mode:'live'};
const sourceConfig=config.source??{venue:'kraken'};
if(!['kraken','alpaca'].includes(sourceConfig.venue))throw new Error('Unsupported source venue');
if(sourceConfig.venue==='alpaca' && fxPolicy.mode!=='usd_parity')throw new Error('Alpaca source requires explicit usd_parity FX mode');
const alpaca=sourceConfig.venue==='alpaca'?{
  key:process.env[sourceConfig.keyEnv??'APCA_API_KEY_ID']??'',
  secret:process.env[sourceConfig.secretEnv??'APCA_API_SECRET_KEY']??'',
  quoteUnitsPerLot:sourceConfig.quoteUnitsPerLot??{},
}:undefined;
// Reject missing credentials before taking an output lock or starting either feed.
if(alpaca && (!alpaca.key||!alpaca.secret))throw new Error('Set Alpaca credentials in the configured environment variables before running');
const releaseLock=acquireOutputLock(out);
const hash=createHash('sha256').update(JSON.stringify(config)).digest('hex');
let recorder: ObservationRecorder;
try {recorder=new ObservationRecorder(out,config.symbols.map(s=>s.symbol),config.maxSampleGapMs,hash);}
catch(error){releaseLock();throw error;}
const feedOptions={connectTimeoutMs:config.connectTimeoutMs,silenceTimeoutMs:config.silenceTimeoutMs,
  reconnectMinMs:config.reconnectMinMs,reconnectMaxMs:config.reconnectMaxMs};
let stopping=false;
const event=(e:any)=>{if(!stopping)recorder.event(e);};
const sourceSymbols=[...config.symbols.map(s=>s.sourceSymbol),...(fxPolicy.mode==='live'?['USDC/USD']:[])];
let sourceFeed:PublicFeed,target:PublicFeed;
try {
sourceFeed=new PublicFeed(sourceConfig.venue,sourceSymbols,{...feedOptions,
  url:sourceConfig.venue==='alpaca'?sourceConfig.url:config.krakenUrl,alpaca,observeActivity:true},event);
target=new PublicFeed('truemarkets',config.symbols.map(s=>s.symbol),{...feedOptions,url:config.trueMarketsUrl,observeActivity:true},event);
} catch(error){releaseLock();throw error;}
const health=()=>({[sourceConfig.venue]:{connected:sourceFeed.connected,lastMessageAt:sourceFeed.lastMessageAt,reconnects:sourceFeed.reconnects,
  endpoint:sourceConfig.venue==='alpaca'?sourceConfig.url:config.krakenUrl},
  truemarkets:{connected:target.connected,lastMessageAt:target.lastMessageAt,reconnects:target.reconnects},currencyAssumption:fxPolicy.mode});
function sample() {
  const now=Date.now();
  for(const symbol of config.symbols) {
    const reference=sourceFeed.quotes.get(symbol.sourceSymbol), venue=target.quotes.get(symbol.symbol),fx=sourceFeed.quotes.get('USDC/USD');
    const sourceHealth=sourceFeed.observe(symbol.sourceSymbol,now,config.limits),targetHealth=target.observe(symbol.symbol,now,config.limits);
    const rawComparison=reference && venue ? {
      interpretation:'Raw numeric comparison; token units unverified; not normalized fair value',
      currencyAssumption:fxPolicy.mode,
      midpointDifferenceBps:((venue.bid+venue.ask)/(reference.bid+reference.ask)-1)*10000,
      sourceSpreadBps:(reference.ask-reference.bid)/((reference.ask+reference.bid)/2)*10000,
      targetSpreadBps:(venue.ask-venue.bid)/((venue.ask+venue.bid)/2)*10000,
      freshInputs:sourceHealth.quoteProblem===null && targetHealth.quoteProblem===null,
    }:undefined;
    const inputs={reference,target:venue,fx,fxPolicy,sourceHealth,targetHealth,rawComparison,
      sourceConnected:sourceFeed.connected,targetConnected:target.connected,targetActive:target.active.has(symbol.symbol)};
    const healthy=sourceFeed.connected && target.connected && inputs.targetActive
      && [reference,venue,...(fxPolicy.mode==='live'?[fx]:[])].every(q=>!bboProblem(q,now,config.limits));
    const result=evaluateShadow({...inputs,config:symbol,limits:config.limits,now});
    recorder.sample(symbol.symbol,now,healthy,result,inputs);
  }
  recorder.save(now,health(),config.requiredHealthyHours);
}
let timer: ReturnType<typeof setInterval>;
let endTimer: ReturnType<typeof setTimeout>;
function stop(failed=false) {
  if(stopping)return;
  stopping=true;clearInterval(timer);clearTimeout(endTimer);
  sourceFeed.stop();target.stop();
  try {const report=recorder.save(Date.now(),health(),config.requiredHealthyHours,true);
    console.log(JSON.stringify({out,runId:recorder.runId,coverage:report.coverage,pilotReady:false},null,2));}
  finally {releaseLock();process.exitCode=failed?1:0;}
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
try {
  sourceFeed.start();target.start();sample();
  timer=setInterval(()=>{try{sample();}catch(error){console.error(error);stop(true);}},config.sampleMs);
  endTimer=setTimeout(()=>stop(),duration*1000);
} catch(error) {stop(true);throw error;}
