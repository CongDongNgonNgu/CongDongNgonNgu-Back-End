import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { AppConfigModule } from '../src/config/config.module';
import { configureApp } from '../src/app.setup';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import { InMemoryIdentityRepository } from '../src/identity/identity.repository';
import { NotificationModule } from '../src/notifications/notification.module';
import {
  InMemoryNotificationRepository,
  NOTIFICATION_REPOSITORY,
} from '../src/notifications/notification.repository';
import { createNotificationIntent } from '../src/notifications/notification.contracts';
import { NotificationService } from '../src/notifications/notification.service';
import { SessionService } from '../src/auth/session/session.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

describe('notifications API', () => {
  let app: INestApplication;
  let identity: InMemoryIdentityRepository;
  let notificationRepository: InMemoryNotificationRepository;
  let sessions: SessionService;

  beforeAll(async () => {
    process.env.AUTH_PERSISTENCE = 'memory';
    identity = new InMemoryIdentityRepository();
    notificationRepository = new InMemoryNotificationRepository();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, NotificationModule],
    })
      .overrideProvider(IDENTITY_REPOSITORY)
      .useValue(identity)
      .overrideProvider(NOTIFICATION_REPOSITORY)
      .useValue(notificationRepository)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists owner notifications, reconciles unread count, and marks one read idempotently', async () => {
    const user = await createUser('notifications-owner@example.com');
    const credentials = await issueAccessToken(user);
    await expect(sessions.authenticate(credentials.accessToken)).resolves.toMatchObject({ user: { id: user.id } });
    const notificationService = app.get(NotificationService);
    const claim = await notificationService.publish(buildIntent(user.id));
    expect(claim.outcome).toBe('CREATED');
    if (claim.outcome !== 'CREATED') throw new Error('notification claim setup failed');

    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${credentials.accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            items: [expect.objectContaining({ id: claim.record.id, read: false })],
            unreadCount: 1,
          },
        });
        expect(body.data.items[0]).not.toHaveProperty('recipientUserId');
        expect(body.data.items[0].target).not.toHaveProperty('id');
      });

    await request(app.getHttpServer())
      .post('/api/v1/notifications/' + claim.record.id + '/read')
      .set('Authorization', `Bearer ${credentials.accessToken}`)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ success: true, data: { notificationId: claim.record.id, read: true } });
      });

    await request(app.getHttpServer())
      .post('/api/v1/notifications/' + claim.record.id + '/read')
      .set('Authorization', `Bearer ${credentials.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${credentials.accessToken}`)
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual({ unreadCount: 0 }));
  });

  it('does not allow another owner to read a notification by id', async () => {
    const owner = await createUser('notifications-owner-two@example.com');
    const other = await createUser('notifications-other@example.com');
    const ownerCredentials = await issueAccessToken(owner);
    const otherCredentials = await issueAccessToken(other);
    const claim = await app.get(NotificationService).publish(buildIntent(owner.id, '44444444-4444-4444-8444-444444444444'));
    if (claim.outcome !== 'CREATED') throw new Error('notification claim setup failed');

    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${otherCredentials.accessToken}`)
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toEqual([]));

    await request(app.getHttpServer())
      .post('/api/v1/notifications/' + claim.record.id + '/read')
      .set('Authorization', `Bearer ${otherCredentials.accessToken}`)
      .expect(404)
      .expect(({ body }) => expect(body.error).toMatchObject({ code: 'NOTIFICATION_NOT_FOUND' }));

    await request(app.getHttpServer())
      .post('/api/v1/notifications/read')
      .set('Authorization', `Bearer ${ownerCredentials.accessToken}`)
      .send({ notificationIds: [claim.record.id] })
      .expect(201)
      .expect(({ body }) => expect(body.data).toMatchObject({ updatedCount: 1, unreadCount: 0 }));
  });

  async function createUser(email: string) {
    return identity.createUser({
      email,
      displayName: 'Notification Test User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
  }

  async function issueAccessToken(user: Awaited<ReturnType<typeof createUser>>) {
    const response = { append: () => undefined } as unknown as Response;
    return sessions.issue(user, response);
  }
});

function buildIntent(recipientUserId: string, eventId = USER_ID) {
  return createNotificationIntent({
    event: {
      eventId,
      eventType: 'community.comment.created',
      eventVersion: 1,
      aggregateType: 'COMMUNITY_COMMENT',
      aggregateId: '55555555-5555-4555-8555-555555555555',
      actor: { kind: 'USER', userId: ACTOR_ID },
      recipient: { authority: 'SOURCE_DOMAIN', userId: recipientUserId },
      occurredAt: '2026-10-01T03:00:00.000Z',
      correlationId: '66666666-6666-4666-8666-666666666666',
      causationId: null,
      idempotencyKey: 'community.comment.created:e2e:' + recipientUserId,
      payload: {
        target: { kind: 'COMMUNITY_POST', id: POST_ID, path: `/community/posts/${POST_ID}` },
        variables: { commentPreview: 'A bounded test notification' },
      },
    },
    notificationType: 'COMMENT_REPLY',
    category: 'COMMUNITY',
    priority: 'NORMAL',
    actor: { kind: 'USER', displayName: 'Notification Actor', profilePath: `/profiles/${ACTOR_ID}` },
    retention: { mode: 'DAYS', days: 180 },
  });
}
