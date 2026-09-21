import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { InMemoryExchangeSafetyRepository } from './exchange-safety.repository';

describe('InMemoryExchangeSafetyRepository', () => {
  it('treats either block direction as a pairwise block and only removes the actor-owned direction', async () => {
    const repository = new InMemoryExchangeSafetyRepository();
    const blocker = randomUUID();
    const target = randomUUID();

    await expect(repository.blockUser(blocker, target)).resolves.toMatchObject({ outcome: 'CREATED' });
    await expect(repository.isBlocked(blocker, target)).resolves.toBe(true);
    await expect(repository.isBlocked(target, blocker)).resolves.toBe(true);
    await expect(repository.isBlockedBy(blocker, target)).resolves.toBe(true);
    await expect(repository.isBlockedBy(target, blocker)).resolves.toBe(false);
    await expect(repository.blockUser(blocker, target)).resolves.toMatchObject({ outcome: 'ALREADY_BLOCKED' });

    await expect(repository.unblockUser(target, blocker)).resolves.toMatchObject({ outcome: 'NOT_BLOCKED' });
    await expect(repository.unblockUser(blocker, target)).resolves.toMatchObject({ outcome: 'REMOVED' });
    await expect(repository.isBlocked(blocker, target)).resolves.toBe(false);
  });

  it('deduplicates reports by reporter, target, and category without exposing report internals', async () => {
    const repository = new InMemoryExchangeSafetyRepository();
    const input = {
      reporterUserId: randomUUID(),
      targetUserId: randomUUID(),
      category: 'SPAM' as const,
      context: 'Repeated unsolicited promotion',
    };

    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: false });
    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: true });
    await expect(repository.submitReport({ ...input, category: 'OTHER' })).resolves.toEqual({ duplicate: false });
  });
});
