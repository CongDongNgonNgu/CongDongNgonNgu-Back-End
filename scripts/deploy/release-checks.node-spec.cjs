const {test}=require('node:test');
const assert=require('node:assert/strict');
const {migrationState,validHealth,validateRuntime,runtimeMetadata,safeArgs}=require('./release-checks.cjs');
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

test('runtime metadata is sanitized and unreviewed/incomplete/drifted contract blocks',()=>{
 const base='/var/www/congdongngonngu/backend';
 const processes=[{name:'cdnn-backend',pm2_env:{pm_cwd:base,pm_exec_path:base+'/dist/main.js',exec_interpreter:'node',exec_mode:'fork_mode',instances:1,PORT:'3201',NODE_ENV:'production',DATABASE_URL:'SECRET_NOT_PRINTED'}}];
 const proof={resolvedInterpreter:'/usr/bin/node',nodeVersion:'24.18.0'};
 const contract={reviewed:true,...runtimeMetadata(processes,proof)};
 assert.equal(validateRuntime(processes,contract,proof),true);
 for(const field of ['node_args','args','node_options','options','resolvedInterpreter','nodeVersion'])assert.equal(validateRuntime(processes,{...contract,[field]:null},proof),false,field);
 assert.equal(validateRuntime(processes,{...contract,reviewed:false},proof),false);
 assert.equal(validateRuntime(processes,{...contract,cwd:'/other'},proof),false);
 assert.equal(validateRuntime([...processes,...processes],contract,proof),false);
 assert.equal(validateRuntime(processes,{...contract,node_args:['--enable-source-maps']},proof),false);
 assert.equal(JSON.stringify(runtimeMetadata(processes,proof)).includes('SECRET_NOT_PRINTED'),false);
 assert.equal(safeArgs('--password=SECRET'),null);
 assert.equal(safeArgs('--require=/secret.js'),null);
 assert.deepEqual(safeArgs('--enable-source-maps --max-old-space-size=512'),['--enable-source-maps','--max-old-space-size=512']);
 for(const key of ['exec_interpreter','instances']){const incomplete=structuredClone(processes);delete incomplete[0].pm2_env[key];assert.equal(validateRuntime(incomplete,{reviewed:true,...runtimeMetadata(incomplete,proof)},proof),false);}
 for(const key of ['PORT','NODE_ENV','pm_cwd','pm_exec_path','exec_interpreter']){const injected=structuredClone(processes);injected[0].pm2_env[key]='SECRET_DO_NOT_EMIT';assert.equal(JSON.stringify(runtimeMetadata(injected,proof)).includes('SECRET_DO_NOT_EMIT'),false,key);}
 processes[0].pm2_env.NODE_OPTIONS='--require=/secret.js';assert.equal(validateRuntime(processes,contract,proof),false);
});
