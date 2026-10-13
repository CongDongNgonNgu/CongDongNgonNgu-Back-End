import type { NotificationActorProjection,NotificationRecord } from './notification.contracts';
import type { NotificationRepository } from './notification.repository';
import { toNotificationResponse,type NotificationResponse } from './notification.projection';

export const CONNECTION_NOTIFICATION_ACCESS='CONNECTION_NOTIFICATION_ACCESS';
export class CurrentConnectionAccessChangedError extends Error {
  constructor(){super('Current connection access changed during resolution');}
}

export interface ConnectionNotificationAccess {
  resolveCommunity?(record:NotificationRecord,channel?:'IN_APP'|'SSE'):Promise<{actor:NotificationActorProjection;parentPostId:string}|null>;
  resolve(record:NotificationRecord,channel?:'IN_APP'|'SSE'):Promise<NotificationActorProjection|null>;
  countUnread(userId:string,repository:NotificationRepository):Promise<number>;
}

export function isCommunityNotification(record:NotificationRecord):boolean {
  return ['COMMENT_REPLY','ANSWER_ACCEPTED','CORRECTION_ACCEPTED'].includes(record.notificationType);
}

export function isConnectionNotification(record:NotificationRecord):boolean {
  // Includes communication notices whose lifetime depends on this current pair.
  return record.notificationType==='BUDDY_REQUEST' || record.notificationType==='BUDDY_CONNECTED'
    || record.notificationType==='DIRECT_MESSAGE';
}

export async function countCurrentUnread(userId:string,repository:NotificationRepository,access?:ConnectionNotificationAccess):Promise<number> {
  if(access) return access.countUnread(userId,repository);
  return countProjectedUnread(userId,repository);
}

// Memory adapter and fail-closed direct-construction fallback. PostgreSQL uses
// one eligibility-filtered count query instead of scanning notification history.
export async function countProjectedUnread(userId:string,repository:NotificationRepository,access?:ConnectionNotificationAccess):Promise<number> {
  let before;let count=0;
  for(;;) {
    const page=await repository.listForUser(userId,{status:'UNREAD',limit:50,before});
    const projected=await Promise.all(page.items.map(({record})=>projectCurrentNotification(record,false,null,access)));
    count+=projected.filter(item=>item.available).length;
    const last=page.items.at(-1);
    if(!page.hasMore || !last) return count;
    before={id:last.record.id,createdAt:new Date(last.record.createdAt)};
  }
}

export async function projectCurrentNotification(
  record:NotificationRecord,read:boolean,readAt:string|null,access?:ConnectionNotificationAccess,channel:'IN_APP'|'SSE'='IN_APP',
):Promise<{response:NotificationResponse;available:boolean}> {
  const response=toNotificationResponse(record,read,readAt);
  if(isCommunityNotification(record)) {
    const current=await access?.resolveCommunity?.(record,channel);
    const available=Boolean(current && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(current.parentPostId));
    return {available,response:{...response,actor:available?current!.actor:{kind:'DELETED',label:'Deleted member'},
      target:available?{kind:'COMMUNITY_POST',path:`/community/posts/${current!.parentPostId}`}:null,variables:{}}};
  }
  if(!isConnectionNotification(record)) return {response,available:true};
  let actor:NotificationActorProjection|null=null;
  try {actor=access?await access.resolve(record,channel):null;}
  catch(error) {if(!(error instanceof CurrentConnectionAccessChangedError)) throw error;}
  if(record.notificationType==='DIRECT_MESSAGE') {
    const id=record.target?.id;
    const available=Boolean(actor && record.target?.kind==='DIRECT_CONVERSATION' && id
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id));
    return {available,response:{...response,
      actor:available?{kind:'SYSTEM',label:'System'}:{kind:'DELETED',label:'Deleted member'},
      target:available?{kind:'DIRECT_CONVERSATION',path:`/exchange/conversations/${id}`}:null,variables:{}}};
  }
  return {available:Boolean(actor),response:{...response,
    actor:actor??{kind:'DELETED',label:'Deleted member'},
    target:actor?{kind:'EXCHANGE_CONNECTION',path:'/exchange/connections'}:null,variables:{}}};
}
