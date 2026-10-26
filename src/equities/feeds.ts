import WebSocket from 'ws';
import { bboProblem, type Bbo, type Limits } from './shadow';

export interface SocketOptions {
  url: string; connectTimeoutMs: number; silenceTimeoutMs: number;
  reconnectMinMs: number; reconnectMaxMs: number;
  observeActivity?: boolean;
  alpaca?: {key:string;secret:string;quoteUnitsPerLot:Record<string,number>};
}
type Factory = (url: string) => any;
export class PublicFeed {
  readonly quotes = new Map<string,Bbo>();
  readonly active = new Set<string>();
  connected = false;
  reconnects = 0;
  lastMessageAt = 0;
  observe(symbol: string, now: number, limits: Limits) {
    const q=this.quotes.get(symbol);
    return {connected:this.connected,lastMessageAt:this.lastMessageAt,
      transportAlive:this.connected && now-this.lastMessageAt<=this.options.silenceTimeoutMs,
      quoteProblem:bboProblem(q,now,limits),
      quoteAgeMs:q?now-q.sourceAt:null,receiptAgeMs:q?now-q.receivedAt:null};
  }
  private socket: any;
  private running = false;
  private attempts = 0;
  private lastSourceAt = new Map<string,number>();
  private authenticated = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  constructor(readonly venue: 'kraken'|'truemarkets'|'alpaca', readonly symbols: string[],
    private options: SocketOptions,
    private event: (event: any) => void = ()=>{},
    private factory: Factory = url => new WebSocket(url)) {
    if (!symbols.length || !['ws:','wss:'].includes(new URL(options.url).protocol)) throw new Error('Invalid feed configuration');
    for(const field of ['connectTimeoutMs','silenceTimeoutMs','reconnectMinMs','reconnectMaxMs']) {
      if (!Number.isFinite(options[field]) || options[field]<=0) throw new Error(`Invalid ${field}`);
    }
    if(options.reconnectMinMs>options.reconnectMaxMs) throw new Error('Reconnect minimum exceeds maximum');
    if(venue==='alpaca') {
      const url=new URL(options.url);
      if(url.protocol!=='wss:' || !['stream.data.alpaca.markets','stream.data.sandbox.alpaca.markets'].includes(url.host) || !['/v2/iex','/v2/sip','/v2/test'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Alpaca market-data endpoint');
      if(!options.alpaca?.key || !options.alpaca?.secret)throw new Error('Alpaca market-data credentials required');
      for(const symbol of symbols)if(!Number.isFinite(options.alpaca.quoteUnitsPerLot[symbol]) || options.alpaca.quoteUnitsPerLot[symbol]<=0)throw new Error('Alpaca quote units per lot required for each symbol');
    }
  }
  start() {
    if(this.running) return;
    this.running=true;
    this.open();
    this.watchdog=setInterval(()=>{
      if(this.connected && Date.now()-this.lastMessageAt>this.options.silenceTimeoutMs) this.fault('transport_silence');
    },Math.min(1000,this.options.silenceTimeoutMs/3));
  }
  stop() {
    this.running=false;
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectTimer); clearInterval(this.watchdog);
    this.reconnectTimer=undefined;
    const old=this.socket; this.socket=undefined; old?.terminate();
    this.invalidate('stopped');
  }
  private invalidate(reason: string) {
    this.connected=false; this.authenticated=false; this.quotes.clear(); this.active.clear(); this.lastSourceAt.clear();
    this.event({type:'feed_state',venue:this.venue,connected:false,reason,at:Date.now()});
  }
  private fault(reason: string) {
    if(!this.running) return;
    clearTimeout(this.connectTimer);
    const old=this.socket; this.socket=undefined;
    this.invalidate(reason); old?.terminate();
    if(this.reconnectTimer) return;
    const delay=Math.min(this.options.reconnectMaxMs,this.options.reconnectMinMs*2**Math.min(this.attempts++,12));
    this.reconnects++;
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=undefined;this.open();},delay);
  }
  private open() {
    if(!this.running) return;
    let socket: any;
    try { socket=this.factory(this.options.url); } catch { this.fault('socket_creation_failed'); return; }
    this.socket=socket;
    const current=()=>this.running && this.socket===socket;
    this.connectTimer=setTimeout(()=>{if(current())this.fault('connect_timeout');},this.options.connectTimeoutMs);
    socket.on('open',()=>{
      if(!current()) return;
      if(this.venue==='alpaca') {
        this.lastMessageAt=Date.now();
        socket.send(JSON.stringify({action:'auth',key:this.options.alpaca!.key,secret:this.options.alpaca!.secret}));
        // Keep the deadline until authentication and subscription are confirmed.
        return;
      }
      clearTimeout(this.connectTimer);
      this.connected=true; this.lastMessageAt=Date.now();
      this.event({type:'feed_state',venue:this.venue,connected:true,at:Date.now()});
      if(this.venue==='kraken') socket.send(JSON.stringify({method:'subscribe',params:{channel:'ticker',symbol:this.symbols,event_trigger:'bbo',snapshot:true}}));
      else socket.send(JSON.stringify({type:'SUBSCRIBE_NO_AUTH',item_names:this.symbols,
        channels:['INSTRUMENT','EBBO','HEARTBEAT',...(this.options.observeActivity?['DEPTH','TRADE']:[])],timestamp:String(Math.floor(Date.now()/1000))}));
    });
    socket.on('message',(raw: any)=>{if(current()){this.lastMessageAt=Date.now();this.ingest(raw.toString());}});
    socket.on('error',()=>{if(current())this.fault('socket_error');});
    socket.on('close',()=>{if(current())this.fault('socket_closed');});
  }
  ingest(raw: string, receivedAt=Date.now()) {
    let m: any;
    try { m=JSON.parse(raw); } catch { this.fault('malformed_json');return; }
    if(this.venue==='alpaca') {this.ingestAlpaca(m,receivedAt);return;}
    if (!m || typeof m!=='object' || Array.isArray(m)) {this.fault('malformed_message');return;}
    this.lastMessageAt=receivedAt;
    if (m.success===false || ['ERROR','UNAUTHORIZED'].includes(m.status)) {this.fault('subscription_rejected');return;}
    if(m.channel==='HEARTBEAT'||m.channel==='heartbeat')this.event({type:'heartbeat',venue:this.venue,at:receivedAt});
    if (this.venue==='kraken') {
      if(m.channel==='status' && m.data?.some((d:any)=>d.system!=='online')) {this.fault('exchange_not_online');return;}
      if(m.channel!=='ticker')return;
      if(!Array.isArray(m.data)) {this.fault('malformed_ticker');return;}
      for(const d of m.data) {
        if(!d || !this.symbols.includes(d.symbol))continue;
        this.accept({symbol:d.symbol,bid:Number(d.bid),ask:Number(d.ask),bidSize:Number(d.bid_qty),askSize:Number(d.ask_qty),
          sourceAt:Date.parse(d.timestamp),receivedAt});
      }
    } else {
      if(this.options.observeActivity && ['DEPTH','TRADE'].includes(m.channel)) {
        const symbol=m.data?.symbol??m.item;
        if(this.symbols.includes(symbol))this.event({type:'market_activity',venue:this.venue,at:receivedAt,message:m});
      }
      if(m.channel==='INSTRUMENT' && m.data?.info?.symbol) {
        const symbol=m.data.info.symbol;
        if(this.symbols.includes(symbol)) {
          if(m.data.status==='ACTIVE')this.active.add(symbol);
          else {this.active.delete(symbol);this.quotes.delete(symbol);}
        }
      }
      if(m.channel==='EBBO' && m.data?.symbol) {
        const d=m.data;
        if(!this.symbols.includes(d.symbol))return;
        let sourceAt=NaN;
        try {if(/^\d+$/.test(d.info?.last_update)) sourceAt=Number(BigInt(d.info.last_update)/1000000n);}catch{}
        this.accept({symbol:d.symbol,bid:Number(d.info?.best_bid?.price),ask:Number(d.info?.best_ask?.price),
          bidSize:Number(d.info?.best_bid?.qty),askSize:Number(d.info?.best_ask?.qty),sourceAt,receivedAt});
      }
    }
  }
  private ingestAlpaca(messages:any, receivedAt:number) {
    if(!Array.isArray(messages) || !messages.length) {this.fault('malformed_message');return;}
    this.lastMessageAt=receivedAt;
    for(const m of messages) {
      if(!m || typeof m!=='object' || Array.isArray(m)){this.fault('malformed_message');return;}
      if(m.T==='error') {
        // Never retain server-supplied messages: they may reflect credentials.
        this.event({type:'provider_error',venue:this.venue,code:Number.isInteger(m.code)?m.code:null,at:receivedAt});
        if([400,401,402,403,404,405,406,409].includes(m.code))this.stop();
        else this.fault('provider_error');
        return;
      }
      if(m.T==='success' && m.msg==='authenticated') {
        this.authenticated=true;
        this.socket?.send(JSON.stringify({action:'subscribe',quotes:this.symbols,trades:this.options.observeActivity?this.symbols:[]}));
      }
      if(m.T==='subscription') {
        if(!this.authenticated || !Array.isArray(m.quotes) || !this.symbols.every(s=>m.quotes.includes(s))) {this.fault('subscription_incomplete');return;}
        clearTimeout(this.connectTimer);this.connected=true;
        this.event({type:'feed_state',venue:this.venue,connected:true,at:receivedAt});
      }
      if(m.T==='q' && this.connected && this.symbols.includes(m.S)) {
        const lot=this.options.alpaca!.quoteUnitsPerLot[m.S];
        this.accept({symbol:m.S,bid:Number(m.bp),ask:Number(m.ap),bidSize:Number(m.bs)*lot,askSize:Number(m.as)*lot,
          sourceAt:Date.parse(m.t),receivedAt});
      }
      if(m.T==='t' && this.connected && this.options.observeActivity && this.symbols.includes(m.S)) {
        this.event({type:'market_activity',venue:this.venue,at:receivedAt,message:{channel:'TRADE',update:'UPDATE',data:{symbol:m.S,info:{price:m.p,qty:m.s,timestamp:m.t}}}});
      }
    }
  }
  private accept(quote: Bbo) {
    if(![quote.bid,quote.ask,quote.bidSize,quote.askSize,quote.sourceAt].every(v=>Number.isFinite(v)&&v>0) || quote.bid>=quote.ask) {
      this.quotes.delete(quote.symbol);
      this.event({type:'invalid_quote',venue:this.venue,symbol:quote.symbol,at:quote.receivedAt});return;
    }
    // Keep the timestamp after invalidating the cached quote, so a sequence of
    // delayed updates cannot restore an older price after the first rejection.
    const previousSourceAt=this.lastSourceAt.get(quote.symbol);
    if(previousSourceAt!==undefined && quote.sourceAt<previousSourceAt) {
      this.quotes.delete(quote.symbol);this.event({type:'out_of_order_quote',venue:this.venue,symbol:quote.symbol,
        sourceAt:quote.sourceAt,previousSourceAt,at:quote.receivedAt});return;
    }
    this.attempts=0;
    this.lastSourceAt.set(quote.symbol,quote.sourceAt);
    this.quotes.set(quote.symbol,quote);
  }
}
