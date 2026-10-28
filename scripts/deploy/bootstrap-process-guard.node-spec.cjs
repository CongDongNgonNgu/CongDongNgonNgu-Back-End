'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {captureIdentity,assertIdentity}=require('./bootstrap-process-guard.cjs');
const initial={pid:41,startTicks:'991',restartCount:0};
test('missing or incomplete process evidence is rejected',()=>{
 for(const guard of [undefined,()=>null,()=>({...initial,restartCount:null}),()=>({...initial,startTicks:''}),()=>({...initial,pid:0})])assert.throws(()=>captureIdentity(guard),e=>e.code==='PROCESS_IDENTITY_UNVERIFIED');
});
test('stable identity accepted; PID, kernel start or restart drift rejected',()=>{
 assert.deepEqual(captureIdentity(()=>initial),initial);assertIdentity(()=>initial,initial);
 for(const changed of [{pid:42},{startTicks:'992'},{restartCount:1}])assert.throws(()=>assertIdentity(()=>({...initial,...changed}),initial),e=>e.code==='PROCESS_DRIFT');
});
test('process inspection failure is sanitized',()=>{
 assert.throws(()=>captureIdentity(()=>{throw Error('PRIVATE_SYNTHETIC_VALUE');}),e=>e.code==='PROCESS_IDENTITY_UNVERIFIED'&&!e.message.includes('PRIVATE'));
});
