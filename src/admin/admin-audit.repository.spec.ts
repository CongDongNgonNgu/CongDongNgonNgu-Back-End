import { describe, expect, it } from '@jest/globals';
import { InMemoryAdminAuditRepository, sanitizeAuditValue } from './admin-audit.repository';

describe('admin audit repository', () => {
  it('sanitizes credential-like fields before storing immutable evidence', async () => {
    const repository = new InMemoryAdminAuditRepository();
    const entry = await repository.append({
      actorUserId: 'admin-1',
      action: 'CONTENT_HIDE',
      targetType: 'COMMUNITY_POST',
      targetId: 'post-1',
      reason: 'Policy violation',
      correlationId: 'corr-1',
      beforeState: {
        moderationState: 'ACTIVE',
        passwordHash: 'must-not-persist',
        nested: { providerSecret: 'must-not-persist' },
      },
      afterState: { moderationState: 'HIDDEN', accessToken: 'must-not-persist' },
      metadata: { paymentSignature: 'must-not-persist', source: 'admin-ui' },
      createdAt: new Date('2026-10-02T05:00:00.000Z'),
    });

    expect(entry.beforeState).toEqual({ moderationState: 'ACTIVE', nested: {} });
    expect(entry.afterState).toEqual({ moderationState: 'HIDDEN' });
    expect(entry.metadata).toEqual({ source: 'admin-ui' });
    const listed = await repository.list({ limit: 10, offset: 0 });
    expect(listed).toMatchObject({ total: 1, items: [expect.objectContaining({ id: entry.id })] });
  });

  it('does not allow a caller to mutate the stored object through returned references', async () => {
    const repository = new InMemoryAdminAuditRepository();
    const entry = await repository.append({
      actorUserId: 'admin-1',
      action: 'USER_WARN',
      targetType: 'USER',
      targetId: 'user-1',
      reason: 'Warning',
      correlationId: 'corr-2',
      beforeState: { status: 'ACTIVE' },
      afterState: { status: 'ACTIVE' },
      metadata: null,
      createdAt: new Date(),
    });
    (entry.beforeState as Record<string, unknown>).status = 'DISABLED';

    await expect(repository.list({ targetId: 'user-1', limit: 10, offset: 0 })).resolves.toMatchObject({
      items: [expect.objectContaining({ beforeState: { status: 'ACTIVE' } })],
    });
  });

  it('drops sensitive keys at any nested object boundary', () => {
    expect(sanitizeAuditValue({ safe: true, nested: { api_key: 'secret', value: 3 } })).toEqual({
      safe: true,
      nested: { value: 3 },
    });
  });

  it('keeps safe timestamps readable without serializing arbitrary object internals', () => {
    expect(sanitizeAuditValue({ createdAt: new Date('2026-10-02T05:00:00.000Z') })).toEqual({
      createdAt: '2026-10-02T05:00:00.000Z',
    });
  });
});
