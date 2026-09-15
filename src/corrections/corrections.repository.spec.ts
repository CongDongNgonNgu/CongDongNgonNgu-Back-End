import { describe, expect, it } from '@jest/globals';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { InMemoryCorrectionsRepository } from './corrections.repository';

describe('InMemoryCorrectionsRepository', () => {
  it('stores correction requests on real Community parents and keeps source data separate', async () => {
    const community = new InMemoryCommunityRepository();
    const repository = new InMemoryCorrectionsRepository(community);
    const createdAt = new Date('2026-09-15T08:00:00.000Z');

    const created = await repository.createCorrectionRequest({
      authorUserId: 'owner',
      targetLanguageCode: 'vi',
      parentContent: 'Xin hãy giúp mình.',
      cefrLevel: 'B1',
      topic: 'travel',
      visibility: 'PRIVATE',
      originalText: '  Tôi muốn đi\r\nHà Nội  ',
      correctionIntent: 'NATURALNESS',
      context: 'Xin hãy giúp mình.',
      createdAt,
    });

    expect(created.post).toMatchObject({
      postType: 'CORRECTION_REQUEST',
      authorUserId: 'owner',
      targetLanguageCode: 'vi',
      content: 'Xin hãy giúp mình.',
    });
    expect(await community.findPostById(created.post.id)).toMatchObject({
      id: created.post.id,
      postType: 'CORRECTION_REQUEST',
    });
    expect(await repository.findCorrectionRequest(created.post.id)).toMatchObject({
      postId: created.post.id,
      originalText: '  Tôi muốn đi\r\nHà Nội  ',
      correctionIntent: 'NATURALNESS',
    });
  });

  it('creates questions without a duplicate question extension', async () => {
    const community = new InMemoryCommunityRepository();
    const repository = new InMemoryCorrectionsRepository(community);

    const question = await repository.createQuestion({
      authorUserId: 'owner',
      targetLanguageCode: 'ja',
      content: 'この表現は自然ですか？',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt: new Date(),
    });

    expect(question.postType).toBe('QUESTION');
    expect(await repository.findCorrectionRequest(question.id)).toBeNull();
  });

  it('keeps formal responses distinct from Community comments and supports lifecycle state', async () => {
    const community = new InMemoryCommunityRepository();
    const repository = new InMemoryCorrectionsRepository(community);
    const post = await community.createPost({
      authorUserId: 'owner',
      targetLanguageCode: 'en',
      postType: 'QUESTION',
      content: 'How do I say this naturally?',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt: new Date(),
    });

    const response = await repository.createStructuredResponse({
      parentPostId: post.id,
      parentPostType: 'QUESTION',
      authorUserId: 'responder',
      responseKind: 'QA_ANSWER',
      correctedText: null,
      answerText: 'Use the shorter form in casual speech.',
      explanation: 'The longer form is formal.',
      createdAt: new Date(),
    });

    expect(response.responseKind).toBe('QA_ANSWER');
    await expect(repository.createStructuredResponse({
      parentPostId: post.id,
      parentPostType: 'QUESTION',
      authorUserId: 'responder',
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'This must not attach to a question.',
      answerText: null,
      explanation: null,
      createdAt: new Date(),
    })).rejects.toThrow('Structured response parent is invalid');

    await expect(repository.listStructuredResponses({
      parentPostId: post.id,
      limit: 20,
    })).resolves.toMatchObject({
      items: [{ id: response.id, answerText: response.answerText }],
      hasMore: false,
    });

    await expect(repository.setStructuredResponseModerationState(
      response.id,
      'DELETED',
      new Date(),
    )).resolves.toMatchObject({
      moderationState: 'DELETED',
      deletedAt: expect.any(Date),
    });
  });
});
