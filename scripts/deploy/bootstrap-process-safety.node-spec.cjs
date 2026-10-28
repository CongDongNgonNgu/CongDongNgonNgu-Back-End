'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('./bootstrap-core.cjs');
const initial={pid:41001,startTicks:'100001',restartCount:0};
function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-process-guard-'));fs.chmodSync(base,0o700);
 fs.mkdirSync(path.join(base,'dist'));fs.writeFileSync(path.join(base,'dist','main.js'),'module.exports=1');
 fs.mkdirSync(path.join(base,'node_modules','probe'),{recursive:true});fs.writeFileSync(path.join(base,'node_modules','probe','index.js'),'module.exports=1');
 fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({dependencies:{probe:'1'}}));fs.writeFileSync(path.join(base,'package-lock.json'),'{}');fs.writeFileSync(path.join(base,'.env'),'SYNTHETIC_ONLY=1',{mode:0o600});
 const cfg={app:'backend',base,baselineSha:'a'.repeat(40)},snapshot=core.inventory(cfg),runtime={reviewed:true,independentEvidence:{kernel:{pid:initial.pid,startTicks:initial.startTicks},pm2RestartCounter:initial.restartCount}};
 const evidence={schema:1,app:'backend',sourceSha:cfg.baselineSha,...snapshot,provenance:{method:'trusted-build-manifest',reference:'synthetic-fixture',reviewedBy:'fixture'}};
 let current={...initial};const options={runtime,processGuard:()=>current,verify:()=>{}};
 return {base,cfg,evidence,options,change:x=>{current=x;},apply(){return core.apply(cfg,evidence,core.plan(cfg,evidence,runtime).digest,options);},done:()=>fs.rmSync(base,{recursive:true,force:true})};
}
const linux={skip:process.platform!=='linux'};
for(const stage of ['prepared','exchanged'])for(const change of ['pid','startTicks','restartCount','exit'])test('fail closed on '+change+' at '+stage,linux,()=>{
 const f=fixture();try{f.options.checkpoint=n=>{if(n===stage)f.change(change==='exit'?null:{...initial,[change]:change==='startTicks'?'100002':initial[change]+1});};
 assert.throws(()=>f.apply(),e=>['PROCESS_DRIFT','PROCESS_IDENTITY_UNVERIFIED'].includes(e.code)&&e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');
 const live=fs.lstatSync(path.join(f.base,'dist'));assert.equal(live.isSymbolicLink(),stage==='exchanged');
 const journal=JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json')));assert.equal(journal.runtimeRecoveryRequired,true);assert.equal(journal.state,'recovery_stopped');
 if(stage==='exchanged')assert.ok(fs.existsSync(path.join(f.base,'.bootstrap-original-'+f.cfg.baselineSha,'main.js')));
 }finally{f.done();}
});
test('stable failed health restores paths but never claims operational recovery',linux,()=>{
 const f=fixture();try{f.options.verify=()=>{throw Error('injected invalid health');};assert.throws(()=>f.apply(),e=>e.recoveryClassification==='PATH_RESTORED_RUNTIME_UNVERIFIED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());const s=JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json')));assert.equal(s.runtimeRecoveryRequired,true);assert.equal(s.recoveryClassification,'PATH_RESTORED_RUNTIME_UNVERIFIED');}finally{f.done();}
});
test('restart during verification prevents automatic reverse exchange',linux,()=>{
 const f=fixture();try{f.options.verify=()=>{f.change({...initial,restartCount:1});throw Error('health unavailable');};assert.throws(()=>f.apply(),e=>e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});
for(const component of ['package.json','node_modules/probe/index.js','.source-sha','dist/main.js'])test('corrupted staged '+component+' stops recovery without exchange',linux,()=>{
 const f=fixture();try{const r=f.apply();fs.appendFileSync(path.join(r.release,component),'changed');assert.throws(()=>core.recoveryPlan(f.cfg),/Baseline|Dependency/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});
test('manual recovery refuses restarted process and preserves retained original',linux,()=>{
 const f=fixture();try{f.apply();const r=core.recoveryPlan(f.cfg);f.change({...initial,pid:initial.pid+1});assert.throws(()=>core.recover(f.cfg,r.digest,f.options),e=>e.code==='PROCESS_DRIFT');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());assert.ok(fs.existsSync(path.join(f.base,'.bootstrap-original-'+f.cfg.baselineSha,'main.js')));}finally{f.done();}
});
test('drift after partial reverse is classified stopped, never verified rollback',linux,()=>{
 const f=fixture();try{f.apply();const r=core.recoveryPlan(f.cfg);assert.throws(()=>core.recover(f.cfg,r.digest,{...f.options,checkpoint:()=>f.change({...initial,restartCount:1})}),e=>e.code==='PROCESS_DRIFT');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json'))).state,'recovery_stopped');}finally{f.done();}
});
test('mandatory identity gate leaves no bootstrap artifacts',linux,()=>{
 const f=fixture();try{delete f.options.processGuard;assert.throws(()=>f.apply(),e=>e.code==='PROCESS_IDENTITY_UNVERIFIED');assert.equal(fs.existsSync(path.join(f.base,'.releases')),false);}finally{f.done();}
});

for(const stage of ['verify','verified'])test('successful health cannot hide restart at '+stage,linux,()=>{
 const f=fixture();try{if(stage==='verify')f.options.verify=()=>f.change({...initial,restartCount:1});else f.options.checkpoint=n=>{if(n==='verified')f.change({...initial,restartCount:1});};assert.throws(()=>f.apply(),e=>e.code==='PROCESS_DRIFT'&&e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json'))).state,'recovery_stopped');}finally{f.done();}
});
for(const target of ['package.json','node_modules/probe/index.js'])test('root runtime '+target+' drift stops without reverse',linux,()=>{
 const f=fixture();try{f.options.verify=()=>fs.appendFileSync(path.join(f.base,target),'changed');assert.throws(()=>f.apply(),e=>e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});
test('missing legacy journal identity prevents manual recovery',linux,()=>{
 const f=fixture();try{f.apply();const journal=path.join(f.base,'.bootstrap-state.json'),s=JSON.parse(fs.readFileSync(journal));delete s.processIdentity;fs.writeFileSync(journal,JSON.stringify(s));const r=core.recoveryPlan(f.cfg);assert.throws(()=>core.recover(f.cfg,r.digest,f.options),e=>e.code==='PROCESS_IDENTITY_UNVERIFIED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});

test('live original tampering at prepared boundary stops before exchange',linux,()=>{
 const f=fixture();try{f.options.checkpoint=n=>{if(n==='prepared')fs.appendFileSync(path.join(f.base,'dist','main.js'),'changed');};assert.throws(()=>f.apply(),/Live original artifact changed/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json'))).state,'recovery_stopped');}finally{f.done();}
});
test('successful verification cannot hide staged artifact mutation',linux,()=>{
 const f=fixture();try{f.options.verify=()=>fs.appendFileSync(path.join(f.base,'dist','main.js'),'changed');assert.throws(()=>f.apply(),e=>e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});

test('release source identity symlink is refused even when bytes match',linux,()=>{
 const f=fixture();try{const r=f.apply(),marker=path.join(r.release,'.source-sha'),other=path.join(f.base,'synthetic-marker');fs.writeFileSync(other,f.cfg.baselineSha+'\n');fs.unlinkSync(marker);fs.symlinkSync(other,marker);assert.throws(()=>core.recoveryPlan(f.cfg),/ordinary metadata/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());}finally{f.done();}
});

for(const stage of ['verify','verified'])for(const mutation of ['live-link','backup-content','backup-missing'])test('endpoint '+mutation+' mutation at '+stage+' cannot be accepted',linux,()=>{
 const f=fixture();try{
  const change=()=>{const live=path.join(f.base,'dist'),backup=path.join(f.base,'.bootstrap-original-'+f.cfg.baselineSha);if(mutation==='live-link'){fs.unlinkSync(live);fs.symlinkSync('.bootstrap-original-'+f.cfg.baselineSha,live);}else if(mutation==='backup-content')fs.appendFileSync(path.join(backup,'main.js'),'changed');else fs.renameSync(backup,path.join(f.base,'retained-but-unexpected-original'));};
  if(stage==='verify')f.options.verify=change;else f.options.checkpoint=n=>{if(n==='verified')change();};
  assert.throws(()=>f.apply(),e=>e.recoveryClassification==='STOPPED_RUNTIME_REVIEW_REQUIRED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'.bootstrap-state.json'))).state,'recovery_stopped');
  assert.ok(fs.existsSync(path.join(f.base,'.releases','baseline-'+f.cfg.baselineSha,'dist','main.js')));
  if(mutation==='backup-missing')assert.ok(fs.existsSync(path.join(f.base,'retained-but-unexpected-original','main.js')));
 }finally{f.done();}
});

test('restart during pre-exchange artifact hashing is rejected before mutation',linux,()=>{
 const f=fixture(),originalRead=fs.readSync;let armed=false,mutations=0;try{
  f.options.checkpoint=n=>{if(n==='prepared')armed=true;};f.options.exchange=()=>{mutations++;throw Error('must not exchange');};
  fs.readSync=(...args)=>{const n=originalRead(...args);if(armed){armed=false;f.change({...initial,restartCount:1});}return n;};
  assert.throws(()=>f.apply(),e=>e.code==='PROCESS_DRIFT');assert.equal(mutations,0);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());
 }finally{fs.readSync=originalRead;f.done();}
});
test('restart during recovery artifact hashing is rejected before reverse mutation',linux,()=>{
 const f=fixture(),originalRead=fs.readSync;let armed=false,mutations=0;try{
  f.apply();const r=core.recoveryPlan(f.cfg),guard=f.options.processGuard;
  fs.readSync=(...args)=>{const n=originalRead(...args);if(armed){armed=false;f.change({...initial,restartCount:1});}return n;};
  const processGuard=()=>{const value=guard();armed=true;return value;};
  assert.throws(()=>core.recover(f.cfg,r.digest,{processGuard,exchange:()=>{mutations++;}}),e=>e.code==='PROCESS_DRIFT');assert.equal(mutations,0);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());
 }finally{fs.readSync=originalRead;f.done();}
});
