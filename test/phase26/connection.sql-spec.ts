import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConnectionCursorCodec } from '../../src/exchange/connection-cursor-codec';
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
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql']) {
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

  it.each(['account', 'opt-out', 'private-language'] as const)(
    'reauthorizes accept after waiting for committed %s revocation', async (revocation) => {
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
        result = waiting.acceptConnection(b,a).then(value => value,error => error);
        await observedLockWait(name);
        if (revocation === 'account') await blocker.query(`UPDATE users SET status='DISABLED' WHERE id=$1`,[a]);
        if (revocation === 'opt-out') await blocker.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1',[a]);
        if (revocation === 'private-language') await blocker.query(`UPDATE user_languages SET visibility='PRIVATE' WHERE user_id=$1`,[a]);
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
