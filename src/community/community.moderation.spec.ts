import { describe, expect, it } from '@jest/globals';
import { InMemoryCommunityRepository } from './community.repository';

describe('community moderation report workflow', () => {
  it('lists duplicate reports as one target/category group with assignment and notes', async () => {
    const repository = new InMemoryCommunityRepository();
    const createdAt = new Date('2026-10-02T04:00:00.000Z');
    const post = await repository.createPost({
      authorUserId: 'author-1',
      targetLanguageCode: 'en',
      postType: 'DISCUSSION',
      content: 'A reportable post',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt,
    });

    const first = await repository.createReport({
      reporterUserId: 'reporter-1',
      targetType: 'POST',
      targetId: post.id,
      category: 'SPAM',
      details: 'Repeated promotion',
      createdAt,
    });
    const second = await repository.createReport({
      reporterUserId: 'reporter-2',
      targetType: 'POST',
      targetId: post.id,
      category: 'SPAM',
      details: 'Same pattern',
      createdAt: new Date(createdAt.getTime() + 1_000),
    });

    expect(first.state).toBe('OPEN');
    expect(first.reporterUserId).toBe('reporter-1');
    expect(second.id).not.toBe(first.id);

    const queue = await repository.listReports({ state: 'OPEN', limit: 10 });
    expect(queue.items).toHaveLength(2);
    expect(queue.items[0].duplicateGroupKey).toBe(`POST:${post.id}:SPAM`);
    expect(queue.items[0].duplicateCount).toBe(2);

    const updated = await repository.updateReport(first.id, {
      assignedToUserId: 'moderator-1',
      state: 'ACTIONED',
      resolutionReason: 'Content removed after review',
      updatedAt: new Date('2026-10-02T04:05:00.000Z'),
    });
    expect(updated).toMatchObject({
      assignedToUserId: 'moderator-1',
      state: 'ACTIONED',
      resolutionReason: 'Content removed after review',
    });

    const note = await repository.addReportNote(first.id, 'moderator-1', 'Reviewed duplicate evidence', new Date());
    expect(note.reportId).toBe(first.id);
    await expect(repository.listReportNotes(first.id)).resolves.toEqual([note]);
    await expect(repository.listReports({ state: 'ACTIONED', limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: first.id })],
    });
  });
});
