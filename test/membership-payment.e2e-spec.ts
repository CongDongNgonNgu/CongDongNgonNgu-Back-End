import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { SessionService } from '../src/auth/session/session.service';
import {
  MEMBERSHIP_PAYMENT_PROVIDER,
  type CreateMembershipCheckoutInput,
  type MembershipPaymentProvider,
} from '../src/membership/membership.payment-provider';
import {
  InMemoryMembershipPaymentRepository,
  MEMBERSHIP_PAYMENT_REPOSITORY,
} from '../src/membership/membership.payment.repository';
import type { MembershipPaymentCatalogEntry } from '../src/membership/membership.payment.types';

const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const PRICE_ID = '44444444-4444-4444-8444-444444444444';

const catalogEntry: MembershipPaymentCatalogEntry = {
  planVersionId: PLAN_ID,
  productCode: 'COMMUNITY_MEMBER',
  productStatus: 'ACTIVE',
  planVersion: 1,
  planStatus: 'ACTIVE',
  planDisplayName: 'Community Member',
  price: {
    id: PRICE_ID,
    planVersionId: PLAN_ID,
    code: 'MONTHLY',
    status: 'ACTIVE',
    amountMinor: 125000n,
    currency: 'VND',
    periodUnit: 'MONTH',
    periodCount: 1,
    availableFrom: new Date('2026-09-01T00:00:00.000Z'),
    availableUntil: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  },
};

class E2ePaymentProvider implements MembershipPaymentProvider {
  readonly code = 'e2e-provider';

  isAvailable(): boolean {
    return true;
  }

  async createCheckout(_input: CreateMembershipCheckoutInput) {
    return {
      providerReference: 'e2e-provider-reference',
      checkoutUrl: 'https://pay.example/e2e-checkout',
    };
  }
}

describe('membership checkout/payment API', () => {
  let app: INestApplication;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const repository = new InMemoryMembershipPaymentRepository({ catalog: [catalogEntry] });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEMBERSHIP_PAYMENT_REPOSITORY)
      .useValue(repository)
      .overrideProvider(MEMBERSHIP_PAYMENT_PROVIDER)
      .useClass(E2ePaymentProvider)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    const sessions = app.get(SessionService);
    const user = await identity.createUser({
      email: 'membership-payment-api@example.com',
      displayName: 'Payment API User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const other = await identity.createUser({
      email: 'membership-payment-other@example.com',
      displayName: 'Other Payment User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    accessToken = (await sessions.issue(user, response())).accessToken;
    otherAccessToken = (await sessions.issue(other, response())).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes a public server catalog without payment or persistence internals', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/membership/catalog')
      .expect(200);

    expect(response.body.data).toMatchObject({
      free: {
        productCode: 'FREE',
        displayName: 'Free',
      },
      plans: [{
        planVersionId: PLAN_ID,
        price: { id: PRICE_ID, amountMinor: '125000', currency: 'VND' },
      }],
    });
    expect(response.body.data.plans[0].price).not.toHaveProperty('availableFrom');
    expect(JSON.stringify(response.body.data)).not.toMatch(/provider|webhook|userId|raw_payload/iu);
  });

  it('rejects unauthenticated access and client-controlled trusted fields', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/membership/orders')
      .set('Idempotency-Key', 'api-key-001')
      .send({ planVersionId: PLAN_ID, priceId: PRICE_ID })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/membership/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'api-key-002')
      .send({
        planVersionId: PLAN_ID,
        priceId: PRICE_ID,
        amountMinor: 1,
        currency: 'USD',
        status: 'PAID',
      })
      .expect(400);
  });

  it('returns only server-derived order facts and keeps order ownership private', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/membership/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'api-key-003')
      .send({ planVersionId: PLAN_ID, priceId: PRICE_ID })
      .expect(201);

    expect(created.body.data.order).toMatchObject({
      status: 'PENDING_PAYMENT',
      product: { code: 'COMMUNITY_MEMBER', planVersion: 1 },
      price: { amountMinor: '125000', currency: 'VND' },
      attempt: null,
    });
    expect(created.body.data.order.amountMinor).toBeUndefined();
    expect(created.body.data.order.userId).toBeUndefined();

    const orderId = created.body.data.order.id as string;
    await request(app.getHttpServer())
      .get(`/api/v1/membership/orders/${orderId}`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .expect(404);

    const attempt = await request(app.getHttpServer())
      .post(`/api/v1/membership/orders/${orderId}/payment-attempts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'api-key-004')
      .expect(201);

    expect(attempt.body.data).toMatchObject({
      orderId,
      status: 'PENDING',
      amountMinor: '125000',
      checkoutUrl: 'https://pay.example/e2e-checkout',
    });
    expect(attempt.body.data.providerReference).toBeUndefined();
  });
});

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
