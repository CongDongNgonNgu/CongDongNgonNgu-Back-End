import { describe,expect,it,jest } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryExchangePreferenceRepository,defaultExchangePreferences } from './exchange.repository';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';
import { InMemoryExchangeSafetyRepository } from './exchange-safety.repository';
import { InMemoryNotificationPreferenceRepository } from '../notifications/notification-preference.repository';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import { MemoryConnectionNotificationAccess } from '../notifications/memory-connection-notification-access';
import { InMemoryNotificationRepository } from '../notifications/notification.repository';
import { MemoryConnectionOutbox } from './memory-connection-outbox';
import { ConnectionNotificationWorker } from './connection-notification-worker';
import type { NotificationRecord } from '../notifications/notification.contracts';

async function fixture() {
  let clock=0;const identities=new InMemoryIdentityRepository();const profiles=new InMemoryProfileRepository();
  const preferences=new InMemoryExchangePreferenceRepository();const safety=new InMemoryExchangeSafetyRepository();
  const queue=new MemoryConnectionOutbox(()=>clock);const connections=new InMemoryExchangeConnectionRepository(safety,undefined,()=>clock,queue);
  const notifications=new InMemoryNotificationRepository();const notificationPreferences=new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());
  const access=new MemoryConnectionNotificationAccess(identities,profiles,preferences,connections,notificationPreferences);
  const publish=jest.fn<(record:NotificationRecord)=>void>();const worker=new ConnectionNotificationWorker(queue,notifications,access,{publish});
  const users=[];
  for(const displayName of ['Requester','Recipient']) {
    const user=await identities.createUser({email:displayName+'@phase26.invalid',displayName,passwordHash:null,status:'ACTIVE',emailVerifiedAt:new Date()});users.push(user);
    await profiles.replaceProfile(user.id,{languages:[{languageCode:'en',roles:['known','learning'],declaredProficiency:'B1',isPrimaryLearningTarget:true,visibility:'PUBLIC'}],
      goals:[],skills:[],interests:[],timezone:null,availability:[]});
    await preferences.savePreferences(user.id,{...defaultExchangePreferences(user.id),exchangeOptIn:true,discoverable:true,offeredLanguageCodes:['en'],wantedLanguageCodes:['en']});
  }
  return {worker,connections,notifications,safety,queue,publish,access,users,advance:(seconds:number)=>{clock+=seconds*1000;}};
}

describe('connection notification worker',()=>{
  it('delivers requested and accepted notices from committed intents exactly once',async()=>{
    const {worker,connections,notifications,publish,users:[a,b]}=await fixture();
    await connections.requestConnection(a.id,b.id);await connections.requestConnection(a.id,b.id);
    expect(await worker.runOnce()).toEqual({processed:1,failed:0});
    await connections.acceptConnection(b.id,a.id);await connections.acceptConnection(b.id,a.id);
    expect(await worker.runOnce()).toEqual({processed:1,failed:0});
    expect(await worker.runOnce()).toEqual({processed:0,failed:0});expect(publish).toHaveBeenCalledTimes(2);
    expect((await notifications.listForUser(a.id,{limit:20,status:'ALL'})).items[0].record.notificationType).toBe('BUDDY_CONNECTED');
    expect((await notifications.listForUser(b.id,{limit:20,status:'ALL'})).items[0].record.notificationType).toBe('BUDDY_REQUEST');
    for(const [record] of publish.mock.calls) expect(record.actor).toEqual({kind:'DELETED',label:'Deleted member'});
  });
  it('delivery failure never changes committed relationship and retries with backoff',async()=>{
    const {worker,connections,notifications,advance,users:[a,b]}=await fixture();
    const request=await connections.requestConnection(a.id,b.id);
    const original=notifications.claimIntent.bind(notifications);
    jest.spyOn(notifications,'claimIntent').mockRejectedValueOnce(new Error('Synthetic materialization failure')).mockImplementation(original);
    expect(await worker.runOnce()).toEqual({processed:0,failed:1});
    expect((await connections.findRelationship(a.id,b.id))?.id).toBe(request.record!.id);
    expect(await notifications.countUnread(b.id)).toBe(0);expect(await worker.runOnce()).toEqual({processed:0,failed:0});
    advance(5);expect(await worker.runOnce()).toEqual({processed:1,failed:0});expect(await notifications.countUnread(b.id)).toBe(1);
  });
  it('suppresses blocked queued intents without unread state or live publication',async()=>{
    const {worker,connections,notifications,safety,publish,users:[a,b]}=await fixture();
    await connections.requestConnection(a.id,b.id);await safety.blockUser(b.id,a.id);
    expect(await worker.runOnce()).toEqual({processed:1,failed:0});expect(await notifications.countUnread(b.id)).toBe(0);expect(publish).not.toHaveBeenCalled();
  });
  it('serializes overlapping drains while one materialization awaits',async()=>{
    const {worker,connections,notifications,users:[a,b]}=await fixture();
    await connections.requestConnection(a.id,b.id);
    let release!:()=>void;let started!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});const observed=new Promise<void>(resolve=>{started=resolve;});
    const original=notifications.claimIntent.bind(notifications);
    const spy=jest.spyOn(notifications,'claimIntent').mockImplementation(async intent=>{started();await held;return original(intent);});
    const first=worker.runOnce();await observed;const second=worker.runOnce();release();
    expect(await first).toEqual({processed:1,failed:0});expect(await second).toEqual({processed:1,failed:0});expect(spy).toHaveBeenCalledTimes(1);
  });
});
