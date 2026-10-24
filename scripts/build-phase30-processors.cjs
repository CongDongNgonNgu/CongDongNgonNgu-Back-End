'use strict';
// Explicit build-time opt-in; normal build/start never downloads native tools.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const packaging=require('./package-phase30-processors.cjs');
function compile(root){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'node_modules','@nestjs','cli','bin','nest.js'),'build'],{cwd:root,shell:false,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('PROCESSOR_BUILD_COMPILER')));});}
async function buildProcessors(args,options={}){
 const root=options.root||path.resolve(__dirname,'..');
 const local=args.length===2&&args[0]==='--archive'&&typeof args[1]==='string'&&args[1].length>0&&!args[1].startsWith('--');
 const download=args.length===1&&args[0]==='--download';
 if(!local&&!download)throw Error('PROCESSOR_BUILD_ARGUMENTS');
 if((options.platform||process.platform)!=='linux'||(options.arch||process.arch)!=='x64')throw Error('PROCESSOR_BUILD_PLATFORM');
 await (options.build||(()=>compile(root)))();
 const destination=path.join(root,'dist','attachments','processors');
 if(local)return (options.packageArchive||packaging.packageArchive)(path.resolve(root,args[1]),destination);
 // Own only this freshly created temporary directory and exact archive; never recursively delete.
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-processor-build-'));
 const archive=path.join(temporary,packaging.PIN.file);
 try{await (options.downloadArchive||packaging.downloadArchive)(archive);return await (options.packageArchive||packaging.packageArchive)(archive,destination);}
 finally{await fs.unlink(archive).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.rmdir(temporary);}
}
module.exports={buildProcessors};
if(require.main===module)buildProcessors(process.argv.slice(2)).then(()=>console.log('PINNED_PROCESSOR_BUILD=VERIFIED')).catch(()=>{console.error('PINNED_PROCESSOR_BUILD=REJECTED');process.exitCode=1;});
