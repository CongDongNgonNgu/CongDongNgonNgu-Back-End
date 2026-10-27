const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const core=require('./bootstrap-core.cjs');
const config=require('./bootstrap-config.json');
function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-bootstrap-'));
 fs.mkdirSync(path.join(base,'dist'));fs.writeFileSync(path.join(base,'dist','main.js'),'console.log(require("probe"))');
 fs.mkdirSync(path.join(base,'dist','assets'));fs.writeFileSync(path.join(base,'dist','index.html'),'<html><script src="/assets/old.js"></script>');
 fs.writeFileSync(path.join(base,'dist','assets','old.js'),'https://api.congdongngonngu.vn/api/v1');
 fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({dependencies:{probe:'1.0.0'}}));fs.writeFileSync(path.join(base,'package-lock.json'),'{}');
 fs.mkdirSync(path.join(base,'node_modules','probe'),{recursive:true});fs.writeFileSync(path.join(base,'node_modules','probe','index.js'),'module.exports="dependency-ok"');
 fs.writeFileSync(path.join(base,'.env'),'SYNTHETIC_ONLY=true\n',{mode:0o600});
 const cfg={...config,base};
 const snap=core.inventory(cfg);
 const evidence={schema:1,app:cfg.app,sourceSha:cfg.baselineSha,distHash:snap.distHash,modulesHash:snap.modulesHash,packageHash:snap.packageHash,lockHash:snap.lockHash,provenance:{method:'trusted-build-manifest',reference:'isolated-fixture-manifest',reviewedBy:'fixture-reviewer'},nginx:{root:base+'/dist',symlinkTraversalReviewed:true},productionApiOrigin:'https://api.congdongngonngu.vn/api/v1'};
 const runtime={reviewed:true,fingerprint:'fixture-runtime'};
 return {base,cfg,evidence,runtime,done:()=>fs.rmSync(base,{recursive:true,force:true})};
}
test('plan is read-only, SHA is pinned and HEAD is not provenance',()=>{
 const f=fixture();try{
  const before=fs.readdirSync(f.base);const p=core.plan(f.cfg,null,f.runtime);assert.equal(p.ready,false);assert.match(p.blockers.join(' '),/provenance/);
  assert.deepEqual(fs.readdirSync(f.base),before);
  assert.equal(core.plan(f.cfg,{...f.evidence,sourceSha:'a'.repeat(40)},f.runtime).ready,false);
  const approved=core.plan(f.cfg,f.evidence,f.runtime);assert.equal(approved.ready,true);assert.match(approved.digest,/^[a-f0-9]{64}$/);
 }finally{f.done();}
});
test('stale content, missing runtime review and secret files block before mutation',()=>{
 const f=fixture();try{
  if(f.cfg.app==='backend')assert.equal(core.plan(f.cfg,f.evidence,{reviewed:false}).ready,false);
  fs.appendFileSync(path.join(f.base,'dist','main.js'),'\n//changed');assert.equal(core.plan(f.cfg,f.evidence,f.runtime).ready,false);
  fs.writeFileSync(path.join(f.base,'dist','.env'),'SYNTHETIC_SECRET');assert.throws(()=>core.inventory(f.cfg),/environment/);
 }finally{f.done();}
});
for(const failure of ['none','copy','exchange','postcheck','runtime'])test('real Linux atomic bootstrap and rollback: '+failure,{skip:process.platform!=='linux'},()=>{
 const oldUmask=process.umask(0o077),f=fixture();try{
  const p=core.plan(f.cfg,f.evidence,f.runtime),env=fs.statSync(path.join(f.base,'.env'));
  const options={runtime:f.runtime,runtimeProbe:failure==='runtime'?()=>({reviewed:false}):()=>f.runtime,verify:()=>{if(failure==='postcheck')throw Error('injected health');},checkpoint:name=>{if(failure==='copy'&&name==='copied')throw Error('injected copy');},exchange:failure==='exchange'?()=>{throw Error('injected exchange');}:undefined};
  if(failure==='none'){
   const result=core.apply(f.cfg,f.evidence,p.digest,options);assert.equal(result.state,'verified');assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());
   if(f.cfg.app==='backend'){
    const run=spawnSync(process.execPath,[path.join(f.base,'dist','main.js')],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'dependency-ok');
    assert.ok(fs.existsSync(path.join(result.release,'node_modules','probe','index.js')));
   }else{assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'dist','cdnn-release.json'))).sha,f.cfg.baselineSha);assert.equal(fs.statSync(result.release).mode&0o777,0o711);assert.equal(fs.statSync(path.dirname(result.release)).mode&0o777,0o711);assert.equal(fs.statSync(path.join(f.base,'dist','assets','old.js')).mode&0o777,0o644);}
   const recovery=core.recoveryPlan(f.cfg);core.recover(f.cfg,recovery.digest);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());
   assert.equal(core.recoveryPlan(f.cfg).state,'original');
  }else{
   assert.throws(()=>core.apply(f.cfg,f.evidence,p.digest,options),/injected|runtime changed/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());
  }
  assert.equal(fs.readFileSync(path.join(f.base,'.env'),'utf8'),'SYNTHETIC_ONLY=true\n');assert.equal(fs.statSync(path.join(f.base,'.env')).ino,env.ino);assert.equal(fs.statSync(path.join(f.base,'.env')).mode&0o777,0o600);
  assert.equal(fs.readFileSync(path.join(f.base,'dist','assets','old.js'),'utf8'),'https://api.congdongngonngu.vn/api/v1');
 }finally{f.done();process.umask(oldUmask);}
});
test('Linux exit after exchange and stale recovery approval',{skip:process.platform!=='linux'},()=>{
 const f=fixture();try{
  const child=spawnSync(process.execPath,['-e',`const c=require(process.argv[1]);const x=JSON.parse(process.argv[2]);c.apply(x.cfg,x.evidence,c.plan(x.cfg,x.evidence,x.runtime).digest,{runtime:x.runtime,verify:()=>{},checkpoint:n=>{if(n==='exchanged')process.exit(73)}});`,path.join(__dirname,'bootstrap-core.cjs'),JSON.stringify(f)],{encoding:'utf8'});
  assert.equal(child.status,73,child.stderr);const recovery=core.recoveryPlan(f.cfg);assert.equal(recovery.state,'exchanged');
  assert.throws(()=>core.recover(f.cfg,'0'.repeat(64)),/approval/);core.recover(f.cfg,recovery.digest);assert.equal(core.recoveryPlan(f.cfg).state,'original');
 }finally{f.done();}
});
for(const stage of ['journal','prepared','exchanged','verified'])test('SIGKILL at durable boundary: '+stage,{skip:process.platform!=='linux'},()=>{
 const f=fixture();try{
  const child=spawnSync(process.execPath,['-e',`const c=require(process.argv[1]),x=JSON.parse(process.argv[2]);c.apply(x.cfg,x.evidence,c.plan(x.cfg,x.evidence,x.runtime).digest,{runtime:x.runtime,verify:()=>{},checkpoint:n=>{if(n===process.argv[3])process.kill(process.pid,'SIGKILL')}});`,path.join(__dirname,'bootstrap-core.cjs'),JSON.stringify(f),stage],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);const r=core.recoveryPlan(f.cfg);core.recover(f.cfg,r.digest);assert.equal(core.recoveryPlan(f.cfg).state,'original');
 }finally{f.done();}
});
test('recovery survives SIGKILL after reverse exchange',{skip:process.platform!=='linux'},()=>{
 const f=fixture();try{
  core.apply(f.cfg,f.evidence,core.plan(f.cfg,f.evidence,f.runtime).digest,{runtime:f.runtime,verify:()=>{}});
  const child=spawnSync(process.execPath,['-e',`const c=require(process.argv[1]),x=JSON.parse(process.argv[2]);c.recover(x.cfg,c.recoveryPlan(x.cfg).digest,{checkpoint:()=>process.kill(process.pid,'SIGKILL')});`,path.join(__dirname,'bootstrap-core.cjs'),JSON.stringify(f)],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);const r=core.recoveryPlan(f.cfg);assert.equal(r.state,'original');core.recover(f.cfg,r.digest);
 }finally{f.done();}
});
test('recovery refuses changed backup and baseline; no target is overwritten',{skip:process.platform!=='linux'},()=>{
 for(const target of ['backup','baseline']){
  const f=fixture();try{
   const result=core.apply(f.cfg,f.evidence,core.plan(f.cfg,f.evidence,f.runtime).digest,{runtime:f.runtime,verify:()=>{}});
   const changed=path.join(target==='backup'?result.original:path.join(result.release,'dist'),'assets','old.js');fs.appendFileSync(changed,'tamper');
   assert.throws(()=>core.recoveryPlan(f.cfg),/recovery|Baseline|endpoints/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isSymbolicLink());
  }finally{f.done();}
 }
});
test('stale approvals, unexpected targets, and escaping symlinks fail closed',{skip:process.platform!=='linux'},()=>{
 const f=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-outside-'));try{
  assert.throws(()=>core.apply(f.cfg,f.evidence,'0'.repeat(64),{runtime:f.runtime}),/approval/);assert.equal(fs.existsSync(path.join(f.base,'.releases')),false);
  fs.symlinkSync(outside,path.join(f.base,'.releases'));assert.throws(()=>core.plan(f.cfg,f.evidence,f.runtime),/canonical/);fs.unlinkSync(path.join(f.base,'.releases'));
  fs.symlinkSync(outside,path.join(f.base,'dist','escape'));assert.throws(()=>core.inventory(f.cfg),/symlink/);
 }finally{f.done();fs.rmSync(outside,{recursive:true,force:true});}
});
test('fsync failure retains original live directory',{skip:process.platform!=='linux'},()=>{
 const f=fixture(),realSync=fs.fsyncSync;try{
  const p=core.plan(f.cfg,f.evidence,f.runtime);let injected=false;fs.fsyncSync=(fd)=>{if(!injected){injected=true;throw Error('injected fsync');}return realSync(fd);};
  assert.throws(()=>core.apply(f.cfg,f.evidence,p.digest,{runtime:f.runtime}),/injected fsync/);assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());
 }finally{fs.fsyncSync=realSync;f.done();}
});
test('same deployment flock rejects concurrent operator work',{skip:process.platform!=='linux'},()=>{
 const f=fixture();try{
  const nested=`const{spawnSync}=require('node:child_process');const r=spawnSync('flock',['-n',process.argv[1],process.execPath,'-e','process.exit(99)']);process.exit(r.status===1?0:2);`;
  const r=spawnSync('flock',['-n',path.join(f.base,'.deploy.lock'),process.execPath,'-e',nested,path.join(f.base,'.deploy.lock')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{f.done();}
});
