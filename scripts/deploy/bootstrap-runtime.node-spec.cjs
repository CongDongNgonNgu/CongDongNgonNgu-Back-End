'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const core=require('./bootstrap-core.cjs'),config=require('./bootstrap-config.json');
function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-runtime-isolated-'));fs.chmodSync(base,0o755);
 fs.mkdirSync(path.join(base,'dist','assets'),{recursive:true});
 fs.writeFileSync(path.join(base,'dist','index.html'),'<html><script src="/assets/old.js"></script></html>');
 fs.writeFileSync(path.join(base,'dist','assets','old.js'),'https://api.congdongngonngu.vn/api/v1');
 fs.writeFileSync(path.join(base,'.env'),'NODE_ENV=production\nPORT=0\n',{mode:0o600});
 fs.mkdirSync(path.join(base,'node_modules','probe'),{recursive:true});
 fs.writeFileSync(path.join(base,'node_modules','probe','index.js'),'module.exports="dependency-ok"');
 fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({dependencies:{probe:'1.0.0'}}));fs.writeFileSync(path.join(base,'package-lock.json'),'{}');
 fs.writeFileSync(path.join(base,'dist','main.js'),String.raw`
 const fs=require('node:fs'),http=require('node:http');
 process.loadEnvFile('.env');
 if(process.env.NODE_ENV!=='production'||process.env.PORT!=='0'||require('probe')!=='dependency-ok')process.exit(81);
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({pid:process.pid,environment:process.env.NODE_ENV,dependency:require('probe'),asset:fs.readFileSync('dist/assets/old.js','utf8')}));});
 server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,pid:process.pid}));
 `);
 const cfg={...config,base},snapshot=core.inventory(cfg);
 const evidence={schema:1,app:cfg.app,sourceSha:cfg.baselineSha,...Object.fromEntries(['distHash','modulesHash','packageHash','lockHash'].map(k=>[k,snapshot[k]])),provenance:{method:'trusted-build-manifest',reference:'synthetic-only',reviewedBy:'test'},productionApiOrigin:'https://api.congdongngonngu.vn/api/v1',nginx:{root:base+'/dist',symlinkTraversalReviewed:true}};
 return {base,cfg,evidence,snapshot,runtime:{reviewed:true,fingerprint:'synthetic-only'}};
}
async function start(f,children){
 const child=fork(path.join(f.base,'dist','main.js'),[],{cwd:f.base,env:{PATH:process.env.PATH},stdio:['ignore','ignore','ignore','ipc']});children.push(child);
 const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Synthetic startup failed: '+code);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic startup timeout')),5000);timer.unref();})]);
 return {...message,child};
}
async function health(server){const r=await fetch('http://127.0.0.1:'+server.port,{signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);const body=await r.json();assert.equal(body.pid,server.pid);assert.equal(body.environment,'production');assert.equal(body.dependency,'dependency-ok');assert.equal(body.asset,'https://api.congdongngonngu.vn/api/v1');}
async function cleanup(f,children){for(const child of children){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}}fs.rmSync(f.base,{recursive:true,force:true});}
test('isolated Linux starts from cwd env through baseline symlink and restored original without restarting original process',{skip:process.platform!=='linux'||config.app!=='backend',timeout:20000},async()=>{
 const f=fixture(),children=[];try{
  const original=await start(f,children);await health(original);
  const result=core.apply(f.cfg,f.evidence,core.plan(f.cfg,f.evidence,f.runtime).digest,{runtime:f.runtime,verify:()=>{}});
  await health(original);const candidate=await start(f,children);await health(candidate);
  assert.equal(fs.existsSync(path.join(result.release,'.env')),false);
  const r=core.recoveryPlan(f.cfg);core.recover(f.cfg,r.digest);
  await health(original);await health(candidate);await health(await start(f,children));
  const restored=core.inventory(f.cfg);for(const key of ['distHash','modulesHash','packageHash','lockHash','env'])assert.deepEqual(restored[key],f.snapshot[key],key);
  assert.equal(original.child.exitCode,null);assert.equal(fs.existsSync(path.join(f.base,'dist','cdnn-release.json')),false);
 }finally{await cleanup(f,children);}
});
test('isolated Linux worker reads future symlink layout and original assets after restoration; missing traversal denies access',{skip:process.platform!=='linux'||config.app!=='frontend'},()=>{
 const f=fixture();try{
  const worker=()=>spawnSync('sudo',['-n','-u','www-data','--',process.execPath,'-e',"const fs=require('node:fs');if(!fs.readFileSync(process.argv[1],'utf8').includes('https://api.congdongngonngu.vn/api/v1'))process.exit(2)",path.join(f.base,'dist','assets','old.js')],{encoding:'utf8'});
  // CI must support the actual worker identity; absence is a failure, never a skip.
  assert.equal(worker().status,0,'Initial worker read failed');
  const result=core.apply(f.cfg,f.evidence,core.plan(f.cfg,f.evidence,f.runtime).digest,{runtime:f.runtime,verify:()=>{}});
  assert.equal(worker().status,0,'Symlink worker read failed');
  fs.chmodSync(result.release,0o700);assert.notEqual(worker().status,0,'Traversal denial must fail');fs.chmodSync(result.release,0o711);
  assert.equal(worker().status,0,'Restored traversal failed');
  core.recover(f.cfg,core.recoveryPlan(f.cfg).digest);assert.equal(worker().status,0,'Original worker read failed');
  assert.equal(core.tree(path.join(f.base,'dist')),f.snapshot.distHash);assert.equal(fs.existsSync(path.join(f.base,'dist','cdnn-release.json')),false);
 }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});

test('runtime fixture satisfies read-only artifact and provenance plan gates before Linux activation',()=>{
 const f=fixture();try{const p=core.plan(f.cfg,f.evidence,f.runtime);assert.equal(p.ready,true,p.blockers.join('; '));assert.ok(fs.lstatSync(path.join(f.base,'dist')).isDirectory());assert.equal(fs.existsSync(path.join(f.base,'.releases')),false);}finally{fs.rmSync(f.base,{recursive:true,force:true});}
});
