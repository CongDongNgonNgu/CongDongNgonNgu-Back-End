import {randomUUID} from 'node:crypto';
import type {AttachmentObjectLocator,AttachmentStorage} from '../storage/attachment-storage.port';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
export interface ListedAttachmentObject {locator:AttachmentObjectLocator;sizeBytes:number}
export const ORPHAN_CLASSIFICATIONS=['TRACKED','CLEANUP_PENDING','UNCERTAIN_PRESENT','RETIRED_PRESENT','UNKNOWN_PRESENT','OWNERSHIP_MISMATCH','UNCLAIMED_PRESENT','INCONSISTENT_MANIFEST'] as const;
export type OrphanClassification=typeof ORPHAN_CLASSIFICATIONS[number];
export interface AttachmentOrphanRepository {classify(objects:readonly ListedAttachmentObject[]):Promise<readonly OrphanClassification[]>}
export interface AttachmentOrphanAlert {eventId:string;code:Exclude<OrphanClassification,'TRACKED'|'CLEANUP_PENDING'>|'UNRECOGNIZED_OBJECTS';count:number}
export interface AttachmentOrphanReport {inspected:number;unrecognized:number;hasMore:boolean;classifications:Readonly<Record<OrphanClassification,number>>}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function assertListedObjects(objects:readonly ListedAttachmentObject[]):void{
 if(!Array.isArray(objects)||objects.length>L.objectListPage)throw Error('ATTACHMENT_RECONCILIATION_UNAVAILABLE');
 const seen=new Set<string>();
 for(const object of objects){
  const p=object?.locator;
  if(!p||![p.attachmentId,p.attemptId,p.objectId].every(x=>typeof x==='string'&&uuid.test(x))||!['source','normalized','thumbnail'].includes(p.kind)||!Number.isSafeInteger(object.sizeBytes)||object.sizeBytes<1||object.sizeBytes>(p.kind==='thumbnail'?L.thumbnailBytes:L.imageBytes)||seen.has(p.objectId))throw Error('ATTACHMENT_RECONCILIATION_UNAVAILABLE');
  seen.add(p.objectId);
 }
}
const validCursor=(cursor:unknown):boolean=>cursor===undefined||(typeof cursor==='string'&&cursor.length>0&&cursor.length<=2048&&!/[\u0000-\u0020\u007f]/.test(cursor));
/** One bounded provider-owned namespace page per call. Classification is an
 * unlocked observation, NEVER cleanup/access/ownership authority. No HEAD/GET/PUT/
 * DELETE is available through this detector's storage port. Scheduler integration,
 * cooldown and durable cursor persistence are separate composition work. */
export class AttachmentOrphanDetector {
 private cursor:string|undefined;private active:Promise<AttachmentOrphanReport>|null=null;
 constructor(private readonly repository:AttachmentOrphanRepository,private readonly storage:Pick<AttachmentStorage,'listOwnedPrefix'>,private readonly alert:(event:AttachmentOrphanAlert)=>void=()=>undefined){}
 inspectNextPage():Promise<AttachmentOrphanReport>{
  if(this.active)return this.active;
  const work=this.inspect();this.active=work;void work.finally(()=>{if(this.active===work)this.active=null;}).catch(()=>undefined);return work;
 }
 private async inspect():Promise<AttachmentOrphanReport>{
  try{
   const page=await this.storage.listOwnedPrefix(this.cursor);assertListedObjects(page.objects);
   if(!Number.isSafeInteger(page.unrecognizedObjects)||page.unrecognizedObjects<0||page.objects.length+page.unrecognizedObjects>L.objectListPage||!validCursor(page.cursor)||(page.cursor!==undefined&&page.cursor===this.cursor))throw Error('invalid page');
   const observations=await this.repository.classify(page.objects);
   if(!Array.isArray(observations)||observations.length!==page.objects.length||observations.some(x=>!ORPHAN_CLASSIFICATIONS.includes(x)))throw Error('invalid classification');
   const classifications=Object.fromEntries(ORPHAN_CLASSIFICATIONS.map(x=>[x,0])) as Record<OrphanClassification,number>;
   for(const observation of observations)classifications[observation as OrphanClassification]++;
   // Finish every read before emitting bounded allowlisted diagnostics. Failures
   // leave cursor unchanged; duplicate diagnostics on retry are harmless.
   for(const code of ORPHAN_CLASSIFICATIONS)if(code!=='TRACKED'&&code!=='CLEANUP_PENDING'&&classifications[code])this.alert({eventId:randomUUID(),code,count:classifications[code]});
   if(page.unrecognizedObjects)this.alert({eventId:randomUUID(),code:'UNRECOGNIZED_OBJECTS',count:page.unrecognizedObjects});
   this.cursor=page.cursor;
   return {inspected:page.objects.length,unrecognized:page.unrecognizedObjects,hasMore:page.cursor!==undefined,classifications:Object.freeze(classifications)};
  }catch{throw Error('ATTACHMENT_RECONCILIATION_UNAVAILABLE');}
 }
}
