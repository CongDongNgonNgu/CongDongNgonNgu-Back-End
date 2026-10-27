// Read-only check only. Never invoke database/migrate.cjs from a production deploy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {migrationState}=require('./release-checks.cjs');
async function main(){
 if(!process.env.DATABASE_URL) throw Error('Database unavailable');
 const dir=path.resolve(__dirname,'../../database/migrations');
 const files=fs.readdirSync(dir).filter(x=>x.endsWith('.sql')&&!x.endsWith('.down.sql')).sort().map(filename=>({filename,checksum:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,filename),'utf8').replace(/\r\n/g,'\n').replace(/\r/g,'\n')).digest('hex')}));
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,max:1});
 try{
  const client=await pool.connect();
  try{
   await client.query('BEGIN READ ONLY');
   await client.query("SET LOCAL statement_timeout = '10s'");
   const {rows}=await client.query('SELECT filename, checksum FROM public.schema_migrations');
   const result=migrationState(files,rows);
   console.log(JSON.stringify({migrationCheck:result}));
   if(Object.values(result).some(x=>x!==0)) throw Error('Reviewed migration plan required');
  } finally {try {await client.query('ROLLBACK');} finally {client.release();}}
 } finally {await pool.end();}
}
main().catch(()=>{console.error('Migration gate failed. Require reviewed backup/recovery plan; no schema changes performed.');process.exitCode=1;});
