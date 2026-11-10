import {parseInitiation, type ParsedInitiation} from '../initiation/initiation-input';
import {assertParentBudget, ATTACHMENT_LIMITS} from '../attachment-policy';
import type {AttachmentBoundParent} from '../authorization/attachment-authorization';
import type {ActivationEnvelope} from './guard';
type DeepReadonly<T> = T extends object ? {readonly [P in keyof T]: DeepReadonly<T[P]>} : T;
export interface FixtureActor {readonly id:string; readonly sessionIds:readonly string[];}
export interface FixtureAttachment {
 readonly id:string;readonly ownerId:string;readonly generation:string|null;
 readonly parent:DeepReadonly<AttachmentBoundParent>|null;
 readonly initiation:DeepReadonly<ParsedInitiation>;readonly sourceSha256:string;
}
export interface FixtureInventory {readonly actors:readonly FixtureActor[];readonly attachments:readonly FixtureAttachment[];}
const fail=():never=>{throw Error('TEST_ADMISSION_INVENTORY');};
function object(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const keys=Reflect.ownKeys(value);if(keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k))||required.some(k=>!keys.includes(k)))return fail();
 const out=Object.create(null) as Record<string,unknown>;
 for(const key of keys as string[]){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value'in d))return fail();out[key]=d.value;}
 return out;
}
function array(value:unknown,max:number,min=0):unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return fail();
 const length=Object.getOwnPropertyDescriptor(value,'length')?.value as unknown;
 if(typeof length!=='number'||!Number.isSafeInteger(length)||length<min||length>max||Reflect.ownKeys(value).length!==length+1)return fail();
 const out:unknown[]=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!('value'in d))return fail();out.push(d.value);}return out;
}
function uuid(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))return fail();return value;}
function freeze<T>(value:T):DeepReadonly<T>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value as DeepReadonly<T>;}
/** Envelope is trusted output of validateEnvelopeValue. This pure declaration
 * check proves no DB/session/parent facts and grants no operation capability. */
export function validateFixtureInventory(value:unknown,envelope:ActivationEnvelope):FixtureInventory{
 try{
  const root=object(value,['actors','attachments']),owned=new Set<string>(),foreign=new Set<string>();
  const own=(v:unknown)=>{const id=uuid(v);if(owned.has(id))return fail();owned.add(id);return id;};
  const reference=(v:unknown)=>{const id=uuid(v);foreign.add(id);return id;};
  own(envelope.runId);own(envelope.activationId);
  let sessionCount=0;const actorIds=new Set<string>();
  const actors=array(root.actors,8,1).map(v=>{const a=object(v,['id','sessionIds']),id=own(a.id);actorIds.add(id);const sessionIds=array(a.sessionIds,16).map(own);sessionCount+=sessionIds.length;if(sessionCount>16)return fail();return{id,sessionIds};});
  const attachments=array(root.attachments,Math.min(4,envelope.budgets.attachments),1).map(v=>{
   const a=object(v,['id','ownerId','generation','parent','initiation','sourceSha256']),id=own(a.id),ownerId=uuid(a.ownerId);
   if(!actorIds.has(ownerId)||typeof a.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sourceSha256))return fail();
   const dto=object(a.initiation,['clientUploadId','scope','filename','mime','bytes'],['caption','alt']);own(dto.clientUploadId);
   const tag=object(dto.scope,['kind'],['postType','languageId','visibility','groupId','conversationId']);
   let scope:Record<string,unknown>;
   if(tag.kind==='COMMUNITY'){scope=object(dto.scope,['kind','postType','languageId','visibility']);reference(scope.languageId);}
   else if(tag.kind==='STUDY_GROUP'){scope=object(dto.scope,['kind','groupId']);reference(scope.groupId);}
   else if(tag.kind==='DIRECT_MESSAGE'){scope=object(dto.scope,['kind','conversationId']);reference(scope.conversationId);}
   else return fail();
   const initiation=parseInitiation({...dto,scope});
   const generation=initiation.intent.kind==='COMMUNITY'?(a.generation===null?null:fail()):reference(a.generation);
   let parent:AttachmentBoundParent|null=null;
   if(a.parent!==null){
    if(initiation.intent.kind==='COMMUNITY'){const p=object(a.parent,['kind','postId']);if(p.kind!=='COMMUNITY')return fail();parent={kind:'COMMUNITY',postId:reference(p.postId)};}
    else if(initiation.intent.kind==='STUDY_GROUP'){const p=object(a.parent,['kind','groupId','textId']);if(p.kind!=='STUDY_GROUP'||p.groupId!==initiation.intent.groupId)return fail();parent={kind:'STUDY_GROUP',groupId:reference(p.groupId),textId:reference(p.textId)};}
    else{const p=object(a.parent,['kind','conversationId','messageId']);if(p.kind!=='DIRECT_MESSAGE'||p.conversationId!==initiation.intent.conversationId)return fail();parent={kind:'DIRECT_MESSAGE',conversationId:reference(p.conversationId),messageId:reference(p.messageId)};}
   }
   return{id,ownerId,generation,parent,initiation,sourceSha256:a.sourceSha256};
  });
  if([...foreign].some(id=>owned.has(id)))return fail();
  if(attachments.filter(a=>a.initiation.format==='VIDEO').length>Math.min(1,envelope.budgets.videos)||attachments.reduce((sum,a)=>sum+a.initiation.bytes,0)>Math.min(ATTACHMENT_LIMITS.parentBytes,envelope.budgets.declaredBytes))return fail();
  const groups=new Map<string,typeof attachments>();
  for(const a of attachments){if(a.parent===null)continue;const parent=a.parent;const target=parent.kind==='COMMUNITY'?parent.postId:parent.kind==='STUDY_GROUP'?parent.textId:parent.messageId;const key=parent.kind+':'+target;const group=groups.get(key)??[];if(group.some(b=>JSON.stringify(b.parent)!==JSON.stringify(a.parent)||JSON.stringify(b.initiation.intent)!==JSON.stringify(a.initiation.intent)))return fail();group.push(a);groups.set(key,group);}
  for(const group of groups.values()){const intent=group[0].initiation.intent;assertParentBudget(intent.kind,intent.kind==='COMMUNITY'?intent.postType:null,group.map(a=>({format:a.initiation.format,sourceBytes:a.initiation.bytes})));}
  return freeze({actors,attachments});
 }catch{return fail();}
}
