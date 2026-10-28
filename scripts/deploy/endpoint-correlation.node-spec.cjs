'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeAddress, parseTable, parseResponse } = require('./endpoint-correlation.cjs');
const healthy = JSON.stringify({ success: true, data: { status: 'ok', service: 'congdongngonngu-backend', environment: 'production' } });
const response = (body = healthy, extra = '', code = 200) => Buffer.from(`HTTP/1.1 ${code} OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`);
test('kernel IPv4 and mapped IPv6 word order normalize to the exact loopback address', () => {
 assert.equal(decodeAddress('0100007F'), '127.0.0.1');
 assert.equal(decodeAddress('0000000000000000FFFF00000100007F'), '127.0.0.1');
 assert.notEqual(decodeAddress('00000000000000000000000001000000'), '127.0.0.1');
 assert.throws(() => decodeAddress('private'));
});
test('socket table preserves inode and exact local and remote tuples', () => {
 const rows = parseTable('header\n 0: 0100007F:0C81 0100007F:C001 01 0:0 00:0 0 1000 0 1234 1\n');
 assert.deepEqual(rows[0], { local: '127.0.0.1', localPort: 3201, remote: '127.0.0.1', remotePort: 49153, state: '01', inode: '1234' });
 assert.throws(() => parseTable('header\nprivate malformed'));
});
test('strict response accepts only bounded exact healthy JSON and preserves malformed HTTP status', () => {
 assert.equal(parseResponse(response()).healthy, true);
 assert.equal(parseResponse(response('{private')).httpStatus, 200);
 assert.equal(parseResponse(response('{private', '', 503)).httpStatus, 503);
 assert.equal(parseResponse(response('{private')).healthy, false);
 assert.equal(parseResponse(response().subarray(0, 20)), null);
});
for (const [name, bytes] of [
 ['duplicate length', response(healthy, 'Content-Length: 1\r\n')],
 ['transfer encoding', response(healthy, 'Transfer-Encoding: chunked\r\n')],
 ['compression', response(healthy, 'Content-Encoding: gzip\r\n')],
 ['trailing response', Buffer.concat([response(), response()])],
 ['oversized headers', response(healthy, `X: ${'x'.repeat(16384)}\r\n`)],
 ['oversized body', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n')],
 ['ambiguous status', Buffer.from('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n')],
 ['folded header', response(healthy, ' X-Private: value\r\n')],
]) test(`strict framing rejects ${name}`, () => assert.throws(() => parseResponse(bytes)));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identity, sameIdentity, exclusiveHolder, probe } = require('./endpoint-correlation.cjs');
function tree() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-endpoint-test-'));
 const make=(pid,inodes=[])=>{fs.mkdirSync(path.join(dir,String(pid),'fd'),{recursive:true});for(const [i,inode]of inodes.entries())fs.symlinkSync(`socket:[${inode}]`,path.join(dir,String(pid),'fd',String(i)));};
 return {dir,make,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('all stable process identity fields reject drift',()=>{
 const a={startTicks:'1',exe:'/node',cwd:'/app',namespace:'net:[1]',uid:1000};
 sameIdentity(a,{...a});
 for(const key of Object.keys(a))assert.throws(()=>sameIdentity(a,{...a,[key]:'changed'}),/PROCESS_IDENTITY_CHANGED/);
});
// Windows socket-target symlinks require privileged filesystem support. Pure parser tests remain portable.
for(const [name,mode,reason]of [['exclusive','single',null],['shared accepted descriptor','shared','ACCEPTED_SOCKET_SHARED'],['transferred descriptor','transfer','ACCEPTED_SOCKET_SHARED'],['disappeared descriptor','gone','ACCEPTED_SOCKET_DISAPPEARED'],['incomplete fd visibility','incomplete','INCOMPLETE_PROCESS_VISIBILITY']])test(`ownership snapshot ${name}`, {skip:process.platform!=='linux'},()=>{
 const f=tree();try{
  f.make(1,mode==='gone'||mode==='transfer'?[]:['99']);
  if(mode==='shared'||mode==='transfer')f.make(2,['99']);
  if(mode==='incomplete')fs.mkdirSync(path.join(f.dir,'2'));
  if(reason)assert.throws(()=>exclusiveHolder('99',1,f.dir),new RegExp(reason));else exclusiveHolder('99',1,f.dir);
 }finally{f.close();}
});
test('invalid PID/platform is sanitized and never prints private exception text',async()=>{
 const result=await probe({pid:-1,startTicks:'0',expectedUid:1,expectedCwd:'/private',expectedExecutable:'/private'});
 assert.equal(result.status,'UNVERIFIED');assert.doesNotMatch(JSON.stringify(result),/\/private|stack|Error:/);
});
test('CLI has no arbitrary PID or mutation fallback and does not print inspector errors',()=>{
 const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[path.join(__dirname,'endpoint-correlation.cjs'),'--pid','123'],{encoding:'utf8'});
 assert.equal(result.status,2);const parsed=JSON.parse(result.stdout);assert.equal(parsed.status,'UNVERIFIED');assert.equal(result.stderr,'');
});
