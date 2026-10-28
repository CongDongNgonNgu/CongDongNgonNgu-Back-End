'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { probe, identity } = require('./endpoint-correlation.cjs');
const required = process.env.CDNN_CORRELATION_LINUX_REQUIRED === '1';
const enabled = process.platform === 'linux' && process.getuid() === 0 && required;
if (required) test('mandatory Linux suite requires existing root proc visibility', () => { assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); });
async function fixture(mode, host) {
 const child = fork(path.join(__dirname, 'endpoint-correlation-fixture.cjs'), [mode, host || '127.0.0.1'], { stdio: ['ignore','ignore','ignore','ipc'], env: {} });
 const [{port}] = await once(child, 'message');
 const current = identity(child.pid);
 return { child, options: { pid:child.pid, startTicks:current.startTicks, expectedCwd:current.cwd, expectedExecutable:current.exe, expectedUid:current.uid, port }, stop:async () => { child.send('stop'); await once(child,'exit'); } };
}
for (const host of ['127.0.0.1', '::']) test(`Linux exact accepted stream succeeds with ${host} listener and parallel client`, {skip:!enabled}, async () => {
 const f = await fixture('healthy',host);
 const net = require('node:net'); const parallel = net.connect(f.options.port,'127.0.0.1'); await once(parallel,'connect');
 try { const result=await probe(f.options); assert.equal(result.status,'PASS_CONNECTION_OWNERSHIP_CORRELATED',JSON.stringify(result)); assert.equal(result.ownershipAfter,true); }
 finally { parallel.destroy(); await f.stop(); }
});
for (const [mode, reason, status] of [['early',null,null],['close',null,200],['timeout','TIMEOUT',null],['drift','PROCESS_IDENTITY_CHANGED',200],['malformed200','APPLICATION_HEALTH_MISMATCH',200],['malformed503','APPLICATION_HEALTH_MISMATCH',503],['trailing','HTTP_TRAILING_DATA',null],['shared','ACCEPTED_SOCKET_SHARED',null],['transfer','SOCKET_OWNERSHIP_MISMATCH',200]]) test(`Linux rejects ${mode} without private output`,{skip:!enabled},async()=>{
 const f=await fixture(mode);
 try { const result=await probe({...f.options,timeoutMs:mode==='timeout'?500:5000}); assert.equal(result.status,'UNVERIFIED'); if(reason)assert.equal(result.reasonCode,reason,JSON.stringify(result)); if(status!==null)assert.equal(result.httpStatus,status); assert.doesNotMatch(JSON.stringify(result),/private|credential/); }
 finally { await f.stop(); }
});
test('Linux wrong PID, start identity, cwd, executable and UID fail closed',{skip:!enabled},async()=>{
 const f=await fixture('healthy');
 try {
  for(const patch of [{pid:process.pid},{startTicks:'0'},{expectedCwd:'/'},{expectedExecutable:'/not-node'},{expectedUid:999999}])assert.equal((await probe({...f.options,...patch,timeoutMs:500})).status,'UNVERIFIED');
 }finally{await f.stop();}
});
test('Linux shared listener alone does not disprove exact accepted ownership',{skip:!enabled},async()=>{
 const f=await fixture('sharedlistener');
 try{const result=await probe(f.options);assert.equal(result.status,'PASS_CONNECTION_OWNERSHIP_CORRELATED',JSON.stringify(result));}finally{await f.stop();}
});
test('Linux current app cwd drift is rejected',{skip:!enabled},async()=>{
 const f=await fixture('healthy');try{f.child.send('chdir');await once(f.child,'message');assert.equal((await probe(f.options)).reasonCode,'PROCESS_EXPECTATION_MISMATCH');}finally{await f.stop();}
});
test('Linux missing process and unavailable listener fail closed',{skip:!enabled},async()=>{
 const f=await fixture('healthy');await f.stop();assert.equal((await probe(f.options)).status,'UNVERIFIED');
 const current=identity(process.pid);const result=await probe({pid:process.pid,startTicks:current.startTicks,expectedCwd:current.cwd,expectedExecutable:current.exe,expectedUid:current.uid,port:f.options.port,timeoutMs:500});assert.equal(result.status,'UNVERIFIED');
});

test('Linux insufficient existing permissions cannot become exclusive ownership',{skip:!enabled},async()=>{
 const f=await fixture('healthy');
 try{
  const {spawnSync}=require('node:child_process');
  const program='require('+JSON.stringify(path.join(__dirname,'endpoint-correlation.cjs'))+').probe('+JSON.stringify(f.options)+').then(r=>console.log(JSON.stringify(r)))';
  const child=spawnSync(process.execPath,['-e',program],{uid:65534,gid:65534,cwd:'/tmp',env:{},encoding:'utf8',timeout:7000});
  assert.equal(child.status,0);const result=JSON.parse(child.stdout);assert.equal(result.status,'UNVERIFIED');assert.equal(result.ownershipAfter,false);assert.doesNotMatch(child.stdout,/credential|private|stack/);
 }finally{await f.stop();}
});
test('Linux namespace mismatch fails before opening any connection',{skip:!enabled},async()=>{
 const os=require('node:os');const root=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-namespace-test-'));
 try{
  const pid=123;fs.mkdirSync(path.join(root,String(pid),'ns'),{recursive:true});fs.mkdirSync(path.join(root,'self/ns'),{recursive:true});
  const fields=Array(20).fill('0');fields[19]='42';fs.writeFileSync(path.join(root,String(pid),'stat'),`${pid} (synthetic) ${fields.join(' ')}`);
  fs.symlinkSync('/synthetic/node',path.join(root,String(pid),'exe'));fs.symlinkSync('/synthetic/app',path.join(root,String(pid),'cwd'));
  fs.symlinkSync('net:[100]',path.join(root,String(pid),'ns/net'));fs.symlinkSync('net:[200]',path.join(root,'self/ns/net'));
  const result=await probe({pid,startTicks:'42',expectedCwd:'/synthetic/app',expectedExecutable:'/synthetic/node',expectedUid:fs.statSync(path.join(root,String(pid))).uid,procRoot:root,port:3201});
  assert.equal(result.reasonCode,'PROCESS_EXPECTATION_MISMATCH');assert.equal(result.ownershipBefore,false);assert.equal(result.httpStatus,null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
