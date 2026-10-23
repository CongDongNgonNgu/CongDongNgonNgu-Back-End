import { spawn } from 'node:child_process';
import { readFileSync, statSync, readdirSync, createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateMp4Structure } from '../video/mp4';
import { validateImageStructure } from '../validation/image';
import { inspectProbe } from './probe';
import { stripImageMetadata } from '../processing/strip-image-metadata';
const directory = process.argv[2], processors = process.argv[3];
const declaration = { filename: 'source.mp4', mime: 'video/mp4' };
let nativePid: number | undefined;
const snapshot = (): void => {
 let rss = process.memoryUsage().rss;
 if (process.platform === 'linux') {
  const memory = (pid: number): number => { const status = readFileSync('/proc/' + pid + '/status', 'utf8'), match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status); if (!match) throw Error('PROCESSING_UNAVAILABLE'); return Number(match[1])*1024; };
  rss = memory(process.pid);
  if (nativePid) { try { rss += memory(nativePid); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } }
 }
 const files = readdirSync(directory); let disk = 0;
 for (const name of files) { const s = statSync(join(directory,name)); if (!s.isFile()) throw Error('PROCESSING_INVALID'); disk += s.size; }
 if (disk > 64*1024*1024) throw Error('PROCESSING_INVALID');
 process.send?.({rss});
 if (rss > 192*1024*1024) throw Error('PROCESSING_MEMORY_LIMIT');
};
const heartbeat = setInterval(()=>{try {snapshot();}catch {if(nativePid)try{process.kill(nativePid,'SIGKILL');}catch{}process.exit(1);}},25);
const environment: NodeJS.ProcessEnv = {OMP_NUM_THREADS:'1',TMPDIR:directory,TMP:directory,TEMP:directory};
if (process.platform==='win32' && process.env.SystemRoot) environment.SystemRoot=process.env.SystemRoot;
async function command(executable: string, args: string[]): Promise<string> {
 snapshot();
 return new Promise((accept,reject)=>{
  const child=spawn(executable,args,{cwd:directory,env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  nativePid=child.pid; process.send?.({nativePid, rss:process.memoryUsage().rss});
  let stdout=Buffer.alloc(0), stderrBytes=0, invalid=false;
  child.stdout.on('data',(chunk:Buffer)=>{if(stdout.length+chunk.length>131072){invalid=true;child.kill('SIGKILL');}else stdout=Buffer.concat([stdout,chunk]);});
  child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>131072){invalid=true;child.kill('SIGKILL');}});
  child.once('error',()=>{invalid=true;});
  child.once('close',code=>{nativePid=undefined;try{snapshot();}catch{invalid=true;}if(code!==0||invalid)reject(Error('PROCESSING_INVALID'));else accept(stdout.toString('utf8'));});
 });
}
async function main(): Promise<void> {
 if (!directory || resolve(directory)!==directory || !processors || resolve(processors)!==processors) throw Error('PROCESSING_UNAVAILABLE');
 const windows=process.platform==='win32', manifest=JSON.parse(await readFile(join(processors,'manifest.json'),'utf8'));
 const approvedArchive=windows?'e7bca5e004c2d13bcb374c3a4bd30c4588b08607a4b1a01369341a4f9678dff3':'5ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927';
 if(manifest.sha256!==approvedArchive || manifest.version!=='n9.0.2-29-g6dfaba896f')throw Error('PROCESSING_UNAVAILABLE');
 const executable=(name:string)=>join(processors,'bin',name+(windows?'.exe':''));
 for(const name of ['ffmpeg','ffprobe']) {
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
 const source=await probe(input);
 if(source.width!==structure.width||source.height!==structure.height||source.frameRate!==structure.frameRate)throw Error('PROCESSING_INVALID');
 const decode=async(file:string)=>command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',file,'-map','0:v:0','-map','0:a:0?','-sn','-dn','-threads','1','-f','null','-']);
 await decode(input);
 await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',input,'-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_metadata:s','-1','-map_chapters','-1','-metadata:s:v:0','language=und','-metadata:s:v:0','handler_name=VideoHandler',...(structure.audioSamples?['-metadata:s:a:0','language=und','-metadata:s:a:0','handler_name=SoundHandler']:[]),'-c','copy','-bsf:v','filter_units=remove_types=6','-movflags','+faststart',normalized]);
 const normal=await readFile(normalized), parsed=validateMp4Structure(normal,declaration);
 if(parsed.seiUnits!==0||parsed.width!==source.width||parsed.height!==source.height||parsed.videoSamples!==structure.videoSamples||parsed.audioSamples!==structure.audioSamples)throw Error('PROCESSING_INVALID');
 await probe(normalized,true); await decode(normalized);
 await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',normalized,'-map','0:v:0','-frames:v','1','-an','-map_metadata','-1','-vf',"scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-threads','1','-c:v','mjpeg','-q:v','4','-update','1',thumbnail]);
 const generated=await readFile(thumbnail); if(generated.length>262144)throw Error('PROCESSING_INVALID');
 const thumb=stripImageMetadata(generated,'jpeg').bytes; await writeFile(thumbnail,thumb,{mode:0o600});
 const image=validateImageStructure(thumb,{filename:'thumbnail.jpg',mime:'image/jpeg'});
 if(image.metadataBytes||Math.max(image.width,image.height)>320)throw Error('PROCESSING_INVALID');
 await command(executable('ffmpeg'),[...base,'-protocol_whitelist','file,pipe','-i',thumbnail,'-threads','1','-f','null','-']);
 await writeFile(join(directory,'result.json'),JSON.stringify({width:parsed.width,height:parsed.height,durationSeconds:parsed.durationSeconds,thumbnailWidth:image.width,thumbnailHeight:image.height}),{flag:'wx',mode:0o600});
 snapshot();
}
void main().then(()=>{clearInterval(heartbeat);process.disconnect?.();}).catch(()=>{clearInterval(heartbeat);if(nativePid)try{process.kill(nativePid,'SIGKILL');}catch{}process.send?.({failure:'PROCESSING_INVALID',rss:process.memoryUsage().rss},()=>process.exit(1));if(!process.send)process.exit(1);});
