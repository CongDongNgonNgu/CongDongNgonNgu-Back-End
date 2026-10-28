'use strict';
// Only allowlisted process identity crosses this boundary; no process environment is read.
function processIdentity(capture){
 const e=capture?.independentEvidence,k=e?.kernel;
 if(e?.pm2OnlineProcessCount!==1||e.pm2Status!=='online'||!Number.isSafeInteger(e.pm2RestartCounter)||e.pm2RestartCounter<0||!Number.isSafeInteger(k?.pid)||k.pid<1||typeof k.startTicks!=='string'||!/^\d+$/.test(k.startTicks)||k.cwdMatches!==true||k.executableMatches!==true||k.listeningOn3201!==true)throw Error('PROCESS_IDENTITY_UNVERIFIED');
 return {pid:k.pid,startTicks:k.startTicks,restartCount:e.pm2RestartCounter};
}
function samePm2Process(before,after){
 const select=rows=>{const m=rows.filter(x=>x.name==='cdnn-backend');if(m.length!==1)return null;const p=m[0];return p.pm2_env?.status==='online'&&Number.isSafeInteger(p.pid)&&p.pid>0&&Number.isSafeInteger(p.pm2_env.restart_time)&&p.pm2_env.restart_time>=0?{pid:p.pid,restartCount:p.pm2_env.restart_time}:null;};
 const a=select(before),b=select(after);return !!a&&!!b&&a.pid===b.pid&&a.restartCount===b.restartCount;
}
function guardedCapture(expected,capture){
 const identity=processIdentity(expected),metadata=JSON.stringify(expected.metadata);
 return ()=>{const current=capture();if(JSON.stringify(current.metadata)!==metadata)throw Error('PM2_LAUNCH_METADATA_DRIFT');const now=processIdentity(current);if(JSON.stringify(now)!==JSON.stringify(identity))throw Error('PROCESS_DRIFT');return now;};
}
module.exports={processIdentity,samePm2Process,guardedCapture};
