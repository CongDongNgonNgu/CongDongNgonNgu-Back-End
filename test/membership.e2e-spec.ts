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

    await request(app.getHttpServer())
      .get('/api/v1/membership/policy?planCode=COMMUNITY_MEMBER')
      .set('Authorization', 'Bearer ' + accessToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          version: 'membership-policy-v1',
          tier: 'FREE',
          plan: { productCode: 'FREE', version: 1 },
        });
        expect(body.data.capabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({ featureKey: 'community.public', decision: 'GRANTED' }),
          expect.objectContaining({ featureKey: 'library.public', decision: 'GRANTED' }),
          expect.objectContaining({ featureKey: 'exchange.basic', decision: 'GRANTED' }),
          expect.objectContaining({ featureKey: 'ai.practice', decision: 'GRANTED', limit: 20_000 }),
          expect.objectContaining({ featureKey: 'practice.advanced', decision: 'DENIED' }),
        ]));
      });

    await request(app.getHttpServer())
      .get('/api/v1/membership/contribution-credit?userId=another-user')
      .set('Authorization', 'Bearer ' + accessToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          contractVersion: 'membership-contribution-credit-v1',
          type: 'MEMBERSHIP_ELIGIBILITY_CREDIT',
          availableCreditUnits: 0,
          redemption: {
            mode: 'SERVER_AUTHORITATIVE_IDEMPOTENT',
            grantsMembership: true,
            actsAsPaymentTender: false,
            period: 'ONE_MONTH_PER_CREDIT_UNIT',
          },
        });
      });

    await request(app.getHttpServer())
      .post('/api/v1/membership/contribution-credit/redemptions')
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Idempotency-Key', 'credit-api-001')
      .send({ planVersionId: '33333333-3333-4333-8333-333333333333', creditUnits: 1 })
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/membership/contribution-credit/redemptions')
      .set('Idempotency-Key', 'credit-api-002')
      .send({ planVersionId: '33333333-3333-4333-8333-333333333333', creditUnits: 1 })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/membership/webhooks/payos')
      .send({})
      .expect(503);
  });
});

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
