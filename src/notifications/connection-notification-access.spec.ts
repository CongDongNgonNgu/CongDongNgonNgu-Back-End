import { describe,expect,it } from '@jest/globals';
import { createNotificationIntent } from './notification.contracts';
import { createNotificationDomainEvent } from './notification-event-integration';
import { createNotificationRecord,InMemoryNotificationRepository } from './notification.repository';
import { projectCurrentNotification,type ConnectionNotificationAccess } from './connection-notification-access';
import { NotificationService } from './notification.service';
import { NotificationRealtimeService,type NotificationRealtimeEvent } from './notification-realtime.service';

const OWNER='00000000-0000-4000-8000-000000000001';const ACTOR='00000000-0000-4000-8000-000000000002';
const CONNECTION='00000000-0000-4000-8000-000000000010';
const event=createNotificationDomainEvent({eventId:CONNECTION,eventType:'exchange.connection.requested',
  aggregateType:'EXCHANGE_CONNECTION',aggregateId:CONNECTION,actor:{kind:'USER',userId:ACTOR},recipientUserId:OWNER,
  occurredAt:'2026-10-09T00:00:00.000Z',idempotencyKey:'synthetic-private-request',
  target:{kind:'EXCHANGE_CONNECTION',id:CONNECTION,path:'/exchange'},variables:{title:'Stale private title'}});
const record=createNotificationRecord(createNotificationIntent({event,notificationType:'BUDDY_REQUEST',category:'EXCHANGE',
  priority:'NORMAL',actor:{kind:'USER',displayName:'Stale name',profilePath:`/profiles/${ACTOR}`},retention:{mode:'UNTIL_READ',maxDays:180}}));

describe('current connection notification projection',()=>{
  it('fails closed without an access reader and discards all saved private snapshots',async()=>{
    expect(await projectCurrentNotification(record,false,null)).toMatchObject({available:false,
      response:{actor:{kind:'DELETED',label:'Deleted member'},target:null,variables:{}}});
  });
  it('resolves only current actor and a fixed connection route',async()=>{
    const access:ConnectionNotificationAccess={resolve:async()=>({kind:'USER',displayName:'Current name',profilePath:`/profiles/${ACTOR}`}),
      countUnread:async(user,repository)=>repository.countUnread(user)};
    expect(await projectCurrentNotification(record,false,null,access)).toMatchObject({available:true,
      response:{actor:{displayName:'Current name'},target:{path:'/exchange/connections'},variables:{}}});
  });
  it('redacts a previously available notice after access is revoked',async()=>{
    let allowed=true;
    const access:ConnectionNotificationAccess={resolve:async()=>allowed?{kind:'USER',displayName:'Current name',profilePath:null}:null,
      countUnread:async()=>0};
    expect((await projectCurrentNotification(record,false,null,access)).available).toBe(true);
    allowed=false;
    expect((await projectCurrentNotification(record,false,null,access)).response).toMatchObject({actor:{kind:'DELETED'},target:null,variables:{}});
  });
  it('REST list and all count responses use current access instead of saved snapshots',async()=>{
    const repository=new InMemoryNotificationRepository();
    const claim=await repository.claimIntent(createNotificationIntent({event,notificationType:'BUDDY_REQUEST',category:'EXCHANGE',
      priority:'NORMAL',actor:{kind:'USER',displayName:'Stale name',profilePath:`/profiles/${ACTOR}`},retention:{mode:'UNTIL_READ',maxDays:180}}));
    if(claim.outcome!=='CREATED') throw new Error('Synthetic notification fixture failed');
    const access:ConnectionNotificationAccess={resolve:async()=>null,countUnread:async()=>0};
    const service=new NotificationService(repository,undefined,undefined,access);
    const page=await service.list(OWNER);
    expect(page.items[0]).toMatchObject({actor:{kind:'DELETED'},target:null,variables:{}});
    expect(page.unreadCount).toBe(0);expect(await service.unreadCount(OWNER)).toEqual({unreadCount:0});
    expect(await service.markManyRead(OWNER,[claim.record.id])).toMatchObject({unreadCount:0});
  });
  it('replay and live delivery recheck access and never emit saved private content after revocation',async()=>{
    const repository=new InMemoryNotificationRepository();
    const first=await repository.claimIntent(createNotificationIntent({event,notificationType:'BUDDY_REQUEST',category:'EXCHANGE',
      priority:'NORMAL',actor:{kind:'USER',displayName:'Stale name',profilePath:`/profiles/${ACTOR}`},retention:{mode:'UNTIL_READ',maxDays:180}}));
    const laterEvent={...event,eventId:'00000000-0000-4000-8000-000000000011',occurredAt:'2026-10-09T00:00:01.000Z'};
    const second=await repository.claimIntent(createNotificationIntent({event:laterEvent,notificationType:'BUDDY_REQUEST',category:'EXCHANGE',
      priority:'NORMAL',actor:{kind:'USER',displayName:'Another stale name',profilePath:`/profiles/${ACTOR}`},retention:{mode:'UNTIL_READ',maxDays:180}}));
    if(first.outcome!=='CREATED'||second.outcome!=='CREATED') throw new Error('Synthetic replay fixture failed');
    let allowed=true;
    const access:ConnectionNotificationAccess={resolve:async()=>allowed?{kind:'USER',displayName:'Current actor',profilePath:`/profiles/${ACTOR}`}:null,
      countUnread:async()=>allowed?2:0};
    const realtime=new NotificationRealtimeService(repository,access);
    const events:NotificationRealtimeEvent[]=[];
    const subscription=realtime.stream(OWNER,first.record.id).subscribe(item=>events.push(item));
    await new Promise(resolve=>setImmediate(resolve));
    expect(events.filter(item=>item.type==='notification')).toMatchObject([{id:second.record.id,data:{actor:{displayName:'Current actor'},variables:{}}}]);
    subscription.unsubscribe();allowed=false;
    const revoked:NotificationRealtimeEvent[]=[];
    const again=realtime.stream(OWNER,first.record.id).subscribe(item=>revoked.push(item));
    await new Promise(resolve=>setImmediate(resolve));realtime.publish(first.record);
    await new Promise(resolve=>setImmediate(resolve));
    expect(revoked.filter(item=>item.type==='notification')).toHaveLength(0);again.unsubscribe();
  });

  it('bounds slow current-access live delivery and reports REST fallback on overflow',async()=>{
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const access:ConnectionNotificationAccess={resolve:async()=>{await held;return {kind:'USER',displayName:'Current actor',profilePath:null};},countUnread:async()=>0};
    const repository=new InMemoryNotificationRepository();const realtime=new NotificationRealtimeService(repository,access);
    const events:NotificationRealtimeEvent[]=[];const subscription=realtime.stream(OWNER).subscribe(item=>events.push(item));
    for(let index=0;index<103;index++) realtime.publish({...record,id:`00000000-0000-4000-8000-${index.toString().padStart(12,'0')}`});
    release();await new Promise(resolve=>setImmediate(resolve));
    expect(events.filter(item=>item.type==='notification')).toHaveLength(1);
    expect(events).toContainEqual({type:'replay-unavailable',data:{reason:'LIVE_QUEUE_OVERFLOW',fallback:'POLL_NOTIFICATIONS',pollPath:'/notifications'}});
    subscription.unsubscribe();
  });
});
