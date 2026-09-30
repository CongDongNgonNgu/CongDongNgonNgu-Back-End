import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { SessionService } from '../src/auth/session/session.service';

describe('membership capability API', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    const user = await identity.createUser({
      email: 'membership-api@example.com',
      displayName: 'Membership API User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    accessToken = (await app.get(SessionService).issue(user, response())).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('protects the capability projection and returns server-derived Free defaults', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/membership/capabilities')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/membership/capabilities?planCode=COMMUNITY_MEMBER')
      .set('Authorization', 'Bearer ' + accessToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          plan: { productCode: 'FREE', version: 1, status: 'ACTIVE' },
          membership: { status: 'DEFAULT_FREE', source: 'DEFAULT_FREE' },
          entitlements: [],
        });
        expect(body.data.evaluatedAt).toEqual(expect.any(String));
      });
  });
});

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
