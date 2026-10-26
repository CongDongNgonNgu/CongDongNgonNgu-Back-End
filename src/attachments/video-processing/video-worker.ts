import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync, createReadStream, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateMp4Structure } from '../video/mp4';
import { validateImageStructure } from '../validation/image';
import { inspectProbe } from './probe';
import { stripImageMetadata } from '../processing/strip-image-metadata';
import {parseLinuxHighWater,parseCompletedNativePeak,measuredNativeInvocation} from './native-memory';
import {NativeDiagnosticFailure,diagnoseNativeFailure,type NativeDiagnostic} from './native-diagnostic';
const directory = process.argv[2], processors = process.argv[3];
const declaration = { filename: 'source.mp4', mime: 'video/mp4' };
let nativePid: number | undefined;
let launcherPid:number|undefined,completedNativePeak=0,launcherPeak=0,commandSequence=0;
let stage:NativeDiagnostic['stage']='BOOT',terminating=false;
const observe=<T>(point:NativeDiagnostic['point'],work:()=>T):T=>{try{return work();}catch(error){throw new NativeDiagnosticFailure(diagnoseNativeFailure(error,stage,point));}};
const snapshot = (): void => {
 let rss = process.memoryUsage().rss;
 if (process.platform === 'linux') {
  const memory=(pid:number,exited=false)=>parseLinuxHighWater(readFileSync('/proc/'+pid+'/status','utf8'),exited);
  rss=observe('WORKER_MEMORY',()=>memory(process.pid))!;
  let live=0;
  if(launcherPid)try{
   launcherPeak=Math.max(launcherPeak,observe('LAUNCHER_MEMORY',()=>memory(launcherPid!,true))??0);
   // GNU time has exactly one command child. Never scan unrelated /proc entries.
   const children=observe('CHILD_LIST',()=>readFileSync('/proc/'+launcherPid+'/task/'+launcherPid+'/children','utf8'));
   if(children.length>64||!/^\s*(?:[1-9]\d*)?\s*$/.test(children))throw new NativeDiagnosticFailure({stage,point:'CHILD_LIST',reason:'FORMAT'});
   nativePid=children.trim()?Number(children.trim()):undefined;
   if(nativePid){if(!Number.isSafeInteger(nativePid)||nativePid<1)throw new NativeDiagnosticFailure({stage,point:'CHILD_LIST',reason:'FORMAT'});try{live=observe('NATIVE_MEMORY',()=>memory(nativePid!,true))??0;}catch(error){if(!(error instanceof NativeDiagnosticFailure&&error.diagnostic.reason==='ENOENT'))throw error;}}
  }catch(error:any){if(error.code!=='ENOENT'&&!(error instanceof NativeDiagnosticFailure&&error.diagnostic.reason==='ENOENT'))throw error;}
  rss+=Math.max(completedNativePeak,live)+launcherPeak;
 }
 const files = observe('SCRATCH_LIST',()=>readdirSync(directory)); let disk = 0;
 for (const name of files) { const s = observe('SCRATCH_STAT',()=>statSync(join(directory,name))); if (!s.isFile()) throw new NativeDiagnosticFailure({stage,point:'SCRATCH_STAT',reason:'FORMAT'}); disk += s.size; }
 if (disk > 64*1024*1024) throw new NativeDiagnosticFailure({stage,point:'SCRATCH_LIMIT',reason:'LIMIT'});
 process.send?.({rss,nativePid:nativePid??null,...(completedNativePeak?{nativePeakRssBytes:completedNativePeak}:{})});
 if (rss > 192*1024*1024) throw new NativeDiagnosticFailure({stage,point:'MEMORY_LIMIT',reason:'LIMIT'});
};
const heartbeat = setInterval(()=>{try {snapshot();}catch(error){reportFailure(error,'HEARTBEAT');}},25);
function reportFailure(error:unknown,point:NativeDiagnostic['point']):void{
 if(terminating)return;terminating=true;clearInterval(heartbeat);
 if(nativePid)try{process.kill(nativePid,'SIGKILL');}catch{}if(launcherPid)try{process.kill(launcherPid,'SIGKILL');}catch{}
 const diagnostic=diagnoseNativeFailure(error,stage,point),exit=()=>process.exit(1);
 // Bound the IPC flush; a stopped parent cannot extend the processing deadline.
 const fallback=setTimeout(exit,100);
 try{if(process.send)process.send({failure:'PROCESSING_INVALID',diagnostic,rss:process.memoryUsage().rss},()=>{clearTimeout(fallback);exit();});else exit();}catch{exit();}
}
const environment: NodeJS.ProcessEnv = {OMP_NUM_THREADS:'1',TMPDIR:directory,TMP:directory,TEMP:directory};
if (process.platform==='win32' && process.env.SystemRoot) environment.SystemRoot=process.env.SystemRoot;
async function command(executable: string, args: string[]): Promise<string> {
 snapshot();
 return new Promise((accept,reject)=>{
  const metric=join(directory,'native-rss-'+(++commandSequence)+'.txt'),invocation=measuredNativeInvocation(executable,args,metric,process.platform);
  const child=observe('COMMAND_SPAWN',()=>spawn(invocation.executable,invocation.args,{cwd:directory,env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']}));
  if(process.platform==='linux')launcherPid=child.pid;else nativePid=child.pid;
  process.send?.({nativePid:process.platform==='linux'?null:nativePid,rss:process.memoryUsage().rss});
  let stdout=Buffer.alloc(0), stderrBytes=0, invalid:NativeDiagnostic|undefined;
  child.stdout.on('data',(chunk:Buffer)=>{if(stdout.length+chunk.length>131072){invalid={stage,point:'COMMAND_STDOUT',reason:'LIMIT'};child.kill('SIGKILL');}else stdout=Buffer.concat([stdout,chunk]);});
  child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>131072){invalid={stage,point:'COMMAND_STDERR',reason:'LIMIT'};child.kill('SIGKILL');}});
  child.once('error',error=>{invalid=diagnoseNativeFailure(error,stage,'COMMAND_SPAWN');});
  child.once('close',code=>{nativePid=undefined;launcherPid=undefined;try{
   if(process.platform==='linux'&&code===0&&!invalid)observe('COMMAND_METRIC',()=>{const info=statSync(metric);if(!info.isFile()||info.size<1||info.size>128)throw Error('PROCESSING_UNAVAILABLE');completedNativePeak=Math.max(completedNativePeak,parseCompletedNativePeak(readFileSync(metric)));});
   snapshot();
  }catch(error){invalid=diagnoseNativeFailure(error,stage,'MAIN');}finally{if(process.platform==='linux')try{unlinkSync(metric);}catch(error:any){if(error.code!=='ENOENT')invalid=diagnoseNativeFailure(error,stage,'COMMAND_UNLINK');}}
  if(code!==0||invalid)reject(new NativeDiagnosticFailure(invalid??{stage,point:'COMMAND_EXIT',reason:'NONZERO'}));else accept(stdout.toString('utf8'));});
 });
}
async function main(): Promise<void> {
 if (!directory || resolve(directory)!==directory || !processors || resolve(processors)!==processors) throw Error('PROCESSING_UNAVAILABLE');
 if(process.platform==='linux'){
  const info=statSync('/usr/bin/time');if(!info.isFile()||!(info.mode&0o111))throw Error('PROCESSING_UNAVAILABLE');
  const version=spawnSync('/usr/bin/time',['--version'],{cwd:directory,env:environment,shell:false,windowsHide:true,timeout:1000,maxBuffer:8192,encoding:'utf8'});
  if(version.error||version.status!==0||!version.stdout.startsWith('time (GNU Time)'))throw Error('PROCESSING_UNAVAILABLE');
 }
 const windows=process.platform==='win32', manifest=JSON.parse(await readFile(join(processors,'manifest.json'),'utf8'));
 const approvedArchive=windows?'e7bca5e004c2d13bcb374c3a4bd30c4588b08607a4b1a01369341a4f9678dff3':'5ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927';
 if(manifest.sha256!==approvedArchive || manifest.version!=='n9.0.2-29-g6dfaba896f')throw Error('PROCESSING_UNAVAILABLE');
 const executable=(name:string)=>join(processors,'bin',name+(windows?'.exe':''));
 for(const name of ['ffmpeg','ffprobe']) {
  stage=name==='ffmpeg'?'VERIFY_FFMPEG':'VERIFY_FFPROBE';
  const relative='bin/'+name+(windows?'.exe':''), file=executable(name), info=statSync(file);
  if(!info.isFile()||info.size>160*1024*1024)throw Error('PROCESSING_UNAVAILABLE');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==manifest.binaryHashes?.[relative])throw Error('PROCESSING_UNAVAILABLE');
  const version=await command(file,['-version']);
  if(!version.startsWith(name+' version n9.0.2-29-g6dfaba896f-20261020 ')||!version.includes('--disable-libx264')||version.includes('--enable-gpl')||version.includes('--enable-nonfree'))throw Error('PROCESSING_UNAVAILABLE');
 }
 const input=join(directory,'input.mp4'), normalized=join(directory,'normalized.mp4'), thumbnail=join(directory,'thumbnail.jpg');
 const bytes=await readFile(input), structure=validateMp4Structure(bytes,declaration);
 const base=['-hide_banner','-nostdin','-y','-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1','-max_alloc','33554432','-xerror','-err_detect','explode'];
 const probe=async(file:string,output=false)=>inspectProbe(JSON.parse(await command(executable('ffprobe'),['-v','error','-protocol_whitelist','file,pipe','-threads','1','-max_alloc','33554432','-show_streams','-show_format','-show_chapters','-of','json',file])),output);
 stage='SOURCE_PROBE';const source=await probe(input);
 if(source.width!==structure.width||source.height!==structure.height||source.frameRate!==structure.frameRate)throw Error('PROCESSING_INVALID');
 const decode=async(file:string)=>command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',file,'-map','0:v:0','-map','0:a:0?','-sn','-dn','-threads','1','-f','null','-']);
 stage='SOURCE_DECODE';await decode(input);
 stage='NORMALIZE';
 await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',input,'-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_metadata:s','-1','-map_chapters','-1','-metadata:s:v:0','language=und','-metadata:s:v:0','handler_name=VideoHandler',...(structure.audioSamples?['-metadata:s:a:0','language=und','-metadata:s:a:0','handler_name=SoundHandler']:[]),'-c','copy','-bsf:v','filter_units=remove_types=6','-movflags','+faststart',normalized]);
 stage='OUTPUT_VALIDATE';const normal=await readFile(normalized), parsed=validateMp4Structure(normal,declaration);
 if(parsed.seiUnits!==0||parsed.width!==source.width||parsed.height!==source.height||parsed.videoSamples!==structure.videoSamples||parsed.audioSamples!==structure.audioSamples)throw Error('PROCESSING_INVALID');
 stage='OUTPUT_PROBE';await probe(normalized,true);stage='OUTPUT_DECODE';await decode(normalized);
 stage='THUMBNAIL';
 await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',normalized,'-map','0:v:0','-frames:v','1','-an','-map_metadata','-1','-vf',"scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-threads','1','-c:v','mjpeg','-q:v','4','-update','1',thumbnail]);
 stage='THUMBNAIL_VALIDATE';const generated=await readFile(thumbnail); if(generated.length>262144)throw Error('PROCESSING_INVALID');
 const thumb=stripImageMetadata(generated,'jpeg').bytes; await writeFile(thumbnail,thumb,{mode:0o600});
 const image=validateImageStructure(thumb,{filename:'thumbnail.jpg',mime:'image/jpeg'});
 if(image.metadataBytes||Math.max(image.width,image.height)>320)throw Error('PROCESSING_INVALID');
 stage='THUMBNAIL_DECODE';await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',thumbnail,'-threads','1','-f','null','-']);
 stage='RESULT';
 await writeFile(join(directory,'result.json'),JSON.stringify({width:parsed.width,height:parsed.height,durationSeconds:parsed.durationSeconds,thumbnailWidth:image.width,thumbnailHeight:image.height}),{flag:'wx',mode:0o600});
 snapshot();
}
void main().then(()=>{if(!terminating){clearInterval(heartbeat);process.disconnect?.();}}).catch(error=>reportFailure(error,'MAIN'));
