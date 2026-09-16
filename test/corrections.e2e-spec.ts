import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SessionService } from '../src/auth/session/session.service';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('corrections and Q&A API', () => {
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

  it('requires authentication and rejects browser-supplied author identity', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/community/correction-requests')
      .send({
        authorUserId: '00000000-0000-4000-8000-000000000001',
        languageCode: 'en',
        originalText: 'Unauthenticated',
        correctionIntent: 'GRAMMAR',
      })
      .expect(401);

    const user = await createUser(identity, 'phase06-spoof@example.com', 'Spoof');
    const accessToken = await accessFor(sessions, user);
    await request(app.getHttpServer())
      .post('/api/v1/community/correction-requests')
      .set('Authorization', 'Bearer ' + accessToken)
      .send({
        authorUserId: '00000000-0000-4000-8000-000000000001',
        languageCode: 'en',
        originalText: 'The author comes from the session.',
        correctionIntent: 'GRAMMAR',
      })
      .expect(400);
  });

  it('creates a correction, exposes immutable source data, and accepts a proposal from another user', async () => {
    const owner = await createUser(identity, 'phase06-correction-owner@example.com', 'Correction Owner');
    const contributor = await createUser(identity, 'phase06-correction-contributor@example.com', 'Correction Contributor');
    const ownerToken = await accessFor(sessions, owner);
    const contributorToken = await accessFor(sessions, contributor);

    const created = await request(app.getHttpServer())
      .post('/api/v1/community/correction-requests')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({
        languageCode: 'en',
        originalText: 'I has a book.\r\n',
        correctionIntent: 'grammar',
        context: 'Practice sentence',
        topic: 'Writing Practice',
      })
      .expect(201);

    expect(created.body.data).toMatchObject({
      post: {
        postType: 'CORRECTION_REQUEST',
        content: 'Practice sentence',
      },
      correction: {
        originalText: 'I has a book.\n',
        correctionIntent: 'GRAMMAR',
        context: 'Practice sentence',
      },
    });
    const postId = created.body.data.post.id as string;

    const proposal = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/structured-responses')
      .set('Authorization', 'Bearer ' + contributorToken)
      .send({
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: 'I have a book.\n',
        explanation: 'Use the first-person singular form.',
      })
      .expect(201);

    expect(proposal.body.data).toMatchObject({
      parentPostId: postId,
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'I have a book.\n',
      author: { id: contributor.id, displayName: 'Correction Contributor' },
      isDeleted: false,
    });

    await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/structured-responses')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items).toHaveLength(1);
        expect(body.data.items[0].author.email).toBeUndefined();
      });

    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/structured-responses')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: 'I have a book.',
      })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('CORRECTIONS_SELF_RESPONSE'));
  });

  it('keeps question answers distinct from correction proposals', async () => {
    const asker = await createUser(identity, 'phase06-question-asker@example.com', 'Question Asker');
    const contributor = await createUser(identity, 'phase06-question-contributor@example.com', 'Question Contributor');
    const askerToken = await accessFor(sessions, asker);
    const contributorToken = await accessFor(sessions, contributor);

    const question = await request(app.getHttpServer())
      .post('/api/v1/community/questions')
      .set('Authorization', 'Bearer ' + askerToken)
      .send({
        languageCode: 'en',
        content: 'Why is this phrase natural?\r\n',
        visibility: 'PUBLIC',
      })
      .expect(201);
    const questionId = question.body.data.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + questionId + '/structured-responses')
      .set('Authorization', 'Bearer ' + contributorToken)
      .send({
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: 'Not an answer',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('CORRECTIONS_RESPONSE_KIND_INVALID'));

    const answer = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + questionId + '/structured-responses')
      .set('Authorization', 'Bearer ' + contributorToken)
      .send({
        responseKind: 'QA_ANSWER',
        answerText: 'The context supplies the implied subject.',
      })
      .expect(201);
    expect(answer.body.data.responseKind).toBe('QA_ANSWER');

    await request(app.getHttpServer())
      .get('/api/v1/community/questions/' + questionId)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.postType).toBe('QUESTION');
        expect(body.data.content).toBe('Why is this phrase natural?\n');
      });
  });

  it('supports structured Helpful votes and requester acceptance without identity spoofing', async () => {
    const owner = await createUser(identity, 'phase06-interactions-owner@example.com', 'Interactions Owner');
    const contributorA = await createUser(identity, 'phase06-interactions-a@example.com', 'Interactions A');
    const contributorB = await createUser(identity, 'phase06-interactions-b@example.com', 'Interactions B');
    const voter = await createUser(identity, 'phase06-interactions-voter@example.com', 'Interactions Voter');
    const ownerToken = await accessFor(sessions, owner);
    const contributorAToken = await accessFor(sessions, contributorA);
    const contributorBToken = await accessFor(sessions, contributorB);
    const voterToken = await accessFor(sessions, voter);

    const question = await request(app.getHttpServer())
      .post('/api/v1/community/questions')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({
        languageCode: 'en',
        content: 'Which answer is more natural?',
      })
      .expect(201);
    const postId = question.body.data.id as string;

    const answerA = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/structured-responses')
      .set('Authorization', 'Bearer ' + contributorAToken)
      .send({
        responseKind: 'QA_ANSWER',
        answerText: 'Answer A explains the context.',
      })
      .expect(201);
    const responseAId = answerA.body.data.id as string;
    const answerB = await request(app.getHttpServer())
      .post('/api/v1/community/posts/' + postId + '/structured-responses')
      .set('Authorization', 'Bearer ' + contributorBToken)
      .send({
        responseKind: 'QA_ANSWER',
        answerText: 'Answer B gives a shorter explanation.',
      })
      .expect(201);
    const responseBId = answerB.body.data.id as string;

    await request(app.getHttpServer())
      .put('/api/v1/community/structured-responses/' + responseAId + '/helpful')
      .expect(401);

    const helpful = await request(app.getHttpServer())
      .put('/api/v1/community/structured-responses/' + responseAId + '/helpful')
      .set('Authorization', 'Bearer ' + voterToken)
      .expect(200);
    expect(helpful.body.data).toMatchObject({ helpfulCount: 1, viewerHelpful: true });
    const duplicateHelpful = await request(app.getHttpServer())
      .put('/api/v1/community/structured-responses/' + responseAId + '/helpful')
      .set('Authorization', 'Bearer ' + voterToken)
      .expect(200);
    expect(duplicateHelpful.body.data.helpfulCount).toBe(1);

    await request(app.getHttpServer())
      .put('/api/v1/community/structured-responses/' + responseAId + '/helpful')
      .set('Authorization', 'Bearer ' + contributorAToken)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('CORRECTIONS_SELF_VOTE'));

    await request(app.getHttpServer())
      .put('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + contributorAToken)
      .send({ responseId: responseAId })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('CORRECTIONS_ACCEPT_FORBIDDEN'));

    await request(app.getHttpServer())
      .put('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ responseId: responseAId, acceptedByUserId: contributorAToken })
      .expect(400);

    const accepted = await request(app.getHttpServer())
      .put('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ responseId: responseAId })
      .expect(200);
    expect(accepted.body.data).toMatchObject({ id: responseAId, isAccepted: true });

    const changed = await request(app.getHttpServer())
      .put('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + ownerToken)
      .send({ responseId: responseBId })
      .expect(200);
    expect(changed.body.data).toMatchObject({ id: responseBId, isAccepted: true });

    const listed = await request(app.getHttpServer())
      .get('/api/v1/community/posts/' + postId + '/structured-responses')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    expect(listed.body.data.items.filter((item: { isAccepted: boolean }) => item.isAccepted)).toHaveLength(1);

    const revoked = await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    expect(revoked.body.data).toMatchObject({ parentPostId: postId, responseId: responseBId, revoked: true });
    const revokedAgain = await request(app.getHttpServer())
      .delete('/api/v1/community/posts/' + postId + '/accepted-response')
      .set('Authorization', 'Bearer ' + ownerToken)
      .expect(200);
    expect(revokedAgain.body.data).toMatchObject({ parentPostId: postId, responseId: null, revoked: false });
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

async function accessFor(
  sessions: SessionService,
  user: Awaited<ReturnType<typeof createUser>>,
) {
  return (await sessions.issue(user, {
    append(): void {
      return;
    },
  } as never)).accessToken;
}
