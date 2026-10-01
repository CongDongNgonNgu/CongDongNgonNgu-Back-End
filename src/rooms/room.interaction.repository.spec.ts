import { describe, expect, it } from '@jest/globals';
import {
  InMemorySpeakingRoomInteractionRepository,
  SpeakingRoomInteractionConflictError,
  type SpeakingRoomInteractionRepository,
} from './room.interaction.repository';
import { InMemorySpeakingRoomParticipantRepository } from './room.participant.repository';

const ROOM_ID = '00000000-0000-4000-8000-000000000100';
const HOST_ID = '00000000-0000-4000-8000-000000000101';
const LISTENER_ID = '00000000-0000-4000-8000-000000000102';
const START = new Date('2026-10-01T00:00:00.000Z');

describe('InMemorySpeakingRoomInteractionRepository', () => {
  async function setup() {
    const participants = new InMemorySpeakingRoomParticipantRepository();
    const interactions: SpeakingRoomInteractionRepository = new InMemorySpeakingRoomInteractionRepository(participants);
    const host = await participants.joinParticipant({
      roomId: ROOM_ID,
      userId: HOST_ID,
      deviceId: 'host-browser',
      joinRequestId: '00000000-0000-4000-8000-000000000201',
      participantId: null,
      role: 'HOST',
      capacity: 5,
      lifecycle: 'LIVE',
      now: START,
    });
    const listener = await participants.joinParticipant({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      deviceId: 'listener-browser',
      joinRequestId: '00000000-0000-4000-8000-000000000202',
      participantId: null,
      role: 'LISTENER',
      capacity: 5,
      lifecycle: 'LIVE',
      now: START,
    });
    return { participants, interactions, host: host.participant, listener: listener.participant };
  }

  it('serializes concurrent raise-hand replay and preserves deterministic order', async () => {
    const { interactions, listener } = await setup();
    const input = {
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000301',
      now: START,
    };
    const [first, replay] = await Promise.all([
      interactions.raiseHand(input),
      interactions.raiseHand(input),
    ]);

    expect(first.entry.id).toBe(replay.entry.id);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect((await interactions.listQueue(ROOM_ID, START)).map((entry) => entry.id)).toEqual([first.entry.id]);
  });

  it('accepts a pending hand only through the queue decision and updates server role state', async () => {
    const { interactions, host, listener } = await setup();
    const raised = await interactions.raiseHand({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000302',
      now: START,
    });
    const accepted = await interactions.decideQueue({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      queueEntryId: raised.entry.id,
      requestId: '00000000-0000-4000-8000-000000000303',
      decision: 'ACCEPT',
      now: START,
    });

    expect(accepted.entry.state).toBe('ACCEPTED');
    expect(accepted.participant.role).toBe('SPEAKER');
    expect((await interactions.decideQueue({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      queueEntryId: raised.entry.id,
      requestId: '00000000-0000-4000-8000-000000000303',
      decision: 'ACCEPT',
      now: START,
    })).replayed).toBe(true);
    expect(host.role).toBe('HOST');
  });

  it('keeps a disconnected speaker request through the reconnect lease and cancels it after reconciliation', async () => {
    const { interactions, participants, listener } = await setup();
    await interactions.raiseHand({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000304',
      now: START,
    });
    await participants.leaveParticipant({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000305',
      mode: 'DISCONNECT',
      now: new Date(START.getTime() + 31_000),
    });

    expect(await interactions.listQueue(ROOM_ID, new Date(START.getTime() + 60_000))).toHaveLength(1);
    expect(await interactions.listQueue(ROOM_ID, new Date(START.getTime() + 151_000))).toHaveLength(0);
  });

  it('audits moderation, integrates room-scoped blocks/reports, and rate-limits chat', async () => {
    const { interactions, host, listener } = await setup();
    const muted = await interactions.moderateParticipant({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      targetParticipantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000306',
      action: 'MUTE',
      mutedUntil: new Date(START.getTime() + 300_000),
      reason: null,
      now: START,
    });
    expect(muted.action.action).toBe('MUTE');
    expect(await interactions.isMuted(ROOM_ID, listener.id, START)).toBe(true);
    expect((await interactions.moderateParticipant({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      targetParticipantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000306',
      action: 'MUTE',
      mutedUntil: new Date(START.getTime() + 300_000),
      reason: null,
      now: START,
    })).replayed).toBe(true);

    const firstMessage = await interactions.sendChat({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000307',
      body: '<script>plain text</script>',
      now: START,
    });
    expect(firstMessage.message.body).toContain('<script>');
    for (let index = 1; index < 5; index += 1) {
      await interactions.sendChat({
        roomId: ROOM_ID,
        userId: LISTENER_ID,
        participantId: listener.id,
        requestId: `00000000-0000-4000-8000-00000000030${7 + index}`,
        body: `message-${index}`,
        now: START,
      });
    }
    await expect(interactions.sendChat({
      roomId: ROOM_ID,
      userId: LISTENER_ID,
      participantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000312',
      body: 'rate limited',
      now: START,
    })).rejects.toMatchObject({ reason: 'RATE_LIMITED' });

    expect(await interactions.blockParticipant({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      targetParticipantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000313',
      action: 'BLOCK',
      now: START,
    })).toMatchObject({ blocked: true, replayed: false });
    expect((await interactions.listChat({
      roomId: ROOM_ID,
      viewerUserId: HOST_ID,
      limit: 50,
      before: null,
    })).items).toHaveLength(0);

    const report = await interactions.reportParticipant({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      targetParticipantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000314',
      category: 'SAFETY_CONCERN',
      details: 'unsafe behavior',
      now: START,
    });
    expect(report).toMatchObject({ duplicate: false, replayed: false });
    expect(await interactions.reportParticipant({
      roomId: ROOM_ID,
      actorUserId: HOST_ID,
      targetParticipantId: listener.id,
      requestId: '00000000-0000-4000-8000-000000000315',
      category: 'SAFETY_CONCERN',
      details: 'duplicate',
      now: START,
    })).toMatchObject({ duplicate: true, replayed: false });
    expect((await interactions.listModerationActions(ROOM_ID, 20)).map((action) => action.action))
      .toEqual(expect.arrayContaining(['MUTE', 'BLOCK', 'REPORT']));
    expect(host.role).toBe('HOST');
  });
});
