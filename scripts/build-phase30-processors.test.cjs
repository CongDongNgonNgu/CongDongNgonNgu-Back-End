'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {buildProcessors:build}=require('./build-phase30-processors.cjs');
const PROOF={glibcVersion:'2.36',peakRssBytes:8192};
const buildProcessors=(args,options={})=>build(args,{packageTime:async()=>{},downloadTime:async archive=>fs.writeFile(archive,'synthetic time'),verifyTime:async()=>PROOF,...options});
async function fixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-build-test-'));try{await fn(root);}finally{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^phase30-build-test-[A-Za-z0-9]+$/);assert.equal((await fs.lstat(resolved)).isSymbolicLink(),false);await fs.rm(resolved,{recursive:true,force:true});}}
test('explicit archives package both tools then return actual selected proof only after successful Nest build',()=>fixture(async root=>{const calls=[];const proof=await buildProcessors(['--archive','input.tar.xz','--time-archive','time.deb'],{root,platform:'linux',arch:'x64',build:async()=>calls.push('build'),packageArchive:async(a,d)=>calls.push(['ffmpeg',a,d]),packageTime:async(a,d)=>calls.push(['time',a,d]),verifyTime:async d=>{calls.push(['verify',d]);return {...PROOF,privateField:'must not escape'};},downloadArchive:async()=>assert.fail('unexpected download')});const destination=path.join(root,'dist','attachments','processors');assert.deepEqual(calls,['build',['ffmpeg',path.join(root,'input.tar.xz'),destination],['time',path.join(root,'time.deb'),destination],['verify',destination]]);assert.deepEqual(proof,{platform:'linux',arch:'x64',...PROOF});}));
test('missing, ambiguous and unknown options reject without build or download',async()=>{for(const args of [[],['--archive'],['--download','extra'],['--archive','a','--download'],['--other']]){await assert.rejects(buildProcessors(args,{platform:'linux',arch:'x64',build:async()=>assert.fail('build started')}),/PROCESSOR_BUILD_ARGUMENTS/);}});
test('unsupported platform rejects before build',async()=>{await assert.rejects(buildProcessors(['--download'],{platform:'win32',arch:'x64',build:async()=>assert.fail('build started')}),/PROCESSOR_BUILD_PLATFORM/);});
test('failed compiler never downloads or packages',async()=>{await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{throw Error('compiler failed');},downloadArchive:async()=>assert.fail('download started'),packageArchive:async()=>assert.fail('package started')}),/compiler failed/);});
test('explicit download cleans its exact temporary archive after successful package',()=>fixture(async root=>{let archive,folder;await buildProcessors(['--download'],{root,platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async a=>{archive=a;folder=path.dirname(a);await fs.writeFile(a,'synthetic');},packageArchive:async a=>{assert.equal(a,archive);assert.equal(await fs.readFile(a,'utf8'),'synthetic');}});await assert.rejects(fs.stat(archive),{code:'ENOENT'});await assert.rejects(fs.stat(folder),{code:'ENOENT'});}));
test('failed download cleans partial archive without packaging',async()=>{let archive;await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async a=>{archive=a;await fs.writeFile(a,'partial');throw Error('download failed');},packageArchive:async()=>assert.fail('package started')}),/download failed/);await assert.rejects(fs.stat(archive),{code:'ENOENT'});});
test('packaging failure cleans the downloaded archive and propagates failure',async()=>{let archive;await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async a=>{archive=a;await fs.writeFile(a,'synthetic');},packageArchive:async()=>{throw Error('checksum mismatch');}}),/checksum mismatch/);await assert.rejects(fs.stat(archive),{code:'ENOENT'});});
test('package scripts preserve ordinary build and startup without a packaging hook',()=>{const scripts=require('../package.json').scripts;assert.equal(scripts.build,'nest build');assert.equal(scripts.start,'node dist/main.js');assert.equal(scripts['build:attachments'],'node scripts/build-phase30-processors.cjs');assert.equal(scripts.postbuild,undefined);assert.equal(scripts.prestart,undefined);});

