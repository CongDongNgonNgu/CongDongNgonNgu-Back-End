import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { validateMp4Structure } from '../video/mp4';
import { validateImageStructure } from '../validation/image';
export class VideoProcessingError extends Error { constructor(readonly code:'PROCESSING_INVALID'|'PROCESSING_UNAVAILABLE'|'PROCESSING_CANCELLED'|'PROCESSING_TIMEOUT'|'PROCESSING_MEMORY_LIMIT'){super(code);this.name='VideoProcessingError';} }
export interface ProcessedVideo {normalized:Buffer;thumbnail:Buffer;width:number;height:number;durationSeconds:number;thumbnailWidth:number;thumbnailHeight:number;peakRssBytes:number;nativeRssObserved:boolean}
interface Options {processorsDirectory:string;temporaryRoot?:string;workerFile?:string;deadlineMs?:number}
/** Disabled infrastructure port. Watchdogs and file/pipe restrictions do not constitute OS memory/network isolation. */
export class NativeVideoProcessor {
 private readonly root:string;private readonly worker:string;private readonly deadline:number;private readonly processors:string;
 private closed=false;private active?:Promise<ProcessedVideo>;private stop?:()=>void;
 constructor(options:Options){
  this.processors=options.processorsDirectory;this.root=resolve(options.temporaryRoot??tmpdir());this.worker=options.workerFile??join(__dirname,'video-worker.js');this.deadline=options.deadlineMs??15000;
  if(!isAbsolute(this.processors)||!isAbsolute(this.worker)||!this.worker.endsWith('.js')||!Number.isSafeInteger(this.deadline)||this.deadline<1||this.deadline>15000)throw new VideoProcessingError('PROCESSING_UNAVAILABLE');
 }
 process(bytes:Buffer,declaration:{filename:string;mime:string},signal?:AbortSignal):Promise<ProcessedVideo>{
  if(this.closed||signal?.aborted)return Promise.reject(new VideoProcessingError('PROCESSING_CANCELLED'));
  if(this.active)return Promise.reject(new VideoProcessingError('PROCESSING_UNAVAILABLE'));
  const task=this.run(bytes,declaration,signal);this.active=task;void task.finally(()=>{this.active=undefined;}).catch(()=>undefined);return task;
 }
 async shutdown():Promise<void>{this.closed=true;this.stop?.();if(this.active)await Promise.allSettled([this.active]);}
 private async run(bytes:Buffer,declaration:{filename:string;mime:string},signal?:AbortSignal):Promise<ProcessedVideo>{
  const started=performance.now();validateMp4Structure(bytes,declaration);const input=Buffer.from(bytes),directory=await mkdtemp(join(this.root,'attachment-video-'));
  try{
   await chmod(directory,0o700);await writeFile(join(directory,'input.mp4'),input,{flag:'wx',mode:0o600});
   const remaining=this.deadline-(performance.now()-started);if(remaining<=0)throw new VideoProcessingError('PROCESSING_TIMEOUT');
   const memory=await this.execute(directory,remaining,signal);
   const output=async(name:string,cap:number)=>{const file=join(directory,name),s=await stat(file);if(!s.isFile()||s.size<1||s.size>cap)throw new VideoProcessingError('PROCESSING_INVALID');return readFile(file);};
   const normalized=await output('normalized.mp4',3145728),thumbnail=await output('thumbnail.jpg',262144);
   const video=validateMp4Structure(normalized,{filename:'normalized.mp4',mime:'video/mp4'}),image=validateImageStructure(thumbnail,{filename:'thumbnail.jpg',mime:'image/jpeg'});
   if(video.seiUnits||image.metadataBytes||Math.max(image.width,image.height)>320)throw new VideoProcessingError('PROCESSING_INVALID');
   if(this.closed||signal?.aborted)throw new VideoProcessingError('PROCESSING_CANCELLED');
   if(performance.now()-started>this.deadline)throw new VideoProcessingError('PROCESSING_TIMEOUT');
   return {normalized,thumbnail,width:video.width,height:video.height,durationSeconds:video.durationSeconds,thumbnailWidth:image.width,thumbnailHeight:image.height,...memory};
  }finally{if(resolve(directory).startsWith(this.root+sep)&&directory.startsWith(join(this.root,'attachment-video-')))await rm(directory,{recursive:true,force:true});}
 }
 private execute(directory:string,deadline:number,signal?:AbortSignal):Promise<{peakRssBytes:number;nativeRssObserved:boolean}>{
  return new Promise((accept,reject)=>{
   if(this.closed||signal?.aborted){reject(new VideoProcessingError('PROCESSING_CANCELLED'));return;}
   const environment:NodeJS.ProcessEnv={OMP_NUM_THREADS:'1',UV_THREADPOOL_SIZE:'1',TMPDIR:directory,TMP:directory,TEMP:directory};
   if(process.platform==='win32'&&process.env.SystemRoot)environment.SystemRoot=process.env.SystemRoot;
   const child:ChildProcess=spawn(process.execPath,['--max-old-space-size=64','--max-semi-space-size=4',this.worker,directory,this.processors],{shell:false,windowsHide:true,cwd:directory,env:environment,detached:process.platform==='linux',stdio:['ignore','ignore','ignore','ipc']});
   let failure:VideoProcessingError|undefined,peak=0,nativeRssObserved=false,finished=false,sampling=false,nativePid:number|undefined,killIssued=false;
   let killTask=Promise.resolve();
   const kill=()=>{
    if(killIssued)return;killIssued=true;
    if(process.platform==='linux'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    else if(process.platform==='win32'&&child.pid&&process.env.SystemRoot){
     killTask=new Promise<void>(done=>{
      const killer=spawn(join(process.env.SystemRoot!,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore',env:environment});
      const timer=setTimeout(()=>{killer.kill();child.kill('SIGKILL');done();},1000);
      killer.on('error',()=>{child.kill('SIGKILL');clearTimeout(timer);done();});killer.on('close',()=>{clearTimeout(timer);done();});
     });
    }else child.kill('SIGKILL');
   };
   const fail=(code:VideoProcessingError['code'])=>{failure??=new VideoProcessingError(code);kill();};
   this.stop=()=>fail('PROCESSING_CANCELLED');const cancel=()=>fail('PROCESSING_CANCELLED');signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
   const observe=(rss:number)=>{if(!Number.isSafeInteger(rss)||rss<1){fail('PROCESSING_UNAVAILABLE');return;}peak=Math.max(peak,rss);if(rss>201326592)fail('PROCESSING_MEMORY_LIMIT');};
   const timer=setTimeout(()=>fail('PROCESSING_TIMEOUT'),deadline);
   const monitor=setInterval(()=>{
    if(process.platform!=='linux'||!child.pid||finished||sampling)return;
    sampling=true;
    const measure=async(pid:number)=>{const s=await readFile('/proc/'+pid+'/status','utf8'),m=/^VmHWM:\s+(\d+)\s+kB$/m.exec(s);if(!m)throw Error('memory observation');return Number(m[1])*1024;};
    void (async()=>{let rss=await measure(child.pid!);if(nativePid)try{rss+=await measure(nativePid);nativeRssObserved=true;}catch(e:any){if(e.code!=='ENOENT')throw e;}observe(rss);})().catch((e:any)=>{if(!finished&&e.code!=='ENOENT')fail('PROCESSING_UNAVAILABLE');}).finally(()=>{sampling=false;});
   },25);
   child.on('message',(message:any)=>{
    if(!message||typeof message!=='object'||typeof message.rss!=='number'){fail('PROCESSING_INVALID');return;}observe(message.rss);
    if(message.nativePid!==undefined){if(!Number.isSafeInteger(message.nativePid)||message.nativePid<1){fail('PROCESSING_INVALID');return;}nativePid=message.nativePid;}
    if(message.failure)fail('PROCESSING_INVALID');
   });
   child.once('error',()=>{failure??=new VideoProcessingError('PROCESSING_UNAVAILABLE');});
   child.once('close',async code=>{finished=true;clearInterval(monitor);clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.stop=undefined;await killTask;if(failure)reject(failure);else if(code!==0||!peak||(process.platform==='linux'&&!nativeRssObserved))reject(new VideoProcessingError('PROCESSING_INVALID'));else accept({peakRssBytes:peak,nativeRssObserved});});
  });
 }
}
