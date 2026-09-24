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

describe('library reviewer HTTP API', () => {
  let app: INestApplication;
  let identity: RoleAwareIdentityRepository;
  let sessions: SessionService;
  let library: LibraryService;
  let sequence = 0;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('protects reviewer queue and detail routes by role', async () => {
    const api = request(app.getHttpServer());
    await api.get('/api/v1/library/reviews').expect(401);
    await api.get('/api/v1/library/reviews/' + uuid(1)).expect(401);

    const member = await createUser('review-member');
    const session = await sessionFor(member);
    await api
      .get('/api/v1/library/reviews')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_FORBIDDEN'));
    await api
      .get('/api/v1/library/reviews/' + uuid(1))
      .set('Authorization', 'Bearer ' + session.accessToken)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_FORBIDDEN'));
  });

  it('returns a safe queue/detail projection and verifies only through the reviewer action', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('review-owner');
    const reviewer = await createUser('review-moderator', ['MODERATOR']);
    const ownerSession = await sessionFor(owner);
    const reviewerSession = await sessionFor(reviewer);
    const licenseKey = await registerLicense('HTTP-REVIEW-SAFE', reviewer);
    const resourceId = await createVocabulary(api, ownerSession, licenseKey, 'HTTP review word');

    await api
      .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(validSubmission())
      .expect(201);

    const queue = await api
      .get('/api/v1/library/reviews')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200);
    expect(queue.body.data.items).toEqual([
      expect.objectContaining({
        resourceId,
        reviewState: 'COMMUNITY_REVIEW',
        verificationEligibility: { eligible: true, issues: [] },
      }),
    ]);
    expect(JSON.stringify(queue.body.data)).not.toContain('sourceNote');
    expect(JSON.stringify(queue.body.data)).not.toContain('email');

    const detail = await api
      .get('/api/v1/library/reviews/' + resourceId)
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      resource: { id: resourceId, reviewState: 'COMMUNITY_REVIEW' },
      provenance: [{ attribution: 'Reviewer-visible attribution' }],
      contributionEvents: [{ eventType: 'LIBRARY_CONTRIBUTION_SUBMITTED', eventVersion: 1 }],
    });
    expect(JSON.stringify(detail.body.data)).not.toContain('sourceNote');
    expect(JSON.stringify(detail.body.data)).not.toContain('contributorUserId');
    expect(JSON.stringify(detail.body.data)).not.toContain('password');

    identity.setRoles(owner.id, ['MODERATOR']);
    const creatorReviewerSession = await sessionFor(owner);
    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + creatorReviewerSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_SELF_VERIFICATION_DENIED'));

    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'VERIFIED', note: 'Reviewed safe attribution' })
      .expect(201)
      .expect(({ body }) => expect(body.data.resource.reviewState).toBe('VERIFIED'));

    await api
      .get('/api/v1/library/reviews')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toEqual([]));
    await api.get('/api/v1/library/resources/' + resourceId).expect(200);
  });

  it('supports bounded filters, cursor pagination, rejection, and deterministic conflicts', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('review-filter-owner');
    const reviewer = await createUser('review-filter-moderator', ['ADMIN']);
    const ownerSession = await sessionFor(owner);
    const reviewerSession = await sessionFor(reviewer);
    const licenseKey = await registerLicense('HTTP-REVIEW-FILTER', reviewer);
    const firstId = await createVocabulary(api, ownerSession, licenseKey, 'queue alpha');
    const secondId = await createVocabulary(api, ownerSession, licenseKey, 'queue beta');
    for (const resourceId of [firstId, secondId]) {
      await api
        .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
        .set('Authorization', 'Bearer ' + ownerSession.accessToken)
        .send(validSubmission())
        .expect(201);
    }

    const filtered = await api
      .get('/api/v1/library/reviews')
      .query({ language: 'en', type: 'VOCABULARY', q: 'queue alpha', limit: 1 })
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200);
    expect(filtered.body.data.items.map((item: { resourceId: string }) => item.resourceId)).toEqual([firstId]);
    expect(filtered.body.data.nextCursor).toBeNull();

    const firstPage = await api
      .get('/api/v1/library/reviews')
      .query({ type: 'VOCABULARY', limit: 1 })
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200);
    expect(firstPage.body.data.items).toHaveLength(1);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));
    const secondPage = await api
      .get('/api/v1/library/reviews')
      .query({ type: 'VOCABULARY', limit: 1, cursor: firstPage.body.data.nextCursor })
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(200);
    expect(secondPage.body.data.items).toHaveLength(1);
    expect(secondPage.body.data.items[0].resourceId).not.toBe(firstPage.body.data.items[0].resourceId);

    await api
      .get('/api/v1/library/reviews')
      .query({ cursor: 'invalid' })
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_INVALID_CURSOR'));

    const rejectedId = await createVocabulary(api, ownerSession, licenseKey, 'queue reject');
    await api
      .post('/api/v1/library/resources/' + rejectedId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(validSubmission())
      .expect(201);
    await api
      .post('/api/v1/library/resources/' + rejectedId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'REJECTED' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_NOTE_REQUIRED'));
    await api
      .post('/api/v1/library/resources/' + rejectedId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'REJECTED', note: 'Needs correction' })
      .expect(201);
    await api
      .get('/api/v1/library/resources/' + rejectedId)
      .expect(404);

    await api
      .post('/api/v1/library/resources/' + rejectedId + '/review')
      .set('Authorization', 'Bearer ' + reviewerSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_CONFLICT'));
  });

  async function createUser(label: string, roles: RoleKey[] = ['MEMBER']): Promise<UserRecord> {
    const user = await identity.createUser({
      email: `library-review-${label}-${sequence++}@example.com`,
      displayName: label,
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    identity.setRoles(user.id, roles);
    return (await identity.findUserById(user.id))!;
  }

  async function sessionFor(user: UserRecord): Promise<TestSession> {
    const values: string[] = [];
    const response = {
      append(_header: string, value: string): void {
        values.push(value);
      },
    } as unknown as Response;
    const credentials = await sessions.issue((await identity.findUserById(user.id))!, response);
    const cookieParts = values.map((value) => value.split(';')[0]);
    const csrfCookie = cookieParts.find((value) => value.startsWith('cdn_csrf='));
    if (!csrfCookie) throw new Error('The test session did not receive a CSRF cookie');
    return {
      ...credentials,
      cookie: cookieParts.join('; '),
      csrfToken: csrfCookie.slice('cdn_csrf='.length),
    };
  }

  async function registerLicense(key: string, reviewer: UserRecord): Promise<string> {
    const licenseKey = `${key}-${sequence++}`;
    await library.registerLicense(
      { userId: reviewer.id, roles: reviewer.roles },
      {
        licenseKey,
        displayName: licenseKey,
        canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
        attributionRequired: true,
        redistributionAllowed: true,
        active: true,
        sourceNote: 'private reviewer registry note',
      },
    );
    return licenseKey;
  }

  async function createVocabulary(
    api: { post(url: string): request.Test },
    session: TestSession,
    licenseKey: string,
    term: string,
  ): Promise<string> {
    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({
        resourceType: 'VOCABULARY',
        primaryLanguageCode: 'en',
        visibility: 'PUBLIC',
        details: { term, definition: `${term} definition` },
      })
      .expect(201);
    const resourceId = created.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({
        sourceType: 'ORIGINAL_AUTHOR',
        sourceId: `review-source-${sequence++}`,
        licenseKey,
        attribution: 'Reviewer-visible attribution',
      })
      .expect(201);
    return resourceId;
  }
});

class RoleAwareIdentityRepository extends InMemoryIdentityRepository {
  private readonly roleOverrides = new Map<string, RoleKey[]>();

  setRoles(userId: string, roles: RoleKey[]): void {
    this.roleOverrides.set(userId, [...roles]);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = await super.findUserById(id);
    return user ? { ...user, roles: [...(this.roleOverrides.get(user.id) ?? user.roles)] } : null;
  }
}

interface TestSession extends SessionCredentials {
  cookie: string;
  csrfToken: string;
}

function validSubmission() {
  return {
    termsVersion: 'library-contribution-v1',
    rightsConfirmed: true,
    reuseConsent: true,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
