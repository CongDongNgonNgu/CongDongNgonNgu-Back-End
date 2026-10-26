import type {Pool} from 'pg';import {Readable} from 'node:stream';
import {AttachmentUploadService} from './attachment-upload-service';import type {AttachmentStorage} from '../storage/attachment-storage.port';
describe('raw intake before database admission',()=>{
 it('observes source failures during session refresh without unhandled error events or database work',async()=>{
  const body=new Readable({read(){}}),query=jest.fn(()=>{throw Error('unexpected database work');});
  const service=new AttachmentUploadService({connect:query} as unknown as Pool,{} as AttachmentStorage,{enabled:true,text:true,image:false,video:false});
  const operation=service.upload({actorId:'unused',attachmentId:'unused',contentType:'text/plain',contentLength:3,body,reauthorize:async()=>{body.destroy(Error('synthetic-input-failure'));await new Promise<void>(r=>setImmediate(r));}});
  await expect(operation).rejects.toThrow('ATTACHMENT_UPLOAD_UNAVAILABLE');expect(query).not.toHaveBeenCalled();expect(body.destroyed).toBe(true);
 });
});
