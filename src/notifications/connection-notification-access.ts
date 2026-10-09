import type { NotificationActorProjection,NotificationRecord } from './notification.contracts';
import type { NotificationRepository } from './notification.repository';
import { toNotificationResponse,type NotificationResponse } from './notification.projection';

export const CONNECTION_NOTIFICATION_ACCESS='CONNECTION_NOTIFICATION_ACCESS';
export class CurrentConnectionAccessChangedError extends Error {
  constructor(){super('Current connection access changed during resolution');}
}

export interface ConnectionNotificationAccess {
  resolve(record:NotificationRecord,channel?:'IN_APP'|'SSE'):Promise<NotificationActorProjection|null>;
  countUnread(userId:string,repository:NotificationRepository):Promise<number>;
}

export function isConnectionNotification(record:NotificationRecord):boolean {
  return record.notificationType==='BUDDY_REQUEST' || record.notificationType==='BUDDY_CONNECTED';
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
  if(!isConnectionNotification(record)) return {response,available:true};
  let actor:NotificationActorProjection|null=null;
  try {actor=access?await access.resolve(record,channel):null;}
  catch(error) {if(!(error instanceof CurrentConnectionAccessChangedError)) throw error;}
  return {available:Boolean(actor),response:{...response,
    actor:actor??{kind:'DELETED',label:'Deleted member'},
    target:actor?{kind:'EXCHANGE_CONNECTION',path:'/exchange/connections'}:null,variables:{}}};
}
