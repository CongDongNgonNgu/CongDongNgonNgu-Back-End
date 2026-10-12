import { describe, expect, it } from '@jest/globals';
import { directMessageNotificationIntent } from '../messaging/direct-message-notification-intent';
import { createNotificationRecord } from './notification.repository';
import { projectCurrentNotification, type ConnectionNotificationAccess } from './connection-notification-access';

const room = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const record = createNotificationRecord(directMessageNotificationIntent(room, recipient,
  { id: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-10T01:00:00.000Z' }));

describe('current direct-message notification projection', () => {
  it('fails closed without a current access reader', async () => {
    expect(await projectCurrentNotification(record, false, null)).toMatchObject({
      available: false, response: { actor: { kind: 'DELETED' }, target: null, variables: {} },
    });
  });

  it('uses a generic actor and fixed conversation navigation, never saved snapshot metadata', async () => {
    const access: ConnectionNotificationAccess = {
      resolve: async () => ({ kind: 'SYSTEM', label: 'System' }), countUnread: async () => 1,
    };
    const forged = { ...record, actor: { kind: 'USER' as const, displayName: 'stale name', profilePath: '/profiles/stale' },
      target: { ...record.target!, path: '/private/old' }, variables: { title: 'private preview' } };
    expect(await projectCurrentNotification(forged, false, null, access)).toMatchObject({
      available: true, response: { actor: { kind: 'SYSTEM', label: 'System' },
        target: { kind: 'DIRECT_CONVERSATION', path: `/exchange/conversations/${room}` }, variables: {} },
    });
  });

  it('clears navigation when current unread/pair access disappears and forwards the delivery channel', async () => {
    let allowed = true;
    const channels: string[] = [];
    const access: ConnectionNotificationAccess = {
      resolve: async (_record, channel) => { channels.push(channel!); return allowed ? { kind: 'SYSTEM', label: 'System' } : null; },
      countUnread: async () => 0,
    };
    expect((await projectCurrentNotification(record, false, null, access, 'SSE')).available).toBe(true);
    allowed = false;
    expect((await projectCurrentNotification(record, false, null, access)).response.target).toBeNull();
    expect(channels).toEqual(['SSE', 'IN_APP']);
  });
});
