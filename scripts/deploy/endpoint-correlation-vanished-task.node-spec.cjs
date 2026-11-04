'use strict';
const {test,mock}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {exclusiveHolder}=require('./endpoint-correlation.cjs');
function snapshots(t,{code='ENOENT',gone=true,shared=false,statCode,ownerHas=true}={}){
 const normalize=value=>String(value).replace(/\\/g,'/');
 mock.method(fs,'readdirSync',value=>{
  const name=normalize(value);
  if(name==='/proc')return ['10','20'];
  if(name==='/proc/10/task')return ['10'];
  if(name==='/proc/20/task')return ['20','21'];
  if(name==='/proc/10/task/10/fd')return ownerHas?['0']:[];
  if(name==='/proc/20/task/20/fd')return [];
  if(name==='/proc/20/task/21/fd'){
   if(shared)return ['0'];
   throw Object.assign(Error('private inspection detail'),{code});
  }
  throw Error('unexpected mocked directory');
 });
 mock.method(fs,'readlinkSync',value=>{
  const name=normalize(value);
  if(name==='/proc/10/task/10/fd/0'||name==='/proc/20/task/21/fd/0')return 'socket:[99]';
  throw Error('unexpected mocked descriptor');
 });
 mock.method(fs,'statSync',value=>{
  if(normalize(value)!=='/proc/20/task/21')throw Error('unexpected mocked stat');
  if(statCode||gone)throw Object.assign(Error('private stat detail'),{code:statCode||'ENOENT'});
  return {};
 });
 mock.method(fs,'existsSync',value=>normalize(value)==='/proc/20/task/21'?!gone:true);
 t.after(()=>mock.restoreAll());
}
test('a vanished foreign task no longer holds the accepted socket while its process survives',t=>{
 snapshots(t);assert.doesNotThrow(()=>exclusiveHolder('99',10,'/proc'));
});
for(const [name,options] of [['a still-visible task with missing fd table',{gone:false}],['a denied task even if a later existence check misses it',{code:'EACCES'}],['an unclassified task read error',{code:'ESRCH'}]])test('task visibility still fails closed for '+name,t=>{
 snapshots(t,options);assert.throws(()=>exclusiveHolder('99',10,'/proc'),/INCOMPLETE_PROCESS_VISIBILITY/);
});
test('a live foreign task with an unshared fd table still disproves exclusive ownership',t=>{
 snapshots(t,{shared:true});assert.throws(()=>exclusiveHolder('99',10,'/proc'),/ACCEPTED_SOCKET_SHARED/);
});

test('denied task disappearance observation cannot bypass visibility',t=>{
 snapshots(t,{statCode:'EACCES'});assert.throws(()=>exclusiveHolder('99',10,'/proc'),/INCOMPLETE_PROCESS_VISIBILITY/);
});
test('a vanished alleged holder cannot substitute for an observed application holder',t=>{
 snapshots(t,{ownerHas:false});assert.throws(()=>exclusiveHolder('99',10,'/proc'),/ACCEPTED_SOCKET_DISAPPEARED/);
});