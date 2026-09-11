import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { COMMUNITY_POST_TYPES } from '../src/community/community.types';

describe('community post API', () => {
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

  it('requires authentication and never accepts a browser-supplied author identity', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .send({
        authorUserId: '00000000-0000-4000-8000-000000000001',
        postType: 'DISCUSSION',
        languageCode: 'en',
        content: 'Unauthenticated',
      })
      .expect(401);

    const user = await createUser(identity, 'community-author-spoof@example.com', 'Spoof Test');
    const accessToken = await accessFor(sessions, user);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({
        authorUserId: '00000000-0000-4000-8000-000000000001',
        postType: 'DISCUSSION',
        languageCode: 'en',
        content: 'The author comes from the session.',
      })
      .expect(400);
  });

  it('creates every documented post type through the same learning-oriented contract', async () => {
    const user = await createUser(identity, 'community-types@example.com', 'Type Test');
    const accessToken = await accessFor(sessions, user);

    for (const [index, postType] of COMMUNITY_POST_TYPES.entries()) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/community/posts')
        .set('Authorization', 'Bearer ' + accessToken)
        .send({
          postType,
          languageCode: 'en',
          cefrLevel: index % 2 === 0 ? 'B1' : undefined,
          topic: 'Travel notes',
          content: 'Xin chào 世界 ' + postType,
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        postType,
        targetLanguage: { code: 'en' },
        content: 'Xin chào 世界 ' + postType,
        cefrLevel: index % 2 === 0 ? 'B1' : null,
        topic: 'travel-notes',
        isOwner: true,
      });
      expect(response.body.data.author).toEqual({
        id: user.id,
        displayName: 'Type Test',
      });
      expect(response.body.data.author.email).toBeUndefined();
      expect(response.body.data.moderationState).toBeUndefined();
    }
  });

  it('enforces owner-only update/delete and removes deleted posts from normal reads', async () => {
    const owner = await createUser(identity, 'community-owner@example.com', 'Owner');
    const other = await createUser(identity, 'community-other@example.com', 'Other');
    const ownerToken = await accessFor(sessions, owner);
    const otherToken = await accessFor(sessions, other);

    const created = await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({
        postType: 'DISCUSSION',
        languageCode: 'vi',
        content: 'Nội dung học tiếng Việt.',
      })
      .expect(201);
    const postId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ content: 'Tampered' })
      .expect(403);

    const updated = await request(app.getHttpServer())
      .patch('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Đã chỉnh sửa', userId: other.id })
      .expect(400);
    expect(updated.body.data).toBeUndefined();

    const validUpdate = await request(app.getHttpServer())
      .patch('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Đã chỉnh sửa', topic: null })
      .expect(200);
    expect(validUpdate.body.data.content).toBe('Đã chỉnh sửa');
    expect(validUpdate.body.data.editedAt).toBeTruthy();

    await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(403);
    await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual({ deleted: true }));

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items.some((item: { id: string }) => item.id === postId)).toBe(false);
      });
  });
});

async function createUser(
  identity: IdentityRepository,
  email: string,
  displayName: string,
) {
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
