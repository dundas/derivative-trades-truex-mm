import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Serialize every acquisition, including dead-owner recovery. A crashed acquisition
// guard is left for explicit inspection rather than guessed safe to remove.
export function acquireOutputLock(out: string): () => void {
  mkdirSync(out,{recursive:true});
  const guard=join(out,'collector.acquire');
  try {mkdirSync(guard);}catch{throw new Error('Another collector is acquiring this output; inspect collector.acquire if abandoned');}
  const file=join(out,'collector.lock');
  const owner={pid:process.pid,token:randomUUID()};
  try {
    if(existsSync(file)) {
      const prior=JSON.parse(readFileSync(file,'utf8'));
      if(!Number.isInteger(prior.pid)||prior.pid<=0)throw new Error('Invalid collector lock; inspect before recovery');
      try {process.kill(prior.pid,0);throw new Error(`Collector already running (${prior.pid})`);}
      catch(error:any){if(error.code!=='ESRCH')throw error;}
      unlinkSync(file);
    }
    writeFileSync(file,JSON.stringify(owner),{flag:'wx',mode:0o600});
  } finally {rmdirSync(guard);}
  return ()=>{
    if(!existsSync(file))return;
    const prior=JSON.parse(readFileSync(file,'utf8'));
    if(prior.token!==owner.token)throw new Error('Collector lock ownership changed; refusing release');
    unlinkSync(file);
  };
}

const ny = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function sessionBand(at: number): string {
  const parts=Object.fromEntries(ny.formatToParts(at).map(p=>[p.type,p.value]));
  if(['Sat','Sun'].includes(parts.weekday))return 'weekend';
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if(minute>=570&&minute<585)return 'open_window';
  if(minute>=945&&minute<960)return 'close_window';
  if(minute>=570&&minute<960)return 'regular';
  if(minute>=240&&minute<570)return 'premarket';
  if(minute>=960&&minute<1200)return 'afterhours';
  return 'overnight';
}
export class ObservationRecorder {
  readonly runId=randomUUID();
  private state: any;
  private previous = new Map<string,{at:number;healthy:boolean;eligible:boolean}>();
  private eventsPath: string;
  constructor(readonly out: string, symbols: string[], private maxGapMs: number, readonly configHash: string) {
    if(!Number.isFinite(maxGapMs)||maxGapMs<=0)throw new Error('Invalid sample gap');
    mkdirSync(out,{recursive:true});
    const file=join(out,'status.json');
    this.state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):
      {schemaVersion:2,configHash,startedAt:null,lastSampleAt:null,coverage:{},runs:0};
    if(this.state.schemaVersion!==2||this.state.configHash!==configHash)throw new Error('Output belongs to a different configuration or schema; choose a new directory');
    for(const symbol of symbols) {
      this.state.coverage[symbol]??={samples:0,healthySamples:0,healthyMs:0,eligibleMs:0,gapMs:0,maxGapMs:0,maxUnhealthyMs:0,currentUnhealthyMs:0,lastSampleAt:null,sessions:{},suppressions:{},proposals:0};
      for(const key of ['samples','healthySamples','healthyMs','eligibleMs','gapMs','maxGapMs']) {
        if(!Number.isFinite(this.state.coverage[symbol][key])||this.state.coverage[symbol][key]<0)throw new Error('Invalid retained coverage');
      }
    }
    this.eventsPath=join(out,`observations-${this.runId}.jsonl`);
    this.state.runs++;
    this.event({type:'run_started',at:Date.now(),runId:this.runId});
  }
  event(record: any) { appendFileSync(this.eventsPath,JSON.stringify(record)+'\n'); }
  sample(symbol: string, at: number, healthy: boolean, evaluation: any, inputs: any) {
    const c=this.state.coverage[symbol]; if(!c)throw new Error('Unconfigured sample symbol');
    // Assumption-based proposals are research output, not verified unit evidence.
    const eligible=healthy && evaluation.quotes.length>0 && evaluation.unitAssumption!=='market_parity';
    const last=this.previous.get(symbol);
    if(last) {
      const dt=at-last.at;
      if(dt<0)throw new Error('Sample clock moved backwards');
      c.maxGapMs=Math.max(c.maxGapMs,dt);
      if(dt<=this.maxGapMs && healthy && last.healthy) {
        c.healthyMs+=dt;
        // Do not assign an interval crossing a session boundary entirely to one session.
        const band=sessionBand(at); if(sessionBand(last.at)===band)c.sessions[band]=(c.sessions[band]??0)+dt;
        c.currentUnhealthyMs=0;
      } else {c.gapMs+=dt;c.currentUnhealthyMs+=dt;c.maxUnhealthyMs=Math.max(c.maxUnhealthyMs,c.currentUnhealthyMs);}
      if(dt<=this.maxGapMs && eligible && last.eligible)c.eligibleMs+=dt;
    } else if(c.lastSampleAt!==null) {
      const gap=Math.max(0,at-c.lastSampleAt);c.gapMs+=gap;c.maxGapMs=Math.max(c.maxGapMs,gap);
      c.currentUnhealthyMs+=gap;c.maxUnhealthyMs=Math.max(c.maxUnhealthyMs,c.currentUnhealthyMs);
    }
    this.previous.set(symbol,{at,healthy,eligible});
    c.lastSampleAt=at;
    c.latest={at,healthy,reasons:evaluation.reasons,referenceSourceAt:inputs.reference?.sourceAt,targetSourceAt:inputs.target?.sourceAt,fxSourceAt:inputs.fx?.sourceAt};
    c.samples++;if(healthy)c.healthySamples++;
    c.proposals+=evaluation.quotes.length;
    for(const reason of evaluation.reasons)c.suppressions[reason]=(c.suppressions[reason]??0)+1;
    this.state.startedAt??=at;
    this.state.lastSampleAt=at;
    this.event({type:'sample',runId:this.runId,symbol,at,healthy,evaluation,inputs});
  }
  save(at: number, feeds: any, requiredHours: number, stopped = false) {
    this.state.updatedAt=new Date(at).toISOString();
    this.state.runId=this.runId;this.state.stopped=stopped;this.state.feeds=feeds;
    this.state.sessionCalendar='America/New_York weekday time bands; holidays not classified';
    this.state.requiredHealthyHours=requiredHours;
    const coverage=Object.values(this.state.coverage) as any[];
    this.state.observationHoursComplete=coverage.every(c=>c.healthyMs>=requiredHours*3600000);
    this.state.normalizedEvidenceHoursComplete=coverage.every(c=>c.eligibleMs>=requiredHours*3600000);
    this.state.pilotReady=false;
    this.state.pilotDecision='Not authorized: requires representative coverage, verified mapping and operational review';
    const tmp=join(this.out,`status.${this.runId}.tmp`);
    writeFileSync(tmp,JSON.stringify(this.state,null,2)+'\n');renameSync(tmp,join(this.out,'status.json'));
    return this.state;
  }
}
