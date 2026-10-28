'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('PM2 rehearsal refuses missing isolated tooling before any daemon command and emits only sanitized failure',()=>{
 const r=spawnSync(process.execPath,[path.join(__dirname,'pm2-recovery-rehearsal.cjs')],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(r.status,1);const summary=JSON.parse(r.stdout);assert.equal(summary.result,'FAIL');assert.equal(summary.failedStage,'preflight');assert.deepEqual(summary.checks,{});assert.equal(r.stderr,'');
});
