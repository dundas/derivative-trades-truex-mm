import type {FeedQuote} from '../truemarkets/runtime';
export function overnightQuote(body:any,symbol:string,receivedAt:number,previousAt=0):FeedQuote {
 const q=body?.quote, sourceAt=Date.parse(q?.t);
 if(body?.symbol!==symbol || !q || ![q.bp,q.ap,q.bs,q.as].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0) ||
   q.bp>=q.ap || !Number.isFinite(sourceAt) || sourceAt<=0 || sourceAt>receivedAt || sourceAt<previousAt) throw Error('Invalid overnight quote');
 return {symbol,bid:q.bp,ask:q.ap,sourceAt,receivedAt,sourceTimeKind:'alpaca_overnight_indicative'};
}
/** Free Alpaca overnight feed: indicative quote, never labelled NBBO or direct BOATS. */
export class AlpacaOvernightFeed {
 readonly quotes=new Map<string,FeedQuote>(); connected=false;
 private running=false;private generation=0;private timer?:ReturnType<typeof setTimeout>;private abort?:AbortController;private previousAt=0;
 constructor(private symbol:string,private options:{key:string;secret:string;pollMs:number;timeoutMs:number},private http:typeof fetch=fetch){
  if(!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)||!options.key||!options.secret||!Number.isInteger(options.pollMs)||options.pollMs<1000||options.pollMs>5000||!Number.isInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>3000)throw Error('Invalid overnight feed configuration');
 }
 start(){if(this.running)return;this.running=true;void this.poll(++this.generation);}
 stop(){this.running=false;this.generation++;clearTimeout(this.timer);this.abort?.abort();this.connected=false;this.quotes.clear();}
 private async poll(generation:number){
  const current=()=>this.running&&generation===this.generation;
  const controller=new AbortController();this.abort=controller;const timeout=setTimeout(()=>controller.abort(),this.options.timeoutMs);
  try {
   const response=await this.http('https://data.alpaca.markets/v2/stocks/'+encodeURIComponent(this.symbol)+'/quotes/latest?feed=overnight',{
     headers:{'APCA-API-KEY-ID':this.options.key,'APCA-API-SECRET-KEY':this.options.secret},signal:controller.signal,redirect:'error'});
   if(!response.ok)throw Error('Overnight feed unavailable');
   const body=await response.json();if(!current())return;
   const quote=overnightQuote(body,this.symbol,Date.now(),this.previousAt);
   this.previousAt=quote.sourceAt;this.quotes.set(this.symbol,quote);this.connected=true;
  }catch{if(current()){this.connected=false;this.quotes.clear();}}
  finally{clearTimeout(timeout);}
  if(current())this.timer=setTimeout(()=>void this.poll(generation),this.options.pollMs);
 }
}
