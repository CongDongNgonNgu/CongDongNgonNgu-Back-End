import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('language exchange safety API', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let first: Awaited<ReturnType<typeof createUser>>;
  let second: Awaited<ReturnType<typeof createUser>>;
  let third: Awaited<ReturnType<typeof createUser>>;
  let firstToken: string;
  let secondToken: string;
  let thirdToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    first = await createUser(identity, 'safety-e2e-first@example.com', 'Safety First');
    second = await createUser(identity, 'safety-e2e-second@example.com', 'Safety Second');
    third = await createUser(identity, 'safety-e2e-third@example.com', 'Safety Third');
    firstToken = (await app.get(SessionService).issue(first, response())).accessToken;
    secondToken = (await app.get(SessionService).issue(second, response())).accessToken;
    thirdToken = (await app.get(SessionService).issue(third, response())).accessToken;
    await prepareProfile(app, firstToken, [
      { languageCode: 'vi', roles: ['native'], declaredProficiency: 'NATIVE' },
      { languageCode: 'en', roles: ['learning'], declaredProficiency: 'A1' },
    ]);
    await prepareProfile(app, secondToken, [
      { languageCode: 'en', roles: ['known'], declaredProficiency: 'C1' },
      { languageCode: 'vi', roles: ['learning'], declaredProficiency: 'A1' },
    ]);
    await preparePreferences(app, firstToken, ['vi'], ['en']);
    await preparePreferences(app, secondToken, ['en'], ['vi']);
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces pairwise blocking, actor-owned unblock, private reports, and contact denial', async () => {
    const server = app.getHttpServer();
    const base = '/api/v1/exchange';

    await request(server)
      .get(`${base}/blocks/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ blockedByMe: false }));

    await request(server)
      .post(`${base}/relationships/${second.id}/request`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('OUTGOING_PENDING'));

    await request(server)
      .post(`${base}/blocks/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ blocked: true, targetUserId: second.id }));

    await request(server)
      .get(`${base}/blocks/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.blockedByMe).toBe(true));
    await request(server)
      .get(`${base}/blocks/${first.id}`)
      .set('Authorization', 'Bearer ' + secondToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.blockedByMe).toBe(false));

    await request(server)
      .get(`${base}/profile-preview/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(404);
    await request(server)
      .get(`${base}/profile-preview/${first.id}`)
      .set('Authorization', 'Bearer ' + secondToken)
      .expect(404);
    await request(server)
      .get(`${base}/relationships/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(404);
    await request(server)
      .get(`${base}/contact-permission/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.decision).toBe('DENIED_BLOCKED'));
    await request(server)
      .get(`${base}/contact-permission/${first.id}`)
      .set('Authorization', 'Bearer ' + secondToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.decision).toBe('DENIED_INELIGIBLE'));

    await request(server)
      .post(`${base}/reports/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .send({ category: 'SAFETY_CONCERN', context: 'Please review privately.' })
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual({ scope: 'exchange-report', submitted: true }));
    await request(server)
      .post(`${base}/reports/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .send({ category: 'SAFETY_CONCERN', context: 'Duplicate should stay idempotent.' })
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual({ scope: 'exchange-report', submitted: true }));
    await request(server)
      .post(`${base}/reports/${first.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .send({ category: 'OTHER' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('EXCHANGE_SELF_REPORT'));
    await request(server)
      .post(`${base}/reports/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .send({ reporterUserId: third.id, category: 'OTHER' })
      .expect(400);

    await request(server)
      .delete(`${base}/blocks/${first.id}`)
      .set('Authorization', 'Bearer ' + secondToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.blocked).toBe(false));
    await request(server)
      .get(`${base}/profile-preview/${first.id}`)
      .set('Authorization', 'Bearer ' + secondToken)
      .expect(404);

    await request(server)
      .delete(`${base}/blocks/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.blocked).toBe(false));
    await request(server)
      .get(`${base}/relationships/${second.id}`)
      .set('Authorization', 'Bearer ' + firstToken)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ state: 'NONE', canRequest: true }));
  });
});

async function prepareProfile(app: INestApplication, token: string, languages: unknown[]) {
  await request(app.getHttpServer())
    .patch('/api/v1/profile')
    .set('Authorization', 'Bearer ' + token)
    .send({ languages, goals: ['conversation'], interests: ['music'] })
    .expect(200);
}

async function preparePreferences(app: INestApplication, token: string, offeredLanguageCodes: string[], wantedLanguageCodes: string[]) {
  await request(app.getHttpServer())
    .patch('/api/v1/exchange/preferences')
    .set('Authorization', 'Bearer ' + token)
    .send({ exchangeOptIn: true, discoverable: true, offeredLanguageCodes, wantedLanguageCodes })
    .expect(200);
}

async function createUser(repository: IdentityRepository, email: string, displayName: string) {
  return repository.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

function response(): Response {
  return { append(): void { return; } } as unknown as Response;
}
