const {validatedTestTarget}=require('./phase30-sql-target.cjs');
// Runs only owned random-schema SQL proofs on the exact approved TEST target.
const {spawn}=require('node:child_process');const {Pool}=require('pg');
const allowed=new Set(['test/phase30/attachment-schema.sql-spec.ts','test/phase30/attachment-auth.sql-spec.ts','test/phase30/attachment-cleanup.sql-spec.ts','test/phase30/attachment-quota.sql-spec.ts','test/phase30/attachment-initiation.sql-spec.ts','test/phase30/attachment-upload.sql-spec.ts','test/phase30/attachment-access.sql-spec.ts','test/phase30/attachment-finalization.sql-spec.ts','test/phase30/attachment-lifecycle.sql-spec.ts','test/phase30/attachment-binding.sql-spec.ts']);
async function main(){
 const selected=process.argv.slice(2);if(selected.some(x=>!allowed.has(x)))throw Error('UNAPPROVED_PROOF_PATH');
 if(!process.env.PHASE22_TEST_DATABASE_URL&&!process.env.DATABASE_URL)process.loadEnvFile('.env');
 const {original,direct,local}=validatedTestTarget(process.env.PHASE22_TEST_DATABASE_URL||process.env.DATABASE_URL);
 const pool=new Pool({connectionString:direct.toString(),max:1,connectionTimeoutMillis:10000,query_timeout:10000});
 try{const r=(await pool.query("SELECT current_database() AS db,current_schema() AS schema,current_setting('server_version_num')::int AS version")).rows[0];if(r.db!==(local?'congdongngonngu_phase22_ci':'neondb')||r.schema!=='public'||r.version<180000)throw Error('READ_ONLY_TEST_PREFLIGHT_FAILED');}finally{await pool.end();}
 console.log('PHASE30_EXACT_APPROVED_TEST_PREFLIGHT=PASS_READ_ONLY; SQL fixtures are restricted to owned random schemas');
 const env={NODE_ENV:'test',PHASE22_TEST_DATABASE_URL:original.toString()};for(const key of ['PATH','SystemRoot','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 const args=['--experimental-vm-modules',require.resolve('jest/bin/jest'),'--runInBand','--config','test/phase30/jest-sql.json','--runTestsByPath',...(selected.length?selected:[...allowed])];
 const child=spawn(process.execPath,args,{cwd:process.cwd(),env,stdio:'inherit',shell:false,windowsHide:true});
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});process.exitCode=exit;
}
main().catch(()=>{console.error('PHASE30_SQL_PROOF_FAILED_NO_SECRET_DETAILS');process.exitCode=1;});
