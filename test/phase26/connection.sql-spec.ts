import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectionCursorCodec } from '../../src/exchange/connection-cursor-codec';
import { PostgresExchangeActionLimiter } from '../../src/exchange/exchange-action-limiter';
import { PostgresExchangeConnectionRepository } from '../../src/exchange/postgres-exchange-connection.repository';
import { PostgresExchangeSafetyRepository } from '../../src/exchange/postgres-exchange-safety.repository';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 connection PostgreSQL authorization and races', () => {
  const db = new SqlHarness();
  let connections: PostgresExchangeConnectionRepository;
  let safety: PostgresExchangeSafetyRepository;
  beforeAll(async () => {
    await db.open();
    for (const migration of ['0002_language_profile.sql', '0006_language_exchange_preferences.sql',
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql','0029_phase26_exchange_limits.sql',
      '0030_phase26_connection_outbox.sql']) {
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
