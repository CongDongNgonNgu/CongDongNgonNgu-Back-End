'use strict';
// Explicit build-time opt-in; normal build/start never downloads native tools.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const packaging=require('./package-phase30-processors.cjs');
const timePackaging=require('./package-phase30-time.cjs');
const STAGES=new Set(['ADMISSION','COMPILE','PROCESSOR_DOWNLOAD','TIME_DOWNLOAD','PROCESSOR_STAGE','TIME_STAGE','TIME_VERIFY','CLEANUP']);
const REASONS=new Set(['PROCESSOR_BUILD_ARGUMENTS','PROCESSOR_BUILD_PLATFORM','PROCESSOR_BUILD_COMPILER','PROCESSOR_BUILD_TIME_PROOF','PROCESSOR_DOWNLOAD_ORIGIN','PROCESSOR_DOWNLOAD','PROCESSOR_DOWNLOAD_SIZE','TIME_DOWNLOAD','TIME_DOWNLOAD_SIZE']);
function formatBuildFailure(stage,error){
 const safeStage=STAGES.has(stage)?stage:'UNKNOWN';let reason='UNKNOWN',status;
 try{
  const code=error?.code;
  const expected=safeStage==='PROCESSOR_DOWNLOAD'?'PHASE30_PROCESSOR_DOWNLOAD_HTTP':safeStage==='TIME_DOWNLOAD'?'PHASE30_TIME_DOWNLOAD_HTTP':undefined;
  if(expected&&code===expected){const value=error.status;if(Number.isInteger(value)&&value>=100&&value<=599){reason='HTTP';status=value;}}
  else{const message=error?.message;if(REASONS.has(message))reason=message;}
 }catch{reason='UNKNOWN';status=undefined;}
 return 'PINNED_PROCESSOR_BUILD=REJECTED STAGE='+safeStage+' REASON='+reason+(status===undefined?'':' HTTP_STATUS='+status);
}
function compile(root){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'node_modules','@nestjs','cli','bin','nest.js'),'build'],{cwd:root,shell:false,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('PROCESSOR_BUILD_COMPILER')));});}
async function buildProcessors(args,options={}){
 const mark=stage=>{try{options.onStage?.(stage);}catch{/* Diagnostics never replace build/cleanup behavior. */}};
 mark('ADMISSION');
 const root=options.root||path.resolve(__dirname,'..');
 const local=args.length===4&&args[0]==='--archive'&&args[2]==='--time-archive'&&[args[1],args[3]].every(value=>typeof value==='string'&&value.length>0&&!value.startsWith('--'));
 const download=args.length===1&&args[0]==='--download';
 if(!local&&!download)throw Error('PROCESSOR_BUILD_ARGUMENTS');
 if((options.platform||process.platform)!=='linux'||(options.arch||process.arch)!=='x64')throw Error('PROCESSOR_BUILD_PLATFORM');
 mark('COMPILE');
 await (options.build||(()=>compile(root)))();
 const destination=path.join(root,'dist','attachments','processors');
 const assemble=async(archive,timeArchive)=>{
  mark('PROCESSOR_STAGE');
  await (options.packageArchive||packaging.packageArchive)(archive,destination);
  mark('TIME_STAGE');
  await (options.packageTime||timePackaging.packageTime)(timeArchive,destination);
  mark('TIME_VERIFY');
  const proof=await (options.verifyTime||((directory)=>require(path.join(root,'dist','attachments','video-processing','native-time.js')).verifyBundledNativeTime(directory,{smoke:true})))(destination);
  if(typeof proof?.glibcVersion!=='string'||!/^\d+\.\d+$/.test(proof.glibcVersion)||!Number.isSafeInteger(proof.peakRssBytes)||proof.peakRssBytes<1||proof.peakRssBytes>192*1024*1024)throw Error('PROCESSOR_BUILD_TIME_PROOF');
  return {platform:'linux',arch:'x64',glibcVersion:proof.glibcVersion,peakRssBytes:proof.peakRssBytes};
 };
 if(local)return assemble(path.resolve(root,args[1]),path.resolve(root,args[3]));
 // Own only this freshly created temporary directory and exact archive; never recursively delete.
 mark('PROCESSOR_DOWNLOAD');
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-processor-build-'));
 const archive=path.join(temporary,packaging.PIN.file);
 const timeArchive=path.join(temporary,timePackaging.TIME_PIN.file);
 try{await (options.downloadArchive||packaging.downloadArchive)(archive);mark('TIME_DOWNLOAD');await (options.downloadTime||timePackaging.downloadTime)(timeArchive);return await assemble(archive,timeArchive);}
 finally{let cleanupError;for(const file of [archive,timeArchive]){try{await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')cleanupError??=error;}}try{await fs.rmdir(temporary);}catch(error){cleanupError??=error;}if(cleanupError){mark('CLEANUP');throw cleanupError;}}
}
module.exports={buildProcessors,formatBuildFailure};
if(require.main===module){let stage='ADMISSION';buildProcessors(process.argv.slice(2),{onStage:value=>{stage=value;}}).then(proof=>{console.log('PINNED_TIME_RUNTIME='+JSON.stringify(proof));console.log('PINNED_PROCESSOR_BUILD=VERIFIED');}).catch(error=>{console.error(formatBuildFailure(stage,error));process.exitCode=1;});}
