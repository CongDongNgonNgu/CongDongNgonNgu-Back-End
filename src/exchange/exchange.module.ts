import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { NotificationModule } from '../notifications/notification.module';
import { NoopExchangeConnectionEventSink,EXCHANGE_CONNECTION_EVENT_SINK } from './exchange-connection.events';
import { ExchangeController } from './exchange.controller';
import { ExchangeService } from './exchange.service';
import { ExchangePersistenceModule } from './exchange-persistence.module';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { MemoryConnectionOutbox } from './memory-connection-outbox';
import { PostgresConnectionOutbox } from './postgres-connection-outbox';
import { ConnectionNotificationWorker } from './connection-notification-worker';
import { NOTIFICATION_REPOSITORY,type NotificationRepository } from '../notifications/notification.repository';
import { NotificationRealtimeService } from '../notifications/notification-realtime.service';
import { CONNECTION_NOTIFICATION_ACCESS,type ConnectionNotificationAccess } from '../notifications/connection-notification-access';

@Module({imports:[AuthModule,IdentityModule,ProfileModule,NotificationModule,ExchangePersistenceModule],
  controllers:[ExchangeController],providers:[ExchangeService,
    // Persistence owns request/connected intent capture; the HTTP post-commit
    // seam must not duplicate delivery or fail a committed domain action.
    {provide:EXCHANGE_CONNECTION_EVENT_SINK,useClass:NoopExchangeConnectionEventSink},
    {provide:ConnectionNotificationWorker,inject:[ConfigService,MemoryConnectionOutbox,NOTIFICATION_REPOSITORY,
      CONNECTION_NOTIFICATION_ACCESS,NotificationRealtimeService],
      useFactory:(config:ConfigService,memory:MemoryConnectionOutbox,notifications:NotificationRepository,
        access:ConnectionNotificationAccess,realtime:NotificationRealtimeService)=>{
        if(config.get<{persistence:string}>('auth')?.persistence==='memory') return new ConnectionNotificationWorker(memory,notifications,access,realtime);
        const connectionString=config.get<string>('database.url');
        if(!connectionString) throw new Error('DATABASE_URL is required for connection notification delivery');
        const pool=new Pool({connectionString});
        return new ConnectionNotificationWorker(new PostgresConnectionOutbox(pool),notifications,access,realtime,pool);
      }},
  ],exports:[ExchangePersistenceModule,ExchangeService,ConnectionNotificationWorker]})
export class ExchangeModule {}
