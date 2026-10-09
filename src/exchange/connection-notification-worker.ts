import type { Pool } from 'pg';
import type { OnModuleInit,OnModuleDestroy } from '@nestjs/common';
import { createNotificationRecord,type NotificationRepository } from '../notifications/notification.repository';
import type { NotificationRecord } from '../notifications/notification.contracts';
import type { NotificationRealtimeService } from '../notifications/notification-realtime.service';
import type { ConnectionNotificationAccess } from '../notifications/connection-notification-access';
import { MemoryConnectionOutbox } from './memory-connection-outbox';
import { PostgresConnectionOutbox } from './postgres-connection-outbox';
import { PostgresNotificationRepository } from '../notifications/postgres-notification.repository';
import { connectionNotificationIntent,materializeConnectionNotification } from './connection-notification-materializer';
import { MemoryConnectionNotificationAccess } from '../notifications/memory-connection-notification-access';
import { CurrentConnectionAccessChangedError } from '../notifications/connection-notification-access';

interface BatchResult {processed:number;failed:number;}

export class ConnectionNotificationWorker implements OnModuleInit,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<BatchResult>;
  private stopped=false;
  constructor(private readonly queue:MemoryConnectionOutbox|PostgresConnectionOutbox,
    private readonly notifications:NotificationRepository,private readonly access:ConnectionNotificationAccess,
    private readonly realtime:Pick<NotificationRealtimeService,'publish'>,private readonly ownedPool?:Pool) {}
  runOnce():Promise<BatchResult> {
    if(this.stopped) return Promise.resolve({processed:0,failed:0});
    if(this.running) return this.running;
    const batch=this.drain();
    this.running=batch;
    void batch.then(()=>{if(this.running===batch)this.running=undefined;},()=>{if(this.running===batch)this.running=undefined;});
    return batch;
  }

  onModuleInit():void {
    const tick=()=>{void this.runOnce().then(result=>{
      if(result.failed) console.warn('Connection notification batch retained failed intents for retry');
    }).catch(()=>console.warn('Connection notification queue is temporarily unavailable'));};
    this.timer=setInterval(tick,1000);this.timer.unref?.();tick();
  }

  async onModuleDestroy():Promise<void> {
    this.stopped=true;if(this.timer) clearInterval(this.timer);
    await this.running?.catch(()=>undefined);await this.ownedPool?.end();
  }

  private async drain():Promise<BatchResult> {
    const batch=await this.queue.lease(20);const result={processed:0,failed:0};
    for(const row of batch) {
      let created:NotificationRecord|undefined;
      try {
        if(this.queue instanceof PostgresConnectionOutbox) {
          if(!(this.notifications instanceof PostgresNotificationRepository)) throw new Error('Postgres intent worker requires transactional notification persistence');
          const notifications=this.notifications;
          await this.queue.process(row,(client,current)=>materializeConnectionNotification(client,current,notifications,record=>{created=record;}));
        } else {
          await this.queue.process(row,async current=>{
            if(!(this.access instanceof MemoryConnectionNotificationAccess)) throw new Error('Memory intent worker requires versioned current access');
            const intent=connectionNotificationIntent(current);
            const revision=this.access.revisionFingerprint;
            const actor=await this.access.resolve(createNotificationRecord(intent,current.id));
            if(this.access.revisionFingerprint!==revision) throw new CurrentConnectionAccessChangedError();
            if(!actor) return 'SUPPRESSED';
            const claim=await this.notifications.claimIntent(intent,current.occurredAt);
            if(claim.outcome==='CONFLICT') throw new Error('Connection notification idempotency conflict');
            if(claim.outcome==='CREATED') created=claim.record;
            return 'DELIVERED';
          });
        }
        result.processed++;
      } catch {result.failed++;continue;}
      // Hint delivery is after the outbox/notification transaction commits.
      // Canonical REST/replay remains recoverable if this local hint fails.
      if(created) {
        try{this.realtime.publish(created);}catch{console.warn('Connection notification live hint was unavailable');}
      }
    }
    return result;
  }
}
