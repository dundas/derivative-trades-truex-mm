import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PublicFeed} from '../src/equities/feeds';
class Socket extends EventEmitter {sent:any[]=[];send(s:string){this.sent.push(JSON.parse(s));}terminate(){this.emit('close');}}
const options={url:'wss://stream.data.alpaca.markets/v2/sip',connectTimeoutMs:1000,silenceTimeoutMs:1000,reconnectMinMs:5,reconnectMaxMs:10,
 alpaca:{key:'fixture-key',secret:'fixture-secret',quoteUnitsPerLot:{NVDA:100}}};
function auth(socket:Socket){socket.emit('message',JSON.stringify([{T:'success',msg:'authenticated'}]));socket.emit('message',JSON.stringify([{T:'subscription',quotes:['NVDA']}]));}
function quote(at=Date.now()){return JSON.stringify([{T:'q',S:'NVDA',bp:200,ap:201,bs:2,as:3,t:new Date(at).toISOString()}]);}
test('Alpaca waits for auth and subscription, converts round lots and retains timestamps',()=>{
 const s=new Socket();const f=new PublicFeed('alpaca',['NVDA'],options,()=>{},()=>s);
 try{f.start();s.emit('open');expect(f.connected).toBe(false);expect(s.sent[0].action).toBe('auth');
 s.emit('message',quote());expect(f.quotes.size).toBe(0);
 auth(s);expect(f.connected).toBe(true);expect(s.sent[1]).toEqual({action:'subscribe',quotes:['NVDA'],trades:[]});
 const at=Date.now();s.emit('message',quote(at));expect(f.quotes.get('NVDA')).toMatchObject({bid:200,ask:201,bidSize:200,askSize:300,sourceAt:at});
 }finally{f.stop();}
});
test('Alpaca reconnect reauthenticates before restoring quotes and rejects delayed updates',async()=>{
 const sockets:Socket[]=[];const f=new PublicFeed('alpaca',['NVDA'],options,()=>{},()=>{const s=new Socket();sockets.push(s);return s;});
 try{f.start();sockets[0].emit('open');auth(sockets[0]);const at=Date.now();sockets[0].emit('message',quote(at));
 sockets[0].emit('message',quote(at-10));expect(f.quotes.size).toBe(0);
 sockets[0].emit('close');await Bun.sleep(20);sockets[1].emit('open');expect(f.connected).toBe(false);expect(sockets[1].sent[0].action).toBe('auth');
 sockets[0].emit('message',quote());expect(f.quotes.size).toBe(0);
 auth(sockets[1]);sockets[1].emit('message',quote());expect(f.quotes.size).toBe(1);
 }finally{f.stop();}
});
test('Alpaca entitlement errors stop the source and do not log reflected secrets',async()=>{
 const events:any[]=[];const s=new Socket();const f=new PublicFeed('alpaca',['NVDA'],options,e=>events.push(e),()=>s);
 f.start();s.emit('open');auth(s);s.emit('message',quote());s.emit('message',JSON.stringify([{T:'error',code:409,msg:'fixture-key fixture-secret'}]));
 expect(f.connected).toBe(false);expect(f.quotes.size).toBe(0);await Bun.sleep(20);expect(f.reconnects).toBe(0);
 expect(JSON.stringify(events)).not.toContain('fixture-secret');expect(JSON.stringify(events)).not.toContain('fixture-key');expect(events.some(e=>e.type==='provider_error'&&e.code===409)).toBe(true);f.stop();
});
test('Alpaca refuses credentials sent to other hosts, missing size units and delayed endpoints',()=>{
 expect(()=>new PublicFeed('alpaca',['NVDA'],{...options,url:'wss://other.invalid/v2/sip'})).toThrow('endpoint');
 expect(()=>new PublicFeed('alpaca',['NVDA'],{...options,url:'wss://stream.data.alpaca.markets/v2/delayed_sip'})).toThrow('endpoint');
 expect(()=>new PublicFeed('alpaca',['NVDA'],{...options,alpaca:{...options.alpaca,quoteUnitsPerLot:{}}})).toThrow('units per lot');
 expect(()=>new PublicFeed('alpaca',['NVDA'],{...options,alpaca:{...options.alpaca,key:''}})).toThrow('credentials');
});
test('Alpaca refuses incomplete subscriptions and malformed frames without preserving prices',()=>{
 const s=new Socket();const f=new PublicFeed('alpaca',['NVDA'],options,()=>{},()=>s);
 try{f.start();s.emit('open');s.emit('message',JSON.stringify([{T:'subscription',quotes:['NVDA']}]));expect(f.connected).toBe(false);
 }finally{f.stop();}
 const socket=new Socket();const g=new PublicFeed('alpaca',['NVDA'],options,()=>{},()=>socket);
 try{g.start();socket.emit('open');auth(socket);socket.emit('message',quote());socket.emit('message','{}');expect(g.connected).toBe(false);expect(g.quotes.size).toBe(0);}finally{g.stop();}
});
