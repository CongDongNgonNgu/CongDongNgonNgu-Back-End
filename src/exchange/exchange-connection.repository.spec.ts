import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';

describe('InMemoryExchangeConnectionRepository', () => {
  it('is idempotent for duplicate requests and converges reciprocal requests', async () => {
    const repository = new InMemoryExchangeConnectionRepository();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();

    const first = await repository.requestConnection(firstUserId, secondUserId);
    const retry = await repository.requestConnection(firstUserId, secondUserId);

    expect(first.outcome).toBe('REQUESTED');
    expect(retry.outcome).toBe('ALREADY_PENDING');
    expect(retry.record?.id).toBe(first.record?.id);

    const [sameDirection, reciprocal] = await Promise.all([
      repository.requestConnection(firstUserId, secondUserId),
      repository.requestConnection(secondUserId, firstUserId),
    ]);
    expect(sameDirection.outcome).toBe('ALREADY_PENDING');
    expect(reciprocal.outcome).toBe('CONNECTED');
    await expect(repository.findRelationship(firstUserId, secondUserId)).resolves.toMatchObject({
      status: 'CONNECTED',
      requesterId: firstUserId,
    });
  });

  it('supports accept, decline, cancel, and disconnect with actor-aware transitions', async () => {
    const repository = new InMemoryExchangeConnectionRepository();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();

    await repository.requestConnection(firstUserId, secondUserId);
    await expect(repository.acceptConnection(firstUserId, secondUserId)).resolves.toMatchObject({
      outcome: 'INVALID_ACTION',
    });
    await expect(repository.declineConnection(firstUserId, secondUserId)).resolves.toMatchObject({
      outcome: 'INVALID_ACTION',
    });
    await expect(repository.cancelConnection(secondUserId, firstUserId)).resolves.toMatchObject({
      outcome: 'INVALID_ACTION',
    });

    await expect(repository.declineConnection(secondUserId, firstUserId)).resolves.toMatchObject({
      outcome: 'DECLINED',
    });
    await expect(repository.declineConnection(secondUserId, firstUserId)).resolves.toMatchObject({
      outcome: 'NONE',
    });

    await repository.requestConnection(firstUserId, secondUserId);
    await expect(repository.cancelConnection(firstUserId, secondUserId)).resolves.toMatchObject({
      outcome: 'CANCELLED',
    });

    await repository.requestConnection(firstUserId, secondUserId);
    await repository.acceptConnection(secondUserId, firstUserId);
    await expect(repository.disconnect(secondUserId, firstUserId)).resolves.toMatchObject({
      outcome: 'DISCONNECTED',
    });
    await expect(repository.disconnect(secondUserId, firstUserId)).resolves.toMatchObject({
      outcome: 'NONE',
    });
  });
});
