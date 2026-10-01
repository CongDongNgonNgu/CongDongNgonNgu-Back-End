import type { Pool, PoolClient } from 'pg';
import type {
  SpeakingRoomParticipantRecord,
  SpeakingRoomParticipantState,
} from './room.participant.types';
import {
  PARTICIPANT_DISCONNECT_AFTER_MS,
  PARTICIPANT_RECONNECT_LEASE_MS,
} from './room.participant.repository';
import type {
  SpeakingRoomChatCursor,
  SpeakingRoomChatMessageRecord,
  SpeakingRoomModerationActionRecord,
  SpeakingRoomModerationActionType,
  SpeakingRoomQueueEntryRecord,
  SpeakingRoomQueueState,
} from './room.interaction.types';
import {
  ROOM_CHAT_RATE_LIMIT,
  ROOM_CHAT_RATE_WINDOW_MS,
  SpeakingRoomInteractionConflictError,
  SpeakingRoomInteractionNotFoundError,
  type BlockParticipantInput,
  type CancelHandInput,
  type ChangeRoleInput,
  type ListChatInput,
  type ModerateParticipantInput,
  type QueueDecisionInput,
  type RaiseHandInput,
  type ReportParticipantInput,
  type SendChatInput,
  type SpeakingRoomBlockMutation,
  type SpeakingRoomChatMutation,
  type SpeakingRoomChatPage,
  type SpeakingRoomInteractionRepository,
  type SpeakingRoomModerationMutation,
  type SpeakingRoomQueueMutation,
  type SpeakingRoomReportMutation,
} from './room.interaction.repository';

export class PostgresSpeakingRoomInteractionRepository implements SpeakingRoomInteractionRepository {
  constructor(private readonly pool: Pool) {}

