const {test}=require('node:test');
const assert=require('node:assert/strict');
const {migrationState,validHealth,validateRuntime}=require('./release-checks.cjs');
test('migration gate rejects pending, modified, and unknown database migrations',()=>{
 const files=[{filename:'001.sql',checksum:'a'}];
 assert.deepEqual(migrationState(files,files),{pending:0,changed:0,unknown:0});
 assert.equal(migrationState(files,[]).pending,1);
 assert.equal(migrationState(files,[{filename:'001.sql',checksum:'b'}]).changed,1);
 assert.equal(migrationState(files,[...files,{filename:'002.sql',checksum:'c'}]).unknown,1);
});
test('health requires HTTP 200 and exact production identity',()=>{
 const body={success:true,data:{status:'ok',service:'congdongngonngu-backend',environment:'production'}};
 assert.equal(validHealth(200,body),true);
 assert.equal(validHealth(503,body),false);
 assert.equal(validHealth(200,{...body,data:{...body.data,environment:'test'}}),false);
 assert.equal(validHealth(200,{data:{status:'ok'}}),false);
});
test('runtime gate rejects unreviewed and mismatched PM2 config without exposing environment',()=>{
 const base='/var/www/congdongngonngu/backend';
 const contract={reviewed:true,cwd:base,script:base+'/dist/main.js',interpreter:'/usr/bin/node',exec_mode:'fork_mode'};
 const processes=[{name:'cdnn-backend',pm2_env:{pm_cwd:base,pm_exec_path:contract.script,exec_interpreter:contract.interpreter,exec_mode:'fork_mode'}}];
 assert.equal(validateRuntime(processes,contract),true);
 assert.equal(validateRuntime(processes,{...contract,reviewed:false}),false);
 assert.equal(validateRuntime(processes,{...contract,cwd:'/other'}),false);
 assert.equal(validateRuntime([...processes,...processes],contract),false);
 assert.equal(validateRuntime(processes,{...contract,script:base+'/../other/main.js'}),false);
});
