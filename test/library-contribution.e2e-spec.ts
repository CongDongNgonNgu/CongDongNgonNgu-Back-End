import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService, type SessionCredentials } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import { InMemoryIdentityRepository } from '../src/identity/identity.repository';
import type { UserRecord } from '../src/identity/identity.types';
import { LibraryService } from '../src/library/library.service';

describe('library contribution HTTP API', () => {
  let app: INestApplication;
  let identity: InMemoryIdentityRepository;
  let sessions: SessionService;
  let library: LibraryService;
  let sequence = 0;

  beforeAll(async () => {
    identity = new InMemoryIdentityRepository();
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

  it('returns a public fail-closed contribution policy without internal license notes', async () => {
    await registerLicense('HTTP-SAFE', true, true, 'safe internal note');
    await registerLicense('HTTP-DISABLED', false, true, 'disabled internal note');
    await registerLicense('HTTP-NO-REDISTRIBUTION', true, false, 'private internal note');
    await registerLicense('HTTP-UNKNOWN', true, null, 'unknown internal note');

    const response = await request(app.getHttpServer())
      .get('/api/v1/library/contribution-policy')
      .expect(200);

    expect(response.body.data).toMatchObject({
      termsVersion: 'library-contribution-v1',
      approvedResourceTypes: ['VOCABULARY', 'SENTENCE', 'TRANSLATION'],
      licenses: [{
        licenseKey: expect.stringContaining('HTTP-SAFE'),
        redistributionAllowed: true,
      }],
    });
    expect(response.body.data.approvedResourceTypes).not.toContain('GRAMMAR_ITEM');
    expect(response.body.data.licenses).toHaveLength(1);
    expect(response.body.data.licenses[0].sourceNote).toBeUndefined();
  });

  it('requires auth and cookie CSRF, binds the owner, submits only to community review, and is retry-safe', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('http-owner');
    const other = await createUser('http-other');
    const ownerSession = await sessionFor(owner);
    const otherSession = await sessionFor(other);
    const licenseKey = await registerLicense('HTTP-CONTRIBUTION', true, true);

    await api
      .post('/api/v1/library/resources/00000000-0000-4000-8000-000000000099/submit-contribution')
      .send(validSubmission())
      .expect(401);

    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({
        resourceType: 'VOCABULARY',
        primaryLanguageCode: 'en',
        visibility: 'PUBLIC',
        details: { term: 'community word', definition: 'a contribution' },
      })
      .expect(201);
    const resourceId = created.body.data.id as string;

    await api
      .post('/api/v1/library/resources/' + resourceId + '/provenance')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({
        sourceType: 'ORIGINAL_AUTHOR',
        sourceId: 'http-contribution-original',
        licenseKey,
        attribution: 'HTTP contribution owner',
      })
      .expect(201);

    await api
      .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .set('Cookie', ownerSession.cookie)
      .send(validSubmission())
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));

    await api
      .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + otherSession.accessToken)
      .send(validSubmission())
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_SUBMIT_FORBIDDEN'));

    const submitted = await api
      .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(validSubmission())
      .expect(201);
    expect(submitted.body.data.resource.reviewState).toBe('COMMUNITY_REVIEW');
    expect(submitted.body.data.audit.action).toBe('SUBMIT');
    expect(submitted.body.data.event.eventType).toBe('LIBRARY_CONTRIBUTION_SUBMITTED');
    expect(submitted.body.data.event.reviewAuditId).toBe(submitted.body.data.audit.id);

    await api
      .post('/api/v1/library/resources/' + resourceId + '/review')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send({ nextState: 'VERIFIED' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_REVIEW_FORBIDDEN'));
    await api.get('/api/v1/library/resources/' + resourceId).expect(404);
    await api
      .get('/api/v1/library/resources')
      .query({ q: 'community word' })
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toEqual([]));
    await api
      .post('/api/v1/library/resources/' + resourceId + '/submit-contribution')
      .set('Authorization', 'Bearer ' + ownerSession.accessToken)
      .send(validSubmission())
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_CONTRIBUTION_CONFLICT'));
  });

  it('rejects private, disallowed-type, stale-terms, and non-boolean submissions without 500s', async () => {
    const api = request(app.getHttpServer());
    const owner = await createUser('http-rejection-owner');
    const session = await sessionFor(owner);
    const licenseKey = await registerLicense('HTTP-REJECTION', true, true);

    const privateResource = await createResource(api, session, licenseKey, 'PRIVATE', 'VOCABULARY');
    await api
      .post('/api/v1/library/resources/' + privateResource + '/submit-contribution')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send(validSubmission())
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_CONTRIBUTION_PUBLIC_REQUIRED'));

    const disallowedResource = await createResource(api, session, licenseKey, 'PUBLIC', 'GRAMMAR_ITEM');
    await api
      .post('/api/v1/library/resources/' + disallowedResource + '/submit-contribution')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send(validSubmission())
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_CONTRIBUTION_TYPE_FORBIDDEN'));

    const staleTermsResource = await createResource(api, session, licenseKey, 'PUBLIC', 'SENTENCE');
    await api
      .post('/api/v1/library/resources/' + staleTermsResource + '/submit-contribution')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({ termsVersion: 'library-contribution-v0', rightsConfirmed: true, reuseConsent: true })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('LIBRARY_CONTRIBUTION_TERMS_STALE'));

    const stringConsentResource = await createResource(api, session, licenseKey, 'PUBLIC', 'TRANSLATION');
    await api
      .post('/api/v1/library/resources/' + stringConsentResource + '/submit-contribution')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({ termsVersion: 'library-contribution-v1', rightsConfirmed: 'true', reuseConsent: true })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('HTTP_400'));
  });

  async function createResource(
    api: { post(url: string): request.Test },
    session: TestSession,
    licenseKey: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    resourceType: 'VOCABULARY' | 'SENTENCE' | 'TRANSLATION' | 'GRAMMAR_ITEM',
  ): Promise<string> {
    const details = resourceType === 'VOCABULARY'
      ? { term: 'word', definition: 'meaning' }
      : resourceType === 'SENTENCE'
        ? { text: 'A sentence', context: 'context' }
        : resourceType === 'TRANSLATION'
          ? { sourceText: 'hello', translatedText: 'xin chào' }
          : { title: 'Grammar', explanation: 'Explanation' };
    const created = await api
      .post('/api/v1/library/resources')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({
        resourceType,
        primaryLanguageCode: 'en',
        ...(resourceType === 'TRANSLATION' ? { secondaryLanguageCode: 'vi' } : {}),
        visibility,
        details,
      })
      .expect(201);
    const id = created.body.data.id as string;
    await api
      .post('/api/v1/library/resources/' + id + '/provenance')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .send({
        sourceType: 'ORIGINAL_AUTHOR',
        sourceId: 'http-rejection-' + id,
        licenseKey,
        attribution: 'HTTP rejection owner',
      })
      .expect(201);
    return id;
  }

  async function registerLicense(
    key: string,
    active: boolean,
    redistributionAllowed: boolean | null,
    sourceNote = 'HTTP internal note',
  ): Promise<string> {
    const licenseKey = key + '-' + sequence++;
    await library.registerLicense(
      { userId: 'http-reviewer', roles: ['MODERATOR'] },
      {
        licenseKey,
        displayName: licenseKey,
        canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
        attributionRequired: true,
        redistributionAllowed,
        active,
        sourceNote,
      },
    );
    return licenseKey;
  }

  async function createUser(label: string): Promise<UserRecord> {
    return identity.createUser({
      email: `library-contribution-${label}-${sequence++}@example.com`,
      displayName: label,
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
  }

  async function sessionFor(user: UserRecord): Promise<TestSession> {
    const values: string[] = [];
    const response = {
      append(_header: string, value: string): void {
        values.push(value);
      },
    } as unknown as Response;
    const credentials = await sessions.issue(user, response);
    const cookieParts = values.map((value) => value.split(';')[0]);
    const csrfCookie = cookieParts.find((value) => value.startsWith('cdn_csrf='));
    if (!csrfCookie) throw new Error('The test session did not receive a CSRF cookie');
    return {
      ...credentials,
      cookie: cookieParts.join('; '),
      csrfToken: csrfCookie.slice('cdn_csrf='.length),
    };
  }
});

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
