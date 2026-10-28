'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'bootstrap.cjs'),'utf8');
for(const scenario of ['pass','unverified','malformed','exit-failed'])test('locked backend CLI correlation gate: '+scenario,()=>{
 const calls=[],output=[],processStub={platform:'linux',argv:['node','bootstrap.cjs','--apply','--approve','fixture'],env:{PATH:'/synthetic',PM2_HOME:'/synthetic/.pm2',CDNN_BOOTSTRAP_LOCKED:'1'},execPath:'/synthetic/node',exitCode:0};let applied=false;
 const runtime={metadata:{},independentEvidence:{}};
 const fakeCore={apply:(cfg,evidence,approval,options)=>{assert.equal(approval,'fixture');assert.equal(typeof options.processGuard,'function');options.verify();applied=true;return {state:'verified'};}};
 const requireStub=name=>{
  if(name==='node:fs')return {};
  if(name==='node:os')return {userInfo:()=>({username:'cdnn-deploy'})};
  if(name==='node:path')return path;
  if(name==='node:child_process')return {spawnSync:(node,args,options)=>{calls.push(path.basename(args[0]));assert.equal(node,'/synthetic/node');assert.equal(options.env.NODE_OPTIONS,undefined);if(path.basename(args[0])==='endpoint-correlation.cjs')return {status:scenario==='exit-failed'?1:0,stdout:scenario==='malformed'?'NEVER_EMIT_PRIVATE_VALUE':JSON.stringify({status:scenario==='unverified'?'UNVERIFIED':'PASS_CONNECTION_OWNERSHIP_CORRELATED'})};return {status:0};}};
  if(name==='./bootstrap-core.cjs')return fakeCore;
  if(name==='./bootstrap-config.json')return {app:'backend',baselineSha:'a'.repeat(40)};
  if(name==='./check-runtime.cjs')return {capture:()=>runtime};
  if(name==='./runtime-process.cjs')return {guardedCapture:()=>()=>({pid:1,startTicks:'2',restartCount:0})};
  throw Error('Unexpected dependency');
 };
 vm.runInNewContext(source,{require:requireStub,__dirname:__dirname,process:processStub,console:{log:x=>output.push(String(x)),error:x=>output.push(String(x))}});
 assert.equal(applied,scenario==='pass');assert.equal(processStub.exitCode,scenario==='pass'?0:1);assert.deepEqual(calls,scenario==='pass'?['endpoint-correlation.cjs','verify.cjs']:['endpoint-correlation.cjs']);assert.equal(output.join('\n').includes('NEVER_EMIT_PRIVATE_VALUE'),false);
});
