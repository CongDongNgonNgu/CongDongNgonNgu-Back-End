import type {PoolClient} from 'pg';
import {authorizeBoundParent,opaqueAttachmentAuthorizationError,type AttachmentBoundParent} from '../authorization/attachment-authorization';
import {readDraftStatus,projectDraft,type DraftRow,type AttachmentDraftStatus} from '../initiation/attachment-draft-repository';
import {assertParentBudget,AttachmentPolicyError,type AttachmentFormat} from '../attachment-policy';
import type {AttachmentStoredObject,AttachmentObjectLocator} from '../storage/attachment-storage.port';
interface Binding {attachment_id:string;uploader_id:string;scope:'COMMUNITY'|'STUDY_GROUP'|'DIRECT_MESSAGE';scope_id:string;community_post_id:string|null;group_text_id:string|null;direct_message_id:string|null;removed_at:Date|null;}
const deny=():never=>{throw opaqueAttachmentAuthorizationError();};
function parent(binding:Binding):AttachmentBoundParent{
 if(binding.scope==='COMMUNITY'&&binding.community_post_id)return {kind:'COMMUNITY',postId:binding.community_post_id};
 if(binding.scope==='STUDY_GROUP'&&binding.group_text_id)return {kind:'STUDY_GROUP',groupId:binding.scope_id,textId:binding.group_text_id};
 if(binding.scope==='DIRECT_MESSAGE'&&binding.direct_message_id)return {kind:'DIRECT_MESSAGE',conversationId:binding.scope_id,messageId:binding.direct_message_id};
 return deny();
}
const uuid=(v:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))deny();};
async function lockBound(client:PoolClient,actor:string|null,id:string):Promise<DraftRow>{
 uuid(id);if(actor!==null)uuid(actor);
 const candidate=(await client.query<Binding>('SELECT * FROM attachment_bindings WHERE attachment_id=$1 AND removed_at IS NULL',[id])).rows[0];
 if(!candidate)return deny();
 const authorized=await authorizeBoundParent(client,actor,parent(candidate));
 const row=(await client.query<DraftRow>("SELECT * FROM attachments WHERE id=$1 AND state='READY' AND first_bound_at IS NOT NULL FOR UPDATE",[id])).rows[0];
 const binding=(await client.query<Binding>('SELECT * FROM attachment_bindings WHERE attachment_id=$1 AND removed_at IS NULL FOR SHARE',[id])).rows[0];
 if(!row||!binding||row.uploader_id!==authorized.authorId||JSON.stringify(parent(binding))!==JSON.stringify(parent(candidate)))return deny();
 try{assertParentBudget(row.scope,authorized.intent.kind==='COMMUNITY'?authorized.intent.postType:null,[{format:row.format,sourceBytes:Number(row.expected_bytes)}]);}catch(error){if(error instanceof AttachmentPolicyError)return deny();throw error;}
 return row;
}
/** Fresh exact-parent admission only. Caller owns the transaction, refreshes session
 * at HTTP admission, then releases SQL locks before bounded provider transfer.
 */
export async function selectAttachmentMetadata(client:PoolClient,actor:string|null,id:string):Promise<AttachmentDraftStatus>{
 uuid(id);const binding=(await client.query('SELECT 1 FROM attachment_bindings WHERE attachment_id=$1',[id])).rowCount;
 if(binding)return projectDraft(await lockBound(client,actor,id));
 if(!actor)return deny();return readDraftStatus(client,actor,id);
}
export async function admitAttachmentRead(client:PoolClient,actor:string|null,id:string,variant:'normalized'|'thumbnail'):Promise<{format:AttachmentFormat;object:AttachmentStoredObject}>{
 if(!['normalized','thumbnail'].includes(variant))return deny();
 const row=await lockBound(client,actor,id);if(row.format==='TEXT'&&variant==='thumbnail')return deny();
 // The selected derivative identity is write-once; never infer newest by timestamp.
 const column=variant==='normalized'?'normalized_object_id':'thumbnail_object_id';
 const object=(await client.query<{id:string;attachment_id:string;attempt_id:string;variant:AttachmentObjectLocator['kind'];sha256:string;byte_count:string;etag:string}>(`SELECT o.* FROM attachment_objects o JOIN attachments a ON a.id=o.attachment_id AND a.${column}=o.id WHERE a.id=$1 AND o.variant=$2 AND o.status='WRITTEN' AND NOT o.put_uncertain AND o.put_settled_at IS NOT NULL FOR SHARE OF o`,[id,variant])).rows[0];
 if(!object||!object.etag)return deny();
 return {format:row.format,object:{locator:{attachmentId:object.attachment_id,attemptId:object.attempt_id,objectId:object.id,kind:object.variant},sha256:object.sha256,sizeBytes:Number(object.byte_count),version:object.etag}};
}
