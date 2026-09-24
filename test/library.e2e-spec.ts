import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService, type SessionCredentials } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import { InMemoryIdentityRepository } from '../src/identity/identity.repository';
import type { RoleKey, UserRecord } from '../src/identity/identity.types';
import { LibraryService } from '../src/library/library.service';

let testIdentity: RoleAwareIdentityRepository;
let testSessions: SessionService;
let testLibrary: LibraryService;
let testReviewer: UserRecord;
let testSequence = 0;

describe('library API', () => {
  let app: INestApplication;
  let identity: RoleAwareIdentityRepository;
  let sessions: SessionService;
  let library: LibraryService;
  let reviewer: UserRecord;

  beforeAll(async () => {
    identity = new RoleAwareIdentityRepository();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_REPOSITORY)
      .useValue(identity)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    sessions = app.get(SessionService);
    library = app.get(LibraryService);
    testIdentity = identity;
    testSessions = sessions;
    testLibrary = library;
    reviewer = await createUser('reviewer', ['MODERATOR']);
    testReviewer = reviewer;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires auth, binds actor identity to the session, and enforces cookie CSRF', async () => {
    const api = request(app.getHttpServer());
    await api
      .post('/api/v1/library/resources')
      .send(resourceBody('PRIVATE'))
      .expect(401);

    const owner = await createUser('actor-bound');
    const session = await sessionFor(owner);
    const spoofed = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({
        ...resourceBody('PRIVATE'),
        createdByUserId: '00000000-0000-4000-8000-000000000001',
        reviewedByUserId: '00000000-0000-4000-8000-000000000002',
        roles: ['ADMIN'],
      })
      .expect(400);
    expect(spoofed.body.data).toBeUndefined();

    await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .set('Cookie', session.cookie)
      .send(resourceBody('PRIVATE'))
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));

    const licenseKey = await registerLicense('E2E-ACTOR', true);
    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send(resourceBody('PRIVATE'))
      .expect(201);
    const resourceId = created.body.data.id as string;
    expect(created.body.data.createdByUserId).toBe(owner.id);
    expect(created.body.data.reviewedByUserId).toBeNull();

    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send(originalProvenance(licenseKey, 'actor-original'))
      .expect(201);
  });

  it('allows original-author provenance but blocks member source impersonation and IDOR', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('source-owner');
    const other = await createUser('source-other');
    const ownerSession = await sessionFor(owner);
    const otherSession = await sessionFor(other);
    const licenseKey = await registerLicense('E2E-SOURCE', true);
    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(resourceBody('PRIVATE'))
      .expect(201);
    const resourceId = created.body.data.id as string;

    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(originalProvenance(licenseKey, 'source-owner-original'))
      .expect(201);

    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + otherSession.accessToken)
      .send(originalProvenance(licenseKey, 'other-cannot-edit'))
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_RESOURCE_FORBIDDEN'));

    for (const sourceType of [
      'OPEN_DATASET',
      'PHASE06_LIBRARY_CANDIDATE',
      'COMMUNITY_POST',
      'MANUAL_ENTRY',
    ]) {
      await api
        .post('/api/v1/library/resources/' + resourceId + '/provenance')
        .set('Authorization', 'Bearer ' + ownerSession.accessToken)
        .send({
          ...originalProvenance(licenseKey, `restricted-${sourceType}`),
          sourceType,
        })
        .expect(403)
        .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_PROVENANCE_SOURCE_FORBIDDEN'));
    }
  });

  it('runs submit, review, public projection, safe-license, and rejection gates over HTTP', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('review-owner');
    const ordinaryMember = await createUser('review-member');
    const ownerSession = await sessionFor(owner);
    const memberSession = await sessionFor(ordinaryMember);
    const reviewerSession = await sessionFor(reviewer);
    const safeLicense = await registerLicense('E2E-SAFE', true);
    const resourceResponse = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(resourceBody('PUBLIC'))
      .expect(201);
    const resourceId = resourceResponse.body.data.id as string;

    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({
        ...originalProvenance(safeLicense, 'review-owner-original'),
        importBatch: 'internal-batch-08a',
        transformationHistory: [{ operation: 'NORMALIZE_WHITESPACE' }],
      })
      .expect(201);
    await api.get('/api/v1/library/resources/' + resourceId).expect(404);

    await submitContribution(api, resourceId, ownerSession);
    await api.get('/api/v1/library/resources/' + resourceId).expect(404);

    identity.setRoles(owner.id, ['MODERATOR']);
    const ownerReviewerSession = await sessionFor(owner);
    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + ownerReviewerSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_SELF_VERIFICATION_DENIED'));

    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + memberSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_FORBIDDEN'));

    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'VERIFIED', note: 'Reviewed attribution and language data' })
      .expect(201);
    const publicResource = await api
      .get('/api/v1/library/resources/' + resourceId)
      .expect(200);
    expect(publicResource.body.data.reviewState).toBe('VERIFIED');
    expect(publicResource.body.data.provenance[0].importBatch).toBeUndefined();
    expect(publicResource.body.data.provenance[0].transformationHistory).toBeUndefined();
    expect(publicResource.body.data.reviewedByUserId).toBeUndefined();
    expect(publicResource.body.data.reviewNotes).toBeUndefined();

    const unsafeLicense = await registerLicense('E2E-UNSAFE', true);
    const unsafe = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + memberSession.accessToken)
      .send(resourceBody('PUBLIC'))
      .expect(201);
    const unsafeId = unsafe.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + unsafeId + '/provenance')
      .set('Authorization', 'Bearer ' + memberSession.accessToken)
      .send(originalProvenance(unsafeLicense, 'unsafe-original'))
      .expect(201);
    await submitContribution(api, unsafeId, memberSession);
    await upsertLicense(unsafeLicense, true, false);
    await api
      .post('/api/v1/library/resources/' + unsafeId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED'));
    await api.get('/api/v1/library/resources/' + unsafeId).expect(404);

    const rejected = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + memberSession.accessToken)
      .send(resourceBody('PUBLIC'))
      .expect(201);
    const rejectedId = rejected.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + rejectedId + '/provenance')
      .set('Authorization', 'Bearer ' + memberSession.accessToken)
      .send(originalProvenance(safeLicense, 'rejected-original'))
      .expect(201);
    await submitContribution(api, rejectedId, memberSession);
    await api
      .post('/api/v1/library/resources/' + rejectedId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'REJECTED', note: 'Internal review rejection' })
      .expect(201);
    await api.get('/api/v1/library/resources/' + rejectedId).expect(404);
  });

  it('reopens rejected resources only through an audited reviewer action', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('reopen-owner');
    const ownerSession = await sessionFor(owner);
    const reviewerSession = await sessionFor(reviewer);
    const licenseKey = await registerLicense('E2E-REOPEN', true);
    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(resourceBody('PUBLIC'))
      .expect(201);
    const resourceId = created.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(originalProvenance(licenseKey, 'reopen-before'))
      .expect(201);
    await transition(api, resourceId, ownerSession, 'COMMUNITY_REVIEW');
    await transition(api, resourceId, reviewerSession, 'REJECTED', 'Needs correction');
    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({ nextState: 'DRAFT', note: 'Owner cannot reopen' })
      .expect(403);
    await transition(api, resourceId, reviewerSession, 'DRAFT', 'Reopen for correction');
    await api.get('/api/v1/library/resources/' + resourceId).expect(404);
    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(originalProvenance(licenseKey, 'reopen-after'))
      .expect(201);
  });

  it('searches the public resource index with Unicode filters, cursors, and live license gates', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('search-owner');
    const ownerSession = await sessionFor(owner);
    const reviewerSession = await sessionFor(reviewer);
    const licenseKey = await registerLicense('E2E-SEARCH', true);

    const vietnamese = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({
        resourceType: 'VOCABULARY',
        primaryLanguageCode: 'vi',
        visibility: 'PUBLIC',
        topics: ['daily-life'],
        cefrLevel: 'A1',
        details: { term: 'từ điển', definition: 'Vietnamese dictionary' },
      })
      .expect(201);
    const vietnameseId = vietnamese.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + vietnameseId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(originalProvenance(licenseKey, 'e2e-search-vietnamese'))
      .expect(201);
    await transition(api, vietnameseId, ownerSession, 'COMMUNITY_REVIEW');
    await transition(api, vietnameseId, reviewerSession, 'VERIFIED');

    const cjk = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({
        resourceType: 'SENTENCE',
        primaryLanguageCode: 'zh',
        visibility: 'PUBLIC',
        topics: ['daily-life'],
        cefrLevel: 'B1',
        details: { text: '你好，语言社区。', context: 'Greeting' },
      })
      .expect(201);
    const cjkId = cjk.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + cjkId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(originalProvenance(licenseKey, 'e2e-search-cjk'))
      .expect(201);
    await transition(api, cjkId, ownerSession, 'COMMUNITY_REVIEW');
    await transition(api, cjkId, reviewerSession, 'VERIFIED');

    await api
      .get('/api/v1/library/resources')
      .query({ q: 'điển', language: 'vi', type: 'VOCABULARY', topic: 'daily-life', level: 'A1' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items).toHaveLength(1);
        expect(body.data.items[0]).toMatchObject({
          id: vietnameseId,
          reviewState: 'VERIFIED',
          preview: { title: 'từ điển' },
        });
        expect(body.data.items[0].createdByUserId).toBeUndefined();
        expect(body.data.items[0].provenance[0].license.licenseKey).toBe(licenseKey);
      });

    await api
      .get('/api/v1/library/resources')
      .query({ q: '你好' })
      .expect(200)
      .expect(({ body }) => expect(body.data.items.map((item: { id: string }) => item.id)).toContain(cjkId));

    const firstPage = await api
      .get('/api/v1/library/resources')
      .query({ topic: 'daily-life', limit: 1 })
      .expect(200);
    expect(firstPage.body.data.items).toHaveLength(1);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));
    const secondPage = await api
      .get('/api/v1/library/resources')
      .query({ topic: 'daily-life', limit: 1, cursor: firstPage.body.data.nextCursor })
      .expect(200);
    expect(secondPage.body.data.items).toHaveLength(1);
    expect(secondPage.body.data.items[0].id).not.toBe(firstPage.body.data.items[0].id);

    await testLibrary.registerLicense(
      { userId: testReviewer.id, roles: ['MODERATOR'] },
      {
        licenseKey,
        displayName: licenseKey,
        canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
        attributionRequired: true,
        redistributionAllowed: true,
        active: false,
      },
    );
    await api
      .get('/api/v1/library/resources')
      .query({ topic: 'daily-life' })
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toEqual([]));
  });
});

