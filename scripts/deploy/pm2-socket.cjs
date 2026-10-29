'use strict';
// Connect-only RPC transport: no PM2 Client/API/CLI construction and no daemon startup path.
function readRows(axon,rpc,socketPath,timeoutMs=2000){
 return new Promise((resolve,reject)=>{
  const socket=axon.socket('req'),client=new rpc.Client(socket);let complete=false;
  const finish=(error,rows)=>{if(complete)return;complete=true;clearTimeout(timer);try{socket.close();}catch{}if(error)reject(Error('PM2 read-only RPC failed'));else if(!Array.isArray(rows))reject(Error('Invalid PM2 response'));else resolve(rows);};
  const timer=setTimeout(()=>finish(Error('timeout')),timeoutMs);
  socket.once('error',()=>finish(Error('socket')));
  socket.once('reconnect attempt',()=>finish(Error('disconnected')));
  socket.once('connect',()=>{try{client.call('getMonitorData',{},finish);}catch{finish(Error('request'));}});
  try{socket.connect(socketPath);}catch{finish(Error('connect'));}
 });
}
module.exports={readRows};
