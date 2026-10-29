const path=require('node:path');
function migrationState(files,rows){
 const local=new Map(files.map(x=>[x.filename,x.checksum]));
 const applied=new Map(rows.map(x=>[x.filename,x.checksum]));
 return {pending:files.filter(x=>!applied.has(x.filename)).length,
 changed:files.filter(x=>applied.has(x.filename)&&applied.get(x.filename)!==x.checksum).length,
 unknown:rows.filter(x=>!local.has(x.filename)).length};
}
function validHealth(status,body){return status===200&&body?.success===true&&body.data?.status==='ok'&&body.data.service==='congdongngonngu-backend'&&body.data.environment==='production';}

const runtimeKeys=['cwd','script','interpreter','resolvedInterpreter','nodeVersion','exec_mode','instances','node_args','args','node_options','port','environment','options'];
function safeArgs(value,application=false){
 if(value===undefined||value===null||value==='')return [];
 const args=Array.isArray(value)?value:typeof value==='string'?value.trim().split(/\s+/):null;
 const allowed=application?/^--(?:port=3201|host=127\.0\.0\.1)$/:/^--(?:enable-source-maps|trace-warnings|trace-deprecation|no-warnings|preserve-symlinks(?:-main)?|unhandled-rejections=(?:strict|throw|warn|none)|max-(?:old|semi)-space-size=\d+)$/;
 return args&&args.every(x=>typeof x==='string'&&allowed.test(x))?args:null;
}
function runtimeMetadata(rows,proof={}){
 const matches=rows.filter(x=>x.name==='cdnn-backend');if(matches.length!==1)throw Error('Expected exactly one PM2 process');
 const p=matches[0].pm2_env;if(!p)throw Error('PM2 metadata absent');
 const base='/var/www/congdongngonngu/backend';
 const nodePath=x=>typeof x==='string'&&/^\/(?:usr\/(?:local\/)?bin|home\/cdnn-deploy\/\.nvm\/versions\/node\/v[0-9.]+\/bin)\/node$/.test(x)?x:null;
 const interpreter=p.exec_interpreter==='node'?'node':nodePath(p.exec_interpreter);
 const options={};for(const key of ['autorestart','watch','max_memory_restart','kill_timeout','listen_timeout','restart_delay','exp_backoff_restart_delay','cron_restart','wait_ready','stop_exit_codes','shutdown_with_message','treekill']){
  const value=p[key]??null;
  options[key]=(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&/^[0-9* ,/.-]{0,80}$/.test(value))||(Array.isArray(value)&&value.every(x=>Number.isInteger(x))))?value:'<UNREVIEWED>';
 }
 return {cwd:p.pm_cwd===base?base:null,script:p.pm_exec_path===base+'/dist/main.js'?base+'/dist/main.js':null,interpreter,resolvedInterpreter:nodePath(proof.resolvedInterpreter),nodeVersion:typeof proof.nodeVersion==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+$/.test(proof.nodeVersion)?proof.nodeVersion:null,exec_mode:['fork_mode','cluster_mode'].includes(p.exec_mode)?p.exec_mode:null,instances:Number.isInteger(p.instances)&&p.instances>0?p.instances:null,node_args:safeArgs(p.node_args??p.interpreter_args),args:safeArgs(p.args,true),node_options:safeArgs(p.NODE_OPTIONS??p.env?.NODE_OPTIONS),port:String(p.PORT??p.env?.PORT)==='3201'?'3201':null,environment:['production','test','development'].includes(p.NODE_ENV??p.env?.NODE_ENV)?(p.NODE_ENV??p.env?.NODE_ENV):null,options};
}
function validateRuntime(rows,review,proof={}){
 try{
  const base='/var/www/congdongngonngu/backend',actual=runtimeMetadata(rows,proof);
  if(review?.reviewed!==true||review.cwd!==base||review.script!==base+'/dist/main.js'||review.exec_mode!=='fork_mode'||review.instances!==1||review.environment!=='production'||review.port!=='3201'||!/^24\.[0-9]+\.[0-9]+$/.test(review.nodeVersion)||!review.resolvedInterpreter?.startsWith('/'))return false;
  if(Object.values(actual.options).includes('<UNREVIEWED>'))return false;
  if(!actual.interpreter||!actual.resolvedInterpreter||actual.instances!==1)return false;
  if(!Array.isArray(review.node_args)||!Array.isArray(review.args)||!Array.isArray(review.node_options)||!review.options)return false;
  return runtimeKeys.every(k=>JSON.stringify(actual[k])===JSON.stringify(review[k]));
 }catch{return false;}
}
// Observation review is deliberately independent of restart authorization.
function assessRuntime(rows,review,proof,evidence){
 let actual;try{actual=runtimeMetadata(rows,proof);}catch{return {observedDeployment:'BLOCKED',restartSafety:'BLOCKED',reviewed:false,blockers:['PM2_IDENTITY_AMBIGUOUS']};}
 const blockers=[];
 for(const [key,code] of [['instances','INSTANCES'],['port','PORT'],['environment','ENVIRONMENT']])if(actual[key]===null)blockers.push('PM2_'+code+'_UNDECLARED');
 if(review?.reviewed!==true)blockers.push('RESTART_CONTRACT_UNREVIEWED');
 const matches=rows.filter(x=>x.name==='cdnn-backend'),kernel=evidence?.kernel,app=evidence?.application;
 const metadataMatches=review?.observationReviewed===true&&runtimeKeys.every(k=>JSON.stringify(actual[k])===JSON.stringify(review[k]));
 const supported=actual.cwd&&actual.script&&actual.interpreter&&actual.resolvedInterpreter&&/^24\.[0-9]+\.[0-9]+$/.test(actual.nodeVersion)&&actual.exec_mode==='fork_mode'&&[actual.node_args,actual.args,actual.node_options].every(Array.isArray)&&!Object.values(actual.options).includes('<UNREVIEWED>');
 const observed=!!(metadataMatches&&supported&&matches[0].pm2_env.status==='online'&&evidence?.pm2OnlineProcessCount===1&&Number.isSafeInteger(kernel?.pid)&&kernel.pid>0&&kernel.pid===matches[0].pid&&/^[0-9]+$/.test(kernel.startTicks)&&kernel.cwdMatches===true&&kernel.executableMatches===true&&kernel.listeningOn3201===true&&app?.httpStatus===200&&app.productionHealth===true);
 if(!observed)blockers.push('OBSERVATION_MISSING_OR_DRIFTED');
 const restart=validateRuntime(rows,review,proof);
 if(!restart&&!blockers.length)blockers.push('RESTART_CONTRACT_MISMATCH');
 return {observationScope:'PM2 metadata match; PID-owned listener and separate localhost health',endpointCorrelation:'UNVERIFIED',observedDeployment:observed?'PASS':'BLOCKED',restartSafety:restart?'PASS':'BLOCKED',reviewed:observed&&restart,blockers};
}
module.exports={migrationState,validHealth,validateRuntime,runtimeMetadata,safeArgs,assessRuntime};
