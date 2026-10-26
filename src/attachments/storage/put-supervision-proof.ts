import {randomUUID} from 'node:crypto';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentStorageError,type AttachmentObjectLocator,type AttachmentPutSupervision} from './attachment-storage.port';
declare const unsentBrand:unique symbol;declare const closureBrand:unique symbol;
export interface PutUnsentCertificate {readonly [unsentBrand]:true;}
export interface PutLocalClosure {readonly [closureBrand]:true;}
type State='ISSUED'|'STARTED'|'SETTLED'|'RETIRED';
interface Facts {id:string;locator:AttachmentObjectLocator;state:State;released:boolean;}
const handles=new WeakMap<AttachmentPutSupervision,Facts>();
const certificates=new WeakMap<PutUnsentCertificate,{id:string;locator:AttachmentObjectLocator}>();
const closures=new WeakMap<PutLocalClosure,{claim:AttachmentPutClaim;id:string}>();
const fail=():never=>{throw new AttachmentStorageError('CONFLICT');};
const sameLocator=(a:AttachmentObjectLocator,b:AttachmentObjectLocator)=>a.attachmentId===b.attachmentId&&a.attemptId===b.attemptId&&a.objectId===b.objectId&&a.kind===b.kind;
function sameClaim(a:AttachmentPutClaim,b:AttachmentPutClaim):boolean{return a.attachmentId===b.attachmentId&&a.objectId===b.objectId&&a.claimId===b.claimId&&a.leaseOwner===b.leaseOwner&&a.attachmentVersion===b.attachmentVersion&&a.objectVersion===b.objectVersion&&a.supervisionId===b.supervisionId&&sameLocator(a.manifest.locator,b.manifest.locator)&&a.manifest.sizeBytes===b.manifest.sizeBytes&&a.manifest.sha256===b.manifest.sha256;}
/** Adapter-internal issuer. Only its captured start closure may mark an actual
 * transport send STARTED, synchronously before dispatch. No provider knowledge,
 * domain permission, public DTO or reconstructed process state grants authority. */
export function createPutSupervisionAuthority(locator:AttachmentObjectLocator,onRelease:()=>void=()=>undefined){
 const facts:Facts={id:randomUUID(),locator:{...locator},state:'ISSUED',released:false};let settle!:()=>void;
 const actual=new Promise<void>(resolve=>{settle=resolve;});
 const handle:AttachmentPutSupervision=Object.freeze({id:facts.id,
  waitForActualSendSettlement:()=>facts.released?Promise.reject(new AttachmentStorageError('UNAVAILABLE')):actual,
  release:()=>{if(!facts.released){facts.released=true;onRelease();}},
  retireUnsent:()=>{if(facts.released||facts.state!=='ISSUED')return fail();facts.state='RETIRED';const certificate=Object.freeze({}) as PutUnsentCertificate;certificates.set(certificate,{id:facts.id,locator:{...facts.locator}});return certificate;},
 });handles.set(handle,facts);
 return {handle,get state(){return facts.state;},get released(){return facts.released;},start:()=>{if(facts.released||facts.state!=='ISSUED')return fail();facts.state='STARTED';},settle:()=>{if(facts.state!=='STARTED')return fail();facts.state='SETTLED';settle();}};
}
/** Internal supervisor must terminalize and await ALL actual local continuations
 * before its callback resolves. Adapter retirement is a separate proof. A failed
 * callback produces no capability. This function never inspects HEAD or leases. */
export async function createPutLocalClosure(claim:AttachmentPutClaim,handle:AttachmentPutSupervision,waitForActualLocalClosure:()=>Promise<void>):Promise<PutLocalClosure>{
 const facts=handles.get(handle);if(!facts||facts.released||!sameLocator(claim.manifest.locator,facts.locator)||typeof waitForActualLocalClosure!=='function')return fail();
 const captured=structuredClone(claim),id=facts.id;await waitForActualLocalClosure();
 const closure=Object.freeze({}) as PutLocalClosure;closures.set(closure,{claim:captured,id});return closure;
}
export function supervisionIdentity(handle:AttachmentPutSupervision,locator:AttachmentObjectLocator):string{
 const facts=handles.get(handle);if(!facts||facts.released||facts.state!=='ISSUED'||!sameLocator(facts.locator,locator))return fail();return facts.id;
}
export function verifyUnsentProof(claim:AttachmentPutClaim,persistedId:string,certificate:PutUnsentCertificate,closure:PutLocalClosure):boolean{
 const c=certificates.get(certificate),p=closures.get(closure);return !!c&&!!p&&c.id===persistedId&&p.id===persistedId&&sameLocator(c.locator,claim.manifest.locator)&&sameClaim(p.claim,claim);
}

/** Exact original adapter entry; public shape/id and arbitrary callbacks grant no
 * settlement authority. Retired, released and never-dispatched handles fail. */
export function originalPutSettlement(handle:AttachmentPutSupervision,locator:AttachmentObjectLocator):{id:string;actual:Promise<void>}{
 const facts=handles.get(handle);if(!facts||facts.released||!['STARTED','SETTLED'].includes(facts.state)||!sameLocator(facts.locator,locator))return fail();
 return {id:facts.id,actual:handle.waitForActualSendSettlement()};
}
