// jlist contains secrets: consume it in memory and emit only these five metadata fields.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const {validateRuntime}=require('./release-checks.cjs');
try{
 if(process.env.PM2_HOME!=='/home/cdnn-deploy/.pm2')throw Error('Wrong PM2 home');
 const result=spawnSync('pm2',['jlist'],{encoding:'utf8',maxBuffer:8*1024*1024});
 if(result.status!==0)throw Error('PM2 unavailable');
 const rows=JSON.parse(result.stdout);
 if(process.argv.includes('--inspect')){
  const matches=rows.filter(x=>x.name==='cdnn-backend');
  if(matches.length!==1)throw Error('Expected one application');
  const p=matches[0].pm2_env;
  console.log(JSON.stringify({reviewed:false,cwd:p.pm_cwd,script:p.pm_exec_path,interpreter:p.exec_interpreter,exec_mode:p.exec_mode},null,2));
 } else if(!validateRuntime(rows,JSON.parse(fs.readFileSync(__dirname+'/runtime-contract.json','utf8'))))throw Error('Unreviewed runtime');
} catch {console.error('PM2 runtime gate failed; inspect and review sanitized contract before activation.');process.exitCode=1;}
