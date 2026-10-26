import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PublicFeed } from '../src/equities/feeds';
import example from '../config/equity-shadow.example.json';
class FakeSocket extends EventEmitter {
  sent:any[]=[];
  send(raw:string){this.sent.push(JSON.parse(raw));}
  terminate(){this.emit('close');}
}
const settings={url:'wss://fixture.invalid',connectTimeoutMs:1000,silenceTimeoutMs:1000,reconnectMinMs:5,reconnectMaxMs:10};
const ticker=(symbol='NVDAx/USD',at=Date.now())=>JSON.stringify({channel:'ticker',data:[{symbol,bid:100,ask:101,bid_qty:2,ask_qty:3,timestamp:new Date(at).toISOString()}]});
test('disconnect invalidates prices; reconnect resubscribes and ignores old socket',async()=>{
  const sockets:FakeSocket[]=[];
  const feed=new PublicFeed('kraken',['NVDAx/USD'],settings,()=>{},()=>{const s=new FakeSocket();sockets.push(s);return s;});
  try {
    feed.start();const first=sockets[0];first.emit('open');first.emit('message',ticker());
    expect(feed.quotes.size).toBe(1);expect(first.sent[0].params.event_trigger).toBe('bbo');
    first.emit('close');expect(feed.connected).toBe(false);expect(feed.quotes.size).toBe(0);
    await Bun.sleep(20);expect(sockets.length).toBe(2);sockets[1].emit('open');
    expect(sockets[1].sent.length).toBe(1);
    first.emit('message',ticker());expect(feed.quotes.size).toBe(0);
    sockets[1].emit('message',ticker());expect(feed.quotes.size).toBe(1);
  } finally {feed.stop();}
});
test('malformed or out-of-order prices cannot preserve cached quotes',()=>{
  const feed=new PublicFeed('kraken',['NVDAx/USD'],settings);const at=Date.now();
  feed.ingest(ticker('NVDAx/USD',at));expect(feed.quotes.size).toBe(1);
  feed.ingest(ticker('NVDAx/USD',at-1));expect(feed.quotes.size).toBe(0);
  feed.ingest(ticker('NVDAx/USD',at));
  feed.ingest(JSON.stringify({channel:'ticker',data:[{symbol:'NVDAx/USD',bid:101,ask:100,bid_qty:2,ask_qty:2,timestamp:new Date().toISOString()}]}));
  expect(feed.quotes.size).toBe(0);
});
test('True Markets extracts nanosecond book time and invalidates a halted instrument',()=>{
  const feed=new PublicFeed('truemarkets',['NVDAC-USDC'],settings);const at=Date.now();
  feed.ingest(JSON.stringify({channel:'INSTRUMENT',data:{status:'ACTIVE',info:{symbol:'NVDAC-USDC'}}}));
  feed.ingest(JSON.stringify({channel:'EBBO',data:{symbol:'NVDAC-USDC',info:{last_update:String(BigInt(at)*1000000n),best_bid:{price:'100',qty:'1'},best_ask:{price:'101',qty:'2'}}}}));
  expect(feed.quotes.get('NVDAC-USDC')?.sourceAt).toBe(at);expect(feed.active.has('NVDAC-USDC')).toBe(true);
  feed.ingest(JSON.stringify({channel:'INSTRUMENT',data:{status:'HALTED',info:{symbol:'NVDAC-USDC'}}}));
  expect(feed.active.size).toBe(0);expect(feed.quotes.size).toBe(0);
});
test('consecutive delayed updates stay suppressed until the last accepted timestamp is recovered',()=>{
  const events:any[]=[];
  const feed=new PublicFeed('kraken',['NVDAx/USD'],settings,e=>events.push(e));const at=Date.now();
  feed.ingest(ticker('NVDAx/USD',at));
  feed.ingest(ticker('NVDAx/USD',at-4000));
  feed.ingest(ticker('NVDAx/USD',at-3000));
  expect(feed.quotes.size).toBe(0);
  expect(events.filter(e=>e.type==='out_of_order_quote').length).toBe(2);
  expect(events.at(-1).previousSourceAt).toBe(at);
  expect(events.at(-1).sourceAt).toBe(at-3000);
  feed.ingest(ticker('NVDAx/USD',at+1));
  expect(feed.quotes.get('NVDAx/USD')?.sourceAt).toBe(at+1);
  feed.stop();
  // A new connection establishes its own timestamp baseline.
  feed.ingest(ticker('NVDAx/USD',at-2000));
  expect(feed.quotes.get('NVDAx/USD')?.sourceAt).toBe(at-2000);
});
test('transport silence reconnects and stop cancels retry timers',async()=>{
  const sockets:FakeSocket[]=[];
  const feed=new PublicFeed('kraken',['NVDAx/USD'],{...settings,silenceTimeoutMs:15},()=>{},()=>{const s=new FakeSocket();sockets.push(s);return s;});
  feed.start();sockets[0].emit('open');await Bun.sleep(40);expect(feed.reconnects).toBeGreaterThan(0);
  feed.stop();const count=sockets.length;await Bun.sleep(20);expect(sockets.length).toBe(count);
});
test('heartbeats keep transport live without refreshing an old book or clearing its stale flag',()=>{
  const socket=new FakeSocket();const events:any[]=[];const at=Date.now();
  const feed=new PublicFeed('kraken',['NVDAx/USD'],settings,e=>events.push(e),()=>socket);
  try {
    feed.start();socket.emit('open');feed.ingest(ticker('NVDAx/USD',at),at);
    feed.ingest(JSON.stringify({channel:'heartbeat'}),at+20000);
    const status=feed.observe('NVDAx/USD',at+20001,example.limits);
    expect(status.connected).toBe(true);expect(status.transportAlive).toBe(true);
    expect(status.quoteProblem).toBe('stale');expect(status.quoteAgeMs).toBe(20001);
    expect(status.receiptAgeMs).toBe(20001);expect(events.some(e=>e.type==='heartbeat')).toBe(true);
    expect(feed.observe('NVDAx/USD',at+22000,example.limits).transportAlive).toBe(false);
    socket.emit('close');const disconnected=feed.observe('NVDAx/USD',at+22000,example.limits);
    expect(disconnected.transportAlive).toBe(false);expect(disconnected.quoteProblem).toBe('missing');
  } finally {feed.stop();}
});
test('optional depth and trade observation retains raw updates without treating snapshots as executions',()=>{
  const socket=new FakeSocket();const events:any[]=[];
  const feed=new PublicFeed('truemarkets',['NVDAC-USDC'],{...settings,observeActivity:true},e=>events.push(e),()=>socket);
  try {
    feed.start();socket.emit('open');
    expect(socket.sent[0].channels).toContain('DEPTH');expect(socket.sent[0].channels).toContain('TRADE');
    feed.ingest(JSON.stringify({channel:'DEPTH',update:'UPDATE',data:{symbol:'NVDAC-USDC',bids:[{price:'100',qty:'0'}]}}));
    feed.ingest(JSON.stringify({channel:'TRADE',update:'SNAPSHOT',data:{symbol:'NVDAC-USDC',info:{price:'100',qty:'1'}}}));
    expect(events.filter(e=>e.type==='market_activity').map(e=>e.message.update)).toEqual(['UPDATE','SNAPSHOT']);
    expect(feed.quotes.size).toBe(0);
  } finally {feed.stop();}
});
test('a malformed stream invalidates a live quote and resubscribes on a fresh socket',async()=>{
  const sockets:FakeSocket[]=[];const events:any[]=[];
  const feed=new PublicFeed('kraken',['NVDAx/USD'],settings,e=>events.push(e),()=>{const s=new FakeSocket();sockets.push(s);return s;});
  try {
    feed.start();sockets[0].emit('open');sockets[0].emit('message',ticker());
    expect(feed.quotes.size).toBe(1);
    sockets[0].emit('message','{"channel":"ticker","data":');
    expect(feed.connected).toBe(false);expect(feed.quotes.size).toBe(0);
    expect(events.some(e=>e.reason==='malformed_json')).toBe(true);
    await Bun.sleep(20);sockets[1].emit('open');
    expect(sockets[1].sent[0].params.symbol).toEqual(['NVDAx/USD']);
    expect(feed.quotes.size).toBe(0);
    sockets[1].emit('message',ticker());expect(feed.quotes.size).toBe(1);
  } finally {feed.stop();}
});
