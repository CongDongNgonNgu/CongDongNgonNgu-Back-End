const path=require('node:path');
function migrationState(files,rows){
 const local=new Map(files.map(x=>[x.filename,x.checksum]));
 const applied=new Map(rows.map(x=>[x.filename,x.checksum]));
 return {pending:files.filter(x=>!applied.has(x.filename)).length,
 changed:files.filter(x=>applied.has(x.filename)&&applied.get(x.filename)!==x.checksum).length,
 unknown:rows.filter(x=>!local.has(x.filename)).length};
}
function validHealth(status,body){return status===200&&body?.success===true&&body.data?.status==='ok'&&body.data.service==='congdongngonngu-backend'&&body.data.environment==='production';}
function validateRuntime(rows,review){
 const base='/var/www/congdongngonngu/backend';
 const matches=rows.filter(x=>x.name==='cdnn-backend');
 if(review?.reviewed!==true||matches.length!==1||review.cwd!==base||!review.script?.startsWith(base+'/dist/')||path.posix.normalize(review.script)!==review.script) return false;
 const p=matches[0].pm2_env;
 return p?.pm_cwd===review.cwd&&p.pm_exec_path===review.script&&p.exec_interpreter===review.interpreter&&p.exec_mode===review.exec_mode;
}
module.exports={migrationState,validHealth,validateRuntime};
