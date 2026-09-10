import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { PROFILE_REPOSITORY } from '../src/profile/profile.repository';
import { InMemoryProfileRepository } from '../src/profile/profile.repository';
import { SessionService } from '../src/auth/session/session.service';

describe('profile API', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let profiles: InMemoryProfileRepository;
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    profiles = app.get<InMemoryProfileRepository>(PROFILE_REPOSITORY);
    const user = await identity.createUser({
      email: 'profile-api@example.com',
      displayName: 'Profile API User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    userId = user.id;
    accessToken = (await app.get(SessionService).issue(user, response())).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the seeded catalog and updates only the authenticated user profile', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/languages')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toHaveLength(8);
        expect(body.data[0]).toMatchObject({
          code: 'vi',
          slug: 'vietnamese',
          launch: true,
          active: true,
        });
      });

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({
        userId: 'another-user',
        displayName: 'Updated Profile API User',
        languages: [
          { languageCode: 'en', roles: ['learning'], declaredProficiency: 'B1' },
          {
            languageCode: 'ja',
            roles: ['learning'],
            declaredProficiency: 'A2',
            visibility: 'PRIVATE',
            isPrimaryLearningTarget: true,
          },
        ],
        goals: ['conversation', 'travel'],
        skills: ['speaking', 'listening'],
        interests: ['music'],
        timezone: 'Asia/Ho_Chi_Minh',
        availability: [{ dayOfWeek: 1, startTime: '23:00', endTime: '24:00' }],
      })
      .expect(400);

    const update = await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({
        displayName: 'Updated Profile API User',
        languages: [
          { languageCode: 'en', roles: ['learning'], declaredProficiency: 'B1' },
          {
            languageCode: 'ja',
            roles: ['learning'],
            declaredProficiency: 'A2',
            visibility: 'PRIVATE',
            isPrimaryLearningTarget: true,
          },
        ],
        goals: ['conversation', 'travel'],
        skills: ['speaking', 'listening'],
        interests: ['music'],
        timezone: 'Asia/Ho_Chi_Minh',
        availability: [{ dayOfWeek: 1, startTime: '23:00', endTime: '24:00' }],
      })
      .expect(200);
    expect(update.body.data.user.displayName).toBe('Updated Profile API User');
    expect(update.body.data.languages).toHaveLength(2);

    await request(app.getHttpServer())
      .get('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.user.email).toBe('profile-api@example.com');
        expect(body.data.timezone).toBe('Asia/Ho_Chi_Minh');
        expect(body.data.availability).toEqual([
          { dayOfWeek: 1, startTime: '23:00', endTime: '24:00' },
        ]);
      });
  });

  it('returns a public projection without private language or availability details', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/profiles/' + userId)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.user).toEqual({ id: userId, displayName: 'Updated Profile API User' });
        expect(body.data.languages.map((language: { code: string }) => language.code)).toEqual(['en']);
        expect(body.data.user.email).toBeUndefined();
        expect(body.data.timezone).toBeUndefined();
        expect(body.data.availability).toBeUndefined();
        expect(body.data.roles).toBeUndefined();
        expect(body.data.languages[0].visibility).toBeUndefined();
      });
  });

  it('rejects unauthorized or malformed profile updates at the API boundary', async () => {
    const otherUser = await identity.createUser({
      email: 'other-profile-api@example.com',
      displayName: 'Other Profile API User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const otherAccessToken = (await app.get(SessionService).issue(otherUser, response())).accessToken;
    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + otherAccessToken)
      .send({
        languages: [{ languageCode: 'en', roles: ['learning'], declaredProficiency: 'A1' }],
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .send({ goals: ['conversation'] })
      .expect(401);

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({ languages: [
        { languageCode: 'en', roles: ['learning'], declaredProficiency: 'A1' },
        { languageCode: 'en', roles: ['known'], declaredProficiency: 'B1' },
      ] })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('PROFILE_DUPLICATE_LANGUAGE'));

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({
        userId: otherUser.id,
        languages: [{ languageCode: 'fr', roles: ['learning'], declaredProficiency: 'A1' }],
      })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/profiles/' + otherUser.id)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.languages.map((language: { code: string }) => language.code)).toEqual(['en']);
      });

    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({ languages: [
        { languageCode: 'xx', roles: ['learning'], declaredProficiency: 'A1' },
      ] })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('PROFILE_LANGUAGE_UNKNOWN'));

    await profiles.setActive('fr', false);
    await request(app.getHttpServer())
      .patch('/api/v1/profile')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({ languages: [
        { languageCode: 'fr', roles: ['learning'], declaredProficiency: 'A1' },
      ] })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('PROFILE_LANGUAGE_INACTIVE'));
    await profiles.setActive('fr', true);

    await request(app.getHttpServer())
      .get('/api/v1/languages?limit=100')
      .expect(400);
  });
});

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
