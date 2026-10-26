'use strict';
// Explicit build-time opt-in; normal build/start never downloads native tools.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const packaging=require('./package-phase30-processors.cjs');
const timePackaging=require('./package-phase30-time.cjs');
function compile(root){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'node_modules','@nestjs','cli','bin','nest.js'),'build'],{cwd:root,shell:false,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('PROCESSOR_BUILD_COMPILER')));});}
async function buildProcessors(args,options={}){
 const root=options.root||path.resolve(__dirname,'..');
 const local=args.length===4&&args[0]==='--archive'&&args[2]==='--time-archive'&&[args[1],args[3]].every(value=>typeof value==='string'&&value.length>0&&!value.startsWith('--'));
 const download=args.length===1&&args[0]==='--download';
 if(!local&&!download)throw Error('PROCESSOR_BUILD_ARGUMENTS');
 if((options.platform||process.platform)!=='linux'||(options.arch||process.arch)!=='x64')throw Error('PROCESSOR_BUILD_PLATFORM');
 await (options.build||(()=>compile(root)))();
 const destination=path.join(root,'dist','attachments','processors');
 const assemble=async(archive,timeArchive)=>{
  await (options.packageArchive||packaging.packageArchive)(archive,destination);
  await (options.packageTime||timePackaging.packageTime)(timeArchive,destination);
  const proof=await (options.verifyTime||((directory)=>require(path.join(root,'dist','attachments','video-processing','native-time.js')).verifyBundledNativeTime(directory,{smoke:true})))(destination);
  if(typeof proof?.glibcVersion!=='string'||!/^\d+\.\d+$/.test(proof.glibcVersion)||!Number.isSafeInteger(proof.peakRssBytes)||proof.peakRssBytes<1||proof.peakRssBytes>192*1024*1024)throw Error('PROCESSOR_BUILD_TIME_PROOF');
  return {platform:'linux',arch:'x64',glibcVersion:proof.glibcVersion,peakRssBytes:proof.peakRssBytes};
 };
 if(local)return assemble(path.resolve(root,args[1]),path.resolve(root,args[3]));
 // Own only this freshly created temporary directory and exact archive; never recursively delete.
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-processor-build-'));
 const archive=path.join(temporary,packaging.PIN.file);
 const timeArchive=path.join(temporary,timePackaging.TIME_PIN.file);
 try{await (options.downloadArchive||packaging.downloadArchive)(archive);await (options.downloadTime||timePackaging.downloadTime)(timeArchive);return await assemble(archive,timeArchive);}
 finally{let cleanupError;for(const file of [archive,timeArchive]){try{await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')cleanupError??=error;}}try{await fs.rmdir(temporary);}catch(error){cleanupError??=error;}if(cleanupError)throw cleanupError;}
}
module.exports={buildProcessors};
if(require.main===module)buildProcessors(process.argv.slice(2)).then(proof=>{console.log('PINNED_TIME_RUNTIME='+JSON.stringify(proof));console.log('PINNED_PROCESSOR_BUILD=VERIFIED');}).catch(()=>{console.error('PINNED_PROCESSOR_BUILD=REJECTED');process.exitCode=1;});
