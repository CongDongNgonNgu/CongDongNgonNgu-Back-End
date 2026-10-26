import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { NativeVideoProcessor } from './video-processor';
import { validateMp4Structure } from '../video/mp4';
import { validateImageStructure } from '../validation/image';
const configured=process.env.PHASE30_PROCESSOR_DIR;
const available = configured && existsSync(join(configured,'bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg'));
if(process.env.PHASE30_REQUIRE_NATIVE_TESTS==='true'&&!available)throw Error('Required pinned native processor tests cannot be skipped');
const native = available ? describe : describe.skip;
native('explicit pinned native synthetic pipeline (not Render acceptance)',()=>{
 let compiled:string,root:string,processors:string,source:Buffer;
 beforeAll(async()=>{
  if(!configured)throw Error('explicit processor directory required');root=await mkdtemp(join(tmpdir(),'video-native-tests-'));compiled=resolve('.video-worker-test-'+randomUUID());processors=join(compiled,'processors');await mkdir(join(processors,'bin'),{recursive:true});
  for(const directory of ['video-processing','video','validation','processing']){
   await mkdir(join(compiled,directory),{recursive:true});
   for(const name of await readdir(join(__dirname,'..',directory))){if(!name.endsWith('.ts')||name.endsWith('.spec.ts'))continue;await writeFile(join(compiled,directory,name.replace(/\.ts$/,'.js')),transpileModule(await readFile(join(__dirname,'..',directory,name),'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022,esModuleInterop:true}}).outputText);}
  }
  const windows=process.platform==='win32',hashes:Record<string,string>={};
  for(const name of ['ffmpeg','ffprobe']){const relative='bin/'+name+(windows?'.exe':'');await copyFile(join(configured,relative),join(processors,relative));const hash=createHash('sha256');for await(const bytes of require('node:fs').createReadStream(join(processors,relative)))hash.update(bytes);hashes[relative]=hash.digest('hex');}
  if(windows){expect(hashes['bin/ffmpeg.exe']).toBe('501ec04f7282f394b5479585166b127ba5ff8f7059a5d81f961a120ffd0dfe1c');expect(hashes['bin/ffprobe.exe']).toBe('1493d24ffa482ab28444e573ee55e23f9f1979c1064b8f24ac5baed05c2d4729');}
  await writeFile(join(processors,'manifest.json'),JSON.stringify({sha256:windows?'e7bca5e004c2d13bcb374c3a4bd30c4588b08607a4b1a01369341a4f9678dff3':'5ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927',version:'n9.0.2-29-g6dfaba896f',binaryHashes:hashes}));
  const output=join(root,'generated.mp4');execFileSync(join(processors,'bin','ffmpeg'+(windows?'.exe':'')),['-hide_banner','-nostdin','-v','error','-threads','1','-filter_threads','1','-f','lavfi','-i','color=c=navy:size=128x72:rate=4','-t','0.5','-c:v','libopenh264','-profile:v','constrained_baseline','-pix_fmt','yuv420p','-bsf:v','h264_metadata=sei_user_data=01234567-89ab-cdef-0123-456789abcdef+PRIVATE_SYNTHETIC_SEI','-metadata','title=PRIVATE_SYNTHETIC_TITLE','-metadata','comment=PRIVATE_SYNTHETIC_COMMENT','-movflags','+faststart',output],{timeout:10000,maxBuffer:131072,windowsHide:true});source=await readFile(output);await rm(output);
 },20000);
 afterAll(async()=>{for(const directory of [root,compiled])if(directory){const p=resolve(directory);if(!(p.startsWith(resolve(tmpdir())+sep)||p.startsWith(process.cwd()+sep+'.video-worker-test-')))throw Error('unsafe cleanup');await rm(p,{recursive:true,force:true});}});
 const create=(deadlineMs?:number)=>new NativeVideoProcessor({processorsDirectory:processors,temporaryRoot:root,workerFile:join(compiled,'video-processing','video-worker.js'),deadlineMs});
 it('fully decodes, removes supplied tags and every SEI, returns clean bounded thumbnail and cleans owned files',async()=>{
  expect(validateMp4Structure(source,{filename:'x.mp4',mime:'video/mp4'}).seiUnits).toBeGreaterThan(0);
  const p=create();const result=await p.process(source,{filename:'x.mp4',mime:'video/mp4'});
  expect(validateMp4Structure(result.normalized,{filename:'x.mp4',mime:'video/mp4'}).seiUnits).toBe(0);
  expect(result.normalized.includes(Buffer.from('PRIVATE_SYNTHETIC'))).toBe(false);
  expect(result.thumbnail.length).toBeLessThanOrEqual(262144);expect(validateImageStructure(result.thumbnail,{filename:'x.jpg',mime:'image/jpeg'}).metadataBytes).toBe(0);
  expect(Math.max(result.thumbnailWidth,result.thumbnailHeight)).toBeLessThanOrEqual(320);expect(result.nativeRssObserved).toBe(process.platform==='linux');expect(await readdir(root)).toEqual([]);await p.shutdown();
 },20000);
 it('enforces a deadline during whole-job admission without leaving files',async()=>{const p=create(1);await expect(p.process(source,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({code:'PROCESSING_TIMEOUT'});expect(await readdir(root)).toEqual([]);await p.shutdown();},5000);
 it('rejects truncated input and cancelled jobs without outputs',async()=>{const p=create(),abort=new AbortController();abort.abort();await expect(p.process(source,{filename:'x.mp4',mime:'video/mp4'},abort.signal)).rejects.toMatchObject({code:'PROCESSING_CANCELLED'});await expect(p.process(source.subarray(0,-8),{filename:'x.mp4',mime:'video/mp4'})).rejects.toThrow();expect(await readdir(root)).toEqual([]);await p.shutdown();});

 it.each(['timeout','cancel'] as const)('terminates an actual generated native child after %s and clears owned temporary files',async reason=>{
  const marker=join(compiled,'native-pid-'+randomUUID()),worker=join(compiled,'controlled-'+randomUUID()+'.js');
  const executable=join(processors,'bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
  await writeFile(worker,[
   "const {spawn}=require('node:child_process'),fs=require('node:fs');",
   "const child=spawn("+JSON.stringify(executable)+",['-hide_banner','-nostdin','-v','error','-re','-f','lavfi','-i','color=size=16x16:rate=1','-t','20','-threads','1','-f','null','-'],{windowsHide:true,stdio:'ignore',env:process.env});",
   "fs.writeFileSync("+JSON.stringify(marker)+",String(child.pid));process.send({nativePid:child.pid,rss:process.memoryUsage().rss});",
   "setInterval(()=>process.send({rss:process.memoryUsage().rss}),50);"
  ].join('\n'));
  const abort=new AbortController(),p=new NativeVideoProcessor({processorsDirectory:processors,temporaryRoot:root,workerFile:worker,deadlineMs:reason==='timeout'?1600:5000});
  const result=p.process(source,{filename:'x.mp4',mime:'video/mp4'},abort.signal).then(()=>({code:'SUCCESS'}),error=>({code:error.code}));
  const readyUntil=Date.now()+1200;while(!existsSync(marker)&&Date.now()<readyUntil)await new Promise(done=>setTimeout(done,10));
  expect(existsSync(marker)).toBe(true);const pid=Number(await readFile(marker,'utf8'));if(reason==='cancel')abort.abort();
  expect(await result).toEqual({code:reason==='timeout'?'PROCESSING_TIMEOUT':'PROCESSING_CANCELLED'});
  const until=Date.now()+1000;let alive=true;while(alive&&Date.now()<until){try{process.kill(pid,0);await new Promise(done=>setTimeout(done,10));}catch{alive=false;}}
  expect(alive).toBe(false);expect(await readdir(root)).toEqual([]);await p.shutdown();
 },8000);


 it('rejects corrupt compressed slices that pass structural preflight, using fatal full native decoding',async()=>{
  const bytes=Buffer.from(source),start=bytes.indexOf(Buffer.from('mdat'))+4;
  let position=start;
  while(position+4<bytes.length){const length=bytes.readUInt32BE(position);position+=4;if(!length||position+length>bytes.length)break;const type=bytes[position]&31;if(type===1||type===5)bytes.fill(0x55,position+Math.min(8,length),position+length);position+=length;}
  expect(()=>validateMp4Structure(bytes,{filename:'x.mp4',mime:'video/mp4'})).not.toThrow();
  const p=create();await expect(p.process(bytes,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({code:'PROCESSING_INVALID'});expect(await readdir(root)).toEqual([]);await p.shutdown();
 },20000);


 it('fully decodes and retains the bounded optional AAC-LC stream through sanitization',async()=>{
  const {syntheticMp4}=await import('../video/synthetic-fixtures'),bytes=Buffer.from(syntheticMp4.withAudio.base64,'base64');
  const p=create(),result=await p.process(bytes,{filename:'x.mp4',mime:'video/mp4'});
  expect(validateMp4Structure(result.normalized,{filename:'x.mp4',mime:'video/mp4'})).toMatchObject({audioSamples:25,audioChannels:2,audioSampleRate:48000,seiUnits:0});expect(await readdir(root)).toEqual([]);await p.shutdown();
 },20000);

});
