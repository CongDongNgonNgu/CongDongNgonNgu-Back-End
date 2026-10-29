'use strict';
// Bound to the existing named-process OAuth runbook. Raw PM2/env data never leaves memory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const BASE='/var/www/congdongngonngu/backend',HOME='/home/cdnn-deploy/.pm2';
const OPTIONS=['autorestart','watch','max_memory_restart','kill_timeout','listen_timeout','restart_delay','exp_backoff_restart_delay','cron_restart','wait_ready','stop_exit_codes','shutdown_with_message','treekill'];
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(stable(v))).digest('hex');
const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const check=(ok)=>{if(!ok)throw Error('RUNTIME_GUARD_REFUSED');};
function launch(e){return hash([e.pm_cwd,e.pm_exec_path,e.exec_interpreter,e.exec_mode,e.args??null,e.node_args??null,e.interpreter_args??null,e.instances??null,e.PORT??null,e.NODE_ENV??null,e.NODE_OPTIONS??null,e.env??null,Object.fromEntries(OPTIONS.map(k=>[k,e[k]??null]))]);}
function select(rows){check(Array.isArray(rows));const targets=rows.filter(p=>p.name==='cdnn-backend');check(targets.length===1);return targets[0];}
function others(rows){return rows.filter(p=>p.name!=='cdnn-backend').map(p=>({id:p.pm_id,name:p.name,pid:p.pid,status:p.pm2_env?.status,restarts:p.pm2_env?.restart_time,launch:launch(p.pm2_env||{})})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
function makeSnapshot(rows,facts){
 const row=select(rows),e=row.pm2_env;check(e&&e.pm_cwd===BASE&&e.pm_exec_path===BASE+'/dist/main.js'&&e.exec_mode==='fork_mode');
 const metadata=require('./release-checks.cjs').runtimeMetadata(rows,{resolvedInterpreter:facts.exe,nodeVersion:facts.nodeVersion});
 check(metadata.interpreter&&metadata.resolvedInterpreter&&/^24\.[0-9]+\.[0-9]+$/.test(facts.nodeVersion));
 check((metadata.instances===null||metadata.instances===1)&&(e.instances==null||e.instances===1));
 check((e.PORT??e.env?.PORT)==null||(e.PORT??e.env?.PORT)===3201||(e.PORT??e.env?.PORT)==='3201');
 check((e.NODE_ENV??e.env?.NODE_ENV)==null||(e.NODE_ENV??e.env?.NODE_ENV)==='production');
 check([metadata.args,metadata.node_args,metadata.node_options].every(Array.isArray)&&!Object.values(metadata.options).includes('<UNREVIEWED>'));
 check(Number.isSafeInteger(e.restart_time)&&e.restart_time>=0&&Number.isInteger(row.pid)&&row.pid>=0);
 const online=e.status==='online';
 if(online){check(row.pid>0&&facts.kernel?.pid===row.pid&&facts.kernel.cwdMatches===true&&facts.kernel.executableMatches===true&&/^\d+$/.test(facts.kernel.startTicks));}
 else check(row.pid===0&&['stopped','errored'].includes(e.status));
 return {version:1,target:{pid:row.pid,startTicks:online?facts.kernel.startTicks:null,restarts:e.restart_time,status:e.status,cwd:BASE,script:BASE+'/dist/main.js',exe:facts.exe,nodeVersion:facts.nodeVersion,launch:launch(e),declarations:{instances:e.instances??null,port:e.PORT??e.env?.PORT??null,environment:e.NODE_ENV??e.env?.NODE_ENV??null}},others:others(rows),env:facts.env,daemon:facts.daemon,healthy:online&&facts.healthy===true};
}
function validateTransition(before,now,mode,facts){
 check(before?.version===1&&now?.version===1&&['capture','unchanged','stopped','restarted','recoverable'].includes(mode));
 check(equal(before.env,now.env)&&equal(before.daemon,now.daemon)&&equal(before.others,now.others));
 for(const key of ['cwd','script','exe','nodeVersion','launch','declarations'])check(equal(before.target[key],now.target[key]));
 const a=before.target,b=now.target,online=b.status==='online'&&b.pid>0;
 if(mode==='capture'||mode==='unchanged'||mode==='restarted')check(online&&now.healthy&&facts.listener==='owned');
 if(mode==='unchanged')check(equal(a,b));
 if(mode==='restarted')check(b.pid!==a.pid&&b.startTicks!==a.startTicks&&b.restarts>a.restarts&&!facts.originalAlive);
 if(mode==='stopped'||(mode==='recoverable'&&!online))check(b.pid===0&&['stopped','errored'].includes(b.status)&&!facts.originalAlive&&facts.listener==='absent');
 if(mode==='recoverable'&&online)check(['owned','absent'].includes(facts.listener)&&(b.pid===a.pid||!facts.originalAlive));
 return true;
}
function privateRead(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);check(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&511)===384&&s.size<1024*1024);const bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd);check(s.ino===after.ino&&s.dev===after.dev&&s.size===after.size&&s.mtimeMs===after.mtimeMs);return {bytes,metadata:{uid:s.uid,mode:s.mode&511,dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,hash:hash(bytes)}};}finally{fs.closeSync(fd);}
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw Error('RUNTIME_GUARD_REFUSED');}}
function daemon(){const pid=Number(fs.readFileSync(HOME+'/pm2.pid','utf8').trim());check(Number.isSafeInteger(pid)&&pid>0&&fs.statSync('/proc/'+pid).uid===process.getuid());return {pid,startTicks:require('./runtime-proof.cjs').startTicks(fs.readFileSync('/proc/'+pid+'/stat','utf8'))};}
function listener(pid){
 const result=spawnSync('ss',['-H','-lntp','sport = :3201'],{encoding:'utf8',timeout:5000});check(result.status===0);
 const lines=result.stdout.trim().split('\n').filter(Boolean);if(!lines.length)return 'absent';
 return pid>0&&lines.every(line=>{const pids=[...line.matchAll(/\bpid=(\d+),/g)].map(x=>Number(x[1]));return pids.length>0&&pids.every(x=>x===pid);})?'owned':'foreign';
}
async function collect(before){
 check(process.platform==='linux'&&require('node:os').userInfo().username==='cdnn-deploy'&&process.env.PM2_HOME===HOME);
 check(spawnSync('systemctl',['is-active','--quiet','pm2-cdnn-deploy'],{timeout:5000}).status===0);
 const socket=fs.lstatSync(HOME+'/rpc.sock');check(socket.isSocket()&&socket.uid===process.getuid());
 let entry;for(const dir of (process.env.PATH||'').split(path.delimiter)){try{const p=path.join(dir,'pm2');fs.accessSync(p,fs.constants.X_OK);entry=fs.realpathSync(p);break;}catch{}}
 check(entry&&path.basename(entry)==='pm2'&&path.basename(path.dirname(entry))==='bin');
 const root=path.dirname(path.dirname(entry)),pkg=JSON.parse(fs.readFileSync(root+'/package.json','utf8'));check(pkg.name==='pm2'&&pkg.version==='7.0.3');
 process.env.DEBUG='';const req=createRequire(root+'/package.json');const transport=name=>fs.existsSync(path.join(root,'modules',name))?require(path.join(root,'modules',name)):req(name);
 const readRows=()=>require('./pm2-socket.cjs').readRows(transport('pm2-axon'),transport('pm2-axon-rpc'),HOME+'/rpc.sock');
 const initialDaemon=daemon(),env=privateRead(BASE+'/.env').metadata,rows=await readRows(),row=select(rows),online=row.pm2_env?.status==='online';
 const exe=online?fs.realpathSync('/proc/'+row.pid+'/exe'):before?.target.exe;check(exe&&require('./release-checks.cjs').runtimeMetadata(rows,{resolvedInterpreter:exe}).resolvedInterpreter===exe);
 const version=spawnSync(exe,['--version'],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}});check(version.status===0);
 const kernel=online?require('./runtime-proof.cjs').inspectProcess(row.pid,{expectedInterpreter:exe}):null;
 let healthy=false;if(online){try{const r=await fetch('http://127.0.0.1:3201/api/v1/health',{redirect:'error',signal:AbortSignal.timeout(5000)});healthy=require('./release-checks.cjs').validHealth(r.status,await r.json());}catch{}}
 const facts={exe,nodeVersion:version.stdout.trim().replace(/^v/,''),kernel,env,daemon:initialDaemon,healthy};
 const snapshot=makeSnapshot(rows,facts),again=await readRows(),second=makeSnapshot(again,facts);
 check(equal(snapshot,second)&&equal(initialDaemon,daemon())&&equal(env,privateRead(BASE+'/.env').metadata));
 if(online)check(equal(kernel,require('./runtime-proof.cjs').inspectProcess(row.pid,{expectedInterpreter:exe})));
 return {snapshot,facts:{listener:listener(row.pid),originalAlive:before?alive(before.target.pid):true}};
}
async function main(){
 const [mode,file,...extra]=process.argv.slice(2);check(!extra.length&&file&&['capture','unchanged','stopped','restarted','recoverable'].includes(mode));
 const before=mode==='capture'?null:JSON.parse(privateRead(file).bytes.toString('utf8'));
 const {snapshot,facts}=await collect(before);validateTransition(before||snapshot,snapshot,mode,facts);
 if(mode==='capture')fs.writeFileSync(file,JSON.stringify(snapshot)+'\n',{flag:'wx',mode:384});
 console.log('RUNTIME_GUARD='+mode.toUpperCase()+'_PASS');
}
module.exports={makeSnapshot,validateTransition};
if(require.main===module)main().catch(()=>{console.error('RUNTIME_GUARD_REFUSED; no daemon startup or lifecycle fallback');process.exitCode=1;});
