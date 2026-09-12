import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { COMMUNITY_REPOSITORY, type CommunityRepository } from '../src/community/community.repository';
import { CommunityRateLimiter } from '../src/community/community.rate-limiter';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('community interaction API', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let sessions: SessionService;
  let repository: CommunityRepository;
  let rateLimiter: CommunityRateLimiter;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    sessions = app.get(SessionService);
    repository = app.get<CommunityRepository>(COMMUNITY_REPOSITORY);
    rateLimiter = app.get(CommunityRateLimiter);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps replies at one level and preserves a deleted parent placeholder', async () => {
    const owner = await createUser(identity, 'interaction-owner@example.com', 'Owner');
    const commenter = await createUser(identity, 'interaction-commenter@example.com', 'Commenter');
    const ownerToken = await accessFor(sessions, owner);
    const commenterToken = await accessFor(sessions, commenter);
    const postId = await createPost(app, ownerToken, 'Comment thread');

    const topLevel = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + commenterToken)
      .send({ content: 'Top-level comment' })
      .expect(201);
    const topLevelId = topLevel.body.data.id as string;

    const reply = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'One-level reply', parentCommentId: topLevelId })
      .expect(201);
    const replyId = reply.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + commenterToken)
      .send({ content: 'Nested reply is forbidden', parentCommentId: replyId })
      .expect(400);

    await request(app.getHttpServer())
      .patch('/api/v1/community/comments/' + replyId)
      .set('Authorization', 'Bearer ' + commenterToken)
      .send({ content: 'Not the reply owner' })
      .expect(403);

    await request(app.getHttpServer())
      .delete('/api/v1/community/comments/' + topLevelId)
      .set('Authorization', 'Bearer ' + commenterToken)
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/comments')
      .expect(200);
    expect(listed.body.data.items).toHaveLength(1);
    expect(listed.body.data.items[0]).toMatchObject({
      id: topLevelId,
      isDeleted: true,
      content: null,
      author: null,
    });
    expect(listed.body.data.items[0].replies).toHaveLength(1);
    expect(listed.body.data.items[0].replies[0]).toMatchObject({
      id: replyId,
      content: 'One-level reply',
      isDeleted: false,
    });
  });

  it('makes helpful reactions idempotent and keeps saves private to the viewer', async () => {
    const owner = await createUser(identity, 'interaction-save-owner@example.com', 'Save Owner');
    const viewer = await createUser(identity, 'interaction-save-viewer@example.com', 'Save Viewer');
    const ownerToken = await accessFor(sessions, owner);
    const viewerToken = await accessFor(sessions, viewer);
    const publicPostId = await createPost(app, ownerToken, 'Public interaction post');
    const publicShare = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + publicPostId + '/share')
      .expect(200);
    expect(publicShare.body.data).toEqual({
      postId: publicPostId,
      canonicalPath: '/community/posts/' + publicPostId,
      isShareable: true,
    });

    const firstReaction = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + publicPostId + '/reactions')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ type: 'HELPFUL' })
      .expect(201);
    expect(firstReaction.body.data).toEqual({
      postId: publicPostId,
      type: 'HELPFUL',
      reacted: true,
      helpfulCount: 1,
    });

    const duplicateReaction = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + publicPostId + '/reactions')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ type: 'HELPFUL' })
      .expect(201);
    expect(duplicateReaction.body.data).toEqual({
      postId: publicPostId,
      type: 'HELPFUL',
      reacted: true,
      helpfulCount: 1,
    });

    const reacted = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + publicPostId)
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(200);
    expect(reacted.body.data).toMatchObject({
      helpfulCount: 1,
      viewerReacted: true,
    });

    await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + publicPostId + '/reactions/HELPFUL')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(200);
    const unreacted = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + publicPostId)
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(200);
    expect(unreacted.body.data).toMatchObject({
      helpfulCount: 0,
      viewerReacted: false,
    });

    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + publicPostId + '/reactions')
      .send({ type: 'HELPFUL' })
      .expect(401);

    const firstSave = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + publicPostId + '/save')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(201);
    expect(firstSave.body.data).toEqual({
      postId: publicPostId,
      saved: true,
    });
    const duplicateSave = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + publicPostId + '/save')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(201);
    expect(duplicateSave.body.data).toEqual({
      postId: publicPostId,
      saved: true,
    });
    const saved = await request(app.getHttpServer())
      .get('/api/v1/community/saved-posts')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(200);
    expect(saved.body.data.items.some((item: { id: string }) => item.id === publicPostId)).toBe(true);

    const privatePostId = await createPost(app, ownerToken, 'Private interaction post', { visibility: 'PRIVATE' });
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + privatePostId + '/reactions')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ type: 'HELPFUL' })
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + privatePostId + '/share')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + privatePostId + '/save')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(201);
    const ownerSaved = await request(app.getHttpServer())
      .get('/api/v1/community/saved-posts')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    expect(ownerSaved.body.data.items.some((item: { id: string }) => item.id === privatePostId)).toBe(true);

    const viewerSaved = await request(app.getHttpServer())
      .get('/api/v1/community/saved-posts')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(200);
    expect(viewerSaved.body.data.items.some((item: { id: string }) => item.id === privatePostId)).toBe(false);

    await request(app.getHttpServer())
      .get('/api/v1/community/saved-posts')
      .set('Authorization', 'Bearer ' + viewerToken)
      .query({ userId: owner.id })
      .expect(400);
  });

  it('uses generic report responses and enforces deterministic cursor pages', async () => {
    const user = await createUser(identity, 'interaction-report@example.com', 'Report User');
    const token = await accessFor(sessions, user);
    const postIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      postIds.push(await createPost(app, token, 'Cursor post ' + index, { languageCode: 'fr' }));
    }

    const firstPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .query({ limit: 2, languageCode: 'fr' })
      .expect(200);
    expect(firstPage.body.data.items).toHaveLength(2);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .query({ limit: 2, languageCode: 'fr', cursor: firstPage.body.data.nextCursor })
      .expect(200);
    const firstIds = new Set(firstPage.body.data.items.map((item: { id: string }) => item.id));
    expect(secondPage.body.data.items).toHaveLength(1);
    expect(secondPage.body.data.items.every((item: { id: string }) => !firstIds.has(item.id))).toBe(true);
    expect(postIds.every((id) => firstIds.has(id) || secondPage.body.data.items.some((item: { id: string }) => item.id === id))).toBe(true);

    const reportResponse = await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({
        targetType: 'POST',
        targetId: postIds[0],
        category: 'SPAM',
        details: 'Duplicate content',
      })
      .expect(201);
    expect(reportResponse.body.data).toEqual({ submitted: true });

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({
        targetType: 'POST',
        targetId: postIds[0],
        category: 'SPAM',
      })
      .expect(201);
    expect(duplicate.body.data).toEqual({ submitted: true });

    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({
        targetType: 'POST',
        targetId: '00000000-0000-4000-8000-000000000001',
        category: 'SPAM',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({
        targetType: 'POST',
        targetId: postIds[0],
        category: 'NOT_A_CATEGORY',
      })
      .expect(400);

    await repository.setPostModerationState(postIds[0], 'HIDDEN', new Date());
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postIds[0])
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items.some((item: { id: string }) => item.id === postIds[0])).toBe(false);
      });
  });

  it('returns a stable rate-limit response for excessive post creation', async () => {
    rateLimiter.clear();
    const user = await createUser(identity, 'interaction-rate@example.com', 'Rate User');
    const token = await accessFor(sessions, user);
    for (let index = 0; index < 10; index += 1) {
      await createPost(app, token, 'Rate post ' + index);
    }
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + token)
      .send({
        postType: 'DISCUSSION',
        languageCode: 'en',
        content: 'Rate limited',
      })
      .expect(429)
      .expect(({ body }) => {
        expect(body.error).toMatchObject({
          code: 'COMMUNITY_RATE_LIMITED',
          message: 'Please try again later',
        });
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

async function createPost(
  app: INestApplication,
  accessToken: string,
  content: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/community/posts')
    .set('Authorization', 'Bearer ' + accessToken)
    .send({
      postType: 'DISCUSSION',
      languageCode: 'en',
      content,
      ...extra,
    })
    .expect(201);
  return response.body.data.id as string;
}

function response(): Response {
  return {
    append(): void {
      return;
    },
  } as unknown as Response;
}
