'use strict';
// Read-only, one-stream ownership observation. This never authorizes a restart.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = code => { throw new Refusal(code); };
function decodeAddress(hex) {
 if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/i.test(hex)) refuse('SOCKET_TABLE_INVALID');
 const bytes = [];
 for (let i = 0; i < hex.length; i += 8) {
  const word = Buffer.from(hex.slice(i, i + 8), 'hex');
  bytes.push(...(os.endianness() === 'LE' ? word.reverse() : word));
 }
 if (bytes.length === 4) return bytes.join('.');
 if (bytes.slice(0, 10).every(x => x === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join('.');
 return Buffer.from(bytes).toString('hex');
}
function parseTable(text) {
 if (Buffer.byteLength(text) > 8 * 1024 * 1024) refuse('SOCKET_TABLE_LIMIT');
 return text.trim().split('\n').slice(1).filter(x => x.trim()).map(line => {
  const f = line.trim().split(/\s+/), local = f[1]?.split(':'), remote = f[2]?.split(':');
  if (f.length < 10 || local?.length !== 2 || remote?.length !== 2 || !/^[0-9a-f]{4}$/i.test(local[1]) || !/^[0-9a-f]{4}$/i.test(remote[1]) || !/^[0-9a-f]{2}$/i.test(f[3]) || !/^\d+$/.test(f[9])) refuse('SOCKET_TABLE_INVALID');
  return { local: decodeAddress(local[0]), localPort: parseInt(local[1], 16), remote: decodeAddress(remote[0]), remotePort: parseInt(remote[1], 16), state: f[3].toUpperCase(), inode: f[9] };
 });
}
function parseResponse(bytes) {
 const end = bytes.indexOf('\r\n\r\n');
 if (end < 0) { if (bytes.length > 16384) refuse('HTTP_HEADERS_LIMIT'); return null; }
 if (end + 4 > 16384) refuse('HTTP_HEADERS_LIMIT');
 const lines = bytes.subarray(0, end).toString('latin1').split('\r\n');
 const status = /^HTTP\/1\.1 ([1-5]\d{2}) [\x20-\x7e]*$/.exec(lines.shift());
 if (!status) refuse('HTTP_FRAMING_UNSUPPORTED');
 const headers = new Map();
 for (const line of lines) {
  const m = /^([!#$%&'*+.^_`|~0-9a-z-]+):[ \t]*([\x20-\x7e\t]*)$/i.exec(line);
  if (!m || headers.has(m[1].toLowerCase())) refuse('HTTP_FRAMING_AMBIGUOUS');
  headers.set(m[1].toLowerCase(), m[2].trim());
 }
 const length = headers.get('content-length');
 if (!/^(0|[1-9]\d{0,5})$/.test(length || '') || headers.has('transfer-encoding') || headers.has('content-encoding') || headers.get('connection')?.toLowerCase() === 'close') refuse('HTTP_FRAMING_UNSUPPORTED');
 const size = Number(length);
 if (size > 65536) refuse('HTTP_BODY_LIMIT');
 if (bytes.length > end + 4 + size) refuse('HTTP_TRAILING_DATA');
 if (bytes.length < end + 4 + size) return null;
 let body;
 try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(end + 4))); } catch { body = null; }
 const httpStatus = Number(status[1]);
 return { httpStatus, healthy: httpStatus === 200 && body?.success === true && body?.data?.status === 'ok' && body?.data?.service === 'congdongngonngu-backend' && body?.data?.environment === 'production' };
}
function identity(pid, procRoot = '/proc') {
 const p = path.join(procRoot, String(pid));
 const stat = fs.readFileSync(path.join(p, 'stat'), 'utf8');
 const end = stat.lastIndexOf(') '), fields = stat.slice(end + 2).trim().split(/\s+/);
 if (end < 0 || !/^\d+$/.test(fields[19] || '')) refuse('PROCESS_IDENTITY_INVALID');
 return { startTicks: fields[19], exe: fs.readlinkSync(path.join(p, 'exe')), cwd: fs.readlinkSync(path.join(p, 'cwd')), namespace: fs.readlinkSync(path.join(p, 'ns/net')), uid: fs.statSync(p).uid };
}
function sameIdentity(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) refuse('PROCESS_IDENTITY_CHANGED'); }
function socketInodes(pid, procRoot = '/proc', deadline = Infinity) {
 const dir = path.join(procRoot, String(pid), 'fd'), result = new Set();
 const files = fs.readdirSync(dir);
 if (files.length > 65536) refuse('FD_VISIBILITY_LIMIT');
 for (const fd of files) {
  if (performance.now() > deadline) refuse('TIMEOUT');
  let link;
  try { link = fs.readlinkSync(path.join(dir, fd)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  const m = /^socket:\[(\d+)\]$/.exec(link); if (m) result.add(m[1]);
 }
 return result;
}
function exclusiveHolder(inode, pid, procRoot = '/proc', deadline = Infinity) {
 let found = false;
 const pids = fs.readdirSync(procRoot).filter(x => /^\d+$/.test(x));
 if (pids.length > 65536) refuse('PROCESS_VISIBILITY_LIMIT');
 for (const entry of pids) {
  if (performance.now() > deadline) refuse('TIMEOUT');
  try {
   // Threads can unshare their fd tables: inspect every task on the real host.
   const taskDir = path.join(procRoot, entry, 'task');
   const tasks = procRoot === '/proc' ? fs.readdirSync(taskDir).filter(x => /^\d+$/.test(x)) : [null];
   if (tasks.length > 65536) refuse('PROCESS_VISIBILITY_LIMIT');
   for (const task of tasks) {
    if (performance.now() > deadline) refuse('TIMEOUT');
    const inodes = task === null ? socketInodes(Number(entry), procRoot, deadline) : socketInodes(Number(task), taskDir, deadline);
    if (inodes.has(inode)) { if (Number(entry) !== pid) refuse('ACCEPTED_SOCKET_SHARED'); found = true; }
   }
  } catch (e) {
   // A vanished process no longer holds an fd; denied visibility is never ignored.
   if (e.code === 'ENOENT' && !fs.existsSync(path.join(procRoot, entry))) continue;
   if (e instanceof Refusal) throw e;
   refuse('INCOMPLETE_PROCESS_VISIBILITY');
  }
 }
 if (!found) refuse('ACCEPTED_SOCKET_DISAPPEARED');
}
function verifyProcVisibility(procRoot) {
 if (procRoot !== '/proc') return;
 // hidepid can hide entire process directories without a read error.
 const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(line => line.split(' ')[4] === '/proc');
 if (!mount || !mount.includes(' - proc ') || /(?:^|[,\s])(?:hidepid=(?!0(?:,|\s|$))|subset=pid)/.test(mount)) refuse('INCOMPLETE_PROCESS_VISIBILITY');
}

async function probe({ pid, startTicks, expectedCwd, expectedExecutable, expectedUid, port = 3201, timeoutMs = 5000, procRoot = '/proc' }) {
 const result = { status: 'UNVERIFIED', reasonCode: 'INSPECTION_UNAVAILABLE', observedAt: new Date().toISOString(), appPid: Number.isSafeInteger(pid) ? pid : null, httpStatus: null, productionHealth: false, ownershipBefore: false, ownershipAfter: false, scope: 'One held connection; trusted ordinary host snapshots only; no restart authorization.' };
 let socket, failure, timer;
 const deadline = performance.now() + Math.min(timeoutMs, 5000);
 const checkTime = () => { if (failure) throw failure; if (performance.now() >= deadline) refuse('TIMEOUT'); };
 try {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1 || !/^\d+$/.test(startTicks || '') || !Number.isSafeInteger(expectedUid) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) refuse('INVALID_PLATFORM_OR_EXPECTATION');
  verifyProcVisibility(procRoot);
  const before = identity(pid, procRoot);
  if (before.startTicks !== startTicks || before.cwd !== expectedCwd || before.exe !== expectedExecutable || before.uid !== expectedUid || before.namespace !== fs.readlinkSync(path.join(procRoot, 'self/ns/net'))) refuse('PROCESS_EXPECTATION_MISMATCH');
  result.appStartTicks = before.startTicks;
  socket = new net.Socket();
  socket.on('error', () => { failure = new Refusal('CONNECTION_ERROR'); });
  socket.on('end', () => { failure = new Refusal('CONNECTION_CLOSED'); });
  socket.on('close', () => { failure ||= new Refusal('CONNECTION_CLOSED'); });
  timer = setTimeout(() => { failure = new Refusal('TIMEOUT'); socket.destroy(); }, Math.max(1, deadline - performance.now()));
  await new Promise((resolve, reject) => {
   socket.once('connect', resolve); socket.once('error', () => reject(new Refusal('CONNECTION_ERROR'))); socket.once('close', () => reject(new Refusal('CONNECTION_CLOSED')));
   socket.connect({ host: '127.0.0.1', port, family: 4 });
  });
  const clientPort = socket.localPort;
  if (socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== port) refuse('CONNECTION_TUPLE_MISMATCH');
  const rows = () => ['tcp', 'tcp6'].flatMap(name => parseTable(fs.readFileSync(path.join(procRoot, String(pid), 'net', name), 'utf8')));
  let accepted, client;
  for (;;) {
   checkTime();
   const all = rows();
   const matches = all.filter(r => r.state === '01' && r.local === '127.0.0.1' && r.localPort === port && r.remote === '127.0.0.1' && r.remotePort === clientPort);
   const clients = all.filter(r => r.state === '01' && r.local === '127.0.0.1' && r.localPort === clientPort && r.remote === '127.0.0.1' && r.remotePort === port);
   if (matches.length > 1 || clients.length > 1) refuse('CONNECTION_AMBIGUOUS');
   if (matches.length === 1 && clients.length === 1 && matches[0].inode !== '0' && clients[0].inode !== '0' && socketInodes(pid, procRoot, deadline).has(matches[0].inode)) { accepted = matches[0]; client = clients[0]; break; }
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  const verify = () => {
   checkTime(); sameIdentity(before, identity(pid, procRoot));
   const all = rows();
   for (const row of [accepted, client]) if (all.filter(x => JSON.stringify(x) === JSON.stringify(row)).length !== 1) refuse('CONNECTION_CHANGED');
   const app = socketInodes(pid, procRoot, deadline);
   const listeners = all.filter(r => r.state === '0A' && r.localPort === port && app.has(r.inode));
   if (!app.has(accepted.inode) || !socketInodes(process.pid, procRoot, deadline).has(client.inode) || accepted.inode === client.inode || !listeners.length || listeners.some(r => r.inode === accepted.inode)) refuse('SOCKET_OWNERSHIP_MISMATCH');
   exclusiveHolder(accepted.inode, pid, procRoot, deadline);
   sameIdentity(before, identity(pid, procRoot));
   const finalRows = rows();
   for (const row of [accepted, client]) if (finalRows.filter(x => JSON.stringify(x) === JSON.stringify(row)).length !== 1) refuse('CONNECTION_CHANGED');
   if (!socketInodes(pid, procRoot, deadline).has(accepted.inode) || !socketInodes(process.pid, procRoot, deadline).has(client.inode)) refuse('SOCKET_OWNERSHIP_MISMATCH');
   checkTime();
  };
  verify(); result.ownershipBefore = true;
  let bytes = Buffer.alloc(0), parsed;
  await new Promise((resolve, reject) => {
   const onFailure = () => reject(failure || new Refusal('CONNECTION_CLOSED'));
   socket.once('error', onFailure); socket.once('close', onFailure); socket.once('end', onFailure);
   socket.on('data', chunk => {
    try {
     checkTime();
     if (bytes.length + chunk.length > 81920) refuse('HTTP_TOTAL_LIMIT');
     bytes = Buffer.concat([bytes, chunk]); parsed = parseResponse(bytes);
     if (parsed) { result.httpStatus = parsed.httpStatus; result.productionHealth = parsed.healthy; resolve(); }
    } catch (e) { failure = e instanceof Refusal ? e : new Refusal('INSPECTION_UNAVAILABLE'); reject(failure); }
   });
   socket.write(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\nAccept: application/json\r\n\r\n`);
  });
  // Give queued data/end events a chance to expose trailing bytes or early closure.
  await new Promise(resolve => setImmediate(resolve));
  verify();
  if (!parsed.healthy) refuse('APPLICATION_HEALTH_MISMATCH');
  result.ownershipAfter = true; result.status = 'PASS_CONNECTION_OWNERSHIP_CORRELATED'; result.reasonCode = 'CORRELATED';
 } catch (e) { result.reasonCode = e instanceof Refusal ? e.code : 'INSPECTION_UNAVAILABLE'; }
 finally { clearTimeout(timer); socket?.destroy(); }
 return result;
}
async function main() {
 let result = { status: 'UNVERIFIED', reasonCode: 'CURRENT_APP_INSPECTION_UNAVAILABLE' };
 try {
  if (!['--inspect', '--capture'].includes(process.argv[2]) || process.argv.length !== 3 || process.platform !== 'linux' || os.userInfo().username !== 'cdnn-deploy') refuse('CLI_IDENTITY_OR_ARGUMENT');
  const current = require('./check-runtime.cjs').capture();
  if (current.observedDeployment !== 'PASS') refuse('CURRENT_OBSERVATION_NOT_PASS');
  const kernel = current.independentEvidence?.kernel;
  result = await probe({ pid: kernel?.pid, startTicks: kernel?.startTicks, expectedCwd: '/var/www/congdongngonngu/backend', expectedExecutable: '/usr/bin/node', expectedUid: process.getuid() });
 } catch (e) { if (e instanceof Refusal) result.reasonCode = e.code; }
 console.log(JSON.stringify(result)); process.exitCode = result.status === 'PASS_CONNECTION_OWNERSHIP_CORRELATED' ? 0 : 2;
}
module.exports = { decodeAddress, parseTable, parseResponse, identity, sameIdentity, socketInodes, exclusiveHolder, verifyProcVisibility, probe };
if (require.main === module) main();
