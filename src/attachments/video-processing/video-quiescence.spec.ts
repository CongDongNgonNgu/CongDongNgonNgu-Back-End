import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {NativeVideoProcessor,VideoProcessingError} from './video-processor';import {syntheticMp4} from '../video/synthetic-fixtures';
describe('uncertain producer temporary ownership',()=>{
 it.each(['PROCESSING_UNQUIESCED','PROCESSING_INVALID'] as const)('retains exact scratch ownership only when %s has not settled',async code=>{
  const root=await mkdtemp(join(tmpdir(),'video-quiescence-test-'));try{
   const processor=new NativeVideoProcessor({processorsDirectory:resolve('approved'),temporaryRoot:root,workerFile:resolve('never-started.js')});jest.spyOn(processor as any,'execute').mockRejectedValue(new VideoProcessingError(code));const bytes=Buffer.from(syntheticMp4.withAudio.base64,'base64');
   await expect(processor.process(bytes,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({code,producerQuiesced:code!=='PROCESSING_UNQUIESCED'});
   const remaining=await readdir(root);if(code==='PROCESSING_UNQUIESCED'){expect(remaining).toHaveLength(1);expect(await readFile(join(root,remaining[0],'input.mp4'))).toEqual(bytes);await expect(processor.process(bytes,{filename:'x.mp4',mime:'video/mp4'})).rejects.toMatchObject({code:'PROCESSING_CANCELLED'});}else expect(remaining).toEqual([]);await processor.shutdown();
  }finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep+'video-quiescence-test-'))throw Error('unsafe test cleanup');await rm(root,{recursive:true,force:true});}
 });
});
