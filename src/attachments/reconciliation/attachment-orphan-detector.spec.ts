import {randomUUID} from 'node:crypto';
import {AttachmentOrphanDetector,type OrphanClassification} from './attachment-orphan-detector';
const locator=()=>({attachmentId:randomUUID(),attemptId:randomUUID(),objectId:randomUUID(),kind:'source' as const});
describe('bounded read-only orphan detection',()=>{
 it('alerts only safe random event IDs/counts for unknown and unrecognized objects and never issues cleanup',async()=>{
  const object={locator:locator(),sizeBytes:3},alerts:unknown[]=[];
  const storage={listOwnedPrefix:jest.fn(async()=>({objects:[object],unrecognizedObjects:1}))},repository={classify:jest.fn(async()=>['UNKNOWN_PRESENT' as const])};
  const report=await new AttachmentOrphanDetector(repository,storage,event=>{alerts.push(event);}).inspectNextPage();
  expect(report).toMatchObject({inspected:1,unrecognized:1,hasMore:false});
  expect(JSON.stringify(alerts)).not.toContain(object.locator.objectId);expect(alerts).toHaveLength(2);
  for(const event of alerts as {eventId:string;code:string;count:number}[]){expect(event.eventId).toMatch(/^[a-f0-9-]{36}$/);expect(Object.keys(event).sort()).toEqual(['code','count','eventId']);}
 });
 it('shares one active page and commits cursor only after the whole database classification succeeds',async()=>{
  let release!:(value:{objects:[];unrecognizedObjects:number;cursor:string})=>void;
  const storage={listOwnedPrefix:jest.fn((_cursor?:string)=>new Promise<{objects:[];unrecognizedObjects:number;cursor:string}>(r=>{release=r;}))},repository={classify:jest.fn(async()=>[] as OrphanClassification[])};
  const detector=new AttachmentOrphanDetector(repository,storage),first=detector.inspectNextPage(),second=detector.inspectNextPage();expect(second).toBe(first);release({objects:[],unrecognizedObjects:0,cursor:'page2'});await first;
  repository.classify.mockRejectedValueOnce(Error('secret database URL'));storage.listOwnedPrefix.mockResolvedValueOnce({objects:[],unrecognizedObjects:0,cursor:'page3'});
  await expect(detector.inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');
  storage.listOwnedPrefix.mockResolvedValueOnce({objects:[],unrecognizedObjects:0,cursor:'page3'});await detector.inspectNextPage();
  expect(storage.listOwnedPrefix.mock.calls.map(args=>args[0])).toEqual([undefined,'page2','page2']);
 });
 it('rejects oversized or malformed pages before touching database ownership',async()=>{
  const repository={classify:jest.fn(async()=>[] as OrphanClassification[])};
  for(const page of [{objects:Array.from({length:101},()=>({locator:locator(),sizeBytes:3})),unrecognizedObjects:0},{objects:[],unrecognizedObjects:101},{objects:[{locator:{...locator(),objectId:'backups/private'},sizeBytes:3}],unrecognizedObjects:0},{objects:[{locator:locator(),sizeBytes:4194305}],unrecognizedObjects:0}]){
   await expect(new AttachmentOrphanDetector(repository,{listOwnedPrefix:async()=>page}).inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');
  }expect(repository.classify).not.toHaveBeenCalled();
 });
 it('reports known uncertain, retired and mismatched presence without adopting or settling any key',async()=>{
  const categories:OrphanClassification[]=['UNCERTAIN_PRESENT','RETIRED_PRESENT','OWNERSHIP_MISMATCH','CLEANUP_PENDING','TRACKED'],alerts:{code:string;count:number}[]=[];
  const detector=new AttachmentOrphanDetector({classify:async()=>categories},{listOwnedPrefix:async()=>({objects:categories.map(()=>({locator:locator(),sizeBytes:3})),unrecognizedObjects:0})},e=>alerts.push(e));
  expect((await detector.inspectNextPage()).classifications).toMatchObject({UNCERTAIN_PRESENT:1,RETIRED_PRESENT:1,OWNERSHIP_MISMATCH:1,CLEANUP_PENDING:1,TRACKED:1});expect(alerts.map(x=>x.code)).toEqual(['UNCERTAIN_PRESENT','RETIRED_PRESENT','OWNERSHIP_MISMATCH']);
 });
 it('keeps cursor unchanged on provider or alert failure and normalizes private diagnostics',async()=>{
  const object={locator:locator(),sizeBytes:3},storage={listOwnedPrefix:jest.fn(async(_cursor?:string)=>({objects:[object],unrecognizedObjects:0,cursor:'page2'}))};
  const detector=new AttachmentOrphanDetector({classify:async()=>['UNKNOWN_PRESENT']},storage,()=>{throw Error('private key/SECRET');});
  await expect(detector.inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');await expect(detector.inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');expect(storage.listOwnedPrefix.mock.calls.map(x=>x[0])).toEqual([undefined,undefined]);
 });

 it('does not advance after a failed provider page or invalid nonadvancing cursor',async()=>{
  const storage={listOwnedPrefix:jest.fn(async(_cursor?:string)=>({objects:[],unrecognizedObjects:0,cursor:'page2'}))},repository={classify:jest.fn(async()=>[] as OrphanClassification[])},detector=new AttachmentOrphanDetector(repository,storage);
  storage.listOwnedPrefix.mockRejectedValueOnce(Error('provider private URL SECRET'));
  await expect(detector.inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');await detector.inspectNextPage();
  await expect(detector.inspectNextPage()).rejects.toThrow('ATTACHMENT_RECONCILIATION_UNAVAILABLE');
  storage.listOwnedPrefix.mockResolvedValueOnce({objects:[],unrecognizedObjects:0,cursor:'page3'});await detector.inspectNextPage();
  expect(storage.listOwnedPrefix.mock.calls.map(x=>x[0])).toEqual([undefined,undefined,'page2','page2']);
 });

});
