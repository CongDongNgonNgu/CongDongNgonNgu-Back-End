// Live metadata is consumed in memory and sanitized before it leaves this process.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {assessRuntime,runtimeMetadata}=require('./release-checks.cjs');
async function collect(){
 if(os.userInfo().username!=='cdnn-deploy'||process.env.PM2_HOME!=='/home/cdnn-deploy/.pm2')throw Error('Wrong PM2 identity');
 if(spawnSync('systemctl',['is-active','--quiet','pm2-cdnn-deploy']).status!==0)throw Error('PM2 service not active');
 const home=process.env.PM2_HOME,socketPath=path.join(home,'rpc.sock');
 const stat=fs.lstatSync(socketPath);if(!stat.isSocket()||stat.uid!==process.getuid())throw Error('Wrong PM2 socket');
 const daemonPid=Number(fs.readFileSync(path.join(home,'pm2.pid'),'utf8').trim());
 if(!Number.isInteger(daemonPid)||daemonPid<1)throw Error('PM2 daemon absent');process.kill(daemonPid,0);
 let entry;
 for(const dir of (process.env.PATH||'').split(path.delimiter)){try{const candidate=path.join(dir,'pm2');fs.accessSync(candidate,fs.constants.X_OK);entry=fs.realpathSync(candidate);break;}catch{}}
 if(!entry||path.basename(entry)!=='pm2'||path.basename(path.dirname(entry))!=='bin')throw Error('Installed PM2 package not located');
 const root=path.dirname(path.dirname(entry)),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 if(pkg.name!=='pm2'||pkg.version!=='7.0.3')throw Error('PM2 7.0.3 compatibility review required');
 process.env.DEBUG=''; // Transport debug output must not disclose raw RPC payloads.
 const req=createRequire(path.join(root,'package.json'));
 const transport=name=>fs.existsSync(path.join(root,'modules',name))?require(path.join(root,'modules',name)):req(name);
 const rows=await require('./pm2-socket.cjs').readRows(transport('pm2-axon'),transport('pm2-axon-rpc'),socketPath);
 const matches=rows.filter(x=>x.name==='cdnn-backend');
 if(matches.length!==1||!Number.isInteger(matches[0].pid)||matches[0].pid<1||matches[0].pm2_env?.status!=='online')throw Error('Expected one online application');
 const restartCount=matches[0].pm2_env.restart_time;
 if(!Number.isSafeInteger(restartCount)||restartCount<0)throw Error('PM2 restart identity unavailable');
 const resolvedInterpreter=fs.realpathSync('/proc/'+matches[0].pid+'/exe');
 if(!runtimeMetadata(rows,{resolvedInterpreter}).resolvedInterpreter)throw Error('Unsupported interpreter path; inspect locally');
 const version=spawnSync(resolvedInterpreter,['--version'],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}});
 if(version.status!==0)throw Error('Cannot verify actual interpreter');
 const proof={resolvedInterpreter,nodeVersion:version.stdout.trim().replace(/^v/,'')};
 const kernel=require('./runtime-proof.cjs').inspectProcess(matches[0].pid,{expectedInterpreter:resolvedInterpreter});
 const {validHealth}=require('./release-checks.cjs');
 let application={httpStatus:null,productionHealth:false};
 try{const response=await fetch('http://127.0.0.1:3201/api/v1/health',{redirect:'error',signal:AbortSignal.timeout(5000)});application={httpStatus:response.status,productionHealth:validHealth(response.status,await response.json())};}catch{}
 const after=require('./runtime-proof.cjs').inspectProcess(matches[0].pid,{expectedInterpreter:resolvedInterpreter});
 if(JSON.stringify(after)!==JSON.stringify(kernel))throw Error('Process changed across health inspection');
 const afterRows=await require('./pm2-socket.cjs').readRows(transport('pm2-axon'),transport('pm2-axon-rpc'),socketPath);
 if(!require('./runtime-process.cjs').samePm2Process(rows,afterRows)||JSON.stringify(runtimeMetadata(afterRows,proof))!==JSON.stringify(runtimeMetadata(rows,proof)))throw Error('PM2 identity changed across inspection');
 const independentEvidence={pm2OnlineProcessCount:matches.length,pm2RestartCounter:restartCount,pm2Status:'online',kernel,application};
 const metadata=runtimeMetadata(rows,proof),contract=JSON.parse(fs.readFileSync(__dirname+'/runtime-contract.json','utf8'));
 const assessment=assessRuntime(rows,contract,proof,independentEvidence);
 return {...assessment,metadata,independentEvidence,fingerprint:crypto.createHash('sha256').update(JSON.stringify({metadata,contract,independentEvidence})).digest('hex')};
}
function capture(){
 const result=spawnSync(process.execPath,[__filename,'--capture'],{encoding:'utf8',maxBuffer:1024*1024,timeout:15000,env:{PATH:process.env.PATH,PM2_HOME:process.env.PM2_HOME}});
 if(result.status!==0)throw Error('Read-only PM2 inspection failed; no daemon was started');
 return JSON.parse(result.stdout);
}
module.exports={capture};
if(require.main===module)collect().then(result=>{
 if(process.argv.includes('--inspect'))console.log(JSON.stringify({reviewed:false,...result.metadata,independentEvidence:result.independentEvidence,assessment:{observationScope:result.observationScope,endpointCorrelation:result.endpointCorrelation,observedDeployment:result.observedDeployment,restartSafety:result.restartSafety,blockers:result.blockers},metadataSource:'PM2 getMonitorData; null means absent or unsupported, not an effective application default'},null,2));
 else if(process.argv.includes('--capture'))console.log(JSON.stringify(result));
 else if(!result.reviewed)throw Error('Runtime review incomplete');
}).catch(()=>{console.error('PM2 runtime gate failed; inspect sanitized metadata and review contract. No daemon startup fallback is permitted.');process.exitCode=1;});
