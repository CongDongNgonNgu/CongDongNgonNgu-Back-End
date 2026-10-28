'use strict';
function failure(code){const error=Error(code==='PROCESS_DRIFT'?'Process identity changed; runtime recovery requires separate operator review':'Process identity unavailable; runtime recovery requires separate operator review');error.code=code;return error;}
function captureIdentity(guard){
 let value;try{value=typeof guard==='function'?guard():null;}catch{throw failure('PROCESS_IDENTITY_UNVERIFIED');}
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.startTicks!=='string'||!/^\d+$/.test(value.startTicks)||!Number.isSafeInteger(value.restartCount)||value.restartCount<0)throw failure('PROCESS_IDENTITY_UNVERIFIED');
 return {pid:value.pid,startTicks:value.startTicks,restartCount:value.restartCount};
}
function assertIdentity(guard,expected){
 const initial=captureIdentity(()=>expected),current=captureIdentity(guard);
 if(JSON.stringify(initial)!==JSON.stringify(current))throw failure('PROCESS_DRIFT');return current;
}
module.exports={captureIdentity,assertIdentity};
