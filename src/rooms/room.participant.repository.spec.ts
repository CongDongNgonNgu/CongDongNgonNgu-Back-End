import { describe, expect, it } from '@jest/globals';
import {
  InMemorySpeakingRoomParticipantRepository,
  SpeakingRoomParticipantConflictError,
  SpeakingRoomParticipantNotFoundError,
} from './room.participant.repository';

const ROOM_ID = '00000000-0000-4000-8000-000000000010';
const USER_A = '00000000-0000-4000-8000-000000000011';
const USER_B = '00000000-0000-4000-8000-000000000012';
const USER_C = '00000000-0000-4000-8000-000000000013';
const START = new Date('2026-10-01T00:00:00.000Z');

describe('InMemorySpeakingRoomParticipantRepository', () => {
  function repository() {
    return new InMemorySpeakingRoomParticipantRepository();
  }

  function joinInput(overrides: Partial<Parameters<InMemorySpeakingRoomParticipantRepository['joinParticipant']>[0]> = {}) {
    return {
      roomId: ROOM_ID,
      userId: USER_A,
      deviceId: 'browser-a',
      joinRequestId: '00000000-0000-4000-8000-000000000101',
      participantId: null,
      role: 'LISTENER' as const,
      capacity: 3,
      lifecycle: 'LIVE' as const,
      now: START,
      ...overrides,
    };
  }

  it('returns the same participant for exact and concurrent join replay', async () => {
    const participants = repository();
    const input = joinInput();

    const [first, replay, concurrentReplay] = await Promise.all([
      participants.joinParticipant(input),
      participants.joinParticipant(input),
      participants.joinParticipant(input),
    ]);

    expect(new Set([first.participant.id, replay.participant.id, concurrentReplay.participant.id]).size).toBe(1);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(concurrentReplay.replayed).toBe(true);
  });

  it('allows distinct devices but collapses duplicate joins from one device', async () => {
    const participants = repository();
    const first = await participants.joinParticipant(joinInput());
    const duplicateDevice = await participants.joinParticipant(joinInput({
      joinRequestId: '00000000-0000-4000-8000-000000000102',
    }));
    const secondDevice = await participants.joinParticipant(joinInput({
      deviceId: 'phone-a',
      joinRequestId: '00000000-0000-4000-8000-000000000103',
    }));

    expect(duplicateDevice.participant.id).toBe(first.participant.id);
    expect(secondDevice.participant.id).not.toBe(first.participant.id);
    expect((await participants.countParticipants(ROOM_ID, START)).participantCount).toBe(2);
  });

  it('enforces capacity under concurrent distinct-device joins', async () => {
    const participants = repository();
    await participants.joinParticipant(joinInput({
      capacity: 2,
      joinRequestId: '00000000-0000-4000-8000-000000000104',
    }));

    const results = await Promise.allSettled([
      participants.joinParticipant(joinInput({
        userId: USER_B,
        deviceId: 'browser-b',
        joinRequestId: '00000000-0000-4000-8000-000000000105',
        capacity: 2,
      })),
      participants.joinParticipant(joinInput({
        userId: USER_C,
        deviceId: 'browser-c',
        joinRequestId: '00000000-0000-4000-8000-000000000106',
        capacity: 2,
      })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await participants.countParticipants(ROOM_ID, START)).participantCount).toBe(2);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(SpeakingRoomParticipantConflictError);
  });

  it('preserves a reconnect lease and cleans it after the bounded cutoff', async () => {
    const participants = repository();
    const joined = await participants.joinParticipant(joinInput());
    const disconnected = await participants.leaveParticipant({
      roomId: ROOM_ID,
      userId: USER_A,
      participantId: joined.participant.id,
      requestId: '00000000-0000-4000-8000-000000000107',
      mode: 'DISCONNECT',
      now: new Date(START.getTime() + 31_000),
    });

    expect(disconnected.participant.state).toBe('DISCONNECTED');
    const reconnected = await participants.joinParticipant(joinInput({
      participantId: joined.participant.id,
      joinRequestId: '00000000-0000-4000-8000-000000000108',
      now: new Date(START.getTime() + 60_000),
    }));
    expect(reconnected.participant.id).toBe(joined.participant.id);
    expect(reconnected.participant.state).toBe('PRESENT');

    await participants.leaveParticipant({
      roomId: ROOM_ID,
      userId: USER_A,
      participantId: joined.participant.id,
      requestId: '00000000-0000-4000-8000-000000000109',
      mode: 'DISCONNECT',
      now: new Date(START.getTime() + 61_000),
    });
    const reconciliation = await participants.reconcileStaleParticipants(
      ROOM_ID,
      new Date(START.getTime() + 151_000),
    );
    expect(reconciliation.left).toBe(1);
    expect((await participants.countParticipants(ROOM_ID, new Date(START.getTime() + 151_000))).participantCount).toBe(0);
  });

  it('makes leave idempotent and rejects cross-user participant mutation', async () => {
    const participants = repository();
    const joined = await participants.joinParticipant(joinInput());
    const leave = {
      roomId: ROOM_ID,
      userId: USER_A,
      participantId: joined.participant.id,
      requestId: '00000000-0000-4000-8000-000000000110',
      mode: 'VOLUNTARY' as const,
      now: START,
    };
    const first = await participants.leaveParticipant(leave);
    const replay = await participants.leaveParticipant(leave);
    expect(first.participant.state).toBe('LEFT');
    expect(replay.participant.id).toBe(first.participant.id);
    expect(replay.replayed).toBe(true);

    await expect(participants.leaveParticipant({
      ...leave,
      userId: USER_B,
      requestId: '00000000-0000-4000-8000-000000000111',
    })).rejects.toBeInstanceOf(SpeakingRoomParticipantNotFoundError);
  });

  it('counts present speakers and listeners from persisted role state', async () => {
    const participants = repository();
    await participants.joinParticipant(joinInput({
      role: 'HOST',
      joinRequestId: '00000000-0000-4000-8000-000000000112',
    }));
    await participants.joinParticipant(joinInput({
      userId: USER_B,
      deviceId: 'browser-b',
      role: 'LISTENER',
      joinRequestId: '00000000-0000-4000-8000-000000000113',
    }));
    expect(await participants.countParticipants(ROOM_ID, START)).toEqual({
      participantCount: 2,
      speakerCount: 1,
      listenerCount: 1,
    });
  });
});
