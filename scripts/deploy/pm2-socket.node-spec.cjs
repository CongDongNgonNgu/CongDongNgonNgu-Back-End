const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {readRows}=require('./pm2-socket.cjs');
for(const state of ['success','missing','timeout','request-error'])test('connect-only PM2 transport: '+state,async()=>{
 const calls=[],sock=new EventEmitter();let closed=false;
 sock.close=()=>{closed=true;};sock.connect=()=>{if(state==='missing')setImmediate(()=>sock.emit('reconnect attempt'));else if(state!=='timeout')setImmediate(()=>sock.emit('connect'));};
 const axon={socket:kind=>{assert.equal(kind,'req');return sock;}},rpc={Client:class{call(method,args,cb){calls.push(method);assert.deepEqual(args,{});cb(state==='request-error'?Error('secret server error'):null,[{name:'SYNTHETIC'}]);}}};
 if(state==='success')assert.deepEqual(await readRows(axon,rpc,'/synthetic/rpc.sock',20),[{name:'SYNTHETIC'}]);
 else await assert.rejects(readRows(axon,rpc,'/synthetic/rpc.sock',20),/read-only RPC failed/);
 assert.equal(closed,true);assert.deepEqual(calls,state==='success'||state==='request-error'?['getMonitorData']:[]);
});