test('failed GNU time download cleans both exact owned archives without claiming verified runtime',async()=>{let ffmpeg,time;await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async archive=>{ffmpeg=archive;await fs.writeFile(archive,'ffmpeg');},downloadTime:async archive=>{time=archive;await fs.writeFile(archive,'partial');throw Error('time download failed');},verifyTime:async()=>assert.fail('verification started')}),/time download failed/);for(const file of [ffmpeg,time])await assert.rejects(fs.stat(file),{code:'ENOENT'});await assert.rejects(fs.stat(path.dirname(time)),{code:'ENOENT'});});
test('time runtime verification failure cleans both archives and propagates failure',async()=>{const files=[];await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async archive=>{files.push(archive);await fs.writeFile(archive,'ffmpeg');},downloadTime:async archive=>{files.push(archive);await fs.writeFile(archive,'time');},packageArchive:async()=>{},verifyTime:async()=>{throw Error('TIME_RUNTIME_REJECTED');}}),/TIME_RUNTIME_REJECTED/);assert.equal(files.length,2);for(const file of files)await assert.rejects(fs.stat(file),{code:'ENOENT'});});
test('missing, zero or malformed runtime evidence never becomes a successful build proof',async()=>{for(const evidence of [undefined,{}, {...PROOF,peakRssBytes:0},{...PROOF,peakRssBytes:Infinity},{...PROOF,glibcVersion:'private-token'}])await assert.rejects(buildProcessors(['--archive','input.tar.xz','--time-archive','time.deb'],{platform:'linux',arch:'x64',build:async()=>{},packageArchive:async()=>{},verifyTime:async()=>evidence}),/PROCESSOR_BUILD_TIME_PROOF/);});