class RoleAwareIdentityRepository extends InMemoryIdentityRepository {
  private readonly roleOverrides = new Map<string, RoleKey[]>();

  setRoles(userId: string, roles: RoleKey[]): void {
    this.roleOverrides.set(userId, [...roles]);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.withRoles(await super.findUserById(id));
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.withRoles(await super.findUserByEmail(email));
  }

  private withRoles(user: UserRecord | null): UserRecord | null {
    if (!user) return null;
    return {
      ...user,
      roles: [...(this.roleOverrides.get(user.id) ?? user.roles)],
    };
  }
}

interface TestSession extends SessionCredentials {
  cookie: string;
  csrfToken: string;
}

async function createUser(
  label: string,
  roles: RoleKey[] = ['MEMBER'],
): Promise<UserRecord> {
  const user = await testIdentity.createUser({
    email: `library-${label}-${testSequence++}@example.com`,
    displayName: label,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
  testIdentity.setRoles(user.id, roles);
  return (await testIdentity.findUserById(user.id))!;
}

async function sessionFor(user: UserRecord): Promise<TestSession> {
  const values: string[] = [];
  const response = {
    append(_header: string, value: string): void {
      values.push(value);
    },
  } as unknown as Response;
  const credentials = await testSessions.issue((await testIdentity.findUserById(user.id))!, response);
  const cookieParts = values.map((value) => value.split(';')[0]);
  const csrfCookie = cookieParts.find((value) => value.startsWith('cdn_csrf='));
  if (!csrfCookie) throw new Error('The test session did not receive a CSRF cookie');
  return {
    ...credentials,
    cookie: cookieParts.join('; '),
    csrfToken: csrfCookie.slice('cdn_csrf='.length),
  };
}

async function registerLicense(
  key: string,
  redistributionAllowed: boolean | null,
): Promise<string> {
  const licenseKey = `${key}-${testSequence++}`;
  await upsertLicense(licenseKey, true, redistributionAllowed);
  return licenseKey;
}

async function upsertLicense(
  licenseKey: string,
  active: boolean,
  redistributionAllowed: boolean | null,
): Promise<void> {
  await testLibrary.registerLicense(
    { userId: testReviewer.id, roles: ['MODERATOR'] },
    {
      licenseKey,
      displayName: licenseKey,
      canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
      attributionRequired: true,
      redistributionAllowed,
      active,
    },
  );
}

function resourceBody(visibility: 'PUBLIC' | 'PRIVATE') {
  return {
    resourceType: 'VOCABULARY',
    primaryLanguageCode: 'en',
    visibility,
    details: { term: 'reviewable word', definition: 'a word for library E2E' },
  };
}

function originalProvenance(licenseKey: string, sourceId: string) {
  return {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId,
    licenseKey,
    attribution: 'Library E2E original author',
  };
}

async function transition(
  api: { post(url: string): request.Test },
  resourceId: string,
  session: TestSession,
  nextState: string,
  note?: string,
): Promise<void> {
  if (nextState === 'COMMUNITY_REVIEW') {
    await submitContribution(api, resourceId, session);
    return;
  }
  await api
    .post('/api/v1/library/resources/' + resourceId + '/review')
    .set('Authorization', 'Bearer ' + session.accessToken)
    .send({ nextState, ...(note ? { note } : {}) })
    .expect(201);
}

async function submitContribution(
  api: { post(url: string): request.Test },
  resourceId: string,
  session: TestSession,
): Promise<void> {
  await api
    .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
    .set('Authorization', 'Bearer ' + session.accessToken)
    .send({
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
    })
    .expect(201);
}