  async raiseHand(input: RaiseHandInput): Promise<SpeakingRoomQueueMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      await reconcileStaleParticipants(client, input.roomId, input.now);
      const action = await this.findQueueAction(client, input.roomId, input.userId, input.requestId);
      if (action) {
        if (action.actionType !== 'RAISE_HAND') throw requestReused();
        return this.queueResult(client, action.entryId, true);
      }
      const participant = await this.findParticipant(client, input.roomId, input.participantId, true);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      if (participant.role !== 'LISTENER') {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'Only listeners can raise a hand');
      }
      const existing = await client.query(
        `SELECT * FROM speaking_room_queue_entries
         WHERE room_id = $1 AND participant_id = $2
           AND state = 'WAITING'::speaking_room_queue_state
         ORDER BY created_at ASC, id ASC
         LIMIT 1 FOR UPDATE`,
        [input.roomId, input.participantId],
      );
      const entry = existing.rows[0]
        ? mapQueueEntry(existing.rows[0])
        : await this.insertQueueEntry(client, input);
      await this.recordQueueAction(client, input.roomId, input.userId, input.requestId, 'RAISE_HAND', entry.id);
      return {
        entry,
        participant,
        replayed: Boolean(existing.rows[0]),
      };
    });
  }

  async cancelHand(input: CancelHandInput): Promise<SpeakingRoomQueueMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      await reconcileStaleParticipants(client, input.roomId, input.now);
      const action = await this.findQueueAction(client, input.roomId, input.userId, input.requestId);
      if (action) {
        if (action.actionType !== 'CANCEL_HAND') throw requestReused();
        return this.queueResult(client, action.entryId, true);
      }
      const participant = await this.findParticipant(client, input.roomId, input.participantId, true);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      const result = await client.query(
        `SELECT * FROM speaking_room_queue_entries
         WHERE room_id = $1 AND participant_id = $2
           AND state = 'WAITING'::speaking_room_queue_state
         ORDER BY created_at ASC, id ASC
         LIMIT 1 FOR UPDATE`,
        [input.roomId, input.participantId],
      );
      if (!result.rows[0]) {
        throw new SpeakingRoomInteractionConflictError('QUEUE_NOT_WAITING', 'There is no pending hand raise');
      }
      const updated = await client.query(
        `UPDATE speaking_room_queue_entries
         SET state = 'CANCELLED'::speaking_room_queue_state, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [result.rows[0].id, input.now],
      );
      const entry = mapQueueEntry(updated.rows[0]);
      await this.recordQueueAction(client, input.roomId, input.userId, input.requestId, 'CANCEL_HAND', entry.id);
      return { entry, participant, replayed: false };
    });
  }

  async listQueue(roomId: string, now: Date): Promise<SpeakingRoomQueueEntryRecord[]> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, roomId);
      await reconcileStaleParticipants(client, roomId, now);
      await client.query(
        `UPDATE speaking_room_queue_entries entries
         SET state = 'CANCELLED'::speaking_room_queue_state, updated_at = $2
         WHERE entries.room_id = $1
           AND entries.state = 'WAITING'::speaking_room_queue_state
           AND NOT EXISTS (
             SELECT 1 FROM speaking_room_participants participants
             WHERE participants.id = entries.participant_id
               AND participants.state IN (
                 'PRESENT'::speaking_room_participant_state,
                 'DISCONNECTED'::speaking_room_participant_state
               )
           )`,
        [roomId, now],
      );
      const result = await client.query(
        `SELECT entries.*
         FROM speaking_room_queue_entries entries
         INNER JOIN speaking_room_participants participants ON participants.id = entries.participant_id
         WHERE entries.room_id = $1
           AND entries.state = 'WAITING'::speaking_room_queue_state
         ORDER BY entries.created_at ASC, entries.id ASC`,
        [roomId],
      );
      return result.rows.map(mapQueueEntry);
    });
  }

  async decideQueue(input: QueueDecisionInput): Promise<SpeakingRoomQueueMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const action = await this.findQueueAction(client, input.roomId, input.actorUserId, input.requestId);
      if (action) {
        if (action.actionType !== input.decision) throw requestReused();
        return this.queueResult(client, action.entryId, true);
      }
      const entryResult = await client.query(
        `SELECT * FROM speaking_room_queue_entries
         WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [input.queueEntryId, input.roomId],
      );
      if (!entryResult.rows[0]) throw new SpeakingRoomInteractionNotFoundError();
      const entry = mapQueueEntry(entryResult.rows[0]);
      if (entry.state !== 'WAITING') {
        throw new SpeakingRoomInteractionConflictError('QUEUE_NOT_WAITING', 'The hand raise is no longer pending');
      }
      const participant = await this.findParticipant(client, input.roomId, entry.participantId, true);
      assertActiveParticipant(participant);
      const state: SpeakingRoomQueueState = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
      const updatedEntryResult = await client.query(
        `UPDATE speaking_room_queue_entries
         SET state = $2::speaking_room_queue_state,
             decided_at = $3,
             decided_by_user_id = $4,
             updated_at = $3
         WHERE id = $1
         RETURNING *`,
        [entry.id, state, input.now, input.actorUserId],
      );
      const updatedParticipant = input.decision === 'ACCEPT'
        ? await this.updateParticipantRole(client, input.roomId, participant.id, 'SPEAKER', input.now)
        : participant;
      await this.recordModerationAction(client, {
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action: input.decision === 'ACCEPT' ? 'ACCEPT_QUEUE' : 'DECLINE_QUEUE',
        reason: null,
        createdAt: input.now,
      }, input.requestId);
      await this.recordQueueAction(client, input.roomId, input.actorUserId, input.requestId, input.decision, entry.id);
      return {
        entry: mapQueueEntry(updatedEntryResult.rows[0]),
        participant: updatedParticipant,
        replayed: false,
      };
    });
  }

  async changeRole(input: ChangeRoleInput): Promise<SpeakingRoomModerationMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const actionName: SpeakingRoomModerationActionType = input.role === 'SPEAKER' ? 'PROMOTE' : 'DEMOTE';
      const existing = await this.findModerationAction(client, input.roomId, input.actorUserId, input.requestId);
      if (existing) {
        if (existing.action !== actionName) throw requestReused();
        const participant = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
        return { participant, action: existing, replayed: true };
      }
      const participant = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
      assertActiveParticipant(participant);
      const updated = await this.updateParticipantRole(client, input.roomId, participant.id, input.role, input.now);
      if (input.role === 'SPEAKER') await this.acceptWaitingQueue(client, input.roomId, participant.id, input.actorUserId, input.now);
      const action = await this.recordModerationAction(client, {
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action: actionName,
        reason: null,
        createdAt: input.now,
      }, input.requestId);
      return { participant: updated, action, replayed: false };
    });
  }

  async moderateParticipant(input: ModerateParticipantInput): Promise<SpeakingRoomModerationMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const existing = await this.findModerationAction(client, input.roomId, input.actorUserId, input.requestId);
      if (existing) {
        if (existing.action !== input.action) throw requestReused();
        const participant = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
        return { participant, action: existing, replayed: true };
      }
      const participant = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
      if (input.action !== 'REMOVE') assertActiveParticipant(participant);
      if (input.action === 'MUTE') {
        await client.query(
          `INSERT INTO speaking_room_participant_moderation_state (
             participant_id, muted_until, updated_at, updated_by_user_id
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (participant_id) DO UPDATE SET
             muted_until = EXCLUDED.muted_until,
             updated_at = EXCLUDED.updated_at,
             updated_by_user_id = EXCLUDED.updated_by_user_id`,
          [participant.id, input.mutedUntil, input.now, input.actorUserId],
        );
      } else if (input.action === 'UNMUTE') {
        await client.query(
          'DELETE FROM speaking_room_participant_moderation_state WHERE participant_id = $1',
          [participant.id],
        );
      } else {
        await client.query(
          `UPDATE speaking_room_participants
           SET state = 'REMOVED'::speaking_room_participant_state,
               left_at = COALESCE(left_at, $3),
               updated_at = $3
           WHERE id = $1 AND room_id = $2`,
          [participant.id, input.roomId, input.now],
        );
        await this.cancelWaitingQueue(client, input.roomId, participant.id, input.now);
      }
      const updated = await this.requireParticipant(client, input.roomId, participant.id);
      const action = await this.recordModerationAction(client, {
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        action: input.action,
        reason: input.reason,
        createdAt: input.now,
      }, input.requestId);
      return { participant: updated, action, replayed: false };
    });
  }

  async isMuted(roomId: string, participantId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM speaking_room_participant_moderation_state moderation
       INNER JOIN speaking_room_participants participants ON participants.id = moderation.participant_id
       WHERE moderation.participant_id = $1
         AND participants.room_id = $2
         AND moderation.muted_until > $3`,
      [participantId, roomId, now],
    );
    return Boolean(result.rows[0]);
  }

  async blockParticipant(input: BlockParticipantInput): Promise<SpeakingRoomBlockMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const existing = await this.findModerationAction(client, input.roomId, input.actorUserId, input.requestId);
      if (existing) {
        if (existing.action !== input.action) throw requestReused();
        return { blocked: input.action === 'BLOCK', replayed: true };
      }
      const target = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
      if (target.userId === input.actorUserId) {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'A participant cannot block themselves');
      }
      if (input.action === 'BLOCK') {
        await client.query(
          `INSERT INTO speaking_room_participant_blocks (
             room_id, blocker_user_id, blocked_user_id, request_id, created_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (room_id, blocker_user_id, blocked_user_id) DO NOTHING`,
          [input.roomId, input.actorUserId, target.userId, input.requestId, input.now],
        );
      } else {
        await client.query(
          `DELETE FROM speaking_room_participant_blocks
           WHERE room_id = $1 AND blocker_user_id = $2 AND blocked_user_id = $3`,
          [input.roomId, input.actorUserId, target.userId],
        );
      }
      await this.recordModerationAction(client, {
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: target.id,
        targetUserId: target.userId,
        action: input.action,
        reason: null,
        createdAt: input.now,
      }, input.requestId);
      return { blocked: input.action === 'BLOCK', replayed: false };
    });
  }

  async isBlocked(roomId: string, firstUserId: string, secondUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM speaking_room_participant_blocks
       WHERE room_id = $1
         AND ((blocker_user_id = $2 AND blocked_user_id = $3)
           OR (blocker_user_id = $3 AND blocked_user_id = $2))
       LIMIT 1`,
      [roomId, firstUserId, secondUserId],
    );
    return Boolean(result.rows[0]);
  }

  async reportParticipant(input: ReportParticipantInput): Promise<SpeakingRoomReportMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const existing = await this.findModerationAction(client, input.roomId, input.actorUserId, input.requestId);
      if (existing) {
        if (existing.action !== 'REPORT') throw requestReused();
        return { duplicate: existing.resultDuplicate === true, replayed: true };
      }
      const target = await this.requireParticipant(client, input.roomId, input.targetParticipantId);
      if (target.userId === input.actorUserId) {
        throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'A participant cannot report themselves');
      }
      const report = await client.query(
        `INSERT INTO speaking_room_reports (
           room_id, reporter_user_id, target_participant_id, target_user_id,
           category, details, created_at
         ) VALUES ($1, $2, $3, $4, $5::speaking_room_report_category, $6, $7)
         ON CONFLICT (room_id, reporter_user_id, target_participant_id, category)
           WHERE state = 'OPEN'::speaking_room_report_state
         DO NOTHING
         RETURNING id`,
        [input.roomId, input.actorUserId, target.id, target.userId, input.category, input.details, input.now],
      );
      const duplicate = !report.rows[0];
      await this.recordModerationAction(client, {
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        targetParticipantId: target.id,
        targetUserId: target.userId,
        action: 'REPORT',
        reason: input.details,
        resultDuplicate: duplicate,
        createdAt: input.now,
      }, input.requestId);
      return { duplicate, replayed: false };
    });
  }

  async listModerationActions(roomId: string, limit: number): Promise<SpeakingRoomModerationActionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM speaking_room_moderation_actions
       WHERE room_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [roomId, limit],
    );
    return result.rows.map(mapAction);
  }

  async sendChat(input: SendChatInput): Promise<SpeakingRoomChatMutation> {
    return this.transaction(async (client) => {
      await this.lockRoom(client, input.roomId);
      const replay = await client.query(
        `SELECT * FROM speaking_room_chat_messages
         WHERE room_id = $1 AND author_user_id = $2 AND request_id = $3`,
        [input.roomId, input.userId, input.requestId],
      );
      if (replay.rows[0]) return { message: mapMessage(replay.rows[0]), replayed: true };
      const participant = await this.findParticipant(client, input.roomId, input.participantId, true);
      assertParticipantOwner(participant, input.userId);
      assertActiveParticipant(participant);
      const cutoff = new Date(input.now.getTime() - ROOM_CHAT_RATE_WINDOW_MS);
      const count = await client.query(
        `SELECT count(*)::int AS message_count
         FROM speaking_room_chat_messages
         WHERE room_id = $1 AND author_user_id = $2 AND created_at > $3`,
        [input.roomId, input.userId, cutoff],
      );
      if (Number(count.rows[0]?.message_count ?? 0) >= ROOM_CHAT_RATE_LIMIT) {
        throw new SpeakingRoomInteractionConflictError('RATE_LIMITED', 'Room chat rate limit exceeded');
      }
      const result = await client.query(
        `INSERT INTO speaking_room_chat_messages (
           room_id, author_participant_id, author_user_id, request_id, body, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [input.roomId, participant.id, input.userId, input.requestId, input.body, input.now],
      );
      return { message: mapMessage(result.rows[0]), replayed: false };
    });
  }

  async listChat(input: ListChatInput): Promise<SpeakingRoomChatPage> {
    const values: unknown[] = [input.roomId, input.viewerUserId];
    const conditions = [
      'messages.room_id = $1',
      `NOT EXISTS (
         SELECT 1 FROM speaking_room_participant_blocks blocks
         WHERE blocks.room_id = messages.room_id
           AND ((blocks.blocker_user_id = $2 AND blocks.blocked_user_id = messages.author_user_id)
             OR (blocks.blocker_user_id = messages.author_user_id AND blocks.blocked_user_id = $2))
       )`,
    ];
    if (input.before) {
      values.push(input.before.createdAt, input.before.id);
      conditions.push(`(
        messages.created_at < $${values.length - 1}
        OR (messages.created_at = $${values.length - 1} AND messages.id < $${values.length})
      )`);
    }
    values.push(input.limit + 1);
    const result = await this.pool.query(
      `SELECT messages.*
       FROM speaking_room_chat_messages messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY messages.created_at DESC, messages.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return {
      items: result.rows.slice(0, input.limit).map(mapMessage),
      hasMore: result.rows.length > input.limit,
    };
  }

  private async insertQueueEntry(client: PoolClient, input: RaiseHandInput): Promise<SpeakingRoomQueueEntryRecord> {
    const result = await client.query(
      `INSERT INTO speaking_room_queue_entries (
         room_id, participant_id, user_id, state, created_at, updated_at
       ) VALUES ($1, $2, $3, 'WAITING'::speaking_room_queue_state, $4, $4)
       RETURNING *`,
      [input.roomId, input.participantId, input.userId, input.now],
    );
    return mapQueueEntry(result.rows[0]);
  }

  private async queueResult(client: PoolClient, entryId: string, replayed: boolean): Promise<SpeakingRoomQueueMutation> {
    const entryResult = await client.query(
      'SELECT * FROM speaking_room_queue_entries WHERE id = $1 FOR UPDATE',
      [entryId],
    );
    if (!entryResult.rows[0]) throw new SpeakingRoomInteractionNotFoundError();
    const entry = mapQueueEntry(entryResult.rows[0]);
    const participant = await this.requireParticipant(client, entry.roomId, entry.participantId);
    return { entry, participant, replayed };
  }

  private async recordQueueAction(
    client: PoolClient,
    roomId: string,
    userId: string,
    requestId: string,
    action: 'RAISE_HAND' | 'CANCEL_HAND' | 'ACCEPT' | 'DECLINE',
    entryId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO speaking_room_queue_actions (
         room_id, user_id, request_id, queue_entry_id, action_type, created_at
       ) VALUES ($1, $2, $3, $4, $5::speaking_room_queue_action, now())`,
      [roomId, userId, requestId, entryId, action],
    );
  }

  private async findQueueAction(
    client: PoolClient,
    roomId: string,
    userId: string,
    requestId: string,
  ): Promise<{ actionType: string; entryId: string } | null> {
    const result = await client.query(
      `SELECT action_type, queue_entry_id
       FROM speaking_room_queue_actions
       WHERE room_id = $1 AND user_id = $2 AND request_id = $3`,
      [roomId, userId, requestId],
    );
    return result.rows[0]
      ? { actionType: String(result.rows[0].action_type), entryId: String(result.rows[0].queue_entry_id) }
      : null;
  }

  private async findModerationAction(
    client: PoolClient,
    roomId: string,
    actorUserId: string,
    requestId: string,
  ): Promise<SpeakingRoomModerationActionRecord | null> {
    const result = await client.query(
      `SELECT * FROM speaking_room_moderation_actions
       WHERE room_id = $1 AND actor_user_id = $2 AND request_id = $3`,
      [roomId, actorUserId, requestId],
    );
    return result.rows[0] ? mapAction(result.rows[0]) : null;
  }

  private async recordModerationAction(
    client: PoolClient,
    action: Omit<SpeakingRoomModerationActionRecord, 'id'>,
    requestId: string,
  ): Promise<SpeakingRoomModerationActionRecord> {
    const result = await client.query(
      `INSERT INTO speaking_room_moderation_actions (
         room_id, actor_user_id, target_participant_id, target_user_id,
         action_type, reason, request_id, result_duplicate, created_at
       ) VALUES ($1, $2, $3, $4, $5::speaking_room_moderation_action, $6, $7, $8, $9)
       RETURNING *`,
      [
        action.roomId,
        action.actorUserId,
        action.targetParticipantId,
        action.targetUserId,
        action.action,
        action.reason,
        requestId,
        action.resultDuplicate ?? false,
        action.createdAt,
      ],
    );
    return mapAction(result.rows[0]);
  }

  private async requireParticipant(
    client: PoolClient,
    roomId: string,
    participantId: string,
  ): Promise<SpeakingRoomParticipantRecord> {
    const participant = await this.findParticipant(client, roomId, participantId, false);
    if (!participant) throw new SpeakingRoomInteractionNotFoundError();
    return participant;
  }

  private async findParticipant(
    client: PoolClient,
    roomId: string,
    participantId: string,
    forUpdate: boolean,
  ): Promise<SpeakingRoomParticipantRecord | null> {
    const result = await client.query(
      `SELECT * FROM speaking_room_participants
       WHERE id = $1 AND room_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [participantId, roomId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }

  private async updateParticipantRole(
    client: PoolClient,
    roomId: string,
    participantId: string,
    role: 'SPEAKER' | 'LISTENER',
    now: Date,
  ): Promise<SpeakingRoomParticipantRecord> {
    const result = await client.query(
      `UPDATE speaking_room_participants
       SET role = $3::speaking_room_participant_role, updated_at = $4
       WHERE id = $1 AND room_id = $2
       RETURNING *`,
      [participantId, roomId, role, now],
    );
    if (!result.rows[0]) throw new SpeakingRoomInteractionNotFoundError();
    return mapParticipant(result.rows[0]);
  }

  private async acceptWaitingQueue(
    client: PoolClient,
    roomId: string,
    participantId: string,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE speaking_room_queue_entries
       SET state = 'ACCEPTED'::speaking_room_queue_state,
           decided_at = $3,
           decided_by_user_id = $4,
           updated_at = $3
       WHERE room_id = $1 AND participant_id = $2
         AND state = 'WAITING'::speaking_room_queue_state`,
      [roomId, participantId, now, actorUserId],
    );
  }

  private async cancelWaitingQueue(
    client: PoolClient,
    roomId: string,
    participantId: string,
    now: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE speaking_room_queue_entries
       SET state = 'CANCELLED'::speaking_room_queue_state, updated_at = $3
       WHERE room_id = $1 AND participant_id = $2
         AND state = 'WAITING'::speaking_room_queue_state`,
      [roomId, participantId, now],
    );
  }

  private async lockRoom(client: PoolClient, roomId: string): Promise<void> {
    const result = await client.query('SELECT id FROM speaking_rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!result.rows[0]) throw new SpeakingRoomInteractionNotFoundError('Speaking room was not found');
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

async function reconcileStaleParticipants(client: PoolClient, roomId: string, now: Date): Promise<void> {
  const disconnectBefore = new Date(now.getTime() - PARTICIPANT_DISCONNECT_AFTER_MS);
  const leaveBefore = new Date(now.getTime() - PARTICIPANT_RECONNECT_LEASE_MS);
  await client.query(
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
  await client.query(
    `UPDATE speaking_room_participants
     SET state = 'DISCONNECTED'::speaking_room_participant_state,
         disconnected_at = COALESCE(disconnected_at, $2),
         updated_at = $2
     WHERE room_id = $1
       AND state = 'PRESENT'::speaking_room_participant_state
       AND last_seen_at <= $3`,
    [roomId, now, disconnectBefore],
  );
  await client.query(
    `UPDATE speaking_room_participants
     SET state = 'LEFT'::speaking_room_participant_state,
         left_at = COALESCE(left_at, $2),
         updated_at = $2
     WHERE room_id = $1
       AND state = 'DISCONNECTED'::speaking_room_participant_state
       AND last_seen_at <= $3`,
    [roomId, now, leaveBefore],
  );
}

function requestReused(): SpeakingRoomInteractionConflictError {
  return new SpeakingRoomInteractionConflictError('REQUEST_REUSED', 'Request id was already used');
}

function assertParticipantOwner(participant: SpeakingRoomParticipantRecord | null, userId: string): asserts participant is SpeakingRoomParticipantRecord {
  if (!participant || participant.userId !== userId) throw new SpeakingRoomInteractionNotFoundError();
}

function assertActiveParticipant(participant: SpeakingRoomParticipantRecord | null): asserts participant is SpeakingRoomParticipantRecord {
  if (!participant || !isActiveState(participant.state)) {
    throw new SpeakingRoomInteractionConflictError('INVALID_STATE', 'Participant is no longer active');
  }
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
    state: row.state as SpeakingRoomParticipantRecord['state'],
    joinedAt: new Date(String(row.joined_at)),
    lastSeenAt: new Date(String(row.last_seen_at)),
    disconnectedAt: row.disconnected_at ? new Date(String(row.disconnected_at)) : null,
    leftAt: row.left_at ? new Date(String(row.left_at)) : null,
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapQueueEntry(row: Record<string, unknown>): SpeakingRoomQueueEntryRecord {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    participantId: String(row.participant_id),
    userId: String(row.user_id),
    state: row.state as SpeakingRoomQueueState,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    decidedAt: row.decided_at ? new Date(String(row.decided_at)) : null,
    decidedByUserId: row.decided_by_user_id ? String(row.decided_by_user_id) : null,
  };
}

function mapAction(row: Record<string, unknown>): SpeakingRoomModerationActionRecord {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    actorUserId: String(row.actor_user_id),
    targetParticipantId: String(row.target_participant_id),
    targetUserId: String(row.target_user_id),
    action: row.action_type as SpeakingRoomModerationActionType,
    reason: row.reason ? String(row.reason) : null,
    resultDuplicate: Boolean(row.result_duplicate),
    createdAt: new Date(String(row.created_at)),
  };
}

function mapMessage(row: Record<string, unknown>): SpeakingRoomChatMessageRecord {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    authorParticipantId: String(row.author_participant_id),
    authorUserId: String(row.author_user_id),
    body: String(row.body),
    createdAt: new Date(String(row.created_at)),
  };
}
