import { describe, expect, it } from '@jest/globals';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DELIVERY_CHANNELS,
} from './notification.contracts';
import {
  InMemoryNotificationPreferenceRepository,
} from './notification-preference.repository';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationFailure } from './notification.errors';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('notification preferences', () => {
  it('returns the complete conservative category/channel matrix without exposing the owner id', async () => {
    const service = new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());

    const response = await service.get(USER_A);

    expect(response).toMatchObject({ scope: 'own', preferences: expect.any(Array) });
    expect(response.preferences).toHaveLength(
      NOTIFICATION_CATEGORIES.length * NOTIFICATION_DELIVERY_CHANNELS.length,
    );
    expect(response.preferences).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: USER_A }),
    ]));
    expect(response.preferences.filter((item) => item.channel === 'IN_APP' && item.enabled)).toHaveLength(
      NOTIFICATION_CATEGORIES.length,
    );
    expect(response.preferences.filter((item) => item.channel === 'SSE' && item.enabled)).toHaveLength(
      NOTIFICATION_CATEGORIES.length,
    );
    expect(response.preferences.every((item) => (
      item.channel === 'EMAIL' || item.channel === 'PUSH' ? !item.enabled : true
    ))).toBe(true);
  });

  it('updates only the authenticated owner and keeps mandatory in-app notices locked', async () => {
    const repository = new InMemoryNotificationPreferenceRepository();
    const service = new NotificationPreferenceService(repository);

    await expect(service.update(USER_A, [
      { category: 'COMMUNITY', channel: 'SSE', enabled: false },
      { category: 'COMMUNITY', channel: 'EMAIL', enabled: true },
    ])).resolves.toMatchObject({
      scope: 'own',
      preferences: expect.arrayContaining([
        expect.objectContaining({ category: 'COMMUNITY', channel: 'SSE', enabled: false, locked: false }),
        expect.objectContaining({ category: 'COMMUNITY', channel: 'EMAIL', enabled: true, locked: false }),
      ]),
    });

    const other = await service.get(USER_B);
    expect(other.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'COMMUNITY', channel: 'SSE', enabled: true }),
    ]));

    await expect(service.update(USER_A, [
      { category: 'SECURITY', channel: 'IN_APP', enabled: false },
    ])).rejects.toMatchObject({
      code: 'NOTIFICATION_MANDATORY_PREFERENCE',
      status: 422,
    });
    await expect(service.get(USER_A)).resolves.toEqual(expect.objectContaining({
      preferences: expect.arrayContaining([
        expect.objectContaining({ category: 'SECURITY', channel: 'IN_APP', enabled: true, locked: true }),
      ]),
    }));
  });

  it('treats repeated updates as idempotent and exposes mandatory delivery protection', async () => {
    const service = new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());

    await service.update(USER_A, [
      { category: 'EXCHANGE', channel: 'SSE', enabled: false },
    ]);
    await expect(service.update(USER_A, [
      { category: 'EXCHANGE', channel: 'SSE', enabled: false },
    ])).resolves.toMatchObject({
      preferences: expect.arrayContaining([
        expect.objectContaining({ category: 'EXCHANGE', channel: 'SSE', enabled: false }),
      ]),
    });

    await expect(service.isChannelEnabled(USER_A, {
      category: 'EXCHANGE',
      channel: 'SSE',
      notificationType: 'BUDDY_REQUEST',
    })).resolves.toBe(false);
    await expect(service.isChannelEnabled(USER_A, {
      category: 'SECURITY',
      channel: 'IN_APP',
      notificationType: 'SECURITY_NOTICE',
    })).resolves.toBe(true);
  });

  it('rejects invalid owner ids and preference duplicates without partial writes', async () => {
    const repository = new InMemoryNotificationPreferenceRepository();
    const service = new NotificationPreferenceService(repository);

    await expect(service.get('not-a-user')).rejects.toBeInstanceOf(NotificationFailure);
    await expect(service.update(USER_A, [
      { category: 'COMMUNITY', channel: 'SSE', enabled: false },
      { category: 'COMMUNITY', channel: 'SSE', enabled: true },
    ])).rejects.toMatchObject({ code: 'NOTIFICATION_INVALID_PREFERENCES' });
    await expect(service.get(USER_A)).resolves.toEqual(expect.objectContaining({
      preferences: expect.arrayContaining([
        expect.objectContaining({ category: 'COMMUNITY', channel: 'SSE', enabled: true }),
      ]),
    }));
  });
});
