import { describe, expect, it } from '@jest/globals';
import type { IdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemorySpeakingRoomRepository } from '../rooms/room.repository';
import { EventService } from './event.service';
import { InMemoryEventRepository } from './event.repository';
import type { CreateEventDto } from './event.dto';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const INACTIVE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = at('2026-10-01T00:00:00.000Z');

describe('EventService', () => {
  it('creates a timezone-aware event only for the speaking-room host', async () => {
    const { service, rooms } = await createService();
    const room = await rooms.createRoom({
      hostUserId: HOST_ID,
      languageCode: 'en',
      level: 'B1',
      topic: 'Coffee talk',
      visibility: 'PUBLIC',
      lifecycle: 'SCHEDULED',
      capacity: 20,
      accessTokenHash: null,
      scheduledAt: at('2026-10-10T02:00:00.000Z'),
      startedAt: null,
      createdAt: NOW,
    });

    const event = await service.createEvent(HOST_ID, createInput(room.id), NOW);

    expect(event).toMatchObject({
      title: 'English Coffee Talk',
      hostUserId: HOST_ID,
      timezone: 'Asia/Ho_Chi_Minh',
      venueType: 'SPEAKING_ROOM',
      speakingRoomId: room.id,
      state: 'UPCOMING',
    });
    expect(event.startAt.toISOString()).toBe('2026-10-10T02:00:00.000Z');
    expect(event.recurrence).toMatchObject({ frequency: 'WEEKLY', count: 4 });
  });

  it('rejects cross-user room binding and currently unsupported provider venues', async () => {
    const { service, rooms } = await createService();
    const room = await rooms.createRoom({
      hostUserId: HOST_ID,
      languageCode: 'en',
      level: null,
      topic: 'Practice',
      visibility: 'PUBLIC',
      lifecycle: 'SCHEDULED',
      capacity: 20,
      accessTokenHash: null,
      scheduledAt: at('2026-10-10T02:00:00.000Z'),
      startedAt: null,
      createdAt: NOW,
    });

    await expect(
      service.createEvent(OTHER_ID, createInput(room.id), NOW),
    ).rejects.toMatchObject({
      code: 'EVENT_SPEAKING_ROOM_HOST_FORBIDDEN',
    });
    await expect(
      service.createEvent(
        HOST_ID,
        {
          ...createInput(room.id),
          venueType: 'EXTERNAL',
          speakingRoomId: null,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'EVENT_VENUE_UNSUPPORTED' });
  });

  it('fails closed for private events and keeps public discovery bounded', async () => {
    const { service, rooms } = await createService();
    const room = await rooms.createRoom({
      hostUserId: HOST_ID,
      languageCode: 'en',
      level: null,
      topic: 'Private practice',
      visibility: 'PUBLIC',
      lifecycle: 'SCHEDULED',
      capacity: 20,
      accessTokenHash: null,
      scheduledAt: at('2026-10-10T02:00:00.000Z'),
      startedAt: null,
      createdAt: NOW,
    });
    const privateEvent = await service.createEvent(
      HOST_ID,
      {
        ...createInput(room.id),
        visibility: 'PRIVATE',
        recurrence: undefined,
      },
      NOW,
    );
    await service.createEvent(
      HOST_ID,
      { ...createInput(room.id), recurrence: undefined },
      NOW,
    );

    await expect(
      service.getEvent(privateEvent.id, OTHER_ID, NOW),
    ).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    await expect(
      service.getEvent(privateEvent.id, null, NOW),
    ).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    expect(
      await service.listPublicEvents({ state: 'UPCOMING' }, NOW),
    ).toHaveLength(1);
    expect((await service.getEvent(privateEvent.id, HOST_ID, NOW)).isHost).toBe(
      true,
    );
  });

  it('allows only the host to cancel and makes repeated cancellation idempotent', async () => {
    const { service, rooms } = await createService();
    const room = await rooms.createRoom({
      hostUserId: HOST_ID,
      languageCode: 'en',
      level: null,
      topic: 'Cancellation',
      visibility: 'PUBLIC',
      lifecycle: 'SCHEDULED',
      capacity: 20,
      accessTokenHash: null,
      scheduledAt: at('2026-10-10T02:00:00.000Z'),
      startedAt: null,
      createdAt: NOW,
    });
    const event = await service.createEvent(
      HOST_ID,
      { ...createInput(room.id), recurrence: undefined },
      NOW,
    );

    await expect(
      service.cancelEvent(event.id, OTHER_ID, NOW),
    ).rejects.toMatchObject({
      code: 'EVENT_HOST_FORBIDDEN',
    });
    const first = await service.cancelEvent(event.id, HOST_ID, NOW);
    const replay = await service.cancelEvent(
      event.id,
      HOST_ID,
      at('2026-10-01T00:01:00.000Z'),
    );
    expect(first).toMatchObject({
      outcome: 'CANCELLED',
      event: { state: 'CANCELLED' },
    });
    expect(replay).toMatchObject({
      outcome: 'REPLAYED',
      event: { state: 'CANCELLED' },
    });
  });

  it('rejects inactive actors before any event or room lookup', async () => {
    const { service } = await createService();
    await expect(
      service.createEvent(
        INACTIVE_ID,
        createInput('44444444-4444-4444-8444-444444444444'),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'EVENT_ACTOR_INVALID' });
  });
});

async function createService() {
  const rooms = new InMemorySpeakingRoomRepository();
  const identities = {
    findUserById: async (id: string) =>
      [HOST_ID, OTHER_ID].includes(id)
        ? {
            id,
            email: `${id}@example.test`,
            displayName: 'Event host',
            passwordHash: null,
            status: 'ACTIVE' as const,
            emailVerifiedAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
            roles: ['MEMBER' as const],
          }
        : id === INACTIVE_ID
          ? {
              id,
              email: `${id}@example.test`,
              displayName: 'Inactive user',
              passwordHash: null,
              status: 'DISABLED' as const,
              emailVerifiedAt: NOW,
              createdAt: NOW,
              updatedAt: NOW,
              roles: ['MEMBER' as const],
            }
          : null,
  } as IdentityRepository;
  return {
    rooms,
    service: new EventService(
      new InMemoryEventRepository(),
      new InMemoryProfileRepository(),
      identities,
      rooms,
    ),
  };
}

function createInput(roomId: string): CreateEventDto {
  return {
    title: 'English Coffee Talk',
    languageCode: 'en',
    level: 'B1',
    topic: 'Small talk',
    startAt: '2026-10-10T02:00:00.000Z',
    endAt: '2026-10-10T03:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    capacity: 20,
    visibility: 'PUBLIC',
    venueType: 'SPEAKING_ROOM',
    speakingRoomId: roomId,
    recurrence: {
      frequency: 'WEEKLY',
      interval: 1,
      count: 4,
      byWeekday: ['MO'],
    },
  };
}

function at(value: string): Date {
  return new Date(value);
}
