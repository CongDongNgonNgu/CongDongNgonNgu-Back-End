'use strict';
// Supplementary kernel observations. These never replace the reviewed PM2 contract.
const fs=require('node:fs'),path=require('node:path');
function startTicks(stat){
 const end=stat.lastIndexOf(') '),fields=stat.slice(end+2).trim().split(/\s+/);
 if(end<0||fields.length<20||!/^\d+$/.test(fields[19]))throw Error('Invalid process identity');
 return fields[19]; // Field 22; comm (field 2) can contain spaces and parentheses.
}
function listeningPorts(table,inodes){
 const ports=new Set();
 for(const line of table.trim().split('\n').slice(1)){
  const fields=line.trim().split(/\s+/);
  if(fields[3]!=='0A'||!inodes.has(fields[9]))continue;
  const hex=fields[1]?.split(':').pop();
  if(!/^[0-9a-f]{4}$/i.test(hex))throw Error('Invalid socket table');
  ports.add(parseInt(hex,16));
 }
 return [...ports].sort((a,b)=>a-b);
}
function inspectProcess(pid,{procRoot='/proc'}={}){
 if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid process PID');
 const root=path.join(procRoot,String(pid)),before=startTicks(fs.readFileSync(path.join(root,'stat'),'utf8'));
 const cwd=fs.readlinkSync(path.join(root,'cwd')),exe=fs.readlinkSync(path.join(root,'exe')),inodes=new Set();
 for(const fd of fs.readdirSync(path.join(root,'fd'))){
  let link;try{link=fs.readlinkSync(path.join(root,'fd',fd));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const match=/^socket:\[(\d+)\]$/.exec(link);if(match)inodes.add(match[1]);
 }
 const ports=new Set();
 for(const table of ['tcp','tcp6'])for(const port of listeningPorts(fs.readFileSync(path.join(root,'net',table),'utf8'),inodes))ports.add(port);
 if(startTicks(fs.readFileSync(path.join(root,'stat'),'utf8'))!==before||fs.readlinkSync(path.join(root,'exe'))!==exe||fs.readlinkSync(path.join(root,'cwd'))!==cwd)throw Error('Runtime process changed during inspection');
 return {pid,startTicks:before,cwdMatches:cwd==='/var/www/congdongngonngu/backend',executableMatches:exe==='/usr/bin/node',listeningOn3201:ports.has(3201)};
}
module.exports={startTicks,listeningPorts,inspectProcess};
