import {AttachmentStorageError,type AttachmentStorage,type AttachmentObjectLocator,type AttachmentPutSupervision,type SupervisableAttachmentStorage} from '../../src/attachments/storage/attachment-storage.port';
import {createPutSupervisionAuthority,supervisionIdentity} from '../../src/attachments/storage/put-supervision-proof';
/** Synthetic protocol double only; this is not provider/durability evidence. */
export function syntheticSupervisedStorage(put:AttachmentStorage['putTemporary']){
 const entries=new Map<AttachmentPutSupervision,ReturnType<typeof createPutSupervisionAuthority>>();
 const storage={
  putTemporary:jest.fn(async()=>{throw Error('UNSUPERVISED_WRITE_FORBIDDEN');}),
  supervisePut:jest.fn((locator:AttachmentObjectLocator)=>{const a=createPutSupervisionAuthority(locator);entries.set(a.handle,a);return a.handle;}),
  putSupervised:jest.fn(async(handle:AttachmentPutSupervision,input:Parameters<AttachmentStorage['putTemporary']>[0])=>{
   const a=entries.get(handle);if(!a||supervisionIdentity(handle,input.locator)!==handle.id)throw new AttachmentStorageError('CONFLICT');
   if(input.signal?.aborted)throw new AttachmentStorageError('UNAVAILABLE');
   a.start();try{return await put(input);}finally{a.settle();}
  }),
 };
 return storage as typeof storage & SupervisableAttachmentStorage;
}
