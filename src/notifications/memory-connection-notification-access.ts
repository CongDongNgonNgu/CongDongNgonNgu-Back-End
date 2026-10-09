import type { IdentityRepository } from '../identity/identity.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import type { ExchangePreferenceRepository } from '../exchange/exchange.repository';
import type { InMemoryExchangeConnectionRepository } from '../exchange/exchange-connection.repository';
import type { NotificationPreferenceService } from './notification-preference.service';
import type { NotificationActorProjection,NotificationRecord } from './notification.contracts';
import type { NotificationRepository } from './notification.repository';
import { countProjectedUnread,isConnectionNotification,CurrentConnectionAccessChangedError,type ConnectionNotificationAccess } from './connection-notification-access';

export class MemoryConnectionNotificationAccess implements ConnectionNotificationAccess {
  get revisionFingerprint():string {return this.revisions().join(':');}
  constructor(private readonly identities:IdentityRepository,private readonly profiles:ProfileRepository,
    private readonly preferences:ExchangePreferenceRepository,private readonly connections:InMemoryExchangeConnectionRepository,
    private readonly notificationPreferences:NotificationPreferenceService) {}

  async resolve(record:NotificationRecord,channel:'IN_APP'|'SSE'='IN_APP'):Promise<NotificationActorProjection|null> {
    if(!isConnectionNotification(record) || record.target?.kind!=='EXCHANGE_CONNECTION' || !record.target.id) return null;
    const revisions=this.revisions();
    if(revisions.some(version=>version===undefined)) return null;
    const relationship=await this.connections.findRelationshipById(record.recipientUserId,record.target.id);
    if(!relationship) return null;
    const actor=relationship.participantAId===record.recipientUserId?relationship.participantBId:relationship.participantAId;
    if(record.notificationType==='BUDDY_REQUEST'
      ? relationship.status!=='PENDING' || relationship.requesterId!==actor
      : relationship.status!=='CONNECTED' || relationship.requesterId!==record.recipientUserId) return null;
    for(const id of [actor,record.recipientUserId]) {
      const preference=await this.preferences.findPreferences(id);
      if(!preference.exchangeOptIn || !preference.offeredLanguageCodes.length || !preference.wantedLanguageCodes.length) return null;
      const profile=await this.profiles.findProfile(id);
      const codes=[...new Set([...preference.offeredLanguageCodes,...preference.wantedLanguageCodes])];
      if((await this.profiles.findActiveByCodes(codes)).length!==codes.length) return null;
      if(!preference.offeredLanguageCodes.every(code=>profile.languages.some(language=>language.language.code===code
        && language.visibility==='PUBLIC' && (language.roles.includes('native')||language.roles.includes('known'))))) return null;
      if(!preference.wantedLanguageCodes.every(code=>profile.languages.some(language=>language.language.code===code
        && language.visibility==='PUBLIC' && language.roles.includes('learning')))) return null;
    }
    if(!await this.notificationPreferences.isChannelEnabled(record.recipientUserId,
      {category:'EXCHANGE',channel:'IN_APP',notificationType:record.notificationType})) return null;
    if(channel==='SSE' && !await this.notificationPreferences.isChannelEnabled(record.recipientUserId,
      {category:'EXCHANGE',channel:'SSE',notificationType:record.notificationType})) return null;
    // Recheck mutable account and pair boundaries after the awaited lookups.
    const users=await Promise.all([actor,record.recipientUserId].map(id=>this.identities.findUserById(id)));
    if(users.some(user=>!user || user.status!=='ACTIVE' || !user.emailVerifiedAt)) return null;
    const current=await this.connections.findRelationshipById(record.recipientUserId,record.target.id);
    if(!current || current.status!==relationship.status || current.requesterId!==relationship.requesterId) return null;
    if(this.revisions().some((version,index)=>version!==revisions[index])) throw new CurrentConnectionAccessChangedError();
    return {kind:'USER',displayName:users[0]!.displayName,profilePath:`/profiles/${actor}`};
  }

  private revisions() {
    return [this.identities.revision,this.profiles.revision,this.preferences.revision,
      this.connections.revision,this.notificationPreferences.revision];
  }

  countUnread(userId:string,repository:NotificationRepository):Promise<number> {
    return countProjectedUnread(userId,repository,this);
  }
}
