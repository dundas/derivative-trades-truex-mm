import {bboProblem,type Bbo,type Limits} from './shadow';
export interface TastytradeOptions {
  url:string;clientId?:string;clientSecret:string;refreshToken:string;
  pollMs:number;requestTimeoutMs:number;silenceTimeoutMs:number;retryMaxMs:number;
  quoteSizeMultiplier:number;
}
class RequestError extends Error {constructor(readonly status:number){super(`tastytrade HTTP ${status}`);}}
export class TastytradeFeed {
  readonly venue='tastytrade';readonly quotes=new Map<string,Bbo>();
  connected=false;lastMessageAt=0;reconnects=0;
  private running=false;private generation=0;private timer?:ReturnType<typeof setTimeout>;private controller?:AbortController;
  private token='';private expiresAt=0;private failures=0;private lastSourceAt=new Map<string,number>();
  constructor(readonly symbols:string[],private options:TastytradeOptions,private event:(e:any)=>void=()=>{},private http:typeof fetch=fetch){
    if(!['https://api.tastyworks.com','https://api.cert.tastyworks.com'].includes(options.url))throw new Error('Unsupported tastytrade REST host');
    if(!symbols.length||symbols.length>100||symbols.some(s=>!/^[A-Z][A-Z0-9.\-]*$/.test(s)))throw new Error('Invalid equity symbols');
    if(!options.clientSecret||!options.refreshToken)throw new Error('Missing tastytrade OAuth credentials');
    for(const key of ['pollMs','requestTimeoutMs','silenceTimeoutMs','retryMaxMs','quoteSizeMultiplier'] as const)if(!Number.isFinite(options[key])||options[key]<=0)throw new Error(`Invalid ${key}`);
    if(options.pollMs<1000||options.retryMaxMs<options.pollMs||options.silenceTimeoutMs<options.pollMs)throw new Error('Invalid tastytrade polling intervals');
  }
  start(){if(this.running)return;this.running=true;void this.tick(++this.generation);}
  stop(){this.running=false;this.generation++;clearTimeout(this.timer);this.controller?.abort();this.invalidate('stopped');}
  observe(symbol:string,now:number,limits:Limits){const q=this.quotes.get(symbol);return {connected:this.connected,lastMessageAt:this.lastMessageAt,
    transportAlive:this.connected&&now-this.lastMessageAt<=this.options.silenceTimeoutMs,quoteProblem:bboProblem(q,now,limits),
    quoteAgeMs:q?now-q.sourceAt:null,receiptAgeMs:q?now-q.receivedAt:null,sourceTimeKind:'provider_updated_at',transport:'REST polling'};}
  private invalidate(reason:string){this.connected=false;this.quotes.clear();this.event({type:'feed_state',venue:this.venue,connected:false,reason,at:Date.now()});}
  private async request(path:string,body?:any){
    const controller=new AbortController();this.controller=controller;const timeout=setTimeout(()=>controller.abort(),this.options.requestTimeoutMs);
    try{
      const r=await this.http(this.options.url+path,{method:body?'POST':'GET',headers:{'User-Agent':'true-markets-equity-research/1.0','Content-Type':'application/json',Accept:'application/json',...(body?{}:{Authorization:`Bearer ${this.token}`})},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:'error'});
      if(!r.ok)throw new RequestError(r.status);return await r.json() as any;
    }finally{clearTimeout(timeout);}
  }
  private async tick(generation:number){
    const current=()=>this.running&&generation===this.generation;
    try{
      if(!this.token||Date.now()>=this.expiresAt){
        const r=await this.request('/oauth/token',{grant_type:'refresh_token',refresh_token:this.options.refreshToken,client_secret:this.options.clientSecret,...(this.options.clientId?{client_id:this.options.clientId}:{}),scope:'read'});
        if(!current())return;
        const token=r.access_token??r.data?.access_token;const expires=Number(r.expires_in??900);
        if(typeof token!=='string'||!token||!Number.isFinite(expires)||expires<=0)throw new Error('Invalid OAuth response');
        this.token=token;this.expiresAt=Date.now()+Math.max(0,expires*1000-Math.min(30000,expires*100));
      }
      const r=await this.request('/market-data/by-type?equity='+encodeURIComponent(this.symbols.join(',')));
      if(!current())return;
      if(!Array.isArray(r.data?.items))throw new Error('Invalid quote response');
      const at=Date.now();this.lastMessageAt=at;this.connected=true;this.failures=0;
      for(const symbol of this.symbols){
        const rows=r.data.items.filter((q:any)=>q.symbol===symbol);const q=rows[0];
        if(rows.length!==1||q['is-trading-halted']!==false||q['instrument-type']!=='Equity'){this.quotes.delete(symbol);this.event({type:'invalid_quote',venue:this.venue,symbol,reason:'missing_duplicate_halted_or_wrong_type',at});continue;}
        const bbo:Bbo={symbol,bid:Number(q.bid),ask:Number(q.ask),bidSize:Number(q['bid-size'])*this.options.quoteSizeMultiplier,askSize:Number(q['ask-size'])*this.options.quoteSizeMultiplier,sourceAt:Date.parse(q['updated-at']),receivedAt:at,sourceTimeKind:'provider_updated_at'};
        if(![bbo.bid,bbo.ask,bbo.bidSize,bbo.askSize,bbo.sourceAt].every(v=>Number.isFinite(v)&&v>0)||bbo.bid>=bbo.ask){this.quotes.delete(symbol);this.event({type:'invalid_quote',venue:this.venue,symbol,at});continue;}
        const prior=this.lastSourceAt.get(symbol);
        if(prior!==undefined&&bbo.sourceAt<prior){this.quotes.delete(symbol);this.event({type:'out_of_order_quote',venue:this.venue,symbol,sourceAt:bbo.sourceAt,previousSourceAt:prior,at});continue;}
        this.lastSourceAt.set(symbol,bbo.sourceAt);this.quotes.set(symbol,bbo);
      }
      this.event({type:'quote_poll',venue:this.venue,at,acceptedSymbols:[...this.quotes.keys()],sourceTimeKind:'provider_updated_at'});
    }catch(error){
      if(!current())return;
      const status=error instanceof RequestError?error.status:null;
      if(status===401){this.token='';this.expiresAt=0;}
      this.invalidate('request_failed');this.failures++;this.reconnects++;
      this.event({type:'provider_error',venue:this.venue,code:status,at:Date.now()});
      if(status===400||status===403){this.running=false;return;}
    }
    if(current()){const delay=Math.min(this.options.retryMaxMs,this.options.pollMs*2**Math.min(this.failures,8));this.timer=setTimeout(()=>void this.tick(generation),delay);}
  }
}
