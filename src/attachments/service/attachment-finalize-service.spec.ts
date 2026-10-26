import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import * as drafts from '../initiation/attachment-draft-repository';
import {AttachmentFinalizeService} from './attachment-finalize-service';
import {AttachmentStorageError,type AttachmentStorage} from '../storage/attachment-storage.port';
import {VideoProcessingError} from '../video-processing/video-processor';

describe('finalizer actual native producer closure',()=>{
 afterEach(()=>jest.restoreAllMocks());
 it.each([['PROCESSING_UNQUIESCED',false],['PROCESSING_INVALID',true]] as const)('holds the processing fence for %s according to actual closure',async(code,quiesced)=>{
  const bytes=Buffer.from('synthetic-native-closure'),source={locator:{attachmentId:'attachment',attemptId:'attempt',objectId:'source',kind:'source' as const},sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),version:'"synthetic"'};
  const client={query:jest.fn(async(sql:string)=>({rows:sql.includes('SELECT declared_mime')?[{declared_mime:'video/mp4',lease_owner:null}]:[],rowCount:0})),release:jest.fn()} as unknown as PoolClient;
  const pool={connect:async()=>client} as unknown as Pool;
  const storage={openRead:async()=>({...source,responseBytes:bytes.length,body:Readable.from([bytes])})} as unknown as AttachmentStorage;
  const row={id:'attachment',state:'PENDING',format:'VIDEO',display_filename:'synthetic.mp4'};
  jest.spyOn(drafts,'lockAuthorizedDraft').mockResolvedValue(row as never);
  jest.spyOn(drafts,'readDraftStatus').mockResolvedValue({state:'REJECTED'} as never);
  const handoff=jest.fn(),service=new AttachmentFinalizeService(pool,storage,{enabled:true,video:true,image:false,text:false},{videoProcessor:{process:async()=>{throw new VideoProcessingError(code);}},onUncertainPut:handoff});
  const internals=service as unknown as {quotas:{consumeRead:jest.Mock};ledger:{claimProcessing:jest.Mock};lifecycle:{rejectProcessing:jest.Mock;settleProcessing:jest.Mock}};
  internals.quotas.consumeRead=jest.fn(async()=>{});
  internals.ledger.claimProcessing=jest.fn(async()=>({attachmentId:'attachment',attachmentVersion:1,leaseOwner:'owner',source}));
  internals.lifecycle.rejectProcessing=jest.fn(async()=>{});internals.lifecycle.settleProcessing=jest.fn(async()=>{});
  const work=service.finalize({actorId:'actor',attachmentId:'attachment',reauthorize:async()=>{}});
  if(quiesced)await expect(work).resolves.toEqual({state:'REJECTED'});else await expect(work).rejects.toMatchObject({code:'PROCESSING_UNQUIESCED',producerQuiesced:false});
  expect(internals.lifecycle.rejectProcessing).toHaveBeenCalledTimes(1);
  expect(internals.lifecycle.settleProcessing).toHaveBeenCalledTimes(quiesced?1:0);expect(handoff).not.toHaveBeenCalled();
 });
});

describe('finalizer source read actual closure',()=>{
 it('retains processing ownership when source GET foreground failure has not stopped the SDK send',async()=>{
  const client={query:jest.fn(async(sql:string)=>({rows:sql.includes('SELECT declared_mime')?[{declared_mime:'text/plain',lease_owner:null}]:[],rowCount:0})),release:jest.fn()} as unknown as PoolClient;
  const pool={connect:async()=>client} as unknown as Pool;
  const failure=Object.assign(new AttachmentStorageError('UNAVAILABLE'),{producerQuiesced:false});
  const storage={openRead:async()=>{throw failure;}} as unknown as AttachmentStorage;
  jest.spyOn(drafts,'lockAuthorizedDraft').mockResolvedValue({id:'attachment',state:'PENDING',format:'TEXT',display_filename:'synthetic.txt'} as never);
  const handoff=jest.fn(),service=new AttachmentFinalizeService(pool,storage,{enabled:true,video:false,image:false,text:true},{onUncertainPut:handoff});
  const internals=service as unknown as {quotas:{consumeRead:jest.Mock};ledger:{claimProcessing:jest.Mock};lifecycle:{rejectProcessing:jest.Mock;settleProcessing:jest.Mock}};
  internals.quotas.consumeRead=jest.fn(async()=>{});internals.ledger.claimProcessing=jest.fn(async()=>({attachmentId:'attachment',attachmentVersion:1,leaseOwner:'owner',source:{}}));
  internals.lifecycle.rejectProcessing=jest.fn(async()=>{});internals.lifecycle.settleProcessing=jest.fn(async()=>{});
  try{
   await expect(service.finalize({actorId:'actor',attachmentId:'attachment',reauthorize:async()=>{}})).rejects.toBe(failure);
   expect(internals.lifecycle.rejectProcessing).toHaveBeenCalledTimes(1);
   expect(internals.lifecycle.settleProcessing).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();
  }finally{jest.restoreAllMocks();}
 });
 it('does not finish a failed source read while its provider body is still closing',async()=>{
  const bytes=Buffer.from('synthetic-source-close');
  const source={locator:{attachmentId:'attachment',attemptId:'attempt',objectId:'source',kind:'source' as const},sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),version:'"synthetic"'};
  let beginClose!:()=>void,completeClose!:()=>void;
  const closing=new Promise<void>(resolve=>{beginClose=resolve;});
  const body=new Readable({read(){},destroy(error,callback){beginClose();completeClose=()=>callback(error);}});
  const storage={openRead:async()=>({...source,responseBytes:bytes.length+1,body})} as unknown as AttachmentStorage;
  const service=new AttachmentFinalizeService({} as Pool,storage,{enabled:true,video:false,image:false,text:true});
  let settled=false;
  const work=(service as unknown as {source(value:typeof source):Promise<Buffer>}).source(source).then(()=>{settled=true;},()=>{settled=true;});
  await closing;await Promise.resolve();await Promise.resolve();
  const finishedBeforeActualClose=settled;
  completeClose();await work;
  expect(finishedBeforeActualClose).toBe(false);
  expect(body.closed).toBe(true);
 });
});
