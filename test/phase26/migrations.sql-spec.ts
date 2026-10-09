import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { SqlHarness } from '../phase22/sql-harness';
import { NOTIFICATION_TYPES,createNotificationIntent } from '../../src/notifications/notification.contracts';
import { createNotificationDomainEvent } from '../../src/notifications/notification-event-integration';
import { PostgresNotificationRepository } from '../../src/notifications/postgres-notification.repository';

it('preserves every prior notification type through0031 up/down on the complete ordered migration baseline',async()=>{
  const db=new SqlHarness();
  try {
    await db.open();
    const extensions=(await db.pool.query(`SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','btree_gist','pg_trgm')`)).rows;
    if(extensions.length!==3) throw new Error('Full baseline proof requires existing TEST extensions');
    // Undo this helper's study-group bootstrap only in its disposable schema;
    // then apply0002–0028 in exactly the production migration order.
    await db.migration('0027_phase22_study_groups.down.sql');
    const files=(await readdir(path.resolve(__dirname,'../../database/migrations')))
      .filter(file=>/^\d{4}_[\w-]+\.sql$/.test(file) && Number(file.slice(0,4))>=2 && Number(file.slice(0,4))<=28).sort();
    for(const file of files) await db.migration(file);
    const recipient=randomUUID();const actor=randomUUID();const connection=randomUUID();
    for(const id of [recipient,actor]) await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
      VALUES($1,$2,$2,'Synthetic migration actor','ACTIVE',now())`,[id,id+'@phase26.invalid']);
    const event=createNotificationDomainEvent({eventId:connection,eventType:'exchange.connection.requested',aggregateType:'EXCHANGE_CONNECTION',
      aggregateId:connection,actor:{kind:'USER',userId:actor},recipientUserId:recipient,occurredAt:'2026-10-09T00:00:00.000Z',
      idempotencyKey:`exchange.connection.requested:${connection}:v1`,
      target:{kind:'EXCHANGE_CONNECTION',id:connection,path:'/exchange'},variables:{}});
    const repository=new PostgresNotificationRepository(db.pool);
    const previousTypes=NOTIFICATION_TYPES.filter(type=>type!=='BUDDY_CONNECTED');
    for(const notificationType of previousTypes) await repository.claimIntent(createNotificationIntent({event,notificationType,
      category:'EXCHANGE',priority:'NORMAL',actor:{kind:'SYSTEM',label:'System'},retention:{mode:'DAYS',days:180}}));
    const assertPreserved=async()=>expect((await db.pool.query('SELECT notification_type FROM notifications ORDER BY notification_type')).rows
      .map(row=>row.notification_type)).toEqual([...previousTypes].sort());
    await assertPreserved();
    await db.migration('0031_phase26_connected_notification.sql');await assertPreserved();
    await db.migration('0031_phase26_connected_notification.down.sql');await assertPreserved();
    await db.migration('0031_phase26_connected_notification.sql');await assertPreserved();
  } finally { await db.close(); }
},180000);