test('closed stages identify every failing operation without replacing original errors or missing cleanup',async()=>{
 for(const stage of ['COMPILE','PROCESSOR_DOWNLOAD','TIME_DOWNLOAD','PROCESSOR_STAGE','TIME_STAGE','TIME_VERIFY']){
  const original=Error('private path https://private.invalid/?secret=value'),stages=[],files=[];
  const hooks={build:async()=>{},downloadArchive:async a=>{files.push(a);await fs.writeFile(a,'processor');},downloadTime:async a=>{files.push(a);await fs.writeFile(a,'time');},packageArchive:async()=>{},packageTime:async()=>{},verifyTime:async()=>PROOF};
  const operation={COMPILE:'build',PROCESSOR_DOWNLOAD:'downloadArchive',TIME_DOWNLOAD:'downloadTime',PROCESSOR_STAGE:'packageArchive',TIME_STAGE:'packageTime',TIME_VERIFY:'verifyTime'}[stage];
  const prior=hooks[operation];hooks[operation]=async(...args)=>{await prior(...args);throw original;};
  await assert.rejects(build(['--download'],{platform:'linux',arch:'x64',...hooks,onStage:s=>stages.push(s)}),e=>e===original);
  assert.equal(stages[0],'ADMISSION');assert.ok(stages.includes(stage));assert.equal(stages.at(-1),stage);
  if(stage==='COMPILE'){assert.deepEqual(files,[]);assert.equal(stages.includes('PROCESSOR_DOWNLOAD'),false);}else assert.equal(stages.includes('CLEANUP'),false);
  for(const file of files)await assert.rejects(fs.stat(file),{code:'ENOENT'});
 }
});
test('admission and successful local proof report only the literal phase sequence',async()=>{
 const stages=[];await assert.rejects(build([],{onStage:s=>stages.push(s)}),/PROCESSOR_BUILD_ARGUMENTS/);assert.deepEqual(stages,['ADMISSION']);
 const observed=[];const proof=await buildProcessors(['--archive','a','--time-archive','t'],{platform:'linux',arch:'x64',build:async()=>{},packageArchive:async()=>{},onStage:s=>observed.push(s)});
 assert.deepEqual(observed,['ADMISSION','COMPILE','PROCESSOR_STAGE','TIME_STAGE','TIME_VERIFY']);assert.deepEqual(proof,{platform:'linux',arch:'x64',...PROOF});
});
test('cleanup error remains the thrown error and reports CLEANUP instead of a false verified build',async t=>{
 const original=Error('private cleanup error'),stages=[];let owned;
 const real=fs.rmdir;t.mock.method(fs,'rmdir',async directory=>{owned=directory;throw original;});
 try{await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{},downloadArchive:async a=>fs.writeFile(a,'processor'),packageArchive:async()=>{throw Error('private earlier body failure');},onStage:s=>stages.push(s)}),e=>e===original);assert.equal(stages.at(-1),'CLEANUP');}
 finally{if(owned){assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^phase30-processor-build-[A-Za-z0-9]+$/);await real(owned);}}
});
test('safe formatter never emits arbitrary error fields or throws for hostile accessors',()=>{
 const {formatBuildFailure}=require('./build-phase30-processors.cjs');
 const privateText='private https://private.invalid/key?credential=secret';
 const hostile={get message(){throw Error(privateText);},get code(){throw Error(privateText);},get status(){throw Error(privateText);}};
 for(const error of [Error(privateText,{cause:privateText}),{message:privateText,cause:privateText,code:privateText,status:privateText},hostile,null]){
  const text=formatBuildFailure('PROCESSOR_DOWNLOAD',error);assert.match(text,/^PINNED_PROCESSOR_BUILD=REJECTED STAGE=PROCESSOR_DOWNLOAD REASON=UNKNOWN$/);assert.equal(text.includes(privateText),false);assert.equal(text.includes('VERIFIED'),false);
 }
 assert.match(formatBuildFailure(privateText,Error(privateText)),/STAGE=UNKNOWN REASON=UNKNOWN$/);
 for(const status of [99,600,504.5,'504',NaN,Infinity])assert.equal(formatBuildFailure('PROCESSOR_DOWNLOAD',{code:'PHASE30_PROCESSOR_DOWNLOAD_HTTP',status}).includes('HTTP_STATUS='),false);
});
test('actual non-200 download responses produce validated closed HTTP diagnostics without body or URL',async t=>{
 const {formatBuildFailure}=require('./build-phase30-processors.cjs');
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push([url,options]);return{status:504,get body(){throw Error('private response body');}};});
 for(const [module,method,phase,code,message]of [
  ['./package-phase30-processors.cjs','downloadArchive','PROCESSOR_DOWNLOAD','PHASE30_PROCESSOR_DOWNLOAD_HTTP','PROCESSOR_DOWNLOAD'],
  ['./package-phase30-time.cjs','downloadTime','TIME_DOWNLOAD','PHASE30_TIME_DOWNLOAD_HTTP','TIME_DOWNLOAD']]){
  await assert.rejects(require(module)[method]('never-written'),error=>{
   assert.equal(error.message,message);assert.equal(error.code,code);assert.equal(error.status,504);
   assert.equal(formatBuildFailure(phase,error),'PINNED_PROCESSOR_BUILD=REJECTED STAGE='+phase+' REASON=HTTP HTTP_STATUS=504');return true;
  });
 }
 assert.equal(calls.length,2);
});

test('diagnostic callback failures never replace the original operation or successful proof',async()=>{
 const original=Error('original compiler failure');await assert.rejects(buildProcessors(['--download'],{platform:'linux',arch:'x64',build:async()=>{throw original;},onStage:()=>{throw Error('observer failed');}}),error=>error===original);
 const proof=await buildProcessors(['--archive','a','--time-archive','t'],{platform:'linux',arch:'x64',build:async()=>{},packageArchive:async()=>{},onStage:()=>{throw Error('observer failed');}});assert.deepEqual(proof,{platform:'linux',arch:'x64',...PROOF});
});

test('formatter caches a checked message once and never emits a later accessor value',()=>{
 const {formatBuildFailure}=require('./build-phase30-processors.cjs');let reads=0;
 const error={get message(){return ++reads===1?'PROCESSOR_BUILD_TIME_PROOF':'private later accessor value';}};
 assert.equal(formatBuildFailure('TIME_VERIFY',error),'PINNED_PROCESSOR_BUILD=REJECTED STAGE=TIME_VERIFY REASON=PROCESSOR_BUILD_TIME_PROOF');assert.equal(reads,1);
});
