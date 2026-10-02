import { describe, expect, it } from '@jest/globals';
import { InMemoryCommunityRepository } from './community.repository';
import { CommunityFailure } from './community.errors';
import { CommunityModerationService } from './community.moderation.service';

describe('CommunityModerationService', () => {
  it('redacts reporter identity and enforces moderation capability boundaries', async () => {
    const repository = new InMemoryCommunityRepository();
    const service = new CommunityModerationService(repository);
    const report = await repository.createReport({
      reporterUserId: 'private-reporter',
      targetType: 'POST',
      targetId: 'post-1',
      category: 'HARASSMENT',
      details: 'Threatening language',
      createdAt: new Date(),
    });

    await expect(service.listReports({ userId: 'expert-1', roles: ['EXPERT'] })).rejects.toMatchObject({
      code: 'COMMUNITY_MODERATION_FORBIDDEN',
    });

    const queue = await service.listReports({ userId: 'moderator-1', roles: ['MODERATOR'] });
    expect(queue.items[0]).not.toHaveProperty('reporterUserId');
    expect(queue.items[0]).toMatchObject({
      id: report.id,
      targetType: 'POST',
      state: 'OPEN',
    });
  });

  it('requires a reason for terminal outcomes and stores assignment/notes', async () => {
    const repository = new InMemoryCommunityRepository();
    const service = new CommunityModerationService(repository);
    const report = await repository.createReport({
      reporterUserId: 'reporter-1',
      targetType: 'COMMENT',
      targetId: 'comment-1',
      category: 'SPAM',
      details: null,
      createdAt: new Date(),
    });
    const moderator = { userId: 'moderator-1', roles: ['MODERATOR'] as const };

    await expect(service.resolveReport(moderator, report.id, 'ACTIONED', '   ')).rejects.toMatchObject({
      code: 'COMMUNITY_MODERATION_REASON_REQUIRED',
    });
    await expect(service.assignReport(moderator, report.id, 'moderator-2')).resolves.toMatchObject({
      assignedToUserId: 'moderator-2',
    });
    await expect(service.resolveReport(moderator, report.id, 'ACTIONED', 'Removed after review')).resolves.toMatchObject({
      state: 'ACTIONED',
      resolutionReason: 'Removed after review',
    });
    await expect(service.addNote(moderator, report.id, 'Evidence reviewed')).resolves.toMatchObject({
      reportId: report.id,
      body: 'Evidence reviewed',
    });
  });

  it('does not treat a missing report as an assignable case', async () => {
    const service = new CommunityModerationService(new InMemoryCommunityRepository());

    await expect(service.assignReport(
      { userId: 'moderator-1', roles: ['MODERATOR'] },
      'missing-report',
      'moderator-2',
    )).rejects.toBeInstanceOf(CommunityFailure);
  });
});
