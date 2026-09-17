import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('language exchange API', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let userA: Awaited<ReturnType<typeof createUser>>;
  let userB: Awaited<ReturnType<typeof createUser>>;
  let accessTokenA: string;
  let accessTokenB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    userA = await createUser(identity, 'exchange-api-a@example.com', 'Exchange API A');
    userB = await createUser(identity, 'exchange-api-b@example.com', 'Exchange API B');
    accessTokenA = (await app.get(SessionService).issue(userA, response())).accessToken;
    accessTokenB = (await app.get(SessionService).issue(userB, response())).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns conservative defaults and rejects unauthenticated or spoofed mutations', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/exchange/discovery')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          scope: 'own',
          exchangeOptIn: false,
          discoverable: false,
          offeredLanguageCodes: [],
          wantedLanguageCodes: [],
          timezoneVisibility: 'HIDDEN',
          availabilityVisibility: 'HIDDEN',
          contactPermission: 'NO_CONTACT',
        });
      });

    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .send({ exchangeOptIn: true })
      .expect(401);
    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .send({ userId: userB.id, exchangeOptIn: true })
      .expect(400);
  });

  it('updates canonical selections and returns a safe public buddy projection', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .send({
        languages: [
          { languageCode: 'vi', roles: ['native'], declaredProficiency: 'NATIVE' },
          { languageCode: 'en', roles: ['learning'], declaredProficiency: 'A1' },
        ],
        goals: ['conversation'],
        interests: ['music'],
        timezone: 'Asia/Ho_Chi_Minh',
        availability: [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }],
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .send({
        exchangeOptIn: true,
        discoverable: true,
        offeredLanguageCodes: ['vi'],
        wantedLanguageCodes: ['en'],
        preferredPartnerLevels: ['A1', 'B1'],
        matchingGoalCodes: ['conversation'],
        matchingInterestCodes: ['music'],
        timezoneVisibility: 'SUMMARY',
        availabilityVisibility: 'SUMMARY',
        contactPermission: 'RELATIONSHIP_GATED',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          exchangeOptIn: true,
          discoverable: true,
          offeredLanguageCodes: ['vi'],
          wantedLanguageCodes: ['en'],
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/exchange/profile-preview/' + userA.id)
      .set('Authorization', 'Bearer ' + accessTokenB)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.user).toEqual({ id: userA.id, displayName: userA.displayName });
        expect(body.data.languages.map((language: { code: string }) => language.code)).toEqual(['vi', 'en']);
        expect(body.data.goals).toEqual(['conversation']);
        expect(body.data.interests).toEqual(['music']);
        expect(body.data.timezoneSummary).toEqual({
          visibility: 'SUMMARY',
          identifier: 'Asia/Ho_Chi_Minh',
        });
        expect(body.data.availabilitySummary).toEqual({
          visibility: 'SUMMARY',
          hasAvailability: true,
        });
        expect(body.data.user.email).toBeUndefined();
        expect(body.data.email).toBeUndefined();
        expect(body.data.availability).toBeUndefined();
        expect(body.data.contact).toBeUndefined();
        expect(body.data.availabilitySummary.windows).toBeUndefined();
      });

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessTokenB)
      .send({
        languages: [
          { languageCode: 'en', roles: ['known'], declaredProficiency: 'C1' },
          { languageCode: 'vi', roles: ['learning'], declaredProficiency: 'A1' },
        ],
        goals: ['conversation'],
        interests: ['music'],
        timezone: 'Asia/Tokyo',
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenB)
      .send({
        exchangeOptIn: true,
        discoverable: true,
        offeredLanguageCodes: ['en'],
        wantedLanguageCodes: ['vi'],
        preferredPartnerLevels: ['A1'],
        matchingGoalCodes: ['conversation'],
        matchingInterestCodes: ['music'],
      })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/exchange/discovery?offeredLanguageCodes=en&page=1&pageSize=1')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.pagination).toEqual({ page: 1, pageSize: 1, totalItems: 1, totalPages: 1 });
        expect(body.data.candidates[0].user).toEqual({ id: userB.id, displayName: userB.displayName });
        expect(body.data.candidates[0].normalizedScore).toEqual(expect.any(Number));
        expect(body.data.candidates[0].reasons.join(' ')).toContain('English');
        expect(body.data.candidates[0].email).toBeUndefined();
        expect(body.data.candidates[0].availability).toBeUndefined();
        expect(body.data.candidates[0].timezone).toBeUndefined();
      });
  });

  it('makes opt-out ineligible, isolates users, and enforces cookie-backed CSRF', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .send({ exchangeOptIn: false })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/exchange/profile-preview/' + userA.id)
      .set('Authorization', 'Bearer ' + accessTokenB)
      .expect(404);

    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenB)
      .send({ discoverable: true })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + accessTokenA)
      .expect(200)
      .expect(({ body }) => expect(body.data.exchangeOptIn).toBe(false));

    const captured = capturedResponse();
    const session = await app.get(SessionService).issue(userA, captured.response);
    await request(app.getHttpServer())
      .patch('/api/v1/exchange/preferences')
      .set('Authorization', 'Bearer ' + session.accessToken)
      .set('Cookie', captured.cookies.map((cookie) => cookie.split(';')[0]).join('; '))
      .set('X-CSRF-Token', 'wrong-csrf')
      .send({ discoverable: false })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));
  });
});

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

function capturedResponse(): { response: Response; cookies: string[] } {
  const cookies: string[] = [];
  return {
    cookies,
    response: {
      append(name: string, value: string): void {
        if (name === 'Set-Cookie') cookies.push(value);
      },
    } as unknown as Response,
  };
}
