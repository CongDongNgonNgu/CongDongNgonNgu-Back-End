import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, copyFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { NativeVideoProcessor } from './video-processor';
import { validateMp4Structure } from '../video/mp4';
import { validateImageStructure } from '../validation/image';
import {verifyBundledNativeTime,NATIVE_TIME_DISTRIBUTION} from './native-time';
import {MINIMAL_NATIVE_DISTRIBUTION} from './native-distribution';
import { loadSyntheticNativeSource, prefixSyntheticSei } from './fixtures/native-source';
const configured=process.env.PHASE30_PROCESSOR_DIR;
const available = configured && existsSync(join(configured,'bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg'));
if(process.env.PHASE30_REQUIRE_NATIVE_TESTS==='true'&&!available)throw Error('Required pinned native processor tests cannot be skipped');
const native = available ? describe : describe.skip;
const assertStagedBinaryHashes=(manifest:{binaryHashes:Record<string,string>},hashes:Record<string,string>)=>expect(manifest.binaryHashes).toEqual(expect.objectContaining(hashes));

describe('hash-bound synthetic native source',()=>{
 it('places verified SEI before IDR without modifying its source or compressed payloads',()=>{
  const fixture=require('./fixtures/sei-fixture.json'),raw=Buffer.from(fixture.base64,'base64'),snapshot=Buffer.from(raw),source=prefixSyntheticSei(raw);
  expect(loadSyntheticNativeSource()).toEqual(source);
  expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.prefixedSha256);
  expect(source.length).toBe(1109);expect(raw).toEqual(snapshot);
  expect(source.readUInt32BE(958)).toBe(47);expect(source[962]&31).toBe(6);
  expect(source.readUInt32BE(1009)).toBe(69);expect(source[1013]&31).toBe(5);
  expect(source.subarray(958,1009)).toEqual(raw.subarray(1031,1082));
  expect(source.subarray(1009,1082)).toEqual(raw.subarray(958,1031));
  expect(validateMp4Structure(source,{filename:'synthetic.mp4',mime:'video/mp4'}).seiUnits).toBe(1);
  for(const marker of ['TITLE','COMMENT','STREAM','SEI_ONLY'])expect(source.includes(Buffer.from('PHASE30_SYNTHETIC_'+marker))).toBe(true);
 });
 it('rejects unknown or already transformed media',()=>{
  expect(()=>prefixSyntheticSei(Buffer.alloc(1109))).toThrow('OWNED_SEI_FIXTURE_REQUIRED');
  expect(()=>prefixSyntheticSei(loadSyntheticNativeSource())).toThrow('OWNED_SEI_FIXTURE_REQUIRED');
 });
});
describe('Linux native fixture manifest preservation',()=>{
 it('accepts matching staged binaries while retaining the real license entry, and rejects changed binaries',()=>{const manifest={binaryHashes:{'bin/ffmpeg':'approved-ffmpeg','bin/ffprobe':'approved-ffprobe','LICENSE.txt':'approved-license'}},before=JSON.stringify(manifest);assertStagedBinaryHashes(manifest,{'bin/ffmpeg':'approved-ffmpeg','bin/ffprobe':'approved-ffprobe'});expect(JSON.stringify(manifest)).toBe(before);expect(()=>assertStagedBinaryHashes(manifest,{'bin/ffprobe':'wrong'})).toThrow();expect(()=>assertStagedBinaryHashes(manifest,{'bin/missing':'wrong'})).toThrow();});
});
const AAC_DISPATCH_GOLDEN = {
 lc_positive: { bytes:1790, sha256:'90c1e51c956e7c943a0e184523627ad17d139648482ec6b758f47da114de6d43' },
 explicit_absent_positive: { bytes:1793, sha256:'56e967f22b342af8a78bca93605fe01dd7a96332d95ee76a3b36b2ef9f642a50' },
 first_sbr: { bytes:1792, sha256:'288096e69ffdac78f35e5c14b34cb5ca35cf98216fa1f006205e3221c3fa77ef' },
 first_crc: { bytes:1793, sha256:'8836b281f13fb4a06a3442e949e151d3f68b8aa2e4d1278b9295e76fdc6942ac' },
 truncated_fil: { bytes:1792, sha256:'275cdf9817d361d35e160b51b5cc73bd48daa614a301765c5cf6f9ef246b61ad' },
 before_channel: { bytes:1792, sha256:'bad329384512673968055a0042304ec34fb6ec78a9161a6ae3e3fd82a31f1e69' },
 late_sbr: { bytes:1792, sha256:'f337078f516440cc9e41ec429b79617e85527df6a4e01828606202423f363105' },
 explicit_absent_late: { bytes:1795, sha256:'22949ff6de2ca020b25bcbcbb9d8dcd0f47fcc58e0c0b7ce8d02198e0ae101c1' },
} as const;
type AacDispatchCase = keyof typeof AAC_DISPATCH_GOLDEN;
function aacDispatchFixture(name:AacDispatchCase):Buffer {
 const corpus=require('./fixtures/aac-dispatch-fixtures.json');
 expect(corpus.scope).toBe('OWNED_SYNTHETIC_AAC_MINIMAL_DISPATCH_NOT_DEEP_SBR_PS_ASAN_OR_RUNTIME_ACCEPTANCE');
 expect(corpus.provenance.workspaceSourceCommit).toBe('a2bbf1e66548058b7de6ae46ab28c31a62e174fd');
 expect(corpus.provenance.sourceSha256).toBe('2ef27e95df445401f512f2e6f07674ae155f8f14b866001100889fbf0839019f');
 expect(corpus.provenance.builderSha256).toBe('8bbcde836a5fa927eba87672551ec29233a4716b93a265a7f4021ab847cb7311');
 expect(Object.keys(corpus.cases).sort()).toEqual(Object.keys(AAC_DISPATCH_GOLDEN).sort());
 const fixture=corpus.cases[name],expected=AAC_DISPATCH_GOLDEN[name];
 expect(fixture.bytes).toBe(expected.bytes);expect(fixture.sha256).toBe(expected.sha256);
 const bytes=Buffer.from(fixture.base64,'base64');expect(bytes.toString('base64')).toBe(fixture.base64);
 expect(bytes.length).toBe(expected.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
 return bytes;
}
describe('hash-bound AAC dispatch corpus (structural-only)',()=>{
 it.each(Object.keys(AAC_DISPATCH_GOLDEN) as AacDispatchCase[])('retains exact golden %s framing without granting native acceptance',name=>{
  const bytes=aacDispatchFixture(name),snapshot=Buffer.from(bytes);
  expect(validateMp4Structure(bytes,{filename:'aac-dispatch.mp4',mime:'video/mp4'})).toMatchObject({structuralOnly:true,requiresNativeValidation:true,width:128,height:72,frameRate:4,durationSeconds:0.5,videoSamples:2,audioSamples:25,audioChannels:2,audioSampleRate:48000,seiUnits:0});
  expect(bytes).toEqual(snapshot);
 });
});

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
  if(windows)await writeFile(join(processors,'manifest.json'),JSON.stringify({sha256:'e7bca5e004c2d13bcb374c3a4bd30c4588b08607a4b1a01369341a4f9678dff3',version:'n9.0.2-29-g6dfaba896f',binaryHashes:hashes}));
  else{
   await verifyBundledNativeTime(configured);
   const manifest=JSON.parse(await readFile(join(configured,'manifest.json'),'utf8'));assertStagedBinaryHashes(manifest,hashes);
   await copyFile(join(configured,'manifest.json'),join(processors,'manifest.json'));
   await copyFile(join(configured,'time-manifest.json'),join(processors,'time-manifest.json'));
   await copyFile(join(configured,'bin','time'),join(processors,'bin','time'));
   await mkdir(join(processors,'source','time'),{recursive:true});
   for(const pin of NATIVE_TIME_DISTRIBUTION)await copyFile(join(configured,'source','time',pin.file),join(processors,'source','time',pin.file));
   for(const pin of MINIMAL_NATIVE_DISTRIBUTION){const target=join(processors,pin.file);await mkdir(dirname(target),{recursive:true});await copyFile(join(configured,pin.file),target);}
  }
  source=loadSyntheticNativeSource();
 },20000);
 (process.platform==='linux'?it:it.skip)('rejects a changed staged source notice before native execution and cleans owned scratch',async()=>{
  const pin=MINIMAL_NATIVE_DISTRIBUTION.find(entry=>entry.file==='notices/LICENSE.md');
  if(!pin)throw Error('expected pinned source notice');
  const file=join(processors,pin.file),original=await readFile(file),mode=(await stat(file)).mode;
  expect(createHash('sha256').update(original).digest('hex')).toBe(pin.sha256);
  const changed=Buffer.from(original);changed[0]^=1;
  const p=create();
  try{
   await chmod(file,mode|0o200);await writeFile(file,changed);
   await expect(p.process(source,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({
    code:'PROCESSING_INVALID',message:'PROCESSING_INVALID [VERIFY_DISTRIBUTION/MAIN/EXCEPTION]',producerQuiesced:true,
   });
   expect(await readdir(root)).toEqual([]);
  }finally{
   await p.shutdown();await writeFile(file,original);await chmod(file,mode);
  }
  expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(pin.sha256);
  expect((await stat(file)).mode).toBe(mode);
 },20000);
 afterAll(async()=>{for(const directory of [root,compiled])if(directory){const p=resolve(directory);if(!(p.startsWith(resolve(tmpdir())+sep)||p.startsWith(process.cwd()+sep+'.video-worker-test-')))throw Error('unsafe cleanup');await rm(p,{recursive:true,force:true});}});
 const create=(deadlineMs?:number)=>new NativeVideoProcessor({processorsDirectory:processors,temporaryRoot:root,workerFile:join(compiled,'video-processing','video-worker.js'),deadlineMs});
 it('fully processes the hash-bound fifteen-second 720p boundary fixture with AAC under unchanged limits',async()=>{
  const bytes=await readFile(join(__dirname,'../runtime-probe/assets/boundary.mp4'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('598f6d9aa585d9e2922bc28ef919960f6bd57ad14244051ba132e6ff97acfd98');
  const p=create();
  try {
   const result=await p.process(bytes,{filename:'boundary.mp4',mime:'video/mp4'});
   expect(result.width).toBe(1280);expect(result.height).toBe(720);expect(result.durationSeconds).toBe(15);
   expect(result.nativeRssObserved).toBe(process.platform==='linux');expect(result.peakRssBytes).toBeGreaterThan(0);expect(result.peakRssBytes).toBeLessThanOrEqual(192*1024*1024);
   expect(result.normalized.length).toBeLessThanOrEqual(3*1024*1024);
   expect(validateMp4Structure(result.normalized,{filename:'normalized.mp4',mime:'video/mp4'})).toMatchObject({width:1280,height:720,durationSeconds:15,frameRate:24,seiUnits:0,audioChannels:1,audioSampleRate:48000});
   expect(result.normalized.includes(Buffer.from('PHASE30_SYNTHETIC'))).toBe(false);
   expect(result.thumbnail.length).toBeLessThanOrEqual(262144);
  } finally {await p.shutdown();}
  expect(await readdir(root)).toEqual([]);
 },20000);
 const decodedSei=async(bytes:Buffer)=>{
  const file=join(compiled,'sei-probe-'+randomUUID()+'.mp4');await writeFile(file,bytes,{flag:'wx'});
  try{
   const info=JSON.parse(execFileSync(join(processors,'bin',process.platform==='win32'?'ffprobe.exe':'ffprobe'),['-v','error','-protocol_whitelist','file,pipe','-threads','1','-max_alloc','33554432','-select_streams','v:0','-show_frames','-of','json',file],{timeout:5000,maxBuffer:131072,windowsHide:true}).toString('utf8'));
   expect(info.frames).toHaveLength(2);
   return info.frames.reduce((count:number,frame:{side_data_list?:{side_data_type:string}[]})=>count+(frame.side_data_list??[]).filter(data=>data.side_data_type==='H.26[45] User Data Unregistered SEI message').length,0);
  }finally{await rm(file,{force:true});}
 };
 it('fully decodes, removes supplied tags and every SEI, returns clean bounded thumbnail and cleans owned files',async()=>{
  const snapshot=Buffer.from(source);
  expect(validateMp4Structure(source,{filename:'x.mp4',mime:'video/mp4'}).seiUnits).toBeGreaterThan(0);
  expect(await decodedSei(source)).toBeGreaterThan(0);
  for(const marker of ['TITLE','COMMENT','STREAM','SEI_ONLY'])expect(source.includes(Buffer.from('PHASE30_SYNTHETIC_'+marker))).toBe(true);
  const p=create();const result=await p.process(source,{filename:'x.mp4',mime:'video/mp4'});
  expect(validateMp4Structure(result.normalized,{filename:'x.mp4',mime:'video/mp4'}).seiUnits).toBe(0);
  expect(await decodedSei(result.normalized)).toBe(0);expect(source).toEqual(snapshot);
  expect(result.normalized.includes(Buffer.from('PHASE30_SYNTHETIC'))).toBe(false);
  expect(result.thumbnail.length).toBeLessThanOrEqual(262144);expect(validateImageStructure(result.thumbnail,{filename:'x.jpg',mime:'image/jpeg'}).metadataBytes).toBe(0);
  expect(Math.max(result.thumbnailWidth,result.thumbnailHeight)).toBeLessThanOrEqual(320);expect(result.nativeRssObserved).toBe(process.platform==='linux');expect(await readdir(root)).toEqual([]);await p.shutdown();
 },20000);
 it('enforces a deadline during whole-job admission without leaving files',async()=>{const p=create(1);await expect(p.process(source,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({code:'PROCESSING_TIMEOUT'});expect(await readdir(root)).toEqual([]);await p.shutdown();},5000);
 it('rejects truncated input and cancelled jobs without outputs',async()=>{const p=create(),abort=new AbortController();abort.abort();await expect(p.process(source,{filename:'x.mp4',mime:'video/mp4'},abort.signal)).rejects.toMatchObject({code:'PROCESSING_CANCELLED'});await expect(p.process(source.subarray(0,-8),{filename:'x.mp4',mime:'video/mp4'})).rejects.toThrow();expect(await readdir(root)).toEqual([]);await p.shutdown();});

 it.each(['timeout','cancel'] as const)('terminates an actual live native child after %s and clears its group and owned temporary files',async reason=>{
  const marker=join(compiled,'native-pid-'+randomUUID()),worker=join(compiled,'controlled-'+randomUUID()+'.js');
  const executable=join(processors,'bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
  await writeFile(worker,[
   "const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');",
   "const child=spawn("+JSON.stringify(executable)+",['-hide_banner','-nostdin','-v','error','-stream_loop','-1','-re','-threads','1','-i',path.join(process.argv[2],'input.mp4'),'-t','20','-map','0:v:0','-threads','1','-f','null','-'],{windowsHide:true,stdio:'ignore',env:process.env});",
   "child.on('error',()=>process.send({rss:process.memoryUsage().rss,failure:true}));child.on('exit',()=>process.send({rss:process.memoryUsage().rss,failure:true}));",
   "process.send({nativePid:child.pid,rss:process.memoryUsage().rss});setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null){try{process.kill(child.pid,0);const marker="+JSON.stringify(marker)+";fs.writeFileSync(marker+'.tmp',JSON.stringify({pid:child.pid,group:process.pid}));fs.renameSync(marker+'.tmp',marker);}catch{}}},350);",
   "setInterval(()=>process.send({rss:process.memoryUsage().rss}),50);"
  ].join('\n'));
  const abort=new AbortController(),p=new NativeVideoProcessor({processorsDirectory:processors,temporaryRoot:root,workerFile:worker,deadlineMs:6000});
  const result=p.process(source,{filename:'x.mp4',mime:'video/mp4'},abort.signal).then(()=>({code:'SUCCESS'}),error=>({code:error.code}));
  try{
  const readyUntil=Date.now()+4500;while(!existsSync(marker)&&Date.now()<readyUntil)await new Promise(done=>setTimeout(done,10));
  expect(existsSync(marker)).toBe(true);const {pid,group}=JSON.parse(await readFile(marker,'utf8'));
  expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);expect(Number.isSafeInteger(group)&&group>0).toBe(true);
  process.kill(pid,0);if(process.platform==='linux')process.kill(-group,0);
  await new Promise(done=>setTimeout(done,150));process.kill(pid,0);
  if(reason==='cancel')abort.abort();
  expect(await result).toEqual({code:reason==='timeout'?'PROCESSING_TIMEOUT':'PROCESSING_CANCELLED'});
  const until=Date.now()+1000;let alive=true;while(alive&&Date.now()<until){try{process.kill(pid,0);await new Promise(done=>setTimeout(done,10));}catch{alive=false;}}
  expect(alive).toBe(false);
  if(process.platform==='linux')expect(()=>process.kill(-group,0)).toThrow(expect.objectContaining({code:'ESRCH'}));
  expect(await readdir(root)).toEqual([]);
  }finally{abort.abort();await p.shutdown();}
 },10000);


 it('rejects structurally valid corrupt slices on native error before retaining outputs',async()=>{
  const bytes=Buffer.from(source),start=bytes.indexOf(Buffer.from('mdat'))+4;
  let position=start;
  while(position+4<bytes.length){const length=bytes.readUInt32BE(position);position+=4;if(!length||position+length>bytes.length)break;const type=bytes[position]&31;if(type===1||type===5)bytes.fill(0x55,position+Math.min(8,length),position+length);position+=length;}
  expect(()=>validateMp4Structure(bytes,{filename:'x.mp4',mime:'video/mp4'})).not.toThrow();
  const p=create();
  try{
   const failure=await p.process(bytes,{filename:'x.mp4',mime:'video/mp4'}).then(()=>{throw Error('corrupt fixture was accepted');},error=>({code:error.code,message:error.message,diagnostic:error.diagnostic,producerQuiesced:error.producerQuiesced}));
   expect(failure).toMatchObject({
    code:'PROCESSING_INVALID',
    message:'PROCESSING_INVALID [SOURCE_PROBE/COMMAND_STDERR/FORMAT]',
    diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_STDERR',reason:'FORMAT'},
    producerQuiesced:true,
   });
   expect(await readdir(root)).toEqual([]);
  }finally{await p.shutdown();}
 },20000);


 it('fully decodes and retains the bounded optional AAC-LC stream through sanitization',async()=>{
  const {syntheticMp4}=await import('../video/synthetic-fixtures'),bytes=Buffer.from(syntheticMp4.withAudio.base64,'base64');
  const p=create(),result=await p.process(bytes,{filename:'x.mp4',mime:'video/mp4'});
  expect(validateMp4Structure(result.normalized,{filename:'x.mp4',mime:'video/mp4'})).toMatchObject({audioSamples:25,audioChannels:2,audioSampleRate:48000,seiUnits:0});expect(await readdir(root)).toEqual([]);await p.shutdown();
 },20000);

 it.each(['lc_positive','explicit_absent_positive'] as const)('fully processes quiet AAC dispatch control %s through the pinned worker',async name=>{
  const bytes=aacDispatchFixture(name),snapshot=Buffer.from(bytes),p=create();
  try{
   const result=await p.process(bytes,{filename:'aac-control.mp4',mime:'video/mp4'});
   expect(validateMp4Structure(result.normalized,{filename:'normalized.mp4',mime:'video/mp4'})).toMatchObject({audioSamples:25,audioChannels:2,audioSampleRate:48000,seiUnits:0});
   expect(result.normalized.length).toBeLessThanOrEqual(3*1024*1024);expect(result.thumbnail.length).toBeLessThanOrEqual(262144);
  }finally{await p.shutdown();expect(bytes).toEqual(snapshot);expect(await readdir(root)).toEqual([]);}
 },20000);
 it.each([
  ['first_sbr','SOURCE_PROBE/MAIN/EXCEPTION'],
  ['first_crc','SOURCE_PROBE/MAIN/EXCEPTION'],
  ['truncated_fil','SOURCE_PROBE/COMMAND_STDERR/FORMAT'],
  ['before_channel','SOURCE_PROBE/COMMAND_STDERR/FORMAT'],
  ['late_sbr','SOURCE_DECODE/COMMAND_STDERR/FORMAT'],
  ['explicit_absent_late','SOURCE_DECODE/COMMAND_STDERR/FORMAT'],
 ] as const)('rejects AAC dispatch negative %s at its exact fail-closed gate',async(name,diagnostic)=>{
  const bytes=aacDispatchFixture(name),snapshot=Buffer.from(bytes),p=create();
  try{
   await expect(p.process(bytes,{filename:'aac-negative.mp4',mime:'video/mp4'})).rejects.toMatchObject({code:'PROCESSING_INVALID',message:'PROCESSING_INVALID ['+diagnostic+']',producerQuiesced:true});
  }finally{await p.shutdown();expect(bytes).toEqual(snapshot);expect(await readdir(root)).toEqual([]);}
 },20000);

});
