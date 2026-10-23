'use strict';
// Explicit build-time command only; never executed on app start or request.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const PIN={tag:'autobuild-2026-10-20-13-08',version:'n9.0.2-29-g6dfaba896f',file:'ffmpeg-n9.0.2-29-g6dfaba896f-linux64-lgpl-9.0.tar.xz',bytes:137943568,sha256:'5ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927'};
const prefix='ffmpeg-n9.0.2-29-g6dfaba896f-linux64-lgpl-9.0/';
const selected=['bin/ffmpeg','bin/ffprobe','LICENSE.txt'];
function tar(archive,args,maxBuffer){const result=spawnSync('tar',[...args,'-f',archive],{shell:false,windowsHide:true,timeout:60000,maxBuffer});if(result.error||result.status!==0)throw Error('PROCESSOR_ARCHIVE_REJECTED');return result.stdout;}
async function packageArchive(archive,destination){
 archive=path.resolve(archive);destination=path.resolve(destination);
 const info=await fs.stat(archive);if(!info.isFile()||info.size!==PIN.bytes)throw Error('PROCESSOR_ARCHIVE_SIZE');
 const hash=crypto.createHash('sha256');for await(const bytes of require('node:fs').createReadStream(archive))hash.update(bytes);if(hash.digest('hex')!==PIN.sha256)throw Error('PROCESSOR_ARCHIVE_CHECKSUM');
 // List once, then emit only exact known members to stdout: no archive-controlled filesystem path extraction.
 const names=tar(archive,['-tJ'],1048576).toString('utf8').trim().split('\n');
 for(const name of names)if(!name.startsWith(prefix)||name.includes('..')||name.includes('\\'))throw Error('PROCESSOR_ARCHIVE_PATH');
 for(const item of selected)if(names.filter(name=>name===prefix+item).length!==1)throw Error('PROCESSOR_ARCHIVE_MEMBER');
 await fs.mkdir(destination,{recursive:false,mode:0o700});await fs.mkdir(path.join(destination,'bin'),{mode:0o700});
 const hashes={};
 for(const item of selected){const bytes=tar(archive,['-xJO',prefix+item],item.startsWith('bin/')?160*1024*1024:65536);if(!bytes.length)throw Error('PROCESSOR_ARCHIVE_EMPTY');await fs.writeFile(path.join(destination,item),bytes,{flag:'wx',mode:item.startsWith('bin/')?0o500:0o400});hashes[item]=crypto.createHash('sha256').update(bytes).digest('hex');}
 const provenance={...PIN,binaryHashes:hashes,source:'https://github.com/BtbN/FFmpeg-Builds/releases/tag/'+PIN.tag,ffmpegSource:'https://github.com/FFmpeg/FFmpeg/tree/6dfaba896f',buildSource:'https://github.com/BtbN/FFmpeg-Builds',license:'LGPL build; upstream LICENSE.txt retained. Source/build instructions and FFmpeg external-library notices must accompany distribution; no GPL/nonfree enablement approved.'};
 await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx',mode:0o400});return provenance;
}
async function downloadArchive(destination){
 const url='https://github.com/BtbN/FFmpeg-Builds/releases/download/'+PIN.tag+'/'+PIN.file;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),180000);
 try{let current=url,response;for(let i=0;i<6;i++){const u=new URL(current);if(u.protocol!=='https:'||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname)||u.username||u.password)throw Error('PROCESSOR_DOWNLOAD_ORIGIN');response=await fetch(u,{redirect:'manual',signal:abort.signal});if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();current=new URL(response.headers.get('location'),u).href;continue;}break;}
 if(!response||response.status!==200||!response.body)throw Error('PROCESSOR_DOWNLOAD');let count=0;const file=await fs.open(destination,'wx',0o600);try{for await(const chunk of response.body){count+=chunk.length;if(count>PIN.bytes)throw Error('PROCESSOR_DOWNLOAD_SIZE');await file.write(chunk);}if(count!==PIN.bytes)throw Error('PROCESSOR_DOWNLOAD_SIZE');}finally{await file.close();}
 }finally{clearTimeout(timer);}
}
module.exports={PIN,packageArchive,downloadArchive};
if(require.main===module){const archive=process.argv[2],destination=process.argv[3];if(!archive||!destination){console.error('Usage: node scripts/package-phase30-processors.cjs ARCHIVE DESTINATION [--download]');process.exitCode=1;}else(async()=>{if(process.argv[4]==='--download')await downloadArchive(archive);await packageArchive(archive,destination);console.log('PINNED_PROCESSOR_PACKAGE=VERIFIED');})().catch(()=>{console.error('PINNED_PROCESSOR_PACKAGE=REJECTED');process.exitCode=1;});}
