import { describe, expect, it, jest } from '@jest/globals';
import type { IdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import {
  InMemoryNotificationPreferenceRepository,
} from '../notifications/notification-preference.repository';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import {
  InMemorySpeakingRoomParticipantRepository,
} from '../rooms/room.participant.repository';
import { InMemorySpeakingRoomRepository } from '../rooms/room.repository';
import { EventService } from './event.service';
import { InMemoryEventRepository } from './event.repository';
import { InMemoryEventParticipationRepository } from './event.participation.repository';
import type { CreateEventDto } from './event.dto';
import type { EventAttendanceLearningHook } from './event.participation.types';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const LEARNER_A = '22222222-2222-4222-8222-222222222222';
const LEARNER_B = '33333333-3333-4333-8333-333333333333';
const LEARNER_C = '44444444-4444-4444-8444-444444444444';
const NOW = at('2026-10-01T00:00:00.000Z');

describe('event participation orchestration', () => {
  it('allocates one last seat atomically, keeps waitlist order, and promotes on cancellation', async () => {
    const { service, rooms, participation } = await createService();
    const room = await createRoom(rooms, 'LIVE');
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        capacity: 1,
        startAt: '2026-10-10T02:00:00.000Z',
        endAt: '2026-10-10T03:00:00.000Z',
      }),
      NOW,
    );

    const results = await Promise.all([
      service.registerEvent(event.id, LEARNER_A, NOW),
      service.registerEvent(event.id, LEARNER_B, NOW),
    ]);
    const statuses = results.map((result) => result.registration.status).sort();
    expect(statuses).toEqual(['REGISTERED', 'WAITLISTED']);
    expect(
      results.find((result) => result.registration.status === 'WAITLISTED')?.registration.waitlistPosition,
    ).toBe(1);

    const registeredUserId = results[0].registration.status === 'REGISTERED' ? LEARNER_A : LEARNER_B;
    const waitlistedUserId = registeredUserId === LEARNER_A ? LEARNER_B : LEARNER_A;
    const replay = await service.registerEvent(event.id, waitlistedUserId, NOW);
    expect(replay.replayed).toBe(true);

    const cancelled = await service.cancelRegistration(event.id, registeredUserId, NOW);
    expect(cancelled.promotedCount).toBe(1);
    const remaining = await participation.findRegistration(event.id, waitlistedUserId);
    expect(remaining?.status).toBe('REGISTERED');
    expect(await participation.listReminderIntents(event.id)).toHaveLength(4);
  });

  it('enforces private invitation access and never treats the host as an attendee', async () => {
    const { service, rooms } = await createService();
    const room = await createRoom(rooms, 'LIVE');
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        visibility: 'PRIVATE',
        startAt: '2026-10-10T02:00:00.000Z',
        endAt: '2026-10-10T03:00:00.000Z',
      }),
      NOW,
    );

    await expect(service.getEvent(event.id, LEARNER_A, NOW)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    await expect(service.registerEvent(event.id, HOST_ID, NOW)).rejects.toMatchObject({
      code: 'EVENT_HOST_CANNOT_REGISTER',
    });

    await service.inviteEventUser(event.id, HOST_ID, { userId: LEARNER_A }, NOW);
    await expect(service.getEvent(event.id, LEARNER_A, NOW)).resolves.toMatchObject({
      id: event.id,
      visibility: 'PRIVATE',
    });
    await expect(service.registerEvent(event.id, LEARNER_A, NOW)).resolves.toMatchObject({
      registration: { status: 'REGISTERED' },
    });
    await expect(
      service.revokeEventInvitation(event.id, HOST_ID, LEARNER_A, NOW),
    ).resolves.toMatchObject({ outcome: 'REVOKED', userId: LEARNER_A });
    await expect(service.getEvent(event.id, LEARNER_A, NOW)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    await expect(service.registerEvent(event.id, LEARNER_B, NOW)).rejects.toMatchObject({
      code: 'EVENT_INVITE_REQUIRED',
    });
  });

  it('suppresses reminder intents from preference policy and reschedules only future windows', async () => {
    const preferences = new NotificationPreferenceService(
      new InMemoryNotificationPreferenceRepository(),
    );
    const { service, rooms } = await createService({ preferences });
    const room = await createRoom(rooms, 'LIVE');
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        startAt: '2026-10-01T02:30:00.000Z',
        endAt: '2026-10-01T03:30:00.000Z',
      }),
      at('2026-09-30T23:00:00.000Z'),
    );

    await preferences.update(LEARNER_A, [
      { category: 'COMMUNITY', channel: 'IN_APP', enabled: false },
    ]);
    await service.registerEvent(event.id, LEARNER_A, NOW);
    const suppressed = await service.getEventReminders(event.id, LEARNER_A);
    expect(suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'SUPPRESSED', suppressionReason: 'IN_APP_PREFERENCE' }),
    ]));

    await preferences.update(LEARNER_A, [
      { category: 'COMMUNITY', channel: 'IN_APP', enabled: true },
    ]);
    const reconciled = await service.reconcileEventReminders(event.id, LEARNER_A, NOW);
    expect(reconciled).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ONE_HOUR', status: 'SCHEDULED', recipientTimezone: 'Asia/Ho_Chi_Minh' }),
    ]));
    expect(reconciled.find((intent) => intent.kind === 'TWENTY_FOUR_HOURS')?.status).toBe('SUPPRESSED');
  });

  it('cancels reminder intents using the server cancellation time', async () => {
    const { service, rooms } = await createService();
    const room = await createRoom(rooms, 'LIVE');
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        startAt: '2026-10-10T02:00:00.000Z',
        endAt: '2026-10-10T03:00:00.000Z',
      }),
      NOW,
    );
    await service.registerEvent(event.id, LEARNER_A, NOW);

    const cancelledAt = at('2026-10-02T05:06:07.000Z');
    await service.cancelRegistration(event.id, LEARNER_A, cancelledAt);

    expect(await service.getEventReminders(event.id, LEARNER_A)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'CANCELLED',
          suppressionReason: 'REGISTRATION_CANCELLED',
          updatedAt: cancelledAt,
        }),
      ]),
    );
  });

  it('accepts host attendance as trusted evidence, rejects altered replay, and calls the hook once', async () => {
    const hook: EventAttendanceLearningHook = {
      recordTrustedAttendance: jest.fn(async () => undefined),
    };
    const { service, rooms } = await createService({ hook });
    const room = await createRoom(rooms, 'LIVE');
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        startAt: '2026-10-01T01:00:00.000Z',
        endAt: '2026-10-01T02:00:00.000Z',
      }),
      NOW,
    );
    await service.registerEvent(event.id, LEARNER_A, NOW);

    const first = await service.markEventAttendance(
      event.id,
      HOST_ID,
      { userId: LEARNER_A },
      at('2026-10-01T01:15:00.000Z'),
    );
    const replay = await service.markEventAttendance(
      event.id,
      HOST_ID,
      { userId: LEARNER_A },
      at('2026-10-01T01:15:00.000Z'),
    );
    expect(first.outcome).toBe('RECORDED');
    expect(replay.outcome).toBe('REPLAYED');
    expect(hook.recordTrustedAttendance).toHaveBeenCalledTimes(1);
    await expect(service.markEventAttendance(
      event.id,
      HOST_ID,
      { userId: LEARNER_A },
      at('2026-10-01T01:16:00.000Z'),
    )).rejects.toMatchObject({ code: 'EVENT_ATTENDANCE_REPLAY_CONFLICT' });
  });

  it('derives system attendance only from room presence, never from page views', async () => {
    const roomParticipants = new InMemorySpeakingRoomParticipantRepository();
    const { service, rooms } = await createService({ roomParticipants });
    const room = await createRoom(rooms, 'LIVE');
    const participant = await roomParticipants.joinParticipant({
      roomId: room.id,
      userId: LEARNER_A,
      deviceId: 'device-a',
      joinRequestId: 'join-a',
      participantId: null,
      role: 'LISTENER',
      capacity: room.capacity,
      lifecycle: 'LIVE',
      now: at('2026-10-01T01:10:00.000Z'),
    });
    const event = await service.createEvent(
      HOST_ID,
      createInput(room.id, {
        startAt: '2026-10-01T01:00:00.000Z',
        endAt: '2026-10-01T02:00:00.000Z',
      }),
      NOW,
    );
    await service.registerEvent(event.id, LEARNER_A, NOW);

    await expect(service.recordSystemAttendance(event.id, {
      userId: LEARNER_A,
      roomId: room.id,
      participantId: participant.participant.id,
      occurredAt: at('2026-10-01T01:10:00.000Z'),
    }, at('2026-10-01T01:11:00.000Z'))).resolves.toMatchObject({
      outcome: 'RECORDED',
      attendance: { evidenceType: 'ROOM_PRESENCE' },
    });
  });
});

