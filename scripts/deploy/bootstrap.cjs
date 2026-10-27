'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const core=require('./bootstrap-core.cjs'),cfg=require('./bootstrap-config.json');
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('Invalid evidence JSON');}}
function verify(){
 const result=spawnSync(process.execPath,[path.join(__dirname,'verify.cjs'),...(cfg.app==='frontend'?[cfg.baselineSha]:[])],{encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH}});
 if(result.status!==0)throw Error('Public post-bootstrap health/assets check failed');
}
try{
 if(process.platform!=='linux'||os.userInfo().username!=='cdnn-deploy')throw Error('Run only as cdnn-deploy on Linux');
 const args=process.argv.slice(2),mode=args.shift(),allowed=['--plan','--apply','--recovery-plan','--recover','--verify'];
 if(!allowed.includes(mode)||args.length%2||args.some((x,i)=>i%2===0&&!['--evidence','--approve'].includes(x)))throw Error('Invalid command; read BOOTSTRAP.md');
 const opts={};for(let i=0;i<args.length;i+=2){if(opts[args[i]])throw Error('Duplicate argument');opts[args[i]]=args[i+1];}
 const mutating=['--apply','--recover'].includes(mode);
 if(mutating&&process.env.CDNN_BOOTSTRAP_LOCKED!=='1')throw Error('Use bootstrap.sh to acquire deployment lock');
 let result;
 if(mode==='--recovery-plan')result=core.recoveryPlan(cfg);
 else if(mode==='--recover')result=core.recover(cfg,opts['--approve']);
 else if(mode==='--verify'){result=core.recoveryPlan(cfg);if(result.state!=='exchanged')throw Error('Bootstrap is not active');verify();}
 else {
  const evidence=opts['--evidence']?json(opts['--evidence']):null;
  const runtime=cfg.app==='backend'?require('./check-runtime.cjs').capture():{reviewed:true};
  if(mode==='--plan'){result=core.plan(cfg,evidence,runtime);if(!result.ready)process.exitCode=2;}
  else result=core.apply(cfg,evidence,opts['--approve'],{runtime,verify,runtimeProbe:cfg.app==='backend'?require('./check-runtime.cjs').capture:undefined});
 }
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
