'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {makeSnapshot,validateTransition}=require('./runtime-snapshot.cjs');
const base='/var/www/congdongngonngu/backend';
function fixture(){
 const rows=[{name:'cdnn-backend',pm_id:0,pid:123,pm2_env:{status:'online',restart_time:0,pm_cwd:base,pm_exec_path:base+'/dist/main.js',exec_interpreter:'node',exec_mode:'fork_mode',env:{SECRET:'SYNTHETIC_PRIVATE_VALUE'},autorestart:true,watch:false}}];
 const facts={exe:'/usr/bin/node',nodeVersion:'24.18.1',kernel:{pid:123,startTicks:'100',cwdMatches:true,executableMatches:true,listeningOn3201:true},env:{uid:1001,mode:384,dev:1,ino:2,size:30,mtimeMs:42,hash:'a'.repeat(64)},daemon:{pid:90,startTicks:'80'},healthy:true,listener:'owned'};
 return {rows,facts};
}
const snapshot=()=>{const x=fixture();return makeSnapshot(x.rows,x.facts);};
test('preserves absent PM2 declarations without leaking the synthetic environment',()=>{
 const x=fixture(),r=makeSnapshot(x.rows,x.facts);
 assert.equal(r.target.declarations.instances,null);assert.equal(r.target.declarations.port,null);assert.equal(r.target.declarations.environment,null);
 assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE_VALUE'));
});
test('unchanged requires exact PID, start ticks and restart counter',()=>{
 const a=snapshot();assert.doesNotThrow(()=>validateTransition(a,structuredClone(a),'unchanged',{originalAlive:true,listener:'owned'}));
 for(const [key,value] of [['pid',124],['startTicks','101'],['restarts',1]]){const b=structuredClone(a);b.target[key]=value;assert.throws(()=>validateTransition(a,b,'unchanged',{originalAlive:true,listener:'owned'}));}
});
test('restart requires new process identity with original launch and environment',()=>{
 const a=snapshot(),b=structuredClone(a);b.target.pid=124;b.target.startTicks='101';b.target.restarts=1;
 assert.doesNotThrow(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'owned'}));
 assert.throws(()=>validateTransition(a,a,'restarted',{originalAlive:true,listener:'owned'}));
 b.target.launch='b'.repeat(64);assert.throws(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'owned'}));
});
test('stopped requires known launch, dead original PID, and no listener',()=>{
 const a=snapshot(),b=structuredClone(a);b.target.pid=0;b.target.startTicks=null;b.target.status='stopped';b.healthy=false;
 assert.doesNotThrow(()=>validateTransition(a,b,'stopped',{originalAlive:false,listener:'absent'}));
 assert.throws(()=>validateTransition(a,b,'stopped',{originalAlive:true,listener:'absent'}));
 assert.throws(()=>validateTransition(a,b,'stopped',{originalAlive:false,listener:'foreign'}));
});
test('rollback permits unhealthy online target with identical launch but refuses drift',()=>{
 const a=snapshot(),b=structuredClone(a);b.target.pid=124;b.target.startTicks='101';b.target.restarts=1;b.healthy=false;
 assert.doesNotThrow(()=>validateTransition(a,b,'recoverable',{originalAlive:false,listener:'owned'}));
 b.target.launch='b'.repeat(64);assert.throws(()=>validateTransition(a,b,'recoverable',{originalAlive:false,listener:'owned'}));
});
test('rollback permits known stopped/errored target but refuses launching or unknown status',()=>{
 const a=snapshot(),b=structuredClone(a);b.target.pid=0;b.target.startTicks=null;b.target.status='errored';b.healthy=false;
 assert.doesNotThrow(()=>validateTransition(a,b,'recoverable',{originalAlive:false,listener:'absent'}));
 b.target.status='launching';assert.throws(()=>validateTransition(a,b,'recoverable',{originalAlive:false,listener:'absent'}));
});
test('all transitions refuse .env, PM2 daemon, unrelated process and launch-option drift',()=>{
 const a=snapshot();
 for(const mutate of [b=>b.env.ino++,b=>b.env.hash='b'.repeat(64),b=>b.daemon.pid++,b=>b.others.push({name:'unrelated',pid:2}),b=>b.target.launch='b'.repeat(64)]){const b=structuredClone(a);mutate(b);assert.throws(()=>validateTransition(a,b,'unchanged',{originalAlive:true,listener:'owned'}));}
 const x=fixture(),before=makeSnapshot(x.rows,x.facts);x.rows[0].pm2_env.kill_timeout=9000;
 assert.notEqual(makeSnapshot(x.rows,x.facts).target.launch,before.target.launch);
});
test('snapshot refuses ambiguous targets, unsupported arguments and conflicting declarations',()=>{
 for(const mutate of [x=>x.rows.push(structuredClone(x.rows[0])),x=>x.rows[0].pm2_env.args=['--unreviewed'],x=>x.rows[0].pm2_env.PORT='9999',x=>x.rows[0].pm2_env.NODE_ENV='test',x=>x.rows[0].pm2_env.instances=2]){const x=fixture();mutate(x);assert.throws(()=>makeSnapshot(x.rows,x.facts));}
});
test('health gates refuse foreign listener or wrong executable and preserve healthy restart requirement',()=>{
 for(const mutate of [x=>x.facts.exe='/other/node',x=>x.facts.kernel.cwdMatches=false,x=>x.facts.kernel.executableMatches=false]){const x=fixture();mutate(x);assert.throws(()=>makeSnapshot(x.rows,x.facts));}
 const a=snapshot(),b=structuredClone(a);b.target.pid=124;b.target.startTicks='101';b.target.restarts=1;b.healthy=false;
 assert.throws(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'owned'}));b.healthy=true;
 assert.throws(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'foreign'}));
});

test('PM2 7.0.3 stop then restart keeps restart_time unchanged but changes PID/start',()=>{
 const a=snapshot(),b=structuredClone(a);b.target.pid=124;b.target.startTicks='101';
 assert.doesNotThrow(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'owned'}));
 b.target.restarts=-1;assert.throws(()=>validateTransition(a,b,'restarted',{originalAlive:false,listener:'owned'}));
});
