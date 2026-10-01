import type { Pool, PoolClient } from 'pg';
import type {
  SpeakingRoomParticipantAction,
  SpeakingRoomParticipantCounts,
  SpeakingRoomParticipantRecord,
  SpeakingRoomParticipantState,
} from './room.participant.types';
import {
  PARTICIPANT_DISCONNECT_AFTER_MS,
  PARTICIPANT_RECONNECT_LEASE_MS,
  SpeakingRoomParticipantConflictError,
  SpeakingRoomParticipantNotFoundError,
  type HeartbeatSpeakingRoomParticipantInput,
  type JoinSpeakingRoomParticipantInput,
  type LeaveSpeakingRoomParticipantInput,
  type SpeakingRoomParticipantMutationResult,
  type SpeakingRoomParticipantReconciliationResult,
  type SpeakingRoomParticipantRepository,
} from './room.participant.repository';

export class PostgresSpeakingRoomParticipantRepository implements SpeakingRoomParticipantRepository {
  constructor(private readonly pool: Pool) {}

  async joinParticipant(input: JoinSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.transaction(async (client) => {
      const room = await client.query(
        'SELECT capacity, lifecycle FROM speaking_rooms WHERE id = $1 FOR UPDATE',
        [input.roomId],
      );
      if (!room.rows[0]) throw new SpeakingRoomParticipantNotFoundError('Speaking room was not found');
      if (String(room.rows[0].lifecycle) !== 'LIVE') {
        throw new SpeakingRoomParticipantConflictError('ROOM_NOT_JOINABLE', 'Room is not live');
      }

      const action = await this.findAction(client, input.roomId, input.userId, input.joinRequestId);
      if (action) {
        if (action.actionType !== 'JOIN') {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return { participant: await this.requireParticipant(client, action.participantId), replayed: true };
      }
      const priorJoin = await client.query(
        `SELECT * FROM speaking_room_participants
         WHERE room_id = $1 AND user_id = $2 AND join_request_id = $3
         FOR UPDATE`,
        [input.roomId, input.userId, input.joinRequestId],
      );
      if (priorJoin.rows[0]) {
        const participant = mapParticipant(priorJoin.rows[0]);
        await this.recordAction(client, input.roomId, input.userId, input.joinRequestId, participant, 'JOIN');
        return { participant, replayed: true };
      }

      await reconcileStaleParticipants(client, input.roomId, input.now);
      const requested = input.participantId
        ? await this.findOwnedParticipant(client, input.roomId, input.userId, input.participantId)
        : null;
      if (input.participantId && !requested) throw new SpeakingRoomParticipantNotFoundError();
      if (requested) {
        if (!isActiveState(requested.state)) {
          throw new SpeakingRoomParticipantConflictError('INVALID_STATE', 'Participant lease is no longer active');
        }
        await this.ensureDeviceAvailable(client, input, requested.id);
        const participant = await this.markPresent(client, requested.id, input.deviceId, input.now);
        await this.recordAction(client, input.roomId, input.userId, input.joinRequestId, participant, 'JOIN');
        return { participant, replayed: false };
      }

      const sameDevice = await client.query(
        `SELECT * FROM speaking_room_participants
         WHERE room_id = $1 AND user_id = $2 AND device_id = $3
           AND state IN ('PRESENT'::speaking_room_participant_state, 'DISCONNECTED'::speaking_room_participant_state)
         ORDER BY joined_at ASC, id ASC
         LIMIT 1
         FOR UPDATE`,
        [input.roomId, input.userId, input.deviceId],
      );
      if (sameDevice.rows[0]) {
        const participant = await this.markPresent(client, String(sameDevice.rows[0].id), input.deviceId, input.now);
        await this.recordAction(client, input.roomId, input.userId, input.joinRequestId, participant, 'JOIN');
        return { participant, replayed: false };
      }

      const activeCount = await client.query(
        `SELECT count(*)::int AS count
         FROM speaking_room_participants
         WHERE room_id = $1
           AND state IN ('PRESENT'::speaking_room_participant_state, 'DISCONNECTED'::speaking_room_participant_state)`,
        [input.roomId],
      );
      if (Number(activeCount.rows[0]?.count ?? 0) >= Number(room.rows[0].capacity)) {
        throw new SpeakingRoomParticipantConflictError('CAPACITY', 'Room capacity has been reached');
      }

      const inserted = await client.query(
        `INSERT INTO speaking_room_participants (
           room_id, user_id, device_id, join_request_id, role, state,
           joined_at, last_seen_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::speaking_room_participant_role,
                   'PRESENT'::speaking_room_participant_state, $6, $6, $6)
         RETURNING *`,
        [input.roomId, input.userId, input.deviceId, input.joinRequestId, input.role, input.now],
      );
      const participant = mapParticipant(inserted.rows[0]);
      await this.recordAction(client, input.roomId, input.userId, input.joinRequestId, participant, 'JOIN');
      return { participant, replayed: false };
    });
  }

  async leaveParticipant(input: LeaveSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const action = await this.findAction(client, input.roomId, input.userId, input.requestId);
      const expectedAction = input.mode === 'DISCONNECT' ? 'DISCONNECT' : 'LEAVE';
      if (action) {
        if (action.actionType !== expectedAction) {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return { participant: await this.requireParticipant(client, action.participantId), replayed: true };
      }
      await reconcileStaleParticipants(client, input.roomId, input.now);
      const participant = await this.findOwnedParticipant(client, input.roomId, input.userId, input.participantId);
      if (!participant) throw new SpeakingRoomParticipantNotFoundError();

      let updated = participant;
      if (input.mode === 'DISCONNECT') {
        if (participant.state === 'PRESENT') {
          updated = await this.updateState(client, participant.id, input.now, 'disconnect');
        }
        await this.recordAction(client, input.roomId, input.userId, input.requestId, updated, 'DISCONNECT');
      } else {
        if (participant.state === 'PRESENT' || participant.state === 'DISCONNECTED') {
          updated = await this.updateState(client, participant.id, input.now, 'leave');
        }
        await this.recordAction(client, input.roomId, input.userId, input.requestId, updated, 'LEAVE');
      }
      return { participant: updated, replayed: false };
    });
  }

