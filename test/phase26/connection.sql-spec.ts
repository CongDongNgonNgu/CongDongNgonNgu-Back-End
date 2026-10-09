import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectionCursorCodec } from '../../src/exchange/connection-cursor-codec';
import { PostgresExchangeActionLimiter } from '../../src/exchange/exchange-action-limiter';
import { PostgresExchangeConnectionRepository } from '../../src/exchange/postgres-exchange-connection.repository';
import { PostgresExchangeSafetyRepository } from '../../src/exchange/postgres-exchange-safety.repository';
import { PostgresConnectionOutbox,type LeasedConnectionIntent } from '../../src/exchange/postgres-connection-outbox';
import { PostgresNotificationRepository } from '../../src/notifications/postgres-notification.repository';
import { createNotificationIntent } from '../../src/notifications/notification.contracts';
import { createNotificationDomainEvent,mapNotificationEvent } from '../../src/notifications/notification-event-integration';
import { materializeConnectionNotification } from '../../src/exchange/connection-notification-materializer';
import { PostgresConnectionNotificationAccess } from '../../src/notifications/postgres-connection-notification-access';
import { NotificationService } from '../../src/notifications/notification.service';
import { NotificationRealtimeService,type NotificationRealtimeEvent } from '../../src/notifications/notification-realtime.service';
import { ConnectionNotificationWorker } from '../../src/exchange/connection-notification-worker';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 connection PostgreSQL authorization and races', () => {
  const db = new SqlHarness();
  let connections: PostgresExchangeConnectionRepository;
  let safety: PostgresExchangeSafetyRepository;
  beforeAll(async () => {
    await db.open();
    for (const migration of ['0002_language_profile.sql', '0006_language_exchange_preferences.sql',
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql','0029_phase26_exchange_limits.sql',
      '0030_phase26_connection_outbox.sql','0016_phase12_notifications_read_state.sql',
      '0017_phase12_notification_preferences.sql','0031_phase26_connected_notification.sql']) {
      await db.migration(migration);
    }
    safety = new PostgresExchangeSafetyRepository(db.pool);
    connections = new PostgresExchangeConnectionRepository(db.pool, safety,
      new ConnectionCursorCodec('synthetic-phase26-cursor-secret-for-tests'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function pair() {
    const ids = [randomUUID(), randomUUID()];
    await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO NOTHING`);
    for (const id of ids) {
      await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
        VALUES($1,$2,$2,'Synthetic connection actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
      await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable)
        VALUES($1,true,true)`, [id]);
      const language = (await db.pool.query(`SELECT id FROM languages WHERE code='en'`)).rows[0];
      const relation = (await db.pool.query(`INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency)
        VALUES($1,$2,true,true,'B1') RETURNING id`, [id, language.id])).rows[0];
      await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
        VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [id, relation.id]);
    }
    return ids;
  }

  it('rejects unrelated cleanup and preserves the canonical pair and outbox',async()=>{
    const [a,b]=await pair();const [c]=await pair();
    await connections.requestConnection(a,b);
    const before=await connections.findRelationship(a,b);
    const intents=(await db.pool.query('SELECT * FROM exchange_notification_outbox ORDER BY id')).rows;
    for(const action of ['acceptConnection','declineConnection','cancelConnection','disconnect'] as const) {
      expect(await connections[action](c,b)).toEqual({record:null,outcome:'INVALID_ACTION'});
      expect(await connections.findRelationship(a,b)).toEqual(before);
      expect((await db.pool.query('SELECT * FROM exchange_notification_outbox ORDER BY id')).rows).toEqual(intents);
    }
    expect((await connections.declineConnection(a,b)).outcome).toBe('INVALID_ACTION');
    expect((await connections.cancelConnection(b,a)).outcome).toBe('INVALID_ACTION');
    expect((await connections.removeRelationshipForSafety(c,b)).outcome).toBe('NONE');
    expect(await connections.findRelationship(a,b)).toEqual(before);
  });

  function notificationIntent(row:LeasedConnectionIntent) {
    const event=createNotificationDomainEvent({eventId:row.id,
      eventType:row.eventKind==='CONNECTED'?'exchange.connection.connected':'exchange.connection.requested',
      aggregateType:'EXCHANGE_CONNECTION',aggregateId:row.connectionId,actor:{kind:'USER',userId:row.actorId},
      recipientUserId:row.recipientId,occurredAt:row.occurredAt,
      idempotencyKey:`exchange.connection.${row.eventKind.toLowerCase()}:${row.connectionId}:v1`,
      target:{kind:'EXCHANGE_CONNECTION',id:row.connectionId,path:'/exchange/connections'},variables:{}});
    return createNotificationIntent({event,...mapNotificationEvent(event),actor:{kind:'DELETED',label:'Deleted member'}});
  }

  it('PostgreSQL worker retries failed materialization and publishes only after canonical commit',async()=>{
    const [a,b]=await pair();const request=await connections.requestConnection(a,b);
    class FailingOnceNotifications extends PostgresNotificationRepository {
      private fail=true;
      override async claimIntentOnClient(...args:Parameters<PostgresNotificationRepository['claimIntentOnClient']>) {
        if(this.fail){this.fail=false;throw new Error('Synthetic SQL worker materialization failure');}
        return super.claimIntentOnClient(...args);
      }
    }
    const notifications=new FailingOnceNotifications(db.pool);const queue=new PostgresConnectionOutbox(db.pool);
    const projections:Promise<unknown>[]=[];
    const worker=new ConnectionNotificationWorker(queue,notifications,new PostgresConnectionNotificationAccess(db.pool),
      {publish:record=>{projections.push(db.pool.query(`SELECT o.status,n.id FROM exchange_notification_outbox o
        JOIN notifications n ON n.source_aggregate_id=o.connection_id AND n.recipient_user_id=o.recipient_id
        WHERE n.id=$1::uuid`,[record.id]).then(result=>result.rows));}});
    expect(await worker.runOnce()).toEqual({processed:0,failed:1});
    expect((await connections.findRelationship(a,b))?.id).toBe(request.record!.id);expect(projections).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(0);
    await db.pool.query(`UPDATE exchange_notification_outbox SET available_at=clock_timestamp()-interval '1 second'`);
    expect(await worker.runOnce()).toEqual({processed:1,failed:0});
    expect(projections).toHaveLength(1);expect(await projections[0]).toEqual([{status:'DELIVERED',id:expect.any(String)}]);
    expect(await worker.runOnce()).toEqual({processed:0,failed:0});await worker.onModuleDestroy();
  });

  it.each(['BLOCK','REMOVE','OPT_OUT','DISABLE','PRIVATE_LANGUAGE','IN_APP_OFF','DISCOVERY_OFF','NO_CONTACT','SSE_OFF'] as const)
    ('current notification read/count projection reflects %s after materialization',async reason=>{
      const [a,b]=await pair();await connections.requestConnection(a,b);
      const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
      await queue.process((await queue.lease())[0],(client,row)=>materializeConnectionNotification(client,row,notification));
      const access=new PostgresConnectionNotificationAccess(db.pool);
      const service=new NotificationService(notification,undefined,undefined,access);
      const first=await service.list(b);
      expect(first.unreadCount).toBe(1);expect(first.items[0]).toMatchObject({actor:{kind:'USER',displayName:'Synthetic connection actor'},
        target:{path:'/exchange/connections'},variables:{}});
      await db.pool.query(`UPDATE users SET display_name='Current synthetic display name' WHERE id=$1`,[a]);
      expect((await service.list(b)).items[0].actor).toMatchObject({kind:'USER',displayName:'Current synthetic display name'});
      if(reason==='BLOCK') await safety.blockUser(b,a);
      if(reason==='REMOVE') await connections.cancelConnection(a,b);
      if(reason==='OPT_OUT') await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[a]);
      if(reason==='DISABLE') await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`,[a]);
      if(reason==='PRIVATE_LANGUAGE') await db.pool.query(`UPDATE user_languages SET visibility='PRIVATE' WHERE user_id=$1`,[a]);
      if(reason==='IN_APP_OFF') await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled) VALUES($1,'EXCHANGE','IN_APP',false)`,[b]);
      if(reason==='SSE_OFF') await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled) VALUES($1,'EXCHANGE','SSE',false)`,[b]);
      if(reason==='DISCOVERY_OFF') await db.pool.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=$1',[a]);
      if(reason==='NO_CONTACT') await db.pool.query(`UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1`,[a]);
      const visible=reason==='DISCOVERY_OFF'||reason==='NO_CONTACT'||reason==='SSE_OFF';
      const page=await service.list(b);
      expect(page.unreadCount).toBe(visible?1:0);expect(await service.unreadCount(b)).toEqual({unreadCount:visible?1:0});
      expect(page.items[0]).toMatchObject(visible?{actor:{kind:'USER'},target:{path:'/exchange/connections'}}:
        {actor:{kind:'DELETED'},target:null,variables:{}});
      expect((await notification.listForUser(b,{limit:20,status:'ALL'})).items[0].record.actor).toEqual({kind:'DELETED',label:'Deleted member'});
      expect(Boolean(await access.resolve((await notification.listForUser(b,{limit:20,status:'ALL'})).items[0].record,'SSE')))
        .toBe(visible && reason!=='SSE_OFF');
    });

  it.each(['LIVE','REPLAY'] as const)('current PostgreSQL projection suppresses blocked %s delivery',async mode=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    await queue.process((await queue.lease())[0],(client,row)=>materializeConnectionNotification(client,row,notification));
    const record=(await notification.listForUser(b,{limit:20,status:'ALL'})).items[0].record;
    const anchorEvent=createNotificationDomainEvent({eventId:randomUUID(),eventType:'community.comment.created',aggregateType:'COMMUNITY_COMMENT',
      aggregateId:randomUUID(),actor:{kind:'SYSTEM',code:'SYNTHETIC'},recipientUserId:b,occurredAt:'2026-01-01T00:00:00.000Z',
      idempotencyKey:'synthetic-replay-anchor',target:{kind:'SYSTEM',id:randomUUID(),path:'/notifications'},variables:{}});
    const anchor=await notification.claimIntent(createNotificationIntent({event:anchorEvent,notificationType:'COMMENT_REPLY',category:'COMMUNITY',
      priority:'NORMAL',actor:{kind:'SYSTEM',label:'System'},retention:{mode:'DAYS',days:180}}));
    if(anchor.outcome!=='CREATED') throw new Error('Synthetic replay anchor failed');
    await safety.blockUser(b,a);
    const access=new PostgresConnectionNotificationAccess(db.pool);const finished=deferred();
    const realtime=new NotificationRealtimeService(notification,{resolve:async(notice,channel)=>{
      try{return await access.resolve(notice,channel);}finally{finished.resolve();}
    },countUnread:(user,repository)=>access.countUnread(user,repository)});
    const events:NotificationRealtimeEvent[]=[];
    const subscription=realtime.stream(b,mode==='REPLAY'?anchor.record.id:undefined).subscribe(event=>events.push(event));
    try {
      if(mode==='LIVE') realtime.publish(record);
      await finished.promise;await new Promise(resolve=>setImmediate(resolve));
      expect(events.filter(event=>event.type==='notification')).toHaveLength(0);
    } finally {subscription.unsubscribe();}
  });

  it.each(['BLOCK','REMOVE','OPT_OUT','DISABLE','IN_APP_OFF','ACCEPTED_REQUEST'] as const)
    ('outbox materializer suppresses current revocation %s',async reason=>{
      const [a,b]=await pair();await connections.requestConnection(a,b);
      const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
      const leased=(await queue.lease())[0];
      if(reason==='BLOCK') await safety.blockUser(b,a);
      if(reason==='REMOVE') await connections.cancelConnection(a,b);
      if(reason==='OPT_OUT') await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[b]);
      if(reason==='DISABLE') await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`,[a]);
      if(reason==='IN_APP_OFF') await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled) VALUES($1,'EXCHANGE','IN_APP',false)`,[b]);
      if(reason==='ACCEPTED_REQUEST') await connections.acceptConnection(b,a);
      await queue.process(leased,(client,row)=>materializeConnectionNotification(client,row,notification));
      expect((await db.pool.query('SELECT status FROM exchange_notification_outbox WHERE id=$1',[leased.id])).rows[0]).toEqual({status:'SUPPRESSED'});
      expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(0);
    });

  it('outbox materializer creates redacted stable request and connected intents without actor snapshots',async()=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    await queue.process((await queue.lease())[0],(client,row)=>materializeConnectionNotification(client,row,notification));
    await connections.acceptConnection(b,a);
    await queue.process((await queue.lease())[0],(client,row)=>materializeConnectionNotification(client,row,notification));
    const rows=(await db.pool.query('SELECT notification_type,actor,variables,target FROM notifications ORDER BY notification_type')).rows;
    expect(rows.map(row=>row.notification_type)).toEqual(['BUDDY_CONNECTED','BUDDY_REQUEST']);
    for(const row of rows) {
      expect(row.actor).toEqual({kind:'DELETED',label:'Deleted member'});expect(row.variables).toEqual({});
      expect(row.target.path).toBe('/exchange/connections');
    }
  });

  it.each(['EXACT','WRONG_SOURCE_HASH','WRONG_PROFILE','WRONG_RETENTION','WRONG_FINGERPRINT'] as const)
    ('outbox materializer reconciles legacy request only for %s',async variant=>{
    const [a,b]=await pair();const request=await connections.requestConnection(a,b);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    const event=createNotificationDomainEvent({eventId:request.record!.id,eventType:'exchange.connection.requested',
      aggregateType:'EXCHANGE_CONNECTION',aggregateId:request.record!.id,actor:{kind:'USER',userId:a},recipientUserId:b,
      occurredAt:request.record!.createdAt,idempotencyKey:`exchange.connection.requested:${request.record!.id}:v1`,
      target:{kind:'EXCHANGE_CONNECTION',id:request.record!.id,path:'/exchange'},variables:{relationship:'BUDDY_REQUEST'}});
    const legacy=await notification.claimIntent(createNotificationIntent({event,...mapNotificationEvent(event),
      actor:{kind:'USER',displayName:'Synthetic preceding actor',profilePath:`/profiles/${a}`}}));
    expect(legacy.outcome).toBe('CREATED');
    if(variant==='WRONG_SOURCE_HASH') await db.pool.query(`UPDATE notifications SET source_payload_hash=$1`,['0'.repeat(64)]);
    if(variant==='WRONG_PROFILE') await db.pool.query(`UPDATE notifications SET actor=jsonb_set(actor,'{profilePath}',to_jsonb($1::text))`,[`/profiles/${b}`]);
    if(variant==='WRONG_RETENTION') await db.pool.query(`UPDATE notifications SET retention='{"mode":"DAYS","days":180}'::jsonb`);
    if(variant==='WRONG_FINGERPRINT') await db.pool.query(`UPDATE notifications SET intent_fingerprint=$1`,['0'.repeat(64)]);
    const process=queue.process((await queue.lease())[0],(client,row)=>materializeConnectionNotification(client,row,notification));
    if(variant==='EXACT') await process;
    else await expect(process).rejects.toThrow('Connection notification idempotency conflict');
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT status FROM exchange_notification_outbox')).rows)
      .toEqual([{status:variant==='EXACT'?'DELIVERED':'PENDING'}]);
  });

  it('outbox materializer leaves unexpected fingerprint conflicts pending for retry',async()=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    const row=(await queue.lease())[0];
    const base=notificationIntent(row);
    // Match canonical event identity, but supply a conflicting actor snapshot.
    const event=createNotificationDomainEvent({eventId:row.connectionId,eventType:'exchange.connection.requested',
      aggregateType:'EXCHANGE_CONNECTION',aggregateId:row.connectionId,actor:{kind:'USER',userId:a},recipientUserId:b,
      occurredAt:row.occurredAt,idempotencyKey:base.sourceEvent.idempotencyKey,target:base.target,variables:{}});
    await notification.claimIntent(createNotificationIntent({event,...mapNotificationEvent(event),
      actor:{kind:'USER',displayName:'Conflicting synthetic actor',profilePath:`/profiles/${a}`}}));
    await expect(queue.process(row,(client,current)=>materializeConnectionNotification(client,current,notification)))
      .rejects.toThrow('Connection notification idempotency conflict');
    expect((await db.pool.query('SELECT status,lease_token FROM exchange_notification_outbox')).rows).toEqual([{status:'PENDING',lease_token:null}]);
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(1);
  });

  it.each(['BLOCK','REMOVE','NO_CONTACT','DISCOVERY_OFF'] as const)('outbox materializer rechecks connected access for %s',async reason=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);await connections.acceptConnection(b,a);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    const connected=(await queue.lease()).find(row=>row.eventKind==='CONNECTED')!;
    if(reason==='BLOCK') await safety.blockUser(a,b);
    if(reason==='REMOVE') await connections.disconnect(b,a);
    if(reason==='NO_CONTACT') await db.pool.query(`UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1`,[a]);
    if(reason==='DISCOVERY_OFF') await db.pool.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=$1',[a]);
    await queue.process(connected,(client,row)=>materializeConnectionNotification(client,row,notification));
    const available=reason==='NO_CONTACT'||reason==='DISCOVERY_OFF';
    expect((await db.pool.query('SELECT status FROM exchange_notification_outbox WHERE id=$1',[connected.id])).rows[0])
      .toEqual({status:available?'DELIVERED':'SUPPRESSED'});
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(available?1:0);
  });

  it('outbox replicas lease distinct rows and recover an expired lease without stale delivery',async()=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);await connections.acceptConnection(b,a);
    const queues=[new PostgresConnectionOutbox(db.pool),new PostgresConnectionOutbox(db.pool)];
    const batches=await Promise.all(queues.map(queue=>queue.lease(1)));
    const rows=batches.flat();expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.id)).size).toBe(2);
    expect(await queues[0].lease()).toHaveLength(0);
    await db.pool.query(`UPDATE exchange_notification_outbox SET leased_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[rows[0].id]);
    const recovered=(await queues[1].lease())[0];expect(recovered).toMatchObject({id:rows[0].id,attempts:2});
    expect(recovered.leaseToken).not.toBe(rows[0].leaseToken);
    let staleCalled=false;
    await queues[0].process(rows[0],async()=>{staleCalled=true;return 'DELIVERED';});
    expect(staleCalled).toBe(false);
    await queues[1].process(recovered,async()=> 'SUPPRESSED');
    expect((await db.pool.query('SELECT status,lease_token FROM exchange_notification_outbox WHERE id=$1',[recovered.id])).rows[0])
      .toEqual({status:'SUPPRESSED',lease_token:null});
  });

  it('outbox failure rolls back notification/read state and retries the committed domain intent exactly once',async()=>{
    const [a,b]=await pair();const request=await connections.requestConnection(a,b);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    const leased=(await queue.lease())[0];
    await expect(queue.process(leased,async(client,row)=>{
      await notification.claimIntentOnClient(client,notificationIntent(row));throw new Error('Synthetic post-materialization failure');
    })).rejects.toThrow('Synthetic post-materialization failure');
    expect((await connections.findRelationship(a,b))?.id).toBe(request.record!.id);
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT notification_id FROM notification_read_states')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT status,lease_token,available_at>clock_timestamp() AS backed_off FROM exchange_notification_outbox')).rows[0])
      .toEqual({status:'PENDING',lease_token:null,backed_off:true});
    await db.pool.query(`UPDATE exchange_notification_outbox SET available_at=clock_timestamp()-interval '1 second'`);
    const retry=(await queue.lease())[0];
    await queue.process(retry,async(client,row)=>{
      expect(await notification.claimIntentOnClient(client,notificationIntent(row))).toMatchObject({outcome:'CREATED'});
      return 'DELIVERED';
    });
    expect((await db.pool.query('SELECT id FROM notifications')).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT notification_id FROM notification_read_states')).rows).toHaveLength(1);
    expect(await queue.lease()).toHaveLength(0);
  });

  it('outbox connected notification schema retains new rows when rollback is incompatible',async()=>{
    const [a,b]=await pair();await connections.requestConnection(a,b);await connections.acceptConnection(b,a);
    const queue=new PostgresConnectionOutbox(db.pool);const notification=new PostgresNotificationRepository(db.pool);
    const connected=(await queue.lease()).find(row=>row.eventKind==='CONNECTED')!;
    await queue.process(connected,async(client,row)=>{
      expect(await notification.claimIntentOnClient(client,notificationIntent(row))).toMatchObject({outcome:'CREATED',record:{notificationType:'BUDDY_CONNECTED'}});
      return 'DELIVERED';
    });
    await expect(db.migration('0031_phase26_connected_notification.down.sql')).rejects.toMatchObject({code:'23514'});
    expect((await db.pool.query('SELECT notification_type FROM notifications')).rows).toEqual([{notification_type:'BUDDY_CONNECTED'}]);
    expect((await db.pool.query(`SELECT 1 FROM pg_constraint WHERE conname='notifications_type_check'
      AND connamespace=$1::regnamespace`,[db.schema])).rows).toHaveLength(1);
  });

  it.each([false,true])('persists one requested and one connected intent for crossed request=%s',async crossed=>{
    const [a,b]=await pair();
    const request=await connections.requestConnection(a,b);
    await connections.requestConnection(a,b);
    if(crossed) await connections.requestConnection(b,a);
    else await connections.acceptConnection(b,a);
    await connections.acceptConnection(b,a);
    const rows=(await db.pool.query(`SELECT connection_id,event_kind,actor_id,recipient_id,occurred_at
      FROM exchange_notification_outbox ORDER BY event_kind`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({connection_id:request.record!.id,event_kind:'CONNECTED',actor_id:b,recipient_id:a});
    expect(rows[1]).toMatchObject({connection_id:request.record!.id,event_kind:'REQUESTED',actor_id:a,recipient_id:b,
      occurred_at:request.record!.createdAt});
    await connections.disconnect(a,b);
    expect((await db.pool.query('SELECT id FROM exchange_notification_outbox')).rows).toHaveLength(2);
  });

  it('rolls back both the connection and pair cooldown when transactional intent insertion fails',async()=>{
    const [a,b]=await pair();
    await db.pool.query(`ALTER TABLE exchange_notification_outbox ADD CONSTRAINT synthetic_fail CHECK(false)`);
    try {
      await expect(connections.requestConnection(a,b)).rejects.toMatchObject({code:'23514'});
      expect((await db.pool.query('SELECT id FROM language_exchange_connections')).rows).toHaveLength(0);
      expect((await db.pool.query('SELECT actor_id FROM exchange_action_rate_limits')).rows).toHaveLength(0);
      expect((await db.pool.query('SELECT id FROM exchange_notification_outbox')).rows).toHaveLength(0);
    } finally {
      await db.pool.query('ALTER TABLE exchange_notification_outbox DROP CONSTRAINT synthetic_fail');
    }
    await expect(connections.requestConnection(a,b)).resolves.toMatchObject({outcome:'REQUESTED'});
  });

  it('enforces ten hourly request attempts across replicas and commits denied attempts to the daily window',async()=>{
    const [a]=await pair();
    const replicas=[new PostgresExchangeActionLimiter(db.pool),new PostgresExchangeActionLimiter(db.pool)];
    const attempts=await Promise.allSettled(Array.from({length:20},(_,index)=>replicas[index%2].consume(a,'REQUEST')));
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(10);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(10);
    expect((await db.pool.query(`SELECT bucket,hits FROM exchange_action_rate_limits WHERE actor_id=$1 ORDER BY bucket`,[a])).rows)
      .toEqual([{bucket:'REQUEST_DAY',hits:20},{bucket:'REQUEST_HOUR',hits:11}]);
    await db.pool.query(`UPDATE exchange_action_rate_limits SET reset_at=clock_timestamp()-interval '1 second'
      WHERE actor_id=$1 AND bucket='REQUEST_HOUR'`,[a]);
    await expect(new PostgresExchangeActionLimiter(db.pool).consume(a,'REQUEST')).resolves.toBeUndefined();
  });

  it('uses a durable canonical new-pair cooldown without charging duplicate requests',async()=>{
    const [a,b]=await pair();
    const first=await connections.requestConnection(a,b);
    expect(await connections.requestConnection(a,b)).toMatchObject({outcome:'ALREADY_PENDING',record:{id:first.record!.id}});
    await connections.cancelConnection(a,b);
    await expect(connections.requestConnection(b,a)).rejects.toMatchObject({code:'EXCHANGE_RATE_LIMITED'});
    expect((await db.pool.query('SELECT id FROM language_exchange_connections')).rows).toHaveLength(0);
    await db.pool.query(`UPDATE exchange_action_rate_limits SET reset_at=clock_timestamp()-interval '1 second'
      WHERE bucket='PAIR_MINUTE'`);
    expect(await connections.requestConnection(b,a)).toMatchObject({outcome:'REQUESTED'});
  });

  it('samples the rate clock after an observed replica wait crossing window expiry',async()=>{
    const [a]=await pair();
    await db.pool.query(`INSERT INTO exchange_action_rate_limits(actor_id,bucket,hits,reset_at)
      VALUES($1,'REQUEST_HOUR',9,clock_timestamp()+interval '3 seconds')`,[a]);
    const released=deferred();const held=deferred();
    const firstPool=new Pool({connectionString:db.scopedUrl,max:1});
    const name='phase26_rate_wait_'+randomUUID();
    const secondPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:name});
    const gatedPool=new Proxy(firstPool,{get(target,key){
      if(key==='connect') return async()=>{
        const client=await target.connect();return new Proxy(client,{get(connection,property){
          if(property==='query') return async(sql:string,parameters?:unknown[])=>{
            const result=await connection.query(sql,parameters);
            if(sql.includes('INSERT INTO exchange_action_rate_limits') && parameters?.[1]==='REQUEST_HOUR') {
              held.resolve();await released.promise;
            }
            return result;
          };
          const value=Reflect.get(connection,property);return typeof value==='function'?value.bind(connection):value;
        }});
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    let one:Promise<unknown>|undefined;let two:Promise<unknown>|undefined;
    try {
      one=new PostgresExchangeActionLimiter(gatedPool).consume(a,'REQUEST').then(()=> 'ALLOWED',error=>error);
      await held.promise;
      two=new PostgresExchangeActionLimiter(secondPool).consume(a,'REQUEST').then(()=> 'ALLOWED',error=>error);
      await observedLockWait(name);
      const deadline=Date.now()+10000;let expired=false;
      while(Date.now()<deadline) {
        const row=(await db.pool.query(`SELECT reset_at<=clock_timestamp() AS expired
          FROM exchange_action_rate_limits WHERE actor_id=$1 AND bucket='REQUEST_HOUR'`,[a])).rows[0];
        if(row.expired){expired=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(!expired) throw new Error('Rate window did not expire within bounded test wait');
      released.resolve();expect(await one).toBe('ALLOWED');expect(await two).toBe('ALLOWED');
    } finally {
      released.resolve();await Promise.allSettled([one,two]);await firstPool.end();await secondPool.end();
    }
  });

  it('cleans at most one hundred expired counters independently before action locks',async()=>{
    const [a]=await pair();
    await db.pool.query(`INSERT INTO exchange_action_rate_limits(actor_id,bucket,target_key,hits,reset_at)
      SELECT $1,'PAIR_MINUTE',gen_random_uuid()::text,1,clock_timestamp()-interval '1 second'
      FROM generate_series(1,120)`,[a]);
    await new PostgresExchangeActionLimiter(db.pool).consume(a,'REQUEST');
    expect(Number((await db.pool.query(`SELECT count(*) AS total FROM exchange_action_rate_limits
      WHERE bucket='PAIR_MINUTE'`)).rows[0].total)).toBe(20);
  });

  it('denies request when current account was disabled after a caller precheck', async () => {
    const [a,b] = await pair();
    await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [b]);
    await expect(connections.requestConnection(a,b)).rejects.toMatchObject({ code: 'EXCHANGE_PROFILE_UNAVAILABLE' });
    expect((await db.pool.query('SELECT id FROM language_exchange_connections')).rows).toHaveLength(0);
  });

  it('denies accept when current requester opted out after a caller precheck', async () => {
    const [a,b] = await pair();
    await connections.requestConnection(a,b);
    await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[a]);
    await expect(connections.acceptConnection(b,a)).rejects.toMatchObject({ code: 'EXCHANGE_PROFILE_UNAVAILABLE' });
    expect((await db.pool.query('SELECT status FROM language_exchange_connections')).rows[0].status).toBe('PENDING');
  });

  it('denies protected relationship read after target disable committed', async () => {
    const [a,b] = await pair();
    await connections.requestConnection(a,b);
    await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`,[b]);
    await expect(connections.findRelationship(a,b)).rejects.toMatchObject({code:'EXCHANGE_PROFILE_UNAVAILABLE'});
  });

  it('rejects an eligible unrelated accept without changing another pending pair', async () => {
    const [a,b] = await pair(); const [c] = await pair();
    await connections.requestConnection(a,b);
    expect(await connections.acceptConnection(c,b)).toMatchObject({outcome:'INVALID_ACTION',record:null});
    expect((await db.pool.query('SELECT status FROM language_exchange_connections')).rows).toEqual([{status:'PENDING'}]);
  });

  it('denies new requests to undiscoverable targets but permits accepting existing requests', async () => {
    const [a,b] = await pair();
    await connections.requestConnection(a,b);
    await db.pool.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=$1',[a]);
    expect(await connections.acceptConnection(b,a)).toMatchObject({outcome:'ACCEPTED'});
    await connections.disconnect(a,b);
    await expect(connections.requestConnection(b,a)).rejects.toMatchObject({code:'EXCHANGE_PROFILE_UNAVAILABLE'});
  });

  it('lists only actor-owned rows with stable cursor pages and no blocked routing ids', async () => {
    const [a,b] = await pair();
    const [c,d] = await pair();
    await connections.requestConnection(a,b);
    await connections.requestConnection(a,c);
    await connections.requestConnection(d,b);
    const first = await connections.listRelationships(a,{kind:'OUTGOING',limit:1});
    if (!first.nextCursor) throw new Error('Expected another page');
    const second = await connections.listRelationships(a,{kind:'OUTGOING',limit:1,cursor:first.nextCursor});
    const replica = new PostgresExchangeConnectionRepository(db.pool,safety,
      new ConnectionCursorCodec('synthetic-phase26-cursor-secret-for-tests'));
    expect(await replica.listRelationships(a,{kind:'OUTGOING',limit:1,cursor:first.nextCursor})).toEqual(second);
    expect(new Set([...first.items,...second.items].map(item => item.targetUserId))).toEqual(new Set([b,c]));
    expect(second.nextCursor).toBeNull();
    await expect(connections.listRelationships(d,{kind:'OUTGOING',limit:1,cursor:first.nextCursor}))
      .rejects.toMatchObject({code:'EXCHANGE_INVALID_CURSOR'});
    await safety.blockUser(b,a);
    const visible = await connections.listRelationships(a,{kind:'OUTGOING'});
    expect(visible.items.map(item => item.targetUserId)).toEqual([c]);
  });

  it('keeps hidden scan metadata encrypted and reaches an eligible row after an empty page', async () => {
    const [a,b] = await pair();
    const [c] = await pair();
    await connections.requestConnection(a,b);
    const hidden = await connections.requestConnection(a,c);
    await db.pool.query(`UPDATE language_exchange_connections SET updated_at='2026-10-09T00:00:01Z'
      WHERE id<>$1`,[hidden.record!.id]);
    await db.pool.query(`UPDATE language_exchange_connections SET updated_at='2026-10-09T00:00:02Z'
      WHERE id=$1`,[hidden.record!.id]);
    await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[c]);
    const first = await connections.listRelationships(a,{kind:'OUTGOING',limit:1});
    expect(first.items).toEqual([]);
    if (!first.nextCursor) throw new Error('Expected another scan page');
    expect(Buffer.from(first.nextCursor,'base64url').toString('utf8')).not.toContain(hidden.record!.id);
    const next = await connections.listRelationships(a,{kind:'OUTGOING',limit:1,cursor:first.nextCursor});
    expect(next.items.map(item=>item.targetUserId)).toEqual([b]);
    const tampered = Buffer.from(first.nextCursor,'base64url'); tampered[tampered.length-1]^=1;
    await expect(connections.listRelationships(a,{kind:'OUTGOING',limit:1,cursor:tampered.toString('base64url')}))
      .rejects.toMatchObject({code:'EXCHANGE_INVALID_CURSOR'});
  });

  it('converges concurrent duplicate and crossed requests to exactly one connected pair', async () => {
    const [a,b] = await pair();
    await Promise.all([connections.requestConnection(a,b),connections.requestConnection(a,b),connections.requestConnection(b,a)]);
    const rows = (await db.pool.query('SELECT status FROM language_exchange_connections')).rows;
    expect(rows).toEqual([{status:'CONNECTED'}]);
  });

  it('block wins concurrent request and accept and unblock never restores connection', async () => {
    const [a,b] = await pair();
    await connections.requestConnection(a,b);
    await Promise.all([connections.acceptConnection(b,a),safety.blockUser(a,b),connections.requestConnection(a,b)]);
    expect(await safety.isBlocked(a,b)).toBe(true);
    expect((await db.pool.query('SELECT id FROM language_exchange_connections')).rows).toHaveLength(0);
    await safety.unblockUser(a,b);
    expect(await connections.findRelationship(a,b)).toBeNull();
  });

  it.each(['account', 'opt-out', 'private-language', 'discovery'] as const)(
    'reauthorizes pair actions after waiting for committed %s revocation', async (revocation) => {
      const [a,b] = await pair();
      await connections.requestConnection(a,b);
      const name = 'phase26_wait_' + randomUUID();
      const waitingPool = new Pool({connectionString:db.scopedUrl,max:1,application_name:name});
      const blocker = await db.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[a]);
        const waiting = new PostgresExchangeConnectionRepository(waitingPool,safety);
        result = (revocation==='discovery' ? waiting.requestConnection(b,a) : waiting.acceptConnection(b,a))
          .then(value => value,error => error);
        await observedLockWait(name);
        if (revocation === 'account') await blocker.query(`UPDATE users SET status='DISABLED' WHERE id=$1`,[a]);
        if (revocation === 'opt-out') await blocker.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[a]);
        if (revocation === 'private-language') await blocker.query(`UPDATE user_languages SET visibility='PRIVATE' WHERE user_id=$1`,[a]);
        if (revocation === 'discovery') await blocker.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=$1',[a]);
        await blocker.query('COMMIT');
        expect(await result).toMatchObject({code:'EXCHANGE_PROFILE_UNAVAILABLE'});
        expect((await db.pool.query('SELECT status FROM language_exchange_connections')).rows[0].status).toBe('PENDING');
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        await result;
        await waitingPool.end();
      }
    },
  );

  it.each([
    ['cancel','accept','CANCELLED','INVALID_ACTION',null],
    ['accept','cancel','ACCEPTED','INVALID_ACTION','CONNECTED'],
    ['block','accept',null,'SAFETY_BLOCKED',null],
    ['accept','block','ACCEPTED',null,null],
  ] as const)('serializes %s before %s using observed independent SQL lock waits', async (first,second,firstOutcome,secondOutcome,status) => {
    const [a,b]=await pair(); await connections.requestConnection(a,b);
    const released=deferred(); const locked=deferred();
    const firstPool=new Pool({connectionString:db.scopedUrl,max:1});
    const name='phase26_order_'+randomUUID();
    const secondPool=new Pool({connectionString:db.scopedUrl,max:1,application_name:name});
    // Pause the real repository only after its ordered account locks are held.
    const gatedPool=new Proxy(firstPool,{get(target,key) {
      if(key==='connect') return async()=>{
        const client=await target.connect();
        return new Proxy(client,{get(connection,property) {
          if(property==='query') return async(sql:string,parameters?:unknown[])=>{
            const result=await connection.query(sql,parameters);
            if(sql.includes('SELECT id, status, email_verified_at FROM users')) {
              locked.resolve(); await released.promise;
            }
            return result;
          };
          const value=Reflect.get(connection,property);return typeof value==='function'?value.bind(connection):value;
        }});
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const perform=(pool:Pool,action:typeof first | typeof second)=>{
      const store=new PostgresExchangeSafetyRepository(pool);
      const repository=new PostgresExchangeConnectionRepository(pool,store);
      if(action==='block') return store.blockUser(a,b);
      if(action==='cancel') return repository.cancelConnection(a,b);
      return repository.acceptConnection(b,a);
    };
    let one:Promise<unknown>|undefined;let two:Promise<unknown>|undefined;
    try {
      one=perform(gatedPool,first); await locked.promise;
      two=perform(secondPool,second); await observedLockWait(name);
      released.resolve();
      const [firstResult,secondResult]=await Promise.all([one,two]);
      if(firstOutcome) expect(firstResult).toMatchObject({outcome:firstOutcome});
      if(secondOutcome) expect(secondResult).toMatchObject({outcome:secondOutcome});
      expect((await db.pool.query('SELECT status FROM language_exchange_connections')).rows)
        .toEqual(status?[{status}]:[]);
      if(first==='block'||second==='block') expect(await safety.isBlocked(a,b)).toBe(true);
    } finally {
      released.resolve();await Promise.allSettled([one,two]);await firstPool.end();await secondPool.end();
    }
  });

  function deferred() {
    let resolve!:()=>void;const promise=new Promise<void>(finish=>{resolve=finish;});return {promise,resolve};
  }

  async function observedLockWait(applicationName: string) {
    const deadline = Date.now()+10000;
    while (Date.now()<deadline) {
      const result = await db.pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`,[applicationName]);
      if (result.rowCount) return;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    throw new Error('Expected independent connection account-lock wait was not observed');
  }
});