async function createService(options: {
  hook?: EventAttendanceLearningHook;
  preferences?: NotificationPreferenceService;
  roomParticipants?: InMemorySpeakingRoomParticipantRepository;
} = {}) {
  const rooms = new InMemorySpeakingRoomRepository();
  const profiles = new InMemoryProfileRepository();
  const participation = new InMemoryEventParticipationRepository();
  const identities = {
    findUserById: async (id: string) =>
      [HOST_ID, LEARNER_A, LEARNER_B, LEARNER_C].includes(id)
        ? {
            id,
            email: `${id}@example.test`,
            displayName: id === HOST_ID ? 'Event host' : 'Learner',
            passwordHash: null,
            status: 'ACTIVE' as const,
            emailVerifiedAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
            roles: ['MEMBER' as const],
          }
        : null,
  } as IdentityRepository;
  return {
    rooms,
    participation,
    service: new EventService(
      new InMemoryEventRepository(),
      profiles,
      identities,
      rooms,
      participation,
      options.hook,
      options.preferences,
      options.roomParticipants,
    ),
  };
}

async function createRoom(
  rooms: InMemorySpeakingRoomRepository,
  lifecycle: 'LIVE' | 'SCHEDULED',
) {
  return rooms.createRoom({
    hostUserId: HOST_ID,
    languageCode: 'en',
    level: 'B1',
    topic: 'Conversation',
    visibility: 'PUBLIC',
    lifecycle,
    capacity: 20,
    accessTokenHash: null,
    scheduledAt: lifecycle === 'SCHEDULED' ? at('2026-10-10T01:00:00.000Z') : null,
    startedAt: lifecycle === 'LIVE' ? at('2026-10-01T00:00:00.000Z') : null,
    createdAt: NOW,
  });
}

function createInput(
  roomId: string,
  overrides: Partial<CreateEventDto> = {},
): CreateEventDto {
  return {
    title: 'English Event',
    languageCode: 'en',
    level: 'B1',
    topic: 'Practice',
    startAt: '2026-10-10T02:00:00.000Z',
    endAt: '2026-10-10T03:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    capacity: 20,
    visibility: 'PUBLIC',
    venueType: 'SPEAKING_ROOM',
    speakingRoomId: roomId,
    recurrence: undefined,
    ...overrides,
  };
}

function at(value: string): Date {
  return new Date(value);
}
