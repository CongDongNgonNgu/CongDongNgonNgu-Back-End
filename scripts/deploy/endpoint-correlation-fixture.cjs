'use strict';
// Synthetic child server only; no application imports, environment or Production files.
const net = require('node:net');
const { fork } = require('node:child_process');
if (process.argv[2] === 'holder') {
 process.on('message', (message, socket) => { if (socket) {
  if (typeof socket.pause === 'function') socket.pause();
  if (message === 'respond') { const body=JSON.stringify({success:true,data:{status:'ok',service:'congdongngonngu-backend',environment:'production'}});socket.write('HTTP/1.1 200 OK\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body); }
  process.send('held');
 } });
} else {
 const mode = process.argv[2], host = process.argv[3] || '127.0.0.1';
 const sockets = new Set(); let holder, held = false;
 const body = JSON.stringify({success:true,data:{status:'ok',service:'congdongngonngu-backend',environment:'production'}});
 const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  if (mode === 'shared') {
   holder = fork(__filename, ['holder'], { stdio: ['ignore','ignore','ignore','ipc'], env: {} });
   holder.on('message', () => { held = true; socket.resume(); });
   holder.send('hold', socket, { keepOpen: true });
  }
  if (mode === 'early') return socket.destroy();
  socket.on('data', async () => {
   while (mode === 'shared' && !held) await new Promise(resolve => setTimeout(resolve, 5));
   if (mode === 'timeout') return;
   if (mode === 'drift') process.chdir('/');
   if (mode === 'transfer') {
    holder = fork(__filename,['holder'],{stdio:['ignore','ignore','ignore','ipc'],env:{}});
    holder.send('respond',socket,{keepOpen:false});return;
   }
   const payload = mode === 'malformed200' || mode === 'malformed503' ? '{private-credential' : body;
   const status = mode === 'malformed503' ? 503 : 200;
   const wire = `HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
   if (mode === 'close') socket.end(wire); else if (mode === 'trailing') socket.write(wire + 'private-trailing'); else socket.write(wire);
  });
 });
 server.listen({host,port:0}, () => {
  if (mode !== 'sharedlistener') return process.send({port:server.address().port});
  holder = fork(__filename, ['holder'], {stdio:['ignore','ignore','ignore','ipc'],env:{}});
  holder.on('message', () => { holder.kill('SIGSTOP'); setTimeout(() => process.send({port:server.address().port}),50); });
  holder.send('listener',server,{keepOpen:true});
 });
 process.on('message', message => {
  if (message === 'chdir') { process.chdir('/'); process.send('changed'); }
  if (message === 'stop') { for (const socket of sockets) socket.destroy(); if(holder){holder.kill('SIGCONT');holder.kill();} server.close(() => process.exit()); }
 });
 process.on('disconnect', () => { if(holder){holder.kill('SIGCONT');holder.kill();} for (const socket of sockets) socket.destroy(); server.close(); });
}
