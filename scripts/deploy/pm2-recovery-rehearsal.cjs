'use strict';
// Explicit Linux-only rehearsal. Never run from a Production host or against an existing PM2_HOME.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const core=require('./bootstrap-core.cjs'),{validHealth,safeArgs}=require('./release-checks.cjs'),{listeningPorts,startTicks}=require('./runtime-proof.cjs');
let application,built;
const appName='cdnn-rehearsal-backend';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={schema:1,scope:'Private Linux PM2 7.0.3 daemon with actual compiled AppConfigModule and HealthModule from the proven Production source artifact9f1d6b5; no business modules, database connection, Production service or systemd boot',checks:{},limitations:['Not a Production restart/rollback authorization','No actual systemd boot test','Application business/database/provider modules excluded','Release-local dependency fallback must be rejected by acceptance checks']};
let stage='preflight',root,home,pm2Home,pm2Bin,env,base,cfg,initial,envBytes,envIdentity,runnerTemp;
const tracked=new Map();
class AcceptanceError extends Error{constructor(code){super(code);this.code=code;}}
function diagnosticTokens(text){
 const tokens=[];
 for(const [token,pattern] of [['CLI_UNKNOWN_OPTION',/unknown option/i],['MODULE_NOT_FOUND',/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/],['NEST_DI',/Nest can't resolve dependencies|UnknownDependenciesException/],['CONFIG_VALIDATION_HINT',/PUBLIC_APP_URL|DATABASE_URL|JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|CORS_ALLOWED_ORIGINS/],['EADDRINUSE',/EADDRINUSE/],['SYNTAX_ERROR',/SyntaxError/]])if(pattern.test(text))tokens.push(token);
 for(const [name,token] of [['@nestjs/core','MISSING_NEST_CORE'],['@nestjs/config','MISSING_NEST_CONFIG'],['reflect-metadata','MISSING_REFLECT_METADATA']])if(text.includes("Cannot find module '"+name+"'"))tokens.push(token);
 return tokens;
}
function privateLogDiagnostics(){
 if(!root||!pm2Home)return [];
 const logs=path.join(pm2Home,'logs'),tokens=new Set();
 try{if(fs.realpathSync(logs)!==logs||!fs.lstatSync(logs).isDirectory())return [];for(const name of fs.readdirSync(logs)){
  const file=path.join(logs,name),st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid())continue;
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const buf=Buffer.alloc(Math.min(st.size,512*1024));const n=fs.readSync(fd,buf,0,buf.length,0);for(const token of diagnosticTokens(buf.subarray(0,n).toString('utf8')))tokens.add(token);}finally{fs.closeSync(fd);}
 }}catch{tokens.add('PRIVATE_LOG_CLASSIFICATION_UNAVAILABLE');}
 return [...tokens].sort();
}
function identity(pid){
 if(!Number.isInteger(pid)||pid<1)return null;
 try{const proc='/proc/'+pid,stat=fs.readFileSync(proc+'/stat','utf8');if(fs.statSync(proc).uid!==process.getuid())throw Error('Foreign process identity');return {pid,start:startTicks(stat),state:stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/)[0]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
}
function remember(pid){const id=identity(pid);if(id)tracked.set(id.pid+':'+id.start,id);}
function remainsAlive(id){const current=identity(id.pid);return current&&current.start===id.start&&current.state!=='Z';}
function guard(){
 if(process.platform!=='linux'||process.version!=='v24.18.1')throw Error('Linux Node24.18.1 required');
 if(!root||!root.startsWith(path.join(runnerTemp,'cdnn-pm2-rehearsal-'))||fs.realpathSync(root)!==root)throw Error('Isolated root required');
 for(const dir of [root,home,pm2Home,base]){const s=fs.lstatSync(dir);if(!s.isDirectory()||fs.realpathSync(dir)!==dir||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Unsafe isolated directory');}
 if(env.PM2_HOME!==pm2Home||env.HOME!==home||env.NODE_ENV!==undefined||env.PORT!==undefined||env.NODE_OPTIONS!==undefined||env.NODE_PATH!==undefined)throw Error('Unsafe PM2 environment');
}
function pm2(args,{allowFailure=false}={}){
 guard();const r=spawnSync(process.execPath,[pm2Bin,'--silent',...args],{cwd:root,env,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});
 if(r.error||r.status!==0){if(!report.firstPm2CommandFailure)report.firstPm2CommandFailure={stage,command:['start','save','kill','resurrect','jlist'].includes(args[0])?args[0]:'UNLISTED',exitCode:Number.isInteger(r.status)?r.status:null,timedOut:r.error?.code==='ETIMEDOUT',tokens:diagnosticTokens(String(r.stdout||'')+String(r.stderr||''))};if(!allowFailure)throw Error('Isolated PM2 command failed');}
 return r;
}
function rows(){const r=pm2(['jlist']);try{const value=JSON.parse(r.stdout);if(!Array.isArray(value))throw Error();return value;}catch{throw Error('Invalid isolated PM2 response');}}
function selected(){const all=rows();assert.equal(all.length,1,'Only one private PM2 process is permitted');const list=all.filter(r=>r.name===appName);assert.equal(list.length,1,'Expected one isolated application');remember(list[0].pid);return list[0];}
function declaration(p){
 const options={};
 for(const key of ['autorestart','watch','max_memory_restart','kill_timeout','listen_timeout','restart_delay','exp_backoff_restart_delay','cron_restart','wait_ready','stop_exit_codes','shutdown_with_message','treekill','max_restarts','min_uptime']){
  const value=p[key]??null;
  options[key]=(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&/^[0-9* ,/.-]{0,80}$/.test(value))||(Array.isArray(value)&&value.every(Number.isInteger)))?value:'<UNREVIEWED>';
 }
 return {cwd:p.pm_cwd===base,script:p.pm_exec_path===path.join(base,'dist','main.js'),interpreter:p.exec_interpreter===process.execPath,mode:p.exec_mode,instances:Number.isInteger(p.instances)?p.instances:null,port:p.PORT===undefined&&p.env?.PORT===undefined?null:'PRESENT',environment:p.NODE_ENV===undefined&&p.env?.NODE_ENV===undefined?null:'PRESENT',nodeArgs:safeArgs(p.node_args??p.interpreter_args),args:safeArgs(p.args,true),nodeOptions:safeArgs(p.NODE_OPTIONS??p.env?.NODE_OPTIONS),options};
}
function startupRejectionEvidence(metadata){
 const state=['online','launching','stopping','stopped','errored','waiting restart'].includes(metadata.status)?metadata.status:'UNSUPPORTED';
 const exitCode=Number.isInteger(metadata.exit_code)&&metadata.exit_code>=0&&metadata.exit_code<=255?metadata.exit_code:null;
 const restartCount=Number.isSafeInteger(metadata.restart_time)&&metadata.restart_time>=0?metadata.restart_time:null;
 const unstableRestarts=Number.isSafeInteger(metadata.unstable_restarts)&&metadata.unstable_restarts>=0?metadata.unstable_restarts:null;
 const observed=state!=='UNSUPPORTED'&&exitCode!==null&&exitCode!==0&&(restartCount>=1||['stopped','errored'].includes(state));
 return {state,exitCode,restartCount,unstableRestarts,startupRejectionObserved:observed};
}

function verifySavedTransformation(original,savedDeclaration){
 assert.deepEqual(Object.keys(savedDeclaration).sort(),Object.keys(original).sort(),'Compared declaration schema must remain identical');
 assert.equal(original.instances,1,'Pinned CLI fixture must declare the measured singleton');
 assert.equal(savedDeclaration.instances,null,'Pinned PM2 save must omit the instance declaration');
 const different=Object.keys(original).filter(key=>JSON.stringify(original[key])!==JSON.stringify(savedDeclaration[key]));
 assert.deepEqual(different,['instances'],'Only the source-reviewed instances omission is accepted during save');
 return different;
}
function verifyResurrectedDeclaration(actual,savedDeclaration,original){
 assert.deepEqual(actual,savedDeclaration,'Resurrection must preserve every saved declaration field');
 verifySavedTransformation(original,actual);
}

function saved(){const dump=JSON.parse(fs.readFileSync(path.join(pm2Home,'dump.pm2'),'utf8'));assert.ok(Array.isArray(dump));const found=dump.filter(p=>p.name===appName);assert.equal(found.length,1);return found[0];}
function copyCompiled(entry,seen=new Set()){
 const source=path.join(built,entry);if(seen.has(source))return;seen.add(source);
 assert.ok(source.startsWith(built+path.sep));const target=path.join(base,'dist',entry);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
 if(!source.endsWith('.js'))return;
 const text=fs.readFileSync(source,'utf8');for(const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)){
  const dependency=createRequire(source).resolve(match[1]);assert.ok(dependency.startsWith(built+path.sep),'Compiled local dependency escapes build');copyCompiled(path.relative(built,dependency),seen);
 }
}
function copyDependencies(names){
 const sourceModules=fs.realpathSync(path.join(application,'node_modules')),targetModules=path.join(base,'node_modules'),copied=new Map();fs.mkdirSync(targetModules);
 function locate(name,from){
  for(const dir of createRequire(path.join(from,'package.json')).resolve.paths(name)||[]){const candidate=path.join(dir,name,'package.json');if(fs.existsSync(candidate)){const result=fs.realpathSync(path.dirname(candidate));assert.ok(result.startsWith(sourceModules+path.sep),'Dependency outside installed repository');return result;}}
  return null;
 }
 function install(name,from,parent,optional=false){
  const source=locate(name,from);if(!source){if(optional)return;throw Error('Required fixture dependency missing');}
  const target=path.join(parent,name);if(fs.existsSync(target))return;
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(copied.has(source)){fs.symlinkSync(path.relative(path.dirname(target),copied.get(source)),target);return;}
  copied.set(source,target);
  fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true,filter:p=>p===source||(!path.relative(source,p).split(path.sep).includes('node_modules')&&!/^\.env(?:$|\.)/.test(path.basename(p)))});
  const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  for(const dep of Object.keys(pkg.dependencies||{}))install(dep,source,path.join(target,'node_modules'),Boolean(pkg.optionalDependencies?.[dep]));
  for(const dep of Object.keys({...pkg.optionalDependencies,...pkg.peerDependencies}))install(dep,source,path.join(target,'node_modules'),true);
 }
 for(const name of names)install(name,application,targetModules);
 return Object.fromEntries(names.map(name=>[name,JSON.parse(fs.readFileSync(path.join(targetModules,name,'package.json'),'utf8')).version]));
}
async function unusedPort(){const s=net.createServer();await new Promise((resolve,reject)=>s.once('error',reject).listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
async function response(port,route){try{const r=await fetch('http://127.0.0.1:'+port+route,{signal:AbortSignal.timeout(1000)});let body=null;try{body=await r.json();}catch{}return {status:r.status,body};}catch{return {status:null,body:null};}}
async function health(port,{release,expectGood=true}={}){
 let last;
 for(let n=0;n<50;n++){
  const h=await response(port,'/api/v1/health');last=h;report.lastHealthStatus=h.status;
  if(validHealth(h.status,h.body)){
   if(!expectGood)throw Error('Injected startup failure unexpectedly healthy');
   const diagnostics=await response(port,'/__rehearsal');assert.equal(diagnostics.status,200);
   const d=diagnostics.body,p=selected();assert.equal(p.pm2_env.status,'online');assert.equal(p.pm2_env.exec_mode,'fork_mode');assert.equal(d.pid,p.pid);assert.equal(d.environment,'production');assert.equal(d.configPort,port);assert.equal(d.launchHadNodeEnv,false);assert.equal(d.launchHadPort,false);
   assert.equal(fs.realpathSync('/proc/'+p.pid+'/exe'),fs.realpathSync(process.execPath));assert.equal(fs.realpathSync('/proc/'+p.pid+'/cwd'),base);
   const inode=new Set();for(const fd of fs.readdirSync('/proc/'+p.pid+'/fd')){try{const m=/^socket:\[(\d+)\]$/.exec(fs.readlinkSync('/proc/'+p.pid+'/fd/'+fd));if(m)inode.add(m[1]);}catch{}}
   const ports=['tcp','tcp6'].flatMap(table=>listeningPorts(fs.readFileSync('/proc/'+p.pid+'/net/'+table,'utf8'),inode));assert.ok(ports.includes(port),'Health PID must own listener');
   if(release){if(!d.dependency.startsWith(path.join(release,'node_modules')+path.sep))throw new AcceptanceError('RELEASE_DEPENDENCY_FALLBACK');if(!d.main.startsWith(path.join(release,'dist')+path.sep))throw new AcceptanceError('RELEASE_ENTRYPOINT_NOT_REALPATH');}
   return {pid:p.pid,diagnostics:d,metadata:declaration(p.pm2_env)};
  }
  if(!expectGood){assert.equal(h.status,null,'Expected startup failure, not a responding service');assert.equal(fs.existsSync(path.join(base,'.env')),false,'Missing-configuration injection must remain active');const failed=selected();assert.equal(failed.pm2_env.exec_mode,'fork_mode');const rejected=startupRejectionEvidence(failed.pm2_env);report.missingEnvironmentRuntime=rejected;if(n>=12&&rejected.startupRejectionObserved)return rejected;}
  await wait(200);
 }
 throw new AcceptanceError(last.status===503?'HEALTH_FAILED':'STARTUP_OR_HEALTH_FAILED');
}
function restoreEnvInvariant(){const s=fs.statSync(path.join(base,'.env'));assert.deepEqual({ino:s.ino,mode:s.mode&0o777,uid:s.uid},envIdentity);assert.equal(digest(fs.readFileSync(path.join(base,'.env'))),digest(envBytes));}
async function killDaemon(){
 guard();let daemon=null;
 try{const pid=Number(fs.readFileSync(path.join(pm2Home,'pm2.pid'),'utf8').trim());daemon=identity(pid);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(daemon&&daemon.state!=='Z'){
  tracked.set(daemon.pid+':'+daemon.start,daemon);
  const managed=rows();assert.ok(managed.every(row=>row.name===appName),'Unexpected app in private PM2 daemon');for(const row of managed)remember(row.pid);
  pm2(['kill']);
 }
 for(let n=0;n<100;n++){if([...tracked.values()].every(id=>!remainsAlive(id)))return;await wait(100);}
 throw Error('Isolated PM2 shutdown incomplete; fixture must be retained');
}
async function resurrect(port,opts){pm2(['resurrect']);return health(port,opts);}
async function main(){
 if(process.platform!=='linux'||process.version!=='v24.18.1')throw Error('Explicit Linux Node24.18.1 rehearsal required');
 const tools=path.resolve(process.env.CDNN_TEST_PM2_ROOT||'');assert.ok(process.env.CDNN_TEST_PM2_ROOT,'Explicit private PM2 tools root required');
 runnerTemp=fs.realpathSync(process.env.RUNNER_TEMP||'/tmp');assert.equal(tools,path.join(runnerTemp,'cdnn-pm2-tools-7.0.3','node_modules','pm2'),'PM2 tools must be the dedicated runner-temp package');assert.equal(fs.realpathSync(tools),tools,'PM2 tools must be canonical');assert.equal(fs.statSync(runnerTemp).uid,process.getuid());assert.equal(runnerTemp.startsWith('/var/www'),false);
 application=path.resolve(process.env.CDNN_TEST_APPLICATION_ROOT||'');assert.ok(process.env.CDNN_TEST_APPLICATION_ROOT,'Explicit pinned application artifact required');
 assert.equal(application,path.join(runnerTemp,'cdnn-pinned-application','source'),'Application must be the dedicated reused artifact');assert.equal(fs.realpathSync(application),application);assert.equal(fs.statSync(application).uid,process.getuid());assert.equal(fs.statSync(application).mode&0o022,0);
 built=path.join(application,'dist');
 const expectedArtifacts={sourceSha:'9f1d6b50dd5d33d312feba0fa23fa4d1e2d46682',distHash:'80a19572e5f1def889327768a8e4a005bfd14069f17d6c1403ba40b7efebe4b4',packageHash:'07b0cd20cfdbd0d95c96386b97a4102074e1d1ac046b264fbfc969c1ac164a43',lockHash:'821fa821a2f350974d20f88f04d5c94e5f4605c902204aa17c7ad98d0ac35616'};
 for(const [file,key] of [['package.json','packageHash'],['package-lock.json','lockHash']]){const filePath=path.join(application,file),st=fs.lstatSync(filePath);assert.ok(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&!(st.mode&0o022));assert.equal(digest(fs.readFileSync(filePath)),expectedArtifacts[key],key);}
 assert.equal(core.tree(built),expectedArtifacts.distHash,'Pinned artifact dist hash');
 report.applicationArtifacts={...expectedArtifacts,provenance:'Reused independently reviewed artifact12735767418; no rebuild or new provenance claim'};
 const pkgRoot=tools,pkg=JSON.parse(fs.readFileSync(path.join(pkgRoot,'package.json'),'utf8'));assert.equal(pkg.version,'7.0.3');pm2Bin=fs.realpathSync(path.join(pkgRoot,'bin','pm2'));
 root=fs.mkdtempSync(path.join(runnerTemp,'cdnn-pm2-rehearsal-'));home=path.join(root,'home');pm2Home=path.join(home,'.pm2');base=path.join(root,'app');for(const p of [home,pm2Home,base])fs.mkdirSync(p,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
 env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:home,PM2_HOME:pm2Home,PM2_SILENT:'true',NO_COLOR:'1'};guard();
 report.node=process.version;report.pm2=pkg.version;const lock=path.join(path.dirname(path.dirname(tools)),'package-lock.json');report.toolLockSha256=fs.existsSync(lock)?digest(fs.readFileSync(lock)):null;assert.ok(report.toolLockSha256,'PM2 transitive dependency lock evidence required');
 stage='fixture';
 fs.mkdirSync(path.join(base,'dist'));for(const entry of ['config/config.module.js','health/health.module.js'])copyCompiled(entry);
 const applicationPackage=JSON.parse(fs.readFileSync(path.join(application,'package.json'),'utf8'));const roots=['@nestjs/common','@nestjs/core','@nestjs/config','@nestjs/platform-express','reflect-metadata','rxjs'];if(applicationPackage.dependencies?.['@nestjs/swagger'])roots.push('@nestjs/swagger');const dependencies=copyDependencies(roots);
 fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'isolated-pm2-nest-rehearsal',private:true,dependencies}));fs.writeFileSync(path.join(base,'package-lock.json'),JSON.stringify({fixture:true,dependencies}));
 const port=await unusedPort();
 envBytes=Buffer.from(['NODE_ENV=production','PORT='+port,'PUBLIC_APP_URL=https://rehearsal.example.test','CORS_ALLOWED_ORIGINS=https://rehearsal.example.test','DATABASE_URL=postgresql://synthetic@127.0.0.1:1/rehearsal_unused','AUTH_PERSISTENCE=postgres','JWT_ACCESS_SECRET='+crypto.randomBytes(32).toString('hex'),'JWT_REFRESH_SECRET='+crypto.randomBytes(32).toString('hex')].join('\n')+'\n');fs.writeFileSync(path.join(base,'.env'),envBytes,{mode:0o600});const es=fs.statSync(path.join(base,'.env'));envIdentity={ino:es.ino,uid:es.uid,mode:es.mode&0o777};
 fs.writeFileSync(path.join(base,'dist','main.js'),String.raw`require('reflect-metadata');
 const fs=require('node:fs');const launchHadNodeEnv=Object.hasOwn(process.env,'NODE_ENV'),launchHadPort=Object.hasOwn(process.env,'PORT');
 const {Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core'),{ConfigService}=require('@nestjs/config');
 const {AppConfigModule}=require('./config/config.module'),{HealthModule}=require('./health/health.module');
 class RehearsalModule{};Module({imports:[AppConfigModule,HealthModule]})(RehearsalModule);
 (async()=>{const app=await NestFactory.create(RehearsalModule,{logger:false});const cfg=app.get(ConfigService);app.setGlobalPrefix('api/v1');
 app.use((req,res,next)=>{if(req.url==='/api/v1/health'&&fs.existsSync('inject-health-failure')){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end('{"success":false}');}else next();});
 app.getHttpAdapter().get('/__rehearsal',(req,res)=>res.json({pid:process.pid,main:__filename,dependency:require.resolve('@nestjs/core'),environment:cfg.get('app.environment'),configPort:cfg.get('app.port'),launchHadNodeEnv,launchHadPort}));
 await app.listen(cfg.get('app.port'),'127.0.0.1');})().catch(()=>process.exit(81));
 `);
 cfg={app:'backend',base,baselineSha:'1'.repeat(40)};initial=core.inventory(cfg);const evidence={schema:1,app:'backend',sourceSha:cfg.baselineSha,...Object.fromEntries(['distHash','modulesHash','packageHash','lockHash'].map(k=>[k,initial[k]])),provenance:{method:'trusted-build-manifest',reference:'isolated-generated-fixture-only',reviewedBy:'automated-rehearsal-fixture'}};const runtime={reviewed:true,scope:'synthetic-fixture-only-not-production-contract'};
 stage='initial-launch';pm2(['start',path.join(base,'dist','main.js'),'--name',appName,'--cwd',base,'--interpreter',process.execPath,'--max-memory-restart','1G','--max-restarts','2']);const first=await health(port);report.launchDeclarations=first.metadata;for(const key of ['cwd','script','interpreter'])assert.equal(first.metadata[key],true,key);assert.equal(first.metadata.mode,'fork_mode');assert.equal(Object.values(first.metadata.options).includes('<UNREVIEWED>'),false);for(const key of ['nodeArgs','args','nodeOptions'])assert.ok(Array.isArray(first.metadata[key]),key);report.checks.initialActualNestHealth=true;
 stage='save-resurrect';pm2(['save','--force']);const declared=declaration(saved());report.savedLaunchDeclarations=declared;report.initialSavedDifferences=verifySavedTransformation(first.metadata,declared);report.checks.onlyDocumentedInstanceDeclarationOmittedBySave=true;await killDaemon();const restored=await resurrect(port);assert.notEqual(restored.pid,first.pid);verifyResurrectedDeclaration(restored.metadata,declared,first.metadata);report.resurrectedLaunchDeclarations=restored.metadata;report.restartContractStatus='BLOCKED_UNDECLARED_LAUNCH_FIELDS';report.restartContractBlockers=['PM2_INSTANCES_UNDECLARED','PM2_PORT_UNDECLARED','PM2_ENVIRONMENT_UNDECLARED','PRODUCTION_CONTRACT_UNREVIEWED'];report.checks.originalColdResurrection=true;
 stage='symlink-bootstrap';const guarded=()=>{guard();const p=selected(),id=identity(p.pid);if(!id||id.state==='Z'||p.pm2_env.status!=='online'||!Number.isSafeInteger(p.pm2_env.restart_time))throw Error('ISOLATED_PROCESS_UNAVAILABLE');return {pid:p.pid,startTicks:id.start,restartCount:p.pm2_env.restart_time};};const initialProcess=guarded();runtime.independentEvidence={kernel:{pid:initialProcess.pid,startTicks:initialProcess.startTicks},pm2RestartCounter:initialProcess.restartCount};const planned=core.plan(cfg,evidence,runtime);assert.equal(planned.ready,true,planned.blockers.join('; '));const applied=core.apply(cfg,evidence,planned.digest,{runtime,processGuard:guarded,verify:()=>{}});assert.equal(fs.lstatSync(path.join(base,'dist')).isSymbolicLink(),true);assert.equal((await health(port)).pid,restored.pid);await killDaemon();const active=await resurrect(port,{release:applied.release});report.symlinkLaunchDeclarations=active.metadata;report.symlinkCurrentSavedMetadataEqual=JSON.stringify(active.metadata)===JSON.stringify(declaration(saved()));assert.equal(report.symlinkCurrentSavedMetadataEqual,true,'Symlink resurrection drifted from saved launch declaration');verifyResurrectedDeclaration(active.metadata,declared,first.metadata);report.checks.symlinkResurrectionPreservesCompleteComparedDeclaration=true;report.checks.symlinkResurrectionReleaseLocalDependencies=true;report.checks.applicationLoadsCwdConfigurationWithoutLaunchDeclarations=true;assert.equal(active.metadata.port,null);assert.equal(active.metadata.environment,null);assert.equal(fs.existsSync(path.join(applied.release,'.env')),false);restoreEnvInvariant();
 stage='missing-env';await killDaemon();fs.renameSync(path.join(base,'.env'),path.join(base,'.held-env'));report.missingEnvironmentStartupRejection=await resurrect(port,{expectGood:false});await killDaemon();fs.renameSync(path.join(base,'.held-env'),path.join(base,'.env'));await resurrect(port,{release:applied.release});restoreEnvInvariant();report.checks.missingEnvironmentFileFailsStartupAndRestores=true;
 stage='missing-release-dependency';await killDaemon();const dep=path.join(applied.release,'node_modules','@nestjs','core'),held=path.join(applied.release,'node_modules','@nestjs','core-held');fs.renameSync(dep,held);let fallbackRejected=false;try{await resurrect(port,{release:applied.release});}catch(error){if(!(error instanceof AcceptanceError)||!['RELEASE_DEPENDENCY_FALLBACK','STARTUP_OR_HEALTH_FAILED','HEALTH_FAILED'].includes(error.code))throw error;fallbackRejected=true;report.missingDependencyOutcome=error.code;}assert.equal(fallbackRejected,true,'Missing release dependency must fail release-local acceptance');await killDaemon();fs.renameSync(held,dep);await resurrect(port,{release:applied.release});report.checks.missingReleaseDependencyRejectedByAcceptance=true;
 stage='failed-health-and-recovery';fs.writeFileSync(path.join(base,'inject-health-failure'),'synthetic-only');const bad=await response(port,'/api/v1/health');assert.equal(bad.status,503);assert.equal(validHealth(bad.status,bad.body),false);assert.equal(selected().pm2_env.status,'online');report.checks.onlineDoesNotOverrideFailedHealth=true;
 const recovery=core.recoveryPlan(cfg);assert.equal(recovery.state,'exchanged');assert.throws(()=>core.recover(cfg,recovery.digest,{processGuard:guarded}),/PROCESS_DRIFT|runtime|process/i);report.checks.restartedProcessBlocksAutomaticPathRecovery=true;guard();core.exchange(path.join(base,'dist'),applied.original);report.checks.separatelyControlledSyntheticPathRestoration=true;fs.unlinkSync(path.join(base,'inject-health-failure'));await killDaemon();const finalProcess=await resurrect(port);verifyResurrectedDeclaration(finalProcess.metadata,declared,first.metadata);assert.deepEqual(finalProcess.metadata,declaration(saved()),'Recovered process declaration differs from saved');report.recoveredLaunchDeclarations=finalProcess.metadata;report.checks.recoveryPreservesCompleteComparedDeclaration=true;report.checks.previousKnownGoodArtifactsResurrectAfterRecovery=true;
 const final=core.inventory(cfg);for(const key of ['distHash','modulesHash','packageHash','lockHash','env'])assert.deepEqual(final[key],initial[key],key);restoreEnvInvariant();assert.equal(core.recoveryPlan(cfg).state,'original');report.checks.exactOriginalHashesAndEnvironmentIdentityRestored=true;
 stage='strict-gate';const productionContract=require('./runtime-contract.json');assert.equal(productionContract.reviewed,false);report.checks.productionRestartContractRemainsUnreviewed=true;report.result='PASS';
}
module.exports={response,diagnosticTokens,startupRejectionEvidence,verifySavedTransformation,verifyResurrectedDeclaration};
if(require.main===module)(async()=>{
 try{await main();}catch(error){report.result='FAIL';report.failedStage=stage;report.failureClass=error instanceof AcceptanceError?error.code:error?.code==='ERR_ASSERTION'?'ACCEPTANCE_ASSERTION':'HARNESS_OR_COMMAND_FAILURE';process.exitCode=1;}
 finally{
  if(root&&env){try{await killDaemon();report.checks.isolatedDaemonStopped=true;}catch{report.checks.isolatedDaemonStopped=false;report.result='FAIL';process.exitCode=1;}}
  report.privateLogTokens=privateLogDiagnostics();
  if(root&&report.checks.isolatedDaemonStopped){try{guard();fs.rmSync(root,{recursive:true,force:true});report.checks.privateFixtureRemoved=true;}catch{report.checks.privateFixtureRemoved=false;report.result='FAIL';process.exitCode=1;}}else if(root){report.checks.privateFixtureRemoved=false;report.retainedFixture=root;}
  const output=process.env.CDNN_PM2_REHEARSAL_REPORT;if(output){try{const permitted=fs.realpathSync(process.env.RUNNER_TEMP||'/tmp');assert.equal(path.resolve(output),path.join(permitted,'cdnn-pm2-rehearsal-summary.json'));assert.equal(fs.statSync(permitted).uid,process.getuid());assert.equal(permitted.startsWith('/var/www'),false);fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}catch{console.error('SANITIZED_REPORT_WRITE_FAILED');process.exitCode=1;}}
  console.log(JSON.stringify(report,null,2));
 }
})();
