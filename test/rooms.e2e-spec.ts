import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('speaking room presence API', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let sessions: SessionService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires authentication and derives participant ownership from the session', async () => {
    const host = await createUser(identity, 'rooms-api-host@example.test', 'Room Host');
    const hostToken = await accessFor(sessions, host);
    const created = await request(app.getHttpServer())
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ languageCode: 'en', topic: 'Presence API', capacity: 3 })
      .expect(201);
    const roomId = created.body.data.room.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .send({
        requestId: '00000000-0000-4000-8000-000000000201',
        deviceId: 'unauthenticated-browser',
      })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000202',
        deviceId: 'host-browser',
        role: 'MODERATOR',
        userId: '00000000-0000-4000-8000-000000000999',
      })
      .expect(400);

    const joined = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000202',
        deviceId: 'host-browser',
      })
      .expect(201);

    expect(joined.body.data.participant.role).toBe('HOST');
    expect(joined.body.data.participant.displayName).toBe('Room Host');
    expect(joined.body.data.participant.participantId).toEqual(expect.any(String));
  });

  it('prevents cross-user leave and exposes only bounded participant projections', async () => {
    const host = await createUser(identity, 'rooms-api-owner@example.test', 'Room Owner');
    const listener = await createUser(identity, 'rooms-api-listener@example.test', 'Room Listener');
    const hostToken = await accessFor(sessions, host);
    const listenerToken = await accessFor(sessions, listener);
    const created = await request(app.getHttpServer())
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ languageCode: 'en', topic: 'Ownership boundary', capacity: 3 })
      .expect(201);
    const roomId = created.body.data.room.id as string;

    const hostJoin = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000203',
        deviceId: 'owner-browser',
      })
      .expect(201);
    const hostParticipantId = hostJoin.body.data.participant.participantId as string;

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000204',
        deviceId: 'listener-browser',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/rooms/' + roomId + '/participants')
      .set('Authorization', 'Bearer ' + listenerToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.counts).toEqual({ participantCount: 2, speakerCount: 1, listenerCount: 1 });
        expect(body.data.participants).toEqual(expect.arrayContaining([
          expect.objectContaining({ displayName: 'Room Owner', role: 'HOST', participantId: null }),
          expect.objectContaining({ displayName: 'Room Listener', role: 'LISTENER' }),
        ]));
        expect(body.data.participants[0].userId).toBeUndefined();
        expect(body.data.participants[0].email).toBeUndefined();
      });

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/leave')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000205',
        participantId: hostParticipantId,
      })
      .expect(404);
  });

  it('keeps private-room join behind the server-validated access token', async () => {
    const host = await createUser(identity, 'rooms-api-private-host@example.test', 'Private Host');
    const guest = await createUser(identity, 'rooms-api-private-guest@example.test', 'Private Guest');
    const hostToken = await accessFor(sessions, host);
    const guestToken = await accessFor(sessions, guest);
    const created = await request(app.getHttpServer())
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ languageCode: 'en', topic: 'Private presence', visibility: 'PRIVATE' })
      .expect(201);
    const roomId = created.body.data.room.id as string;
    const privateAccessToken = created.body.data.privateAccessToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + guestToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000206',
        deviceId: 'guest-browser',
      })
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + guestToken)
      .set('x-room-access-token', privateAccessToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000207',
        deviceId: 'guest-browser',
      })
      .expect(201);
  });

  it('enforces host moderation, deterministic queue replay, room safety and bounded chat projections', async () => {
    const host = await createUser(identity, 'rooms-api-13c-host@example.test', '13C Host');
    const listener = await createUser(identity, 'rooms-api-13c-listener@example.test', '13C Listener');
    const hostToken = await accessFor(sessions, host);
    const listenerToken = await accessFor(sessions, listener);
    const created = await request(app.getHttpServer())
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ languageCode: 'en', topic: 'Queue and moderation', capacity: 4 })
      .expect(201);
    const roomId = created.body.data.room.id as string;

    const hostJoin = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000401',
        deviceId: '13c-host-browser',
      })
      .expect(201);
    const listenerJoin = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/join')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000402',
        deviceId: '13c-listener-browser',
      })
      .expect(201);
    const listenerParticipantId = listenerJoin.body.data.participant.participantId as string;

    const raisePayload = {
      requestId: '00000000-0000-4000-8000-000000000403',
    };
    const [raised, replayed] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/rooms/' + roomId + '/queue/raise-hand')
        .set('Authorization', 'Bearer ' + listenerToken)
        .send(raisePayload),
      request(app.getHttpServer())
        .post('/api/v1/rooms/' + roomId + '/queue/raise-hand')
        .set('Authorization', 'Bearer ' + listenerToken)
        .send(raisePayload),
    ]);
    expect(raised.status).toBe(201);
    expect(replayed.status).toBe(201);
    expect(raised.body.data.items[0].queueEntryId).toBe(replayed.body.data.items[0].queueEntryId);

    const queue = await request(app.getHttpServer())
      .get('/api/v1/rooms/' + roomId + '/queue')
      .set('Authorization', 'Bearer ' + hostToken)
      .expect(200);
    const queueEntryId = queue.body.data.items[0].queueEntryId as string;
    expect(queue.body.data.items[0].participantId).toBe(listenerParticipantId);

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/queue/' + queueEntryId + '/decision')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000404',
        decision: 'ACCEPT',
      })
      .expect(403);

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/queue/' + queueEntryId + '/decision')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000405',
        decision: 'ACCEPT',
      })
      .expect(201);
    expect(accepted.body.data.participant.role).toBe('SPEAKER');

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/participants/' + listenerParticipantId + '/mute')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({ requestId: '00000000-0000-4000-8000-000000000406' })
      .expect(403);

    const muted = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/participants/' + listenerParticipantId + '/mute')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ requestId: '00000000-0000-4000-8000-000000000407', durationSeconds: 120 })
      .expect(201);
    expect(muted.body.data.participant.muted).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/chat')
      .set('Authorization', 'Bearer ' + listenerToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000408',
        content: '<script>chat text</script>',
      })
      .expect(201);
    const chat = await request(app.getHttpServer())
      .get('/api/v1/rooms/' + roomId + '/chat')
      .set('Authorization', 'Bearer ' + hostToken)
      .expect(200);
    expect(chat.body.data.items[0]).toMatchObject({
      displayName: '13C Listener',
      body: '<script>chat text</script>',
      own: false,
    });
    expect(chat.body.data.items[0].authorUserId).toBeUndefined();

    await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/participants/' + listenerParticipantId + '/block')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({ requestId: '00000000-0000-4000-8000-000000000409' })
      .expect(201);
    expect((await request(app.getHttpServer())
      .get('/api/v1/rooms/' + roomId + '/chat')
      .set('Authorization', 'Bearer ' + hostToken)
      .expect(200)).body.data.items).toHaveLength(0);

    const report = await request(app.getHttpServer())
      .post('/api/v1/rooms/' + roomId + '/participants/' + listenerParticipantId + '/report')
      .set('Authorization', 'Bearer ' + hostToken)
      .send({
        requestId: '00000000-0000-4000-8000-000000000410',
        category: 'SAFETY_CONCERN',
        details: 'bounded test report',
      })
      .expect(201);
    expect(report.body.data).toMatchObject({ scope: 'room-report', submitted: true });
    expect(report.body.data.duplicate).toBeUndefined();

    const audit = await request(app.getHttpServer())
      .get('/api/v1/rooms/' + roomId + '/moderation/audit')
      .set('Authorization', 'Bearer ' + hostToken)
      .expect(200);
    expect(audit.body.data.items.map((item: { action: string }) => item.action))
      .toEqual(expect.arrayContaining(['ACCEPT_QUEUE', 'MUTE', 'BLOCK', 'REPORT']));
    expect(JSON.stringify(audit.body.data)).not.toContain('bounded test report');
  });
});

async function createUser(identity: IdentityRepository, email: string, displayName: string) {
  return identity.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

async function accessFor(sessions: SessionService, user: Awaited<ReturnType<typeof createUser>>) {
  return (await sessions.issue(user, response())).accessToken;
}

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
