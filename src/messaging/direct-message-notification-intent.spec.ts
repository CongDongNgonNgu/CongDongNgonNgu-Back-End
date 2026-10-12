import { describe, expect, it } from '@jest/globals';
import { directMessageNotificationIntent } from './direct-message-notification-intent';

const room = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const first = { id: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-10T01:00:00.000Z' };

describe('generic coalesced direct-message notification intent', () => {
  it('uses only room, recipient and first unread identity with a fixed generic actor and no preview', () => {
    const intent = directMessageNotificationIntent(room, recipient, first);
    expect(intent).toMatchObject({
      notificationType: 'DIRECT_MESSAGE', category: 'EXCHANGE', priority: 'NORMAL',
      actor: { kind: 'SYSTEM', label: 'System' }, variables: {},
      target: { kind: 'DIRECT_CONVERSATION', id: room, path: `/exchange/conversations/${room}` },
      recipient: { authority: 'SOURCE_DOMAIN', userId: recipient },
      sourceEvent: { eventId: first.id, eventType: 'messaging.direct.unread',
        aggregateType: 'DIRECT_CONVERSATION', aggregateId: room },
      createdAt: first.createdAt,
    });
  });

  it('coalesces repeat materialization until the first unread message advances', () => {
    const original = directMessageNotificationIntent(room, recipient, first);
    expect(directMessageNotificationIntent(room, recipient, { ...first })).toEqual(original);
    const advanced = directMessageNotificationIntent(room, recipient,
      { ...first, id: '44444444-4444-4444-8444-444444444444' });
    expect(advanced.deduplicationKey).not.toBe(original.deduplicationKey);
    const otherRecipient = directMessageNotificationIntent(room,
      '55555555-5555-4555-8555-555555555555', first);
    expect(otherRecipient.deduplicationKey).not.toBe(original.deduplicationKey);
  });

  it('does not copy extra source fields into durable metadata', () => {
    const source = { ...first, text: 'private note', title: 'restricted title', token: 'invite secret' };
    const serialized = JSON.stringify(directMessageNotificationIntent(room, recipient, source));
    for (const hidden of [source.text, source.title, source.token]) expect(serialized).not.toContain(hidden);
  });
});
