const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtimeMetadata,assessRuntime}=require('./release-checks.cjs');
const contract=require('./runtime-contract.json');
function fixture(){
 const base='/var/www/congdongngonngu/backend';
 const rows=[{name:'cdnn-backend',pid:123,pm2_env:{status:'online',pm_cwd:base,pm_exec_path:base+'/dist/main.js',exec_interpreter:'node',exec_mode:'fork_mode',autorestart:true,watch:false,max_memory_restart:1073741824,treekill:true}}];
 const proof={resolvedInterpreter:'/usr/bin/node',nodeVersion:'24.18.1'};
 const evidence={pm2OnlineProcessCount:1,kernel:{pid:123,startTicks:'456',cwdMatches:true,executableMatches:true,listeningOn3201:true},application:{httpStatus:200,productionHealth:true}};
 return {rows,proof,evidence,review:{...contract,observationReviewed:true,...runtimeMetadata(rows,proof)}};
}
test('observed null launch fields are preserved; observations never approve restart',()=>{
 const {rows,proof,evidence,review}=fixture(),result=assessRuntime(rows,review,proof,evidence);
 assert.equal(result.observedDeployment,'PASS');assert.equal(result.restartSafety,'BLOCKED');assert.equal(result.reviewed,false);
 assert.deepEqual(result.blockers,['PM2_INSTANCES_UNDECLARED','PM2_PORT_UNDECLARED','PM2_ENVIRONMENT_UNDECLARED','RESTART_CONTRACT_UNREVIEWED']);
 const metadata=runtimeMetadata(rows,proof);for(const k of ['instances','port','environment'])assert.equal(metadata[k],null);
});
test('drift, duplicates, incomplete observations and unsafe arguments fail observation review',()=>{
 for(const change of [x=>x.rows.push(structuredClone(x.rows[0])),x=>x.rows[0].pm2_env.status='stopped',x=>x.rows[0].pm2_env.watch=true,x=>x.rows[0].pm2_env.NODE_OPTIONS='--require=/private/secret',x=>x.evidence.kernel.pid=999,x=>x.evidence.kernel.listeningOn3201=false,x=>x.evidence.application.productionHealth=false,x=>x.review.observationReviewed=false]){
  const f=fixture();change(f);const r=assessRuntime(f.rows,f.review,f.proof,f.evidence);assert.equal(r.observedDeployment,'BLOCKED');assert.equal(r.reviewed,false);
 }
});
test('forging reviewed=true cannot substitute observations for launch declarations',()=>{
 const f=fixture();f.review.reviewed=true;const r=assessRuntime(f.rows,f.review,f.proof,f.evidence);assert.equal(r.restartSafety,'BLOCKED');assert.equal(r.reviewed,false);
});

test('committed observation baseline matches the documented PM2 row without filling absent fields',()=>{
 const f=fixture();for(const [key,value] of Object.entries(runtimeMetadata(f.rows,f.proof)))assert.deepEqual(contract[key],value,key);
 const r=assessRuntime(f.rows,contract,f.proof,f.evidence);assert.equal(r.observedDeployment,'PASS');assert.equal(r.endpointCorrelation,'UNVERIFIED');assert.equal(r.reviewed,false);
});
