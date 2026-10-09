import { describe,expect,it,jest } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryExchangePreferenceRepository,defaultExchangePreferences } from '../exchange/exchange.repository';
import { InMemoryExchangeConnectionRepository } from '../exchange/exchange-connection.repository';
import { InMemoryExchangeSafetyRepository } from '../exchange/exchange-safety.repository';
import { InMemoryNotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationPreferenceService } from './notification-preference.service';
import { MemoryConnectionNotificationAccess } from './memory-connection-notification-access';
import { createNotificationDomainEvent } from './notification-event-integration';
import { createNotificationIntent } from './notification.contracts';
import { InMemoryNotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';

describe('shared memory current connection notice access',()=>{
  it.each(['BLOCK','REMOVE','OPT_OUT','DISABLE','PRIVATE_LANGUAGE','INACTIVE_LANGUAGE','IN_APP_OFF','SSE_OFF','DISCOVERY_OFF','NO_CONTACT',
    'MID_OPT_OUT','MID_PRIVATE_LANGUAGE','MID_NOTIFICATION_PREF'] as const)
    ('uses authoritative shared stores for %s',async reason=>{
      const identities=new InMemoryIdentityRepository();const profiles=new InMemoryProfileRepository();
      const preferences=new InMemoryExchangePreferenceRepository();const safety=new InMemoryExchangeSafetyRepository();
      const connections=new InMemoryExchangeConnectionRepository(safety);
      const notificationPreferences=new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());
      const users=[];
      for(const displayName of ['Requester','Recipient']) {
        const user=await identities.createUser({email:displayName+'@phase26.invalid',displayName,passwordHash:null,status:'ACTIVE',emailVerifiedAt:new Date()});
        users.push(user);
        await profiles.replaceProfile(user.id,{languages:[{languageCode:'en',roles:['known','learning'],declaredProficiency:'B1',
          isPrimaryLearningTarget:true,visibility:'PUBLIC'}],goals:[],skills:[],interests:[],timezone:null,availability:[]});
        await preferences.savePreferences(user.id,{...defaultExchangePreferences(user.id),exchangeOptIn:true,discoverable:true,
          offeredLanguageCodes:['en'],wantedLanguageCodes:['en']});
      }
      const [a,b]=users;const request=await connections.requestConnection(a.id,b.id);
      const event=createNotificationDomainEvent({eventId:request.record!.id,eventType:'exchange.connection.requested',aggregateType:'EXCHANGE_CONNECTION',
        aggregateId:request.record!.id,actor:{kind:'USER',userId:a.id},recipientUserId:b.id,occurredAt:request.record!.createdAt,
        idempotencyKey:'synthetic-shared-memory-request',target:{kind:'EXCHANGE_CONNECTION',id:request.record!.id,path:'/exchange'},variables:{}});
      const notifications=new InMemoryNotificationRepository();const claim=await notifications.claimIntent(createNotificationIntent({event,
        notificationType:'BUDDY_REQUEST',category:'EXCHANGE',priority:'NORMAL',actor:{kind:'USER',displayName:'Stale actor',profilePath:`/profiles/${a.id}`},
        retention:{mode:'UNTIL_READ',maxDays:180}}));
      if(claim.outcome!=='CREATED') throw new Error('Synthetic fixture failure');
      const access=new MemoryConnectionNotificationAccess(identities,profiles,preferences,connections,notificationPreferences);
      const service=new NotificationService(notifications,undefined,undefined,access);
      expect((await service.list(b.id)).items[0].actor).toMatchObject({displayName:'Requester'});
      if(reason.startsWith('MID_')) {
        let release!:()=>void;let observe!:()=>void;
        const held=new Promise<void>(resolve=>{release=resolve;});const observed=new Promise<void>(resolve=>{observe=resolve;});
        const original=identities.findUserById.bind(identities);let gated=false;
        const spy=jest.spyOn(identities,'findUserById').mockImplementation(async id=>{
          if(!gated){gated=true;observe();await held;}return original(id);
        });
        const pending=access.resolve(claim.record);await observed;
        if(reason==='MID_OPT_OUT') await preferences.savePreferences(a.id,{...await preferences.findPreferences(a.id),exchangeOptIn:false});
        if(reason==='MID_PRIVATE_LANGUAGE') {
          const profile=await profiles.findProfile(a.id);
          await profiles.replaceProfile(a.id,{...profile,languages:[{languageCode:'en',roles:['known','learning'],declaredProficiency:'B1',isPrimaryLearningTarget:true,visibility:'PRIVATE'}]});
        }
        if(reason==='MID_NOTIFICATION_PREF') await notificationPreferences.update(b.id,[{category:'EXCHANGE',channel:'IN_APP',enabled:false}]);
        release();await expect(pending).rejects.toThrow('Current connection access changed during resolution');spy.mockRestore();
      }
      if(reason==='BLOCK') await safety.blockUser(b.id,a.id);
      if(reason==='REMOVE') await connections.cancelConnection(a.id,b.id);
      if(reason==='DISABLE') await identities.updateUser(a.id,{status:'DISABLED'});
      if(reason==='PRIVATE_LANGUAGE') {
        const profile=await profiles.findProfile(a.id);
        await profiles.replaceProfile(a.id,{...profile,languages:[{languageCode:'en',roles:['known','learning'],declaredProficiency:'B1',isPrimaryLearningTarget:true,visibility:'PRIVATE'}]});
      }
      if(reason==='INACTIVE_LANGUAGE') await profiles.setActive('en',false);
      if(reason==='IN_APP_OFF'||reason==='SSE_OFF') await notificationPreferences.update(b.id,
        [{category:'EXCHANGE',channel:reason==='SSE_OFF'?'SSE':'IN_APP',enabled:false}]);
      if(reason==='OPT_OUT'||reason==='DISCOVERY_OFF'||reason==='NO_CONTACT') await preferences.savePreferences(a.id,
        {...await preferences.findPreferences(a.id),exchangeOptIn:reason!=='OPT_OUT',discoverable:reason!=='DISCOVERY_OFF',contactPermission:'NO_CONTACT'});
      const visible=['SSE_OFF','DISCOVERY_OFF','NO_CONTACT'].includes(reason);
      expect((await service.list(b.id)).items[0].actor.kind).toBe(visible?'USER':'DELETED');
      expect(await service.unreadCount(b.id)).toEqual({unreadCount:visible?1:0});
      expect(Boolean(await access.resolve(claim.record,'SSE'))).toBe(visible && reason!=='SSE_OFF');
    });
});
