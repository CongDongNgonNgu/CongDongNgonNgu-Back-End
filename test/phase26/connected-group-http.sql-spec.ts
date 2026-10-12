import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { SessionService } from '../../src/auth/session/session.service';
import { configureApp } from '../../src/app.setup';
import { buildConfiguration } from '../../src/config/configuration';
import { validateEnvironment } from '../../src/config/env.validation';
import { IDENTITY_REPOSITORY } from '../../src/identity/identity.module';
import { PostgresIdentityRepository } from '../../src/identity/postgres-identity.repository';
import { StudyGroupModule } from '../../src/study-groups/study-group.module';
import { StudyGroupService } from '../../src/study-groups/study-group.service';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 connected-partner invitation native PostgreSQL HTTP boundary', () => {
  const db = new SqlHarness();
  const prefix = '/api/v1/study-groups';
  let app: INestApplication;
  let identity: PostgresIdentityRepository;
  let sessions: SessionService;
  let groups: StudyGroupService;
  beforeAll(async () => {
    await db.open();
    expect((await db.pool.query(`SELECT extname FROM pg_extension
      WHERE extname IN ('pgcrypto','btree_gist','pg_trgm')`)).rowCount).toBe(3);
    await db.migration('0027_phase22_study_groups.down.sql');
    const files = (await readdir(path.resolve(__dirname, '../../database/migrations')))
      .filter(file => /^\d{4}_[\w-]+\.sql$/.test(file)
        && Number(file.slice(0, 4)) >= 2 && Number(file.slice(0, 4)) <= 36).sort();
    expect(files).toHaveLength(35);
    for (const file of files) await db.migration(file);
    identity = new PostgresIdentityRepository(db.pool);
    groups = new StudyGroupService(db.pool);
    const config = buildConfiguration(validateEnvironment({
      NODE_ENV: 'test', PORT: '3000', PUBLIC_APP_URL: 'http://localhost:5173', CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      DATABASE_URL: db.scopedUrl, AUTH_PERSISTENCE: 'postgres',
      JWT_ACCESS_SECRET: 'phase26-group-http-isolated-access-secret-32', JWT_REFRESH_SECRET: 'phase26-group-http-isolated-refresh-secret-32',
      PAYMENT_PROVIDER: 'disabled', PAYMENT_QR_ENABLED: 'false', EMAIL_PROVIDER: 'disabled', STORAGE_PROVIDER: 'disabled',
      REALTIME_PROVIDER: 'disabled', AI_PROVIDER: 'disabled', OAUTH_PROVIDER: 'disabled', SESSION_STORE: 'disabled',
    }));
    const moduleRef = await Test.createTestingModule({ imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => config] }), AuthModule, StudyGroupModule,
    ] }).overrideProvider(IDENTITY_REPOSITORY).useValue(identity)
      .overrideProvider(StudyGroupService).useValue(groups).compile();
    app = moduleRef.createNestApplication(); configureApp(app); await app.init(); sessions = app.get(SessionService);
  }, 180000);
  afterAll(async () => { await app?.close(); await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function actor() {
    const user = await identity.createUser({ email: randomUUID() + '@phase26.invalid', displayName: 'Synthetic group HTTP actor',
      passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date() });
    expect(user.roles).toEqual(['MEMBER']);
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
      VALUES($1,true,true,'RELATIONSHIP_GATED')`, [user.id]);
    const relation = (await db.pool.query(`INSERT INTO user_languages
      (user_id,language_id,is_known,is_learning,declared_proficiency)
      VALUES($1,$2,true,true,'B1') RETURNING id`, [user.id, language])).rows[0].id;
    await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
      VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [user.id, relation]);
    const cookies: string[] = [];
    const credentials = await sessions.issue(user,
      { append: (_key: string, value: string) => cookies.push(value) } as unknown as Response);
    return { ...user, token: credentials.accessToken, cookies };
  }

  async function connect(a: string, b: string) {
    const [first, second] = [a, b].sort();
    await db.pool.query(`INSERT INTO language_exchange_connections
      (participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$3,'CONNECTED')`, [first, second, a]);
  }

  async function fixture() {
    const owner = await actor(); const partner = await actor(); const other = await actor();
    await connect(owner.id, partner.id);
    const group = await groups.createGroup(owner.id, { name: 'Private synthetic HTTP group' });
    return { owner, partner, other, group };
  }
  const http = () => request(app.getHttpServer());
  const bearer = (user: { token: string }) => ({ Authorization: 'Bearer ' + user.token });
  const route = (groupId: string) => `${prefix}/${groupId}/invitations/connected-partner`;
  async function state(groupId: string) {
    return { invitations: (await db.pool.query('SELECT * FROM study_group_invitations WHERE group_id=$1 ORDER BY id', [groupId])).rows,
      memberships: (await db.pool.query('SELECT * FROM study_group_memberships WHERE group_id=$1 ORDER BY user_id', [groupId])).rows };
  }

  it('returns a one-time no-store bearer for an ordinary verified connected owner without granting partner membership', async () => {
    const h = await fixture(); const before = await state(h.group.id);
    const response = await http().post(route(h.group.id)).set(bearer(h.owner)).send({ partnerUserId: h.partner.id }).expect(200);
    expect(response.body.success).toBe(true);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['cache-control']).toContain('private');
    const issued = response.body.data;
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'id', 'token']);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const after = await state(h.group.id);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.invitations).toHaveLength(1);
    expect(after.invitations[0]).toMatchObject({ id: issued.id, issuer_user_id: h.owner.id,
      token_digest: createHash('sha256').update(issued.token).digest('hex'), accepted_at: null, revoked_at: null });
    expect(after.invitations[0].expires_at.toISOString()).toBe(issued.expiresAt);
    expect(JSON.stringify(after)).not.toContain(issued.token);
    await http().get(`${prefix}/${h.group.id}`).set(bearer(h.partner)).expect(404);
    const metadata = await http().get(`${prefix}/${h.group.id}/invitations`).set(bearer(h.owner)).expect(200);
    expect(JSON.stringify(metadata.body)).not.toContain(issued.token);
  });

  it('rejects missing, malformed or forged body/path fields without issuing a token', async () => {
    const h = await fixture(); const before = await state(h.group.id);
    const bodies = [{}, { partnerUserId: null }, { partnerUserId: 42 }, { partnerUserId: 'invalid' },
      { partnerUserId: [h.partner.id] }, { partnerUserId: h.partner.id, ownerUserId: h.other.id },
      { partnerUserId: h.partner.id, groupId: randomUUID() }, { partnerUserId: h.partner.id, token: 'forged' }];
    for (const body of bodies) await http().post(route(h.group.id)).set(bearer(h.owner)).send(body).expect(400);
    await http().post(route('invalid')).set(bearer(h.owner)).send({ partnerUserId: h.partner.id }).expect(400);
    expect(await state(h.group.id)).toEqual(before);
  });

  it('denies anonymous issuance before exposing invitation or group details', async () => {
    const h = await fixture(); const before = await state(h.group.id);
    await http().post(route(h.group.id)).send({ partnerUserId: h.partner.id }).expect(401);
    expect(await state(h.group.id)).toEqual(before);
  });

  it.each(['blocked', 'removed', 'foreign issuer'] as const)(
    'freshly denies %s with uniform404 and no invitation/membership changes', async reason => {
      const h = await fixture(); let issuer = h.owner;
      if (reason === 'blocked') await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)',
        [h.partner.id, h.owner.id]);
      if (reason === 'removed') await db.pool.query('DELETE FROM language_exchange_connections');
      if (reason === 'foreign issuer') { await connect(h.other.id, h.partner.id); issuer = h.other; }
      const before = await state(h.group.id);
      const response = await http().post(route(h.group.id)).set(bearer(issuer)).send({ partnerUserId: h.partner.id }).expect(404);
      expect(response.body.error.code).toBe('GROUP_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain(h.group.name);
      expect(await state(h.group.id)).toEqual(before);
    });

  it('retains explicit manual unbound bearer acceptance and one-use replay denial', async () => {
    const h = await fixture();
    const issued = (await http().post(route(h.group.id)).set(bearer(h.owner))
      .send({ partnerUserId: h.partner.id }).expect(200)).body.data;
    // The selected partner is convenience only: an unrelated bearer holder
    // can deliberately redeem through the unchanged native acceptance route.
    const accepted = await http().post(`${prefix}/invitations/accept`).set(bearer(h.other))
      .send({ groupId: h.group.id, token: issued.token }).expect(200);
    expect(accepted.body.data).toMatchObject({ id: h.group.id, role: 'MEMBER' });
    await http().get(`${prefix}/${h.group.id}`).set(bearer(h.other)).expect(200);
    await http().get(`${prefix}/${h.group.id}`).set(bearer(h.partner)).expect(404);
    await http().post(`${prefix}/invitations/accept`).set(bearer(h.partner))
      .send({ groupId: h.group.id, token: issued.token }).expect(404);
    expect((await state(h.group.id)).memberships).toHaveLength(2);
  });

  it('preserves cookie CSRF and origin checks on the convenience mutation', async () => {
    const h = await fixture(); const before = await state(h.group.id);
    const cookie = h.owner.cookies.map(value => value.split(';')[0]).join('; ');
    const csrf = h.owner.cookies.find(value => value.startsWith('cdn_csrf='))?.split(';')[0].split('=')[1];
    expect(csrf).toBeDefined();
    await http().post(route(h.group.id)).set(bearer(h.owner)).set('Cookie', cookie)
      .send({ partnerUserId: h.partner.id }).expect(403);
    await http().post(route(h.group.id)).set(bearer(h.owner)).set('Cookie', cookie)
      .set('Origin', 'https://foreign.invalid').set('X-CSRF-Token', csrf!)
      .send({ partnerUserId: h.partner.id }).expect(403);
    expect(await state(h.group.id)).toEqual(before);
    await http().post(route(h.group.id)).set(bearer(h.owner)).set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173').set('X-CSRF-Token', csrf!)
      .send({ partnerUserId: h.partner.id }).expect(200);
  });
});
