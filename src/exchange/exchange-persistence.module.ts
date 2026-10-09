import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { EXCHANGE_PREFERENCE_REPOSITORY,InMemoryExchangePreferenceRepository } from './exchange.repository';
import { EXCHANGE_CONNECTION_REPOSITORY,InMemoryExchangeConnectionRepository } from './exchange-connection.repository';
import { EXCHANGE_SAFETY_GATE,type ExchangeSafetyRepository } from './exchange-safety.types';
import { InMemoryExchangeSafetyRepository } from './exchange-safety.repository';
import { PostgresExchangeSafetyRepository } from './postgres-exchange-safety.repository';
import { PostgresExchangePreferenceRepository } from './postgres-exchange.repository';
import { PostgresExchangeConnectionRepository } from './postgres-exchange-connection.repository';
import { ConnectionCursorCodec } from './connection-cursor-codec';
import { EXCHANGE_ACTION_LIMITER,MemoryExchangeActionLimiter,PostgresExchangeActionLimiter } from './exchange-action-limiter';
import { MemoryConnectionOutbox } from './memory-connection-outbox';

interface ExchangePersistenceConfig {persistence:'postgres'|'memory';accessSecret?:string;}
function postgresPool(config:ConfigService):Pool {
  const connectionString=config.get<string>('database.url');
  if(!connectionString) throw new Error('DATABASE_URL is required for Exchange persistence');
  return new Pool({connectionString});
}

// Domain and notification readers share these exact memory instances.
// Imports neither ExchangeService nor NotificationModule.
@Module({providers:[
  MemoryConnectionOutbox,
  {provide:EXCHANGE_ACTION_LIMITER,inject:[ConfigService],useFactory:(config:ConfigService)=>
    config.get<ExchangePersistenceConfig>('auth')?.persistence==='memory'
      ?new MemoryExchangeActionLimiter():new PostgresExchangeActionLimiter(postgresPool(config))},
  {provide:EXCHANGE_SAFETY_GATE,inject:[ConfigService],useFactory:(config:ConfigService)=>
    config.get<ExchangePersistenceConfig>('auth')?.persistence==='memory'
      ?new InMemoryExchangeSafetyRepository():new PostgresExchangeSafetyRepository(postgresPool(config))},
  {provide:EXCHANGE_PREFERENCE_REPOSITORY,inject:[ConfigService],useFactory:(config:ConfigService)=>
    config.get<ExchangePersistenceConfig>('auth')?.persistence==='memory'
      ?new InMemoryExchangePreferenceRepository():new PostgresExchangePreferenceRepository(postgresPool(config))},
  {provide:EXCHANGE_CONNECTION_REPOSITORY,inject:[ConfigService,EXCHANGE_SAFETY_GATE,MemoryConnectionOutbox],
    useFactory:(config:ConfigService,safety:ExchangeSafetyRepository,outbox:MemoryConnectionOutbox)=>{
      const auth=config.get<ExchangePersistenceConfig>('auth');
      if(!auth?.accessSecret) throw new Error('Auth access secret is required for connection cursors');
      const cursors=new ConnectionCursorCodec(auth.accessSecret);
      return auth.persistence==='memory'?new InMemoryExchangeConnectionRepository(safety,cursors,Date.now,outbox)
        :new PostgresExchangeConnectionRepository(postgresPool(config),safety,cursors);
    }},
],exports:[EXCHANGE_ACTION_LIMITER,EXCHANGE_SAFETY_GATE,EXCHANGE_PREFERENCE_REPOSITORY,EXCHANGE_CONNECTION_REPOSITORY,MemoryConnectionOutbox]})
export class ExchangePersistenceModule {}
