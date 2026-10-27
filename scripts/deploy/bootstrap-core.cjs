'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {spawnSync}=require('node:child_process');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('Invalid JSON metadata');}};
const identity=p=>{const s=fs.lstatSync(p);return {dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777,mtime:s.mtimeMs};};
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function directory(p){if(!fs.lstatSync(p).isDirectory()||fs.realpathSync(p)!==path.resolve(p))throw Error('Expected canonical real directory: '+p);}
function safeBase(cfg){directory(cfg.base);if(process.platform==='linux'&&(fs.lstatSync(cfg.base).mode&0o022))throw Error('Writable app root');}
function tree(root,allowLinks=false){
 directory(root);const records=[];
 function visit(dir){for(const name of fs.readdirSync(dir).sort()){
  if(/^\.env(?:$|\.)/.test(name)&&name!=='.env.example')throw Error('Runtime environment file in artifact');
  const p=path.join(dir,name),rel=path.relative(root,p).split(path.sep).join('/'),s=fs.lstatSync(p);
  if(s.isSymbolicLink()){
   const target=fs.readlinkSync(p),resolved=fs.realpathSync(p);
   if(!allowLinks||path.isAbsolute(target)||!resolved.startsWith(root+path.sep))throw Error('Escaping artifact symlink');
   records.push(['link',rel,target]);
  }else if(s.isDirectory()){records.push(['dir',rel]);visit(p);}
  else if(s.isFile()){
   if(s.nlink!==1)throw Error('Hardlinked artifact rejected');
   const digest=crypto.createHash('sha256'),fd=fs.openSync(p,'r'),buffer=Buffer.alloc(128*1024);
   try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
   records.push(['file',rel,s.size,digest.digest('hex')]);
  }else throw Error('Special artifact file rejected');
 }}visit(root);return hash(JSON.stringify(records));
}
function fileHash(p){const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1)throw Error('Expected ordinary metadata file');return hash(fs.readFileSync(p));}
function inventory(cfg){
 safeBase(cfg);const base=cfg.base;
 const baseIdentity=identity(base);delete baseIdentity.mtime;
 const snapshot={base:baseIdentity,dist:identity(path.join(base,'dist')),distHash:tree(path.join(base,'dist')),modulesHash:null,packageHash:null,lockHash:null,env:null};
 if(cfg.app==='backend'){
  snapshot.modulesHash=tree(path.join(base,'node_modules'),true);
  snapshot.packageHash=fileHash(path.join(base,'package.json'));snapshot.lockHash=fileHash(path.join(base,'package-lock.json'));
  const env=path.join(base,'.env'),s=fs.lstatSync(env);
  if(!s.isFile()||s.nlink!==1||(process.platform==='linux'&&(s.mode&0o777)!==0o600)||s.uid!==fs.lstatSync(base).uid)throw Error('Production env owner/mode gate');
  snapshot.env=identity(env); // Never open or copy .env.
 }
 return snapshot;
}
function paths(cfg){const release=path.join(cfg.base,'.releases','baseline-'+cfg.baselineSha);return {release,target:path.join(release,'dist'),backup:path.join(cfg.base,'.bootstrap-original-'+cfg.baselineSha),journal:path.join(cfg.base,'.bootstrap-state.json'),link:'.releases/baseline-'+cfg.baselineSha+'/dist'};}
function bytes(root){let total=0;for(const name of fs.readdirSync(root)){const p=path.join(root,name),s=fs.lstatSync(p);if(s.isDirectory())total+=bytes(p);else if(s.isFile())total+=s.size;}return total;}
function plan(cfg,evidence,runtime={reviewed:false}){
 const snapshot=inventory(cfg),p=paths(cfg),blockers=[];
 if(snapshot.base.dev!==snapshot.dist.dev)blockers.push('dist mount/device differs from app root');
 if(cfg.app==='frontend'){
  const {validArtifact}=require('./verify.cjs'),dist=path.join(cfg.base,'dist');
  const assets=fs.readdirSync(path.join(dist,'assets')).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(path.join(dist,'assets',x),'utf8'));
  if(!validArtifact(fs.readFileSync(path.join(dist,'index.html'),'utf8'),assets))blockers.push('Production API artifact check failed');
 }
 if(!evidence||evidence.schema!==1||evidence.app!==cfg.app||evidence.sourceSha!==cfg.baselineSha||!['trusted-build-manifest','reproducible-build'].includes(evidence.provenance?.method)||!evidence.provenance?.reference||!evidence.provenance?.reviewedBy)blockers.push('Reviewed artifact provenance required; clean HEAD is insufficient');
 for(const key of ['distHash','modulesHash','packageHash','lockHash'])if(evidence?.[key]!==snapshot[key])blockers.push('Provenance mismatch: '+key);
 if(cfg.app==='backend'&&runtime.reviewed!==true)blockers.push('PM2 runtime contract unreviewed or mismatched');
 if(cfg.app==='frontend'&&evidence?.productionApiOrigin!=='https://api.congdongngonngu.vn/api/v1')blockers.push('Production API origin evidence required');
 if(cfg.app==='frontend'&&(evidence?.nginx?.root!==cfg.base+'/dist'||evidence?.nginx?.symlinkTraversalReviewed!==true))blockers.push('Nginx symlink policy must be reviewed');
 const releases=path.dirname(p.release);
 if(exists(releases)){directory(releases);if(process.platform==='linux'&&(fs.statSync(releases).mode&0o022))throw Error('Writable release root');if(process.platform==='linux'&&cfg.app==='frontend'&&!(fs.statSync(releases).mode&0o001))blockers.push('Nginx cannot traverse existing releases directory');}
 for(const target of [p.release,p.backup,p.journal])if(exists(target))blockers.push('Existing bootstrap target: '+target);
 const storage={copyBytes:bytes(path.join(cfg.base,'dist'))+(cfg.app==='backend'?bytes(path.join(cfg.base,'node_modules')):0),reserveBytes:512*1024*1024};
 if(process.platform==='linux'){const stat=fs.statfsSync(cfg.base);storage.availableBytes=stat.bavail*stat.bsize;if(storage.availableBytes<storage.copyBytes*2+storage.reserveBytes)blockers.push('Insufficient free space for copy and recovery reserve');}
 const payload={schema:1,operation:'bootstrap-with-automatic-restore',app:cfg.app,base:cfg.base,sourceSha:cfg.baselineSha,snapshot,paths:p,evidence,runtime};
 return {...payload,storage,exchangeSupport:'UNVERIFIED_UNTIL_APPLY_PROBE',ready:!blockers.length,blockers,digest:hash(JSON.stringify(payload))};
}
function syncDir(p){const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncTree(root){for(const name of fs.readdirSync(root)){const p=path.join(root,name),s=fs.lstatSync(p);if(s.isDirectory())syncTree(p);else if(s.isFile()){const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}syncDir(root);}
function writeState(p,value){const tmp=p+'.tmp-'+crypto.randomBytes(8).toString('hex');const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,p);syncDir(path.dirname(p));}
function exchange(a,b){
 const result=spawnSync('python3',[path.join(__dirname,'exchange.py'),a,b],{encoding:'utf8',timeout:15000});
 if(result.error||result.status!==0)throw Error('Atomic exchange unavailable/failed; original paths retained (inspect recovery plan)');
 syncDir(path.dirname(a));
}
function probeExchange(release){
 const a=path.join(release,'.exchange-probe-dir'),b=path.join(release,'.exchange-probe-link');
 fs.mkdirSync(a);fs.writeFileSync(path.join(a,'probe'),'probe');fs.symlinkSync('.exchange-probe-dir',b);
 exchange(a,b);exchange(a,b);fs.unlinkSync(b);fs.unlinkSync(path.join(a,'probe'));fs.rmdirSync(a);syncDir(release);
}
function publicPermissions(root){for(const name of fs.readdirSync(root)){const p=path.join(root,name),s=fs.lstatSync(p);if(s.isDirectory())publicPermissions(p);else fs.chmodSync(p,0o644);}fs.chmodSync(root,0o755);}
function dependencies(cfg,release){
 if(cfg.app!=='backend')return;
 const req=createRequire(path.join(release,'dist','main.js')),pkg=read(path.join(release,'package.json'));
 for(const name of Object.keys(pkg.dependencies||{})){
  const resolved=fs.realpathSync(req.resolve(name));
  if(!resolved.startsWith(path.join(release,'node_modules')+path.sep))throw Error('Dependency resolves outside baseline: '+name);
 }
}
function copiedHashes(cfg,release){return {distHash:tree(path.join(release,'dist')),modulesHash:cfg.app==='backend'?tree(path.join(release,'node_modules'),true):null,packageHash:cfg.app==='backend'?fileHash(path.join(release,'package.json')):null,lockHash:cfg.app==='backend'?fileHash(path.join(release,'package-lock.json')):null};}
function sameOriginal(p,snapshot){return fs.lstatSync(p).isDirectory()&&identity(p).dev===snapshot.dist.dev&&identity(p).ino===snapshot.dist.ino&&tree(p)===snapshot.distHash;}
function recoveryPlan(cfg){
 safeBase(cfg);const p=paths(cfg),s=read(p.journal);
 if(s.app!==cfg.app||s.sourceSha!==cfg.baselineSha||JSON.stringify(s.paths)!==JSON.stringify(p)||s.base!==cfg.base||s.snapshot.base.ino!==identity(cfg.base).ino||s.snapshot.base.dev!==identity(cfg.base).dev)throw Error('Ambiguous recovery journal');
 const live=path.join(cfg.base,'dist');let state;
 if(exists(live)&&sameOriginal(live,s.snapshot)){
  if(exists(p.backup)&&(!fs.lstatSync(p.backup).isSymbolicLink()||fs.readlinkSync(p.backup)!==p.link))throw Error('Unexpected pre-exchange backup');
  state='original';
 }else if(fs.lstatSync(live).isSymbolicLink()&&fs.readlinkSync(live)===p.link&&fs.realpathSync(live)===p.target&&exists(p.backup)&&sameOriginal(p.backup,s.snapshot)){
  directory(p.release);directory(p.target);
  if(fs.readFileSync(path.join(p.release,'.source-sha'),'utf8').trim()!==cfg.baselineSha||tree(p.target)!==s.stagedHash)throw Error('Baseline changed; recovery refused');
  state='exchanged';
 }else throw Error('Unexpected endpoints; manual recovery review required');
 const payload={operation:'recover',app:cfg.app,base:cfg.base,sourceSha:cfg.baselineSha,state,journalHash:fileHash(p.journal),live:identity(live),backup:exists(p.backup)?identity(p.backup):null};
 return {...payload,digest:hash(JSON.stringify(payload))};
}
function recover(cfg,approval,options={}){
 const r=recoveryPlan(cfg);if(approval!==r.digest)throw Error('Recovery approval digest mismatch');
 const p=paths(cfg),s=read(p.journal);
 if(r.state==='exchanged'){exchange(path.join(cfg.base,'dist'),p.backup);options.checkpoint?.('recovered-exchange');}
 if(!sameOriginal(path.join(cfg.base,'dist'),s.snapshot))throw Error('Recovery verification failed');
 writeState(p.journal,{...s,state:'rolled_back'});return {state:'original',retainedRelease:p.release};
}
function apply(cfg,evidence,approval,options={}){
 const p=plan(cfg,evidence,options.runtime),where=p.paths;
 if(!p.ready)throw Error(p.blockers.join('; '));
 if(approval!==p.digest)throw Error('Apply approval digest mismatch');
 if(process.platform!=='linux')throw Error('Linux atomic exchange required');
 const checkpoint=options.checkpoint||(()=>{}),performExchange=options.exchange||exchange;
 // Approved apply includes immediate restoration of original dist on ordinary verification failure.
 let state={app:cfg.app,base:cfg.base,sourceSha:cfg.baselineSha,paths:where,snapshot:p.snapshot,planDigest:p.digest,state:'staging'};
 try{
  if(!exists(path.dirname(where.release))){fs.mkdirSync(path.dirname(where.release),{mode:0o700});fs.chmodSync(path.dirname(where.release),cfg.app==='frontend'?0o711:0o700);syncDir(cfg.base);}
  directory(path.dirname(where.release));fs.mkdirSync(where.release,{mode:0o700});fs.chmodSync(where.release,cfg.app==='frontend'?0o711:0o700);syncDir(path.dirname(where.release));
  writeState(where.journal,state);checkpoint('journal');
  fs.cpSync(path.join(cfg.base,'dist'),where.target,{recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true});
  if(cfg.app==='backend'){
   fs.cpSync(path.join(cfg.base,'node_modules'),path.join(where.release,'node_modules'),{recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true});
   for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(cfg.base,name),path.join(where.release,name),fs.constants.COPYFILE_EXCL);
  }
  checkpoint('copied');
  const copied=copiedHashes(cfg,where.release);
  for(const key of ['distHash','modulesHash','packageHash','lockHash'])if(copied[key]!==p.snapshot[key])throw Error('Copied snapshot mismatch: '+key);
  fs.writeFileSync(path.join(where.release,'.source-sha'),cfg.baselineSha+'\n',{flag:'wx',mode:0o600});
  if(cfg.app==='frontend'){
   const marker=path.join(where.target,'cdnn-release.json');
   if(exists(marker)&&read(marker).sha!==cfg.baselineSha)throw Error('Conflicting existing release marker');
   if(!exists(marker))fs.writeFileSync(marker,JSON.stringify({sha:cfg.baselineSha})+'\n',{flag:'wx',mode:0o644});
   publicPermissions(where.target);
   if((fs.statSync(path.dirname(where.release)).mode&0o001)===0)throw Error('Nginx cannot traverse release ancestor');
  }
  dependencies(cfg,where.release);syncTree(where.release);syncDir(path.dirname(where.release));
  probeExchange(where.release); // Actual same-filesystem kernel support, before touching live dist.
  if(JSON.stringify(inventory(cfg))!==JSON.stringify(p.snapshot))throw Error('Live snapshot changed during staging');
  if(options.runtimeProbe&&JSON.stringify(options.runtimeProbe())!==JSON.stringify(options.runtime))throw Error('PM2 runtime changed during staging');
  fs.symlinkSync(where.link,where.backup);syncDir(cfg.base);
  state={...state,stagedHash:tree(where.target),state:'prepared'};writeState(where.journal,state);checkpoint('prepared');
  performExchange(where.backup,path.join(cfg.base,'dist'));checkpoint('exchanged');
  if(recoveryPlan(cfg).state!=='exchanged')throw Error('Exchange postcondition failed');
  dependencies(cfg,where.release);
  if(cfg.app==='backend'&&JSON.stringify(identity(path.join(cfg.base,'.env')))!==JSON.stringify(p.snapshot.env))throw Error('Production env metadata changed');
  if(options.verify)options.verify();
  state={...state,state:'verified'};writeState(where.journal,state);checkpoint('verified');
  return {state:'verified',release:where.release,original:where.backup,serviceRestarted:false};
 }catch(error){
  if(exists(where.journal)){
   try{const r=recoveryPlan(cfg);recover(cfg,r.digest);}catch(recoveryError){error.message+='; recovery requires operator review: '+recoveryError.message;}
  }
  throw error;
 }
}
module.exports={tree,inventory,plan,apply,recoveryPlan,recover,exchange};
