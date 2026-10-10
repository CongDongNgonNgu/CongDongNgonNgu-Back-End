import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { PostgresDirectConversationRepository } from '../src/messaging/postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from '../src/messaging/postgres-direct-message.repository';
import { PostgresMessageStreamRepository } from '../src/messaging/postgres-message-stream.repository';
import { MessageFailure } from '../src/messaging/message-failure';
import { normalizeMessagePayload, type MessagePayloadInput } from '../src/messaging/message-context';

// Transport/native-session proof only. Actual domain authorization, persistence
// and races are separately proved by the guarded PostgreSQL suites.
describe('Phase26 messaging HTTP and native authenticated SSE transport', () => {
  let app: INestApplication;
  let base: string;
  const conversationId = randomUUID();
  const actors: { id: string; token: string; sessionId: string }[] = [];
  const summary = { id: conversationId, partner: { userId: randomUUID(), displayName: 'Synthetic partner' },
    headSequence: '9007199254740993', changeVersion: '0', lastReadSequence: '0', unreadCount: '1', updatedAt: new Date().toISOString() };
  const conversations = { open: jest.fn().mockResolvedValue(summary), get: jest.fn().mockResolvedValue(summary),
    list: jest.fn().mockResolvedValue({ items: [summary], nextCursor: null }) };
  const messages = { send: jest.fn(async (actor: string, id: string, input: MessagePayloadInput & { clientMessageId: string }) => ({
    id: randomUUID(), conversationId: id, senderUserId: actor, sequence: '9007199254740993',
    text: normalizeMessagePayload(input).text, clientMessageId: input.clientMessageId, createdAt: new Date().toISOString() })),
    history: jest.fn().mockResolvedValue({ items: [], nextCursor: null, beforeCursor: 'synthetic-before', afterCursor: 'synthetic-after' }),
    context: jest.fn(async (_actor: string, _id: string, messageId: string) => ({ messageId, context: { availability: 'UNAVAILABLE' } })),
    markRead: jest.fn().mockResolvedValue(undefined) };
  const streams = { acquire: jest.fn(async (actor: string, id: string, sessionId: string) => ({
    id: randomUUID(), ownerToken: randomUUID(), actor, conversationId: id, sessionId })),
    poll: jest.fn().mockResolvedValue('0'), release: jest.fn().mockResolvedValue(undefined) };
  const response = { append: () => undefined } as unknown as Response;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PostgresDirectConversationRepository).useValue(conversations)
      .overrideProvider(PostgresDirectMessageRepository).useValue(messages)
      .overrideProvider(PostgresMessageStreamRepository).useValue(streams).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    for (const name of ['Synthetic message actor', 'Synthetic reply actor']) {
      const user = await identity.createUser({ email: randomUUID() + '@phase26.invalid', displayName: name,
        passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date() });
      const session = await app.get(SessionService).issue(user, response);
      actors.push({ id: user.id, token: session.accessToken, sessionId: session.sessionId });
    }
  });
  afterAll(async () => { await app?.close(); });
  const path = () => '/api/v1/exchange/conversations/' + conversationId;
  const auth = () => 'Bearer ' + actors[0].token;

  it('requires native bearer auth and rejects query-string credentials', async () => {
    await request(app.getHttpServer()).get('/api/v1/exchange/conversations').expect(401);
    await request(app.getHttpServer()).get(path() + '/stream').query({ token: actors[0].token }).expect(401);
    await request(app.getHttpServer()).get(path() + '/stream').set('Authorization', auth())
      .query({ token: 'synthetic-forbidden-query-token' }).expect(400);
  });

  it('forbids forged sender, assigned sequence, context and read-owner fields', async () => {
    const valid = { clientMessageId: randomUUID(), text: 'Hello' };
    for (const extra of [{ senderUserId: actors[1].id }, { sequence: '1' }, { context: { id: randomUUID() } }]) {
      await request(app.getHttpServer()).post(path() + '/messages').set('Authorization', auth()).send({ ...valid, ...extra }).expect(400);
    }
    await request(app.getHttpServer()).post(path() + '/read').set('Authorization', auth())
      .send({ sequence: '1', userId: actors[1].id }).expect(400);
    expect(messages.send).not.toHaveBeenCalled();
    expect(messages.markRead).not.toHaveBeenCalled();
  });

  it('passes actor-owned typed inputs and preserves normalized text and exact bigint strings', async () => {
    await request(app.getHttpServer()).post('/api/v1/exchange/conversations').set('Authorization', auth())
      .send({ partnerUserId: actors[1].id }).expect(201);
    expect(conversations.open).toHaveBeenCalledWith(actors[0].id, actors[1].id);
    const input = { clientMessageId: randomUUID(), text: '  ' + '🌏'.repeat(4000) + '  ' };
    await request(app.getHttpServer()).post(path() + '/messages').set('Authorization', auth()).send(input).expect(201)
      .expect(({ body }) => {
        expect(body.data.sequence).toBe('9007199254740993');
        expect([...body.data.text]).toHaveLength(4000);
        expect(body.data.senderUserId).toBe(actors[0].id);
      });
    expect(messages.send).toHaveBeenCalledWith(actors[0].id, conversationId, expect.objectContaining(input));
    await request(app.getHttpServer()).post(path() + '/read').set('Authorization', auth())
      .send({ sequence: '9007199254740993' }).expect(200);
    expect(messages.markRead).toHaveBeenCalledWith(actors[0].id, conversationId, '9007199254740993');
  });

  it('accepts only typed context fields and routes complete payloads through the authenticated actor', async () => {
    for (const contextType of ['LIBRARY_RESOURCE', 'COMMUNITY_POST']) {
      const input = { clientMessageId: randomUUID(), contextType, contextId: randomUUID() };
      await request(app.getHttpServer()).post(path() + '/messages').set('Authorization', auth())
        .send(input).expect(201).expect(({ body }) => expect(body.data.text).toBe(''));
      expect(messages.send).toHaveBeenLastCalledWith(actors[0].id, conversationId, expect.objectContaining(input));
    }
    const before = messages.send.mock.calls.length;
    for (const context of [{ contextType: 'ARBITRARY_URL', contextId: randomUUID() },
      { contextType: 'LIBRARY_RESOURCE', contextId: 'https://example.invalid' },
      { contextType: ['COMMUNITY_POST'], contextId: randomUUID() },
      { contextType: 'COMMUNITY_POST', contextId: randomUUID(), previewText: 'forged' }])
      await request(app.getHttpServer()).post(path() + '/messages').set('Authorization', auth())
        .send({ clientMessageId: randomUUID(), ...context }).expect(400);
    expect(messages.send.mock.calls).toHaveLength(before);
    // Partial references and empty content pass DTO shape checks but must fail
    // at the domain boundary, also exercised by the guarded SQL suites.
    for (const payload of [{}, { contextType: 'LIBRARY_RESOURCE' }, { contextId: randomUUID() }])
      await request(app.getHttpServer()).post(path() + '/messages').set('Authorization', auth())
        .send({ clientMessageId: randomUUID(), ...payload }).expect(400);
  });

  it('reauthorizes individual cards with native bearer and actor-scoped UUIDs without private caching', async () => {
    const messageId = randomUUID();
    const contextPath = path() + '/messages/' + messageId + '/context';
    await request(app.getHttpServer()).get(contextPath).expect(401);
    await request(app.getHttpServer()).get(contextPath).set('Authorization', auth())
      .expect(200).expect('Cache-Control', 'private, no-store')
      .expect(({ body }) => expect(body.data).toEqual({ messageId, context: { availability: 'UNAVAILABLE' } }));
    expect(messages.context).toHaveBeenLastCalledWith(actors[0].id, conversationId, messageId);
    await request(app.getHttpServer()).get(path() + '/messages/not-a-uuid/context').set('Authorization', auth()).expect(400);
  });

  it('validates list/history query boundaries and disables private response caching', async () => {
    await request(app.getHttpServer()).get('/api/v1/exchange/conversations').set('Authorization', auth())
      .query({ limit: 50, cursor: 'synthetic-list-cursor' }).expect(200).expect('Cache-Control', 'private, no-store');
    expect(conversations.list).toHaveBeenCalledWith(actors[0].id, expect.objectContaining({ limit: 50, cursor: 'synthetic-list-cursor' }));
    await request(app.getHttpServer()).get(path() + '/messages').set('Authorization', auth())
      .query({ limit: 30, after: 'synthetic-catchup-cursor' }).expect(200);
    expect(messages.history).toHaveBeenCalledWith(actors[0].id, conversationId, expect.objectContaining({ limit: 30, after: 'synthetic-catchup-cursor' }));
    for (const suffix of ['?limit=51', '?limit=0', '?limit=1.5', '?unknown=true'])
      await request(app.getHttpServer()).get(path() + '/messages' + suffix).set('Authorization', auth()).expect(400);
    await request(app.getHttpServer()).get('/api/v1/exchange/conversations/not-a-uuid').set('Authorization', auth()).expect(400);
    await request(app.getHttpServer()).post(path() + '/read').set('Authorization', auth()).send({ sequence: 1 }).expect(400);
  });

  it('allows Last-Event-ID under the existing approved Origin and rejects disallowed stream Origin before acquisition', async () => {
    const before = streams.acquire.mock.calls.length;
    await request(app.getHttpServer()).get(path() + '/stream').set('Authorization', auth())
      .set('Origin', 'https://unapproved.phase26.invalid').expect(403);
    expect(streams.acquire.mock.calls).toHaveLength(before);
    await request(app.getHttpServer()).options(path() + '/stream').set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization,last-event-id')
      .expect(204).expect('Access-Control-Allow-Origin', 'http://localhost:5173')
      .expect(({ headers }) => expect(String(headers['access-control-allow-headers']).toLowerCase()).toContain('last-event-id'));
  });

  it('returns setup rate limits as structured HTTP429 before SSE headers', async () => {
    streams.acquire.mockRejectedValueOnce(new MessageFailure('MESSAGE_STREAM_RATE_LIMITED', 429, 'Too many stream attempts', 17));
    await request(app.getHttpServer()).get(path() + '/stream').set('Authorization', auth())
      .expect(429).expect('Retry-After', '17').expect(({ body }) => expect(body.error.code).toBe('MESSAGE_STREAM_RATE_LIMITED'));
    await request(app.getHttpServer()).get(path() + '/stream').set('Authorization', auth())
      .set('Last-Event-ID', '01').expect(400);
  });

  it('uses real fetch SSE headers and closes after current native session revocation', async () => {
    const controller = new AbortController();
    const actor = actors[1];
    const result = await fetch(base + path() + '/stream', { signal: controller.signal,
      headers: { Authorization: 'Bearer ' + actor.token, Origin: 'http://localhost:5173', 'Last-Event-ID': '0' } });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    expect(result.headers.get('cache-control')).toContain('no-transform');
    const reader = result.body!.getReader();
    let received = '';
    try {
      while (!received.includes('event: hint')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain('data: {"version":"0"}');
      expect(received).not.toContain('Synthetic');
      await app.get(SessionService).logout(actor.sessionId, response);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).not.toContain('event: error');
      expect(streams.release).toHaveBeenCalledWith(expect.objectContaining({ actor: actor.id, sessionId: actor.sessionId }));
    } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
  }, 10_000);
});
