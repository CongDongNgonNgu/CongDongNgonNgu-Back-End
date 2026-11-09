'use strict';
// Explicit build-time software delivery only. Never handles user uploads or runs at app start.
const fs=require('node:fs/promises'),path=require('node:path');
const {stagePinnedArchive}=require('./stage-phase30-archive.cjs');
const DISTRIBUTION=require('./phase30-minimal-distribution.json');
const PIN=Object.freeze({tag:'phase30-processors-simd-20261109',version:'9.0.2',file:'phase30-minimal-simd-linux-x64.tar.gz',bytes:DISTRIBUTION.bytes,sha256:DISTRIBUTION.sha256,source:'https://github.com/CongDongNgonNgu/CongDongNgonNgu-Workspace/releases/download/phase30-processors-simd-20261109/phase30-minimal-simd-linux-x64.tar.gz'});
function runtimeManifest(){
 const binaryHashes={},binaryBytes={};
 for(const name of ['ffmpeg','ffprobe']){
  const relative='bin/'+name,pin=DISTRIBUTION.members.find(item=>item.path===relative);
  if(!pin)throw Error('PROCESSOR_DISTRIBUTION_PIN');
  binaryHashes[relative]=pin.sha256;binaryBytes[relative]=pin.bytes;
 }
 return {format:1,platform:'linux',arch:'x64',version:PIN.version,sourceCommit:'6dfaba896fddaea098abec8ac84ff67375a7c6f1',sha256:PIN.sha256,bytes:PIN.bytes,source:PIN.source,binaryHashes,binaryBytes,distributionManifest:'distribution-manifest.json',sourceAndNotices:'Complete corresponding source, original notices, exact build/configuration and compiler/startup materials retained alongside executables. GNU time remains a separate reviewed distribution.'};
}
async function packageArchive(archive,destination){
 archive=path.resolve(archive);destination=path.resolve(destination);
 await stagePinnedArchive(archive,destination,DISTRIBUTION);
 // Keep the authenticated source candidate manifest intact; runtime identity is
 // independently code-pinned in native-identity.ts and native-distribution.ts.
 await fs.rename(path.join(destination,'manifest.json'),path.join(destination,'distribution-manifest.json'));
 const manifest=runtimeManifest();
 await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o400});
 return manifest;
}
async function downloadArchive(destination){
 const url=PIN.source;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),180000);
 try{let current=url,response;for(let i=0;i<6;i++){const u=new URL(current);if(u.protocol!=='https:'||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname)||u.username||u.password)throw Error('PROCESSOR_DOWNLOAD_ORIGIN');response=await fetch(u,{redirect:'manual',signal:abort.signal});if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();current=new URL(response.headers.get('location'),u).href;continue;}break;}
 if(!response||response.status!==200||!response.body)throw Error('PROCESSOR_DOWNLOAD');let count=0;const file=await fs.open(destination,'wx',0o600);try{for await(const chunk of response.body){count+=chunk.length;if(count>PIN.bytes)throw Error('PROCESSOR_DOWNLOAD_SIZE');await file.write(chunk);}if(count!==PIN.bytes)throw Error('PROCESSOR_DOWNLOAD_SIZE');}finally{await file.close();}
 }finally{clearTimeout(timer);}
}

module.exports={PIN,packageArchive,downloadArchive,runtimeManifest};
if(require.main===module){const archive=process.argv[2],destination=process.argv[3];if(!archive||!destination||process.argv.length>5||(process.argv[4]&&process.argv[4]!=='--download')){console.error('Usage: node scripts/package-phase30-processors.cjs ARCHIVE DESTINATION [--download]');process.exitCode=1;}else(async()=>{if(process.argv[4]==='--download')await downloadArchive(archive);await packageArchive(archive,destination);console.log('PINNED_PROCESSOR_PACKAGE=VERIFIED');})().catch(()=>{console.error('PINNED_PROCESSOR_PACKAGE=REJECTED');process.exitCode=1;});}
