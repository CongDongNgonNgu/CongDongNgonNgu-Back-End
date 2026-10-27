'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startTicks,listeningPorts,inspectProcess}=require('./runtime-proof.cjs');
test('proc stat parser handles spaces and parentheses in PM2 process titles',()=>{
 const tail=['S',...Array.from({length:18},()=> '0'),'123456','0'];
 assert.equal(startTicks('12 (node /app (worker)) '+tail.join(' ')),'123456');
 assert.throws(()=>startTicks('12 malformed'));
});
test('socket proof requires LISTEN state and inode owned by the selected PID',()=>{
 const row=(port,state,inode)=>` 0: 00000000:${port} 00000000:0000 ${state} 0:0 0:0 0 1001 0 ${inode}`;
 assert.deepEqual(listeningPorts('header\n'+[row('0C81','0A','22'),row('0C82','01','22'),row('0C83','0A','23')].join('\n'),new Set(['22'])),[3201]);
});
test('process proof reads kernel identity only and refuses invalid PIDs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-proof-'));
 try{
  assert.throws(()=>inspectProcess('../1',{procRoot:root}));
  assert.throws(()=>inspectProcess(0,{procRoot:root}));
  fs.mkdirSync(path.join(root,'123'));
  fs.writeFileSync(path.join(root,'123','stat'),'invalid');
  assert.throws(()=>inspectProcess(123,{procRoot:root}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux fixture proves only PID-owned listener and allowlisted identity without reading environment', {skip:process.platform!=='linux'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-proof-'));
 try{
  const proc=path.join(root,'123');fs.mkdirSync(path.join(proc,'fd'),{recursive:true});fs.mkdirSync(path.join(proc,'net'));
  fs.writeFileSync(path.join(proc,'stat'),'123 (node /app (worker)) '+['S',...Array(18).fill('0'),'456','0'].join(' '));
  fs.symlinkSync('/var/www/congdongngonngu/backend',path.join(proc,'cwd'));
  fs.symlinkSync('/usr/bin/node',path.join(proc,'exe'));fs.symlinkSync('socket:[22]',path.join(proc,'fd','3'));
  fs.writeFileSync(path.join(proc,'net','tcp'),'header\n 0: 00000000:0C81 00000000:0000 0A 0:0 0:0 0 1001 0 22\n');
  fs.writeFileSync(path.join(proc,'net','tcp6'),'header\n');
  assert.deepEqual(inspectProcess(123,{procRoot:root}),{pid:123,startTicks:'456',cwdMatches:true,executableMatches:true,listeningOn3201:true});
  assert.equal(inspectProcess(123,{procRoot:root,expectedInterpreter:'/usr/local/bin/node'}).executableMatches,false);
  fs.unlinkSync(path.join(proc,'fd','3'));assert.equal(inspectProcess(123,{procRoot:root}).listeningOn3201,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
