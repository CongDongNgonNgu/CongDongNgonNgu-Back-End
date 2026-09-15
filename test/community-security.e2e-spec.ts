import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { COMMUNITY_REPOSITORY, type CommunityRepository } from '../src/community/community.repository';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { PROFILE_REPOSITORY } from '../src/profile/profile.repository';
import type { ProfileRepository } from '../src/profile/profile.repository';

describe('community security boundaries', () => {
  let app: INestApplication;
  let identity: IdentityRepository;
  let sessions: SessionService;
  let repository: CommunityRepository;
  let profiles: ProfileRepository & { setActive(code: string, active: boolean): Promise<void> };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    identity = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    sessions = app.get(SessionService);
    repository = app.get<CommunityRepository>(COMMUNITY_REPOSITORY);
    profiles = app.get<ProfileRepository & { setActive(code: string, active: boolean): Promise<void> }>(PROFILE_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects every Community path for a public post whose author is no longer active', async () => {
    const owner = await createUser(identity, 'security-disabled-owner@example.com', 'Disabled Owner');
    const viewer = await createUser(identity, 'security-disabled-viewer@example.com', 'Active Viewer');
    const ownerToken = await accessFor(sessions, owner);
    const viewerToken = await accessFor(sessions, viewer);
    const postId = await createPost(ownerToken, 'Post becomes unavailable');

    await identity.updateUser(owner.id, { status: 'DISABLED' });

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ content: 'Must not be accepted' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/reactions')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ type: 'HELPFUL' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/save')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/share')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);

    void repository;
  });

  it('accepts Unicode-code-point boundary content instead of UTF-16 length rejection', async () => {
    const user = await createUser(identity, 'security-unicode-boundary@example.com', 'Unicode Boundary');
    const token = await accessFor(sessions, user);

    await createPost(token, '😀'.repeat(20_000));

    const commentPostId = await createPost(token, 'Comment boundary post');
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + commentPostId + '/comments')
      .set('Authorization', 'Bearer ' + token)
      .send({ content: '😀'.repeat(5_000) })
      .expect(201);
  });

  it('keeps an inactive comment author private while preserving a non-content placeholder count', async () => {
    const owner = await createUser(identity, 'security-comment-owner@example.com', 'Comment Owner');
    const commenter = await createUser(identity, 'security-comment-disabled@example.com', 'Comment Disabled');
    const ownerToken = await accessFor(sessions, owner);
    const commenterToken = await accessFor(sessions, commenter);
    const postId = await createPost(ownerToken, 'Comment author status');

    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + commenterToken)
      .send({ content: 'Private after account disable' })
      .expect(201);
    await identity.updateUser(commenter.id, { status: 'DISABLED' });

    const comments = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    expect(comments.body.data.items).toHaveLength(1);
    expect(comments.body.data.items[0]).toMatchObject({
      author: null,
      content: null,
      isDeleted: true,
      replies: [],
    });

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.commentCount).toBe(1));
  });

  it('uses the same unavailable contract for private, hidden, and deleted posts', async () => {
    const owner = await createUser(identity, 'security-visibility-owner@example.com', 'Visibility Owner');
    const viewer = await createUser(identity, 'security-visibility-viewer@example.com', 'Visibility Viewer');
    const ownerToken = await accessFor(sessions, owner);
    const viewerToken = await accessFor(sessions, viewer);
    const privatePostId = await createPost(ownerToken, 'Private post', { visibility: 'PRIVATE' });

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + privatePostId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + privatePostId)
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + privatePostId + '/comments')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + privatePostId + '/share')
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + privatePostId + '/reactions')
      .set('Authorization', 'Bearer ' + viewerToken)
      .send({ type: 'HELPFUL' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + privatePostId + '/save')
      .set('Authorization', 'Bearer ' + viewerToken)
      .expect(404);

    const hiddenPostId = await createPost(ownerToken, 'Hidden post');
    await repository.setPostModerationState(hiddenPostId, 'HIDDEN', new Date());
    const deletedPostId = await createPost(ownerToken, 'Deleted post');
    await repository.setPostModerationState(deletedPostId, 'DELETED', new Date());

    for (const postId of [hiddenPostId, deletedPostId]) {
      await request(app.getHttpServer())
        .get('/api/v1/community/posts/' + postId)
        .set('Authorization', 'Bearer ' + ownerToken)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/community/posts/' + postId + '/share')
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/community/posts/' + postId + '/comments')
        .set('Authorization', 'Bearer ' + viewerToken)
        .send({ content: 'Unavailable target' })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/community/posts/' + postId + '/reactions')
        .set('Authorization', 'Bearer ' + viewerToken)
        .send({ type: 'HELPFUL' })
      .expect(404);
    }
  });

  it('rejects ownership and identity-field tampering for posts, comments, and reports', async () => {
    const owner = await createUser(identity, 'security-idor-owner@example.com', 'IDOR Owner');
    const other = await createUser(identity, 'security-idor-other@example.com', 'IDOR Other');
    const ownerToken = await accessFor(sessions, owner);
    const otherToken = await accessFor(sessions, other);
    const postId = await createPost(ownerToken, 'Ownership target');
    const otherPostId = await createPost(otherToken, 'Other ownership target');

    await request(app.getHttpServer())
      .patch('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ content: 'Cross-owner edit' })
      .expect(403);
    await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(403);
    await request(app.getHttpServer())
      .patch('/api/v1/community/posts/' + postId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Tampered author', authorUserId: other.id })
      .expect(400);

    const comment = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Owner comment' })
      .expect(201);
    const commentId = comment.body.data.id as string;
    await request(app.getHttpServer())
      .patch('/api/v1/community/comments/' + commentId)
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ content: 'Cross-owner comment edit' })
      .expect(403);
    await request(app.getHttpServer())
      .delete('/api/v1/community/comments/' + commentId)
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + otherPostId + '/comments')
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ content: 'Tampered identity', authorUserId: owner.id })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + otherToken)
      .send({
        targetType: 'POST',
        targetId: postId,
        category: 'SPAM',
        reporterUserId: owner.id,
      })
      .expect(400);
  });

  it('reconciles comment counts and keeps report outcomes generic', async () => {
    const owner = await createUser(identity, 'security-count-owner@example.com', 'Count Owner');
    const commenter = await createUser(identity, 'security-count-commenter@example.com', 'Count Commenter');
    const reporter = await createUser(identity, 'security-count-reporter@example.com', 'Count Reporter');
    const ownerToken = await accessFor(sessions, owner);
    const commenterToken = await accessFor(sessions, commenter);
    const reporterToken = await accessFor(sessions, reporter);
    const postId = await createPost(ownerToken, 'Count reconciliation target');

    const comment = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + commenterToken)
      .send({ content: 'Top-level count item' })
      .expect(201);
    const commentId = comment.body.data.id as string;
    const reply = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/comments')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Reply count item', parentCommentId: commentId })
      .expect(201);
    const replyId = reply.body.data.id as string;

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .expect(200)
      .expect(({ body }) => expect(body.data.commentCount).toBe(2));
    await request(app.getHttpServer())
      .delete('/api/v1/community/comments/' + commentId)
      .set('Authorization', 'Bearer ' + commenterToken)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .expect(200)
      .expect(({ body }) => expect(body.data.commentCount).toBe(1));
    await request(app.getHttpServer())
      .delete('/api/v1/community/comments/' + replyId)
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId)
      .expect(200)
      .expect(({ body }) => expect(body.data.commentCount).toBe(0));

    const reportPostId = await createPost(ownerToken, 'Report privacy target');
    const reportComment = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + reportPostId + '/comments')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ content: 'Reportable comment' })
      .expect(201);
    const reportCommentId = reportComment.body.data.id as string;

    for (const payload of [
      { targetType: 'POST', targetId: reportPostId, category: 'SPAM' },
      { targetType: 'POST', targetId: reportPostId, category: 'SPAM' },
      { targetType: 'COMMENT', targetId: reportCommentId, category: 'OTHER' },
      { targetType: 'POST', targetId: '00000000-0000-4000-8000-000000000001', category: 'SPAM' },
    ]) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/community/reports')
        .set('Authorization', 'Bearer ' + reporterToken)
        .send(payload)
        .expect(201);
      expect(response.body.data).toEqual({ submitted: true });
      expect(response.body.data.reportId).toBeUndefined();
    }

    const privatePostId = await createPost(ownerToken, 'Private report target', { visibility: 'PRIVATE' });
    const hiddenPostId = await createPost(ownerToken, 'Hidden report target');
    await repository.setPostModerationState(hiddenPostId, 'HIDDEN', new Date());
    for (const targetId of [privatePostId, hiddenPostId]) {
      await request(app.getHttpServer())
        .post('/api/v1/community/reports')
        .set('Authorization', 'Bearer ' + reporterToken)
        .send({ targetType: 'POST', targetId, category: 'SPAM' })
        .expect(201)
        .expect(({ body }) => expect(body.data).toEqual({ submitted: true }));
    }
    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + reporterToken)
      .send({ targetType: 'POST', targetId: reportPostId, category: 'INVALID' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + reporterToken)
      .send({ targetType: 'POST', targetId: reportPostId, category: 'OTHER', details: 'x'.repeat(1_001) })
      .expect(400);
  });

  it('requires CSRF for cookie-backed Community mutations while allowing bearer-only requests', async () => {
    const user = await createUser(identity, 'security-csrf@example.com', 'CSRF User');
    const issued = await issueWithCookies(sessions, user);
    const cookieHeader = issued.cookieHeader;

    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + issued.accessToken)
      .set('Cookie', cookieHeader)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'Missing CSRF' })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));

    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + issued.accessToken)
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', issued.csrfToken)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'Valid CSRF' })
      .expect(201);
  });

  it('keeps plain text safe and rejects oversized or invalid Community values', async () => {
    const user = await createUser(identity, 'security-validation@example.com', 'Validation User');
    const token = await accessFor(sessions, user);
    const validBoundaryPostId = await createPost(token, 'Boundary post', { topic: 'a'.repeat(80) });
    const xssPostId = await createPost(
      token,
      '<script>alert(1)</script> <img src=x onerror=alert(1)> javascript:alert(1) SELECT * FROM users',
    );

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + xssPostId)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.content).toContain('<script>alert(1)</script>');
        expect(body.data.content).toContain('<img src=x onerror=alert(1)>');
        expect(body.data.content).toContain('javascript:alert(1)');
        expect(body.data.content).toContain('SELECT * FROM users');
      });
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + token)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'x'.repeat(20_001) })
      .expect(400);
    const commentBoundaryPostId = await createPost(token, 'Comment oversized target');
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + commentBoundaryPostId + '/comments')
      .set('Authorization', 'Bearer ' + token)
      .send({ content: 'x'.repeat(5_001) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + token)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'x', topic: 'a'.repeat(81) })
      .expect(400);

    for (const input of [
      { postType: 'NOT_A_TYPE', languageCode: 'en', content: 'invalid type' },
      { postType: 'DISCUSSION', languageCode: 'zz', content: 'invalid language' },
      { postType: 'DISCUSSION', languageCode: 'en', content: 'invalid cefr', cefrLevel: 'Z9' },
      { postType: 'DISCUSSION', languageCode: 'en', content: 'invalid visibility', visibility: 'HIDDEN' },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/community/posts')
        .set('Authorization', 'Bearer ' + token)
        .send(input)
        .expect(400);
    }
    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + validBoundaryPostId + '/reactions')
      .set('Authorization', 'Bearer ' + token)
      .send({ type: 'LIKE' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({ targetType: 'POST', targetId: validBoundaryPostId, category: 'INVALID' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/community/reports')
      .set('Authorization', 'Bearer ' + token)
      .send({
        targetType: 'POST',
        targetId: validBoundaryPostId,
        category: 'OTHER',
        details: String.fromCodePoint(0x1f600).repeat(1_001),
      })
      .expect(400);
  });

  it('keeps feed and comment cursors deterministic without duplicates', async () => {
    const user = await createUser(identity, 'security-pagination@example.com', 'Pagination User');
    const token = await accessFor(sessions, user);
    const postIds = await Promise.all([
      createPost(token, 'Pagination one', { languageCode: 'fr' }),
      createPost(token, 'Pagination two', { languageCode: 'fr' }),
      createPost(token, 'Pagination three', { languageCode: 'fr' }),
    ]);
    const firstFeedPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .query({ languageCode: 'fr', limit: 2 })
      .expect(200);
    expect(firstFeedPage.body.data.items).toHaveLength(2);
    expect(firstFeedPage.body.data.nextCursor).toEqual(expect.any(String));
    const secondFeedPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .query({ languageCode: 'fr', limit: 2, cursor: firstFeedPage.body.data.nextCursor })
      .expect(200);
    const firstFeedIds = new Set(firstFeedPage.body.data.items.map((item: { id: string }) => item.id));
    expect(secondFeedPage.body.data.items).toHaveLength(1);
    expect(secondFeedPage.body.data.items.every((item: { id: string }) => !firstFeedIds.has(item.id))).toBe(true);
    expect(postIds.every((id) => firstFeedIds.has(id) || secondFeedPage.body.data.items.some((item: { id: string }) => item.id === id))).toBe(true);

    const commentPostId = await createPost(token, 'Comment pagination');
    for (const content of ['Comment one', 'Comment two', 'Comment three']) {
      await request(app.getHttpServer())
        .post('/api/v1/community/posts/' + commentPostId + '/comments')
        .set('Authorization', 'Bearer ' + token)
        .send({ content })
        .expect(201);
    }
    const firstCommentPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + commentPostId + '/comments')
      .query({ limit: 2 })
      .expect(200);
    const secondCommentPage = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + commentPostId + '/comments')
      .query({ limit: 2, cursor: firstCommentPage.body.data.nextCursor })
      .expect(200);
    const firstCommentIds = new Set(firstCommentPage.body.data.items.map((item: { id: string }) => item.id));
    expect(secondCommentPage.body.data.items.every((item: { id: string }) => !firstCommentIds.has(item.id))).toBe(true);

    await request(app.getHttpServer())
      .get('/api/v1/community/posts')
      .query({ cursor: 'not-a-valid-cursor' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('COMMUNITY_INVALID_CURSOR'));
  });

  it('rejects Community writes from disabled and verification-pending users', async () => {
    const disabled = await createUser(identity, 'security-disabled-writer@example.com', 'Disabled Writer');
    const disabledToken = await accessFor(sessions, disabled);
    await identity.updateUser(disabled.id, { status: 'DISABLED' });
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + disabledToken)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'Disabled write' })
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_ACCOUNT_DISABLED'));

    const pending = await identity.createUser({
      email: 'security-pending-writer@example.com',
      displayName: 'Pending Writer',
      passwordHash: null,
      status: 'VERIFICATION_PENDING',
    });
    const pendingToken = await accessFor(sessions, pending);
    await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + pendingToken)
      .send({ postType: 'DISCUSSION', languageCode: 'en', content: 'Pending write' })
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_SESSION_EXPIRED'));
  });

  it('treats a language deactivated after publication as an unavailable target', async () => {
    const owner = await createUser(identity, 'security-inactive-language-owner@example.com', 'Inactive Language Owner');
    const viewer = await createUser(identity, 'security-inactive-language-viewer@example.com', 'Inactive Language Viewer');
    const ownerToken = await accessFor(sessions, owner);
    const viewerToken = await accessFor(sessions, viewer);
    const postId = await createPost(ownerToken, 'Language becomes inactive');

    await profiles.setActive('en', false);
    try {
      await request(app.getHttpServer())
        .get('/api/v1/community/posts/' + postId)
        .set('Authorization', 'Bearer ' + viewerToken)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/community/posts/' + postId + '/comments')
        .set('Authorization', 'Bearer ' + viewerToken)
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/community/posts/' + postId + '/reactions')
        .set('Authorization', 'Bearer ' + viewerToken)
        .send({ type: 'HELPFUL' })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/community/posts/' + postId + '/save')
        .set('Authorization', 'Bearer ' + viewerToken)
        .expect(404);
    } finally {
      await profiles.setActive('en', true);
    }
  });

  async function createPost(
    token: string,
    content: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/community/posts')
      .set('Authorization', 'Bearer ' + token)
      .send({
        postType: 'DISCUSSION',
        languageCode: 'en',
        content,
        ...extra,
      })
      .expect(201);
    return response.body.data.id as string;
  }
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

async function accessFor(
  sessions: SessionService,
  user: Awaited<ReturnType<typeof createUser>>,
) {
  return (await sessions.issue(user, response())).accessToken;
}

async function issueWithCookies(
  sessions: SessionService,
  user: Awaited<ReturnType<typeof createUser>>,
): Promise<{ accessToken: string; cookieHeader: string; csrfToken: string }> {
  const target = response();
  const credentials = await sessions.issue(user, target);
  const cookieHeader = target.cookies
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  const csrfToken = readCookie(target.cookies, 'cdn_csrf');
  return { accessToken: credentials.accessToken, cookieHeader, csrfToken };
}

function response(): Response & { cookies: string[] } {
  const cookies: string[] = [];
  return {
    cookies,
    append(name: string, value: string | string[]): void {
      if (name !== 'Set-Cookie') return;
      cookies.push(...(Array.isArray(value) ? value : [value]));
    },
  } as unknown as Response & { cookies: string[] };
}

function readCookie(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1).split(';', 1)[0]) : '';
}