  async heartbeatParticipant(input: HeartbeatSpeakingRoomParticipantInput): Promise<SpeakingRoomParticipantMutationResult> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const action = await this.findAction(client, input.roomId, input.userId, input.requestId);
      if (action) {
        if (action.actionType !== 'HEARTBEAT') {
          throw new SpeakingRoomParticipantConflictError('REQUEST_REUSED', 'Request id was already used');
        }
        return { participant: await this.requireParticipant(client, action.participantId), replayed: true };
      }
      await reconcileStaleParticipants(client, input.roomId, input.now);
      const participant = await this.findOwnedParticipant(client, input.roomId, input.userId, input.participantId);
      if (!participant || !isActiveState(participant.state)) {
        throw new SpeakingRoomParticipantNotFoundError();
      }
      const updated = await this.markPresent(client, participant.id, participant.deviceId, input.now);
      await this.recordAction(client, input.roomId, input.userId, input.requestId, updated, 'HEARTBEAT');
      return { participant: updated, replayed: false };
    });
  }

  async reconcileStaleParticipants(
    roomId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantReconciliationResult> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      return reconcileStaleParticipants(client, roomId, now);
    });
  }

  async listParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantRecord[]> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      const result = await client.query(
        `SELECT * FROM speaking_room_participants
         WHERE room_id = $1
           AND state IN ('PRESENT'::speaking_room_participant_state, 'DISCONNECTED'::speaking_room_participant_state)
         ORDER BY joined_at ASC, id ASC`,
        [roomId],
      );
      return result.rows.map(mapParticipant);
    });
  }

  async countParticipants(roomId: string, now: Date): Promise<SpeakingRoomParticipantCounts> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      const result = await client.query(
        `SELECT
           count(*)::int AS participant_count,
           count(*) FILTER (WHERE role IN ('SPEAKER'::speaking_room_participant_role, 'HOST'::speaking_room_participant_role, 'MODERATOR'::speaking_room_participant_role))::int AS speaker_count,
           count(*) FILTER (WHERE role = 'LISTENER'::speaking_room_participant_role)::int AS listener_count
         FROM speaking_room_participants
         WHERE room_id = $1 AND state = 'PRESENT'::speaking_room_participant_state`,
        [roomId],
      );
      const row = result.rows[0] ?? {};
      return {
        participantCount: Number(row.participant_count ?? 0),
        speakerCount: Number(row.speaker_count ?? 0),
        listenerCount: Number(row.listener_count ?? 0),
      };
    });
  }

  async findActiveParticipant(
    roomId: string,
    userId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    await this.reconcileStaleParticipants(roomId, now);
    const result = await this.pool.query(
      `SELECT * FROM speaking_room_participants
       WHERE room_id = $1 AND user_id = $2 AND state = 'PRESENT'::speaking_room_participant_state
       ORDER BY joined_at ASC, id ASC
       LIMIT 1`,
      [roomId, userId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }

  async findParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      const result = await client.query(
        `SELECT * FROM speaking_room_participants
         WHERE id = $1 AND room_id = $2`,
        [participantId, roomId],
      );
      return result.rows[0] ? mapParticipant(result.rows[0]) : null;
    });
  }

  async setParticipantRole(
    roomId: string,
    participantId: string,
    role: SpeakingRoomParticipantRecord['role'],
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      const participant = await this.findParticipantForUpdate(client, roomId, participantId);
      if (!participant) throw new SpeakingRoomParticipantNotFoundError();
      if (!isActiveState(participant.state)) {
        throw new SpeakingRoomParticipantConflictError('INVALID_STATE', 'Participant is no longer active');
      }
      const result = await client.query(
        `UPDATE speaking_room_participants
         SET role = $3::speaking_room_participant_role, updated_at = $4
         WHERE id = $1 AND room_id = $2
         RETURNING *`,
        [participantId, roomId, role, now],
      );
      return mapParticipant(result.rows[0]);
    });
  }

  async removeParticipant(
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      const participant = await this.findParticipantForUpdate(client, roomId, participantId);
      if (!participant) throw new SpeakingRoomParticipantNotFoundError();
      if (!isActiveState(participant.state)) return participant;
      const result = await client.query(
        `UPDATE speaking_room_participants
         SET state = 'REMOVED'::speaking_room_participant_state,
             left_at = COALESCE(left_at, $3),
             updated_at = $3
         WHERE id = $1 AND room_id = $2
         RETURNING *`,
        [participantId, roomId, now],
      );
      return mapParticipant(result.rows[0]);
    });
  }

  private async lockRoom(client: PoolClient, roomId: string): Promise<void> {
    const result = await client.query('SELECT id FROM speaking_rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!result.rows[0]) throw new SpeakingRoomParticipantNotFoundError('Speaking room was not found');
  }

  private async findAction(
    client: PoolClient,
    roomId: string,
    userId: string,
    requestId: string,
  ): Promise<{ participantId: string; actionType: SpeakingRoomParticipantAction } | null> {
    const result = await client.query(
      `SELECT participant_id, action_type
       FROM speaking_room_participant_actions
       WHERE room_id = $1 AND user_id = $2 AND request_id = $3`,
      [roomId, userId, requestId],
    );
    if (!result.rows[0]) return null;
    return {
      participantId: String(result.rows[0].participant_id),
      actionType: result.rows[0].action_type as SpeakingRoomParticipantAction,
    };
  }

  private async findOwnedParticipant(
    client: PoolClient,
    roomId: string,
    userId: string,
    participantId: string,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    const result = await client.query(
      `SELECT * FROM speaking_room_participants
       WHERE id = $1 AND room_id = $2 AND user_id = $3
       FOR UPDATE`,
      [participantId, roomId, userId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }

  private async findParticipantForUpdate(
    client: PoolClient,
    roomId: string,
    participantId: string,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    const result = await client.query(
      `SELECT * FROM speaking_room_participants
       WHERE id = $1 AND room_id = $2
       FOR UPDATE`,
      [participantId, roomId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }

  private async requireParticipant(client: PoolClient, participantId: string): Promise<SpeakingRoomParticipantRecord> {
    const result = await client.query(
      'SELECT * FROM speaking_room_participants WHERE id = $1 FOR UPDATE',
      [participantId],
    );
    if (!result.rows[0]) throw new SpeakingRoomParticipantNotFoundError();
    return mapParticipant(result.rows[0]);
  }

  private async ensureDeviceAvailable(
    client: PoolClient,
    input: JoinSpeakingRoomParticipantInput,
    exceptParticipantId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT id FROM speaking_room_participants
       WHERE room_id = $1 AND user_id = $2 AND device_id = $3
         AND id <> $4
         AND state IN ('PRESENT'::speaking_room_participant_state, 'DISCONNECTED'::speaking_room_participant_state)
       LIMIT 1
       FOR UPDATE`,
      [input.roomId, input.userId, input.deviceId, exceptParticipantId],
    );
    if (result.rows[0]) {
      throw new SpeakingRoomParticipantConflictError('DEVICE_CONFLICT', 'Device already has an active participant');
    }
  }

  private async markPresent(
    client: PoolClient,
    participantId: string,
    deviceId: string,
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    const result = await client.query(
      `UPDATE speaking_room_participants
       SET device_id = $2,
           state = 'PRESENT'::speaking_room_participant_state,
           last_seen_at = $3,
           disconnected_at = NULL,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [participantId, deviceId, now],
    );
    if (!result.rows[0]) throw new SpeakingRoomParticipantNotFoundError();
    return mapParticipant(result.rows[0]);
  }

  private async updateState(
    client: PoolClient,
    participantId: string,
    now: Date,
    action: 'leave' | 'disconnect',
  ): Promise<SpeakingRoomParticipantRecord> {
    const result = await client.query(
      action === 'disconnect'
        ? `UPDATE speaking_room_participants
           SET state = 'DISCONNECTED'::speaking_room_participant_state,
               disconnected_at = COALESCE(disconnected_at, $2),
               updated_at = $2
           WHERE id = $1
           RETURNING *`
        : `UPDATE speaking_room_participants
           SET state = 'LEFT'::speaking_room_participant_state,
               left_at = COALESCE(left_at, $2),
               updated_at = $2
           WHERE id = $1
           RETURNING *`,
      [participantId, now],
    );
    if (!result.rows[0]) throw new SpeakingRoomParticipantNotFoundError();
    return mapParticipant(result.rows[0]);
  }

  private async recordAction(
    client: PoolClient,
    roomId: string,
    userId: string,
    requestId: string,
    participant: SpeakingRoomParticipantRecord,
    action: SpeakingRoomParticipantAction,
  ): Promise<void> {
    await client.query(
      `INSERT INTO speaking_room_participant_actions (
         room_id, user_id, request_id, participant_id, action_type, result_state
       ) VALUES ($1, $2, $3, $4, $5::speaking_room_participant_action, $6::speaking_room_participant_state)`,
      [roomId, userId, requestId, participant.id, action, participant.state],
    );
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function reconcileStaleParticipants(
  client: PoolClient,
  roomId: string,
  now: Date,
): Promise<SpeakingRoomParticipantReconciliationResult> {
  const disconnectBefore = new Date(now.getTime() - PARTICIPANT_DISCONNECT_AFTER_MS);
  const leaveBefore = new Date(now.getTime() - PARTICIPANT_RECONNECT_LEASE_MS);
  const leftPresent = await client.query(
    `UPDATE speaking_room_participants
     SET state = 'LEFT'::speaking_room_participant_state,
         disconnected_at = COALESCE(disconnected_at, $2),
         left_at = COALESCE(left_at, $2),
         updated_at = $2
     WHERE room_id = $1
       AND state = 'PRESENT'::speaking_room_participant_state
       AND last_seen_at <= $3`,
    [roomId, now, leaveBefore],
  );
  const disconnected = await client.query(
    `UPDATE speaking_room_participants
     SET state = 'DISCONNECTED'::speaking_room_participant_state,
         disconnected_at = COALESCE(disconnected_at, $2),
         updated_at = $2
     WHERE room_id = $1
       AND state = 'PRESENT'::speaking_room_participant_state
       AND last_seen_at <= $3`,
    [roomId, now, disconnectBefore],
  );
  const leftDisconnected = await client.query(
    `UPDATE speaking_room_participants
     SET state = 'LEFT'::speaking_room_participant_state,
         left_at = COALESCE(left_at, $2),
         updated_at = $2
     WHERE room_id = $1
       AND state = 'DISCONNECTED'::speaking_room_participant_state
       AND last_seen_at <= $3`,
    [roomId, now, leaveBefore],
  );
  return {
    disconnected: Number(disconnected.rowCount ?? 0),
    left: Number(leftPresent.rowCount ?? 0) + Number(leftDisconnected.rowCount ?? 0),
  };
}

function isActiveState(state: SpeakingRoomParticipantState): boolean {
  return state === 'PRESENT' || state === 'DISCONNECTED';
}

function mapParticipant(row: Record<string, unknown>): SpeakingRoomParticipantRecord {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    joinRequestId: String(row.join_request_id),
    role: row.role as SpeakingRoomParticipantRecord['role'],
    state: row.state as SpeakingRoomParticipantState,
    joinedAt: new Date(String(row.joined_at)),
    lastSeenAt: new Date(String(row.last_seen_at)),
    disconnectedAt: row.disconnected_at ? new Date(String(row.disconnected_at)) : null,
    leftAt: row.left_at ? new Date(String(row.left_at)) : null,
    updatedAt: new Date(String(row.updated_at)),
  };
}
