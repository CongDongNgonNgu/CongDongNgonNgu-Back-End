import type { Pool,PoolClient } from 'pg';
import {
  hashNotificationIntent,
  normalizeNotificationActorProjection,
  validateNotificationIntent,
  validateNotificationRetentionPolicy,
} from './notification.contracts';
import type {
  NotificationIntent,
  NotificationReadState,
  NotificationRecord,
  NotificationSemanticVariables,
} from './notification.contracts';
import {
  createNotificationRecord,
  type MarkManyReadResult,
  type NotificationCursor,
  type NotificationIntentClaim,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationRecordWithReadState,
  type NotificationReplayPage,
  type NotificationRepository,
} from './notification.repository';

const NOTIFICATION_COLUMNS = `
  n.id,
  n.intent_id,
  n.deduplication_key,
  n.source_event_id,
  n.recipient_user_id,
  n.notification_type,
  n.category,
  n.priority,
  n.actor,
  n.target,
  n.variables,
  n.retention,
  n.source_event_type,
  n.source_event_version,
  n.source_aggregate_type,
  n.source_aggregate_id,
  n.source_idempotency_key,
  n.source_payload_hash,
  n.intent_fingerprint,
  n.created_at`;
const NOTIFICATION_RETURNING_COLUMNS = NOTIFICATION_COLUMNS.replaceAll('n.', '');

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly pool: Pool) {}

  // The caller owns BEGIN/COMMIT/ROLLBACK/release for atomic domain materialization.
  async claimIntentOnClient(client:PoolClient,intent:NotificationIntent,now=new Date()):Promise<NotificationIntentClaim> {
    return this.persistIntent(intent,now,client);
  }

  async claimIntent(intent: NotificationIntent, now = new Date()): Promise<NotificationIntentClaim> {
    return this.persistIntent(intent,now);
  }

  private async persistIntent(intent:NotificationIntent,now:Date,providedClient?:PoolClient):Promise<NotificationIntentClaim> {
    const validated = validateNotificationIntent(intent);
    const fingerprint = hashNotificationIntent(validated);
    const client = providedClient ?? await this.pool.connect();
    const ownsTransaction = providedClient === undefined;
    try {
      if(ownsTransaction) await client.query('BEGIN');
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO notifications (
           intent_id,
           deduplication_key,
           recipient_user_id,
           notification_type,
           category,
           priority,
           actor,
           target,
           variables,
           retention,
           source_event_id,
           source_event_type,
           source_event_version,
           source_aggregate_type,
           source_aggregate_id,
           source_idempotency_key,
           source_payload_hash,
           intent_fingerprint,
           created_at
         ) VALUES (
           $1, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11::uuid, $12, $13, $14, $15::uuid, $16, $17, $18, $19::timestamptz
         )
         ON CONFLICT (deduplication_key) DO NOTHING
         RETURNING ${NOTIFICATION_RETURNING_COLUMNS}`,
        [
          validated.intentId,
          validated.deduplicationKey,
          validated.recipient.userId,
          validated.notificationType,
          validated.category,
          validated.priority,
          JSON.stringify(validated.actor),
          JSON.stringify(validated.target),
          JSON.stringify(validated.variables),
          JSON.stringify(validated.retention),
          validated.sourceEvent.eventId,
          validated.sourceEvent.eventType,
          validated.sourceEvent.eventVersion,
          validated.sourceEvent.aggregateType,
          validated.sourceEvent.aggregateId,
          validated.sourceEvent.idempotencyKey,
          validated.sourceEvent.payloadHash,
          fingerprint,
          validated.createdAt,
        ],
      );

      if (inserted.rows[0]) {
        const record = mapNotificationRow(inserted.rows[0]);
        await client.query(
          `INSERT INTO notification_read_states (
             notification_id, recipient_user_id, status, read_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, 'UNREAD', NULL, $3::timestamptz)`,
          [record.id, record.recipientUserId, now],
        );
        if(ownsTransaction) await client.query('COMMIT');
        return { outcome: 'CREATED', record };
      }

      const existingResult = await client.query<Record<string, unknown>>(
        `SELECT ${NOTIFICATION_COLUMNS}
           FROM notifications n
          WHERE n.deduplication_key = $1
          FOR SHARE`,
        [validated.deduplicationKey],
      );
      if (!existingResult.rows[0]) throw new Error('Notification idempotency record is unavailable');
      const existing = existingResult.rows[0];
      const record = mapNotificationRow(existing);
      const existingFingerprint = String(existing.intent_fingerprint);
      if(ownsTransaction) await client.query('COMMIT');
      if (existingFingerprint === fingerprint) return { outcome: 'REPLAYED', record };
      return {
        outcome: 'CONFLICT',
        code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
        deduplicationKey: validated.deduplicationKey,
      };
    } catch (error) {
      if(ownsTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if(ownsTransaction) client.release();
    }
  }

  async listForUser(userId: string, query: NotificationListQuery): Promise<NotificationPage> {
    const values: unknown[] = [userId, query.status];
    let cursorClause = '';
    if (query.before) {
      values.push(query.before.createdAt, query.before.id);
      const createdAtParameter = '$' + (values.length - 1);
      const idParameter = '$' + values.length;
      cursorClause = ` AND (
        n.created_at < ${createdAtParameter}::timestamptz
        OR (n.created_at = ${createdAtParameter}::timestamptz AND n.id < ${idParameter}::uuid)
      )`;
    }
    values.push(query.limit + 1);
    const limitParameter = '$' + values.length;
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${NOTIFICATION_COLUMNS},
              rs.status AS read_status,
              rs.read_at,
              rs.updated_at AS read_updated_at
         FROM notifications n
         INNER JOIN notification_read_states rs ON rs.notification_id = n.id
        WHERE n.recipient_user_id = $1::uuid
          AND ($2::text = 'ALL' OR rs.status = 'UNREAD')
          ${cursorClause}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ${limitParameter}::integer`,
      values,
    );
    const consumed = result.rows.slice(0, query.limit + 1);
    return {
      items: consumed.slice(0, query.limit).map(mapNotificationWithReadState),
      hasMore: consumed.length > query.limit,
    };
  }

  async findNotificationCursorForUser(userId: string, notificationId: string): Promise<NotificationCursor | null> {
    const result = await this.pool.query<{ created_at: Date | string; id: string }>(
      `SELECT created_at, id
         FROM notifications
        WHERE id = $1::uuid
          AND recipient_user_id = $2::uuid`,
      [notificationId, userId],
    );
    const row = result.rows[0];
    return row
      ? { createdAt: new Date(String(row.created_at)), id: String(row.id) }
      : null;
  }

  async listForUserAfter(
    userId: string,
    after: NotificationCursor,
    limit: number,
  ): Promise<NotificationReplayPage> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${NOTIFICATION_COLUMNS},
              rs.status AS read_status,
              rs.read_at,
              rs.updated_at AS read_updated_at
         FROM notifications n
         INNER JOIN notification_read_states rs ON rs.notification_id = n.id
        WHERE n.recipient_user_id = $1::uuid
          AND (
            n.created_at > $2::timestamptz
            OR (n.created_at = $2::timestamptz AND n.id > $3::uuid)
          )
        ORDER BY n.created_at ASC, n.id ASC
        LIMIT $4::integer`,
      [userId, after.createdAt, after.id, limit + 1],
    );
    return {
      hasMore: result.rows.length > limit,
      items: result.rows.slice(0, limit).map(mapNotificationWithReadState),
    };
  }

  async countUnread(userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM notification_read_states
        WHERE recipient_user_id = $1::uuid
          AND status = 'UNREAD'`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async markRead(userId: string, notificationId: string, now: Date): Promise<NotificationReadState | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE notification_read_states
          SET status = 'READ',
              read_at = COALESCE(read_at, $3::timestamptz),
              updated_at = CASE WHEN status = 'UNREAD' THEN $3::timestamptz ELSE updated_at END
        WHERE notification_id = $1::uuid
          AND recipient_user_id = $2::uuid
        RETURNING notification_id, recipient_user_id, status, read_at, updated_at`,
      [notificationId, userId, now],
    );
    return result.rows[0] ? mapReadStateRow(result.rows[0]) : null;
  }

  async markManyRead(userId: string, notificationIds: readonly string[], now: Date): Promise<MarkManyReadResult> {
    if (notificationIds.length === 0) return { updatedCount: 0 };
    const result = await this.pool.query(
      `UPDATE notification_read_states
          SET status = 'READ', read_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE recipient_user_id = $1::uuid
          AND notification_id = ANY($2::uuid[])
          AND status = 'UNREAD'
        RETURNING notification_id`,
      [userId, notificationIds, now],
    );
    return { updatedCount: result.rowCount ?? 0 };
  }
}

function mapNotificationWithReadState(row: Record<string, unknown>): NotificationRecordWithReadState {
  return {
    record: mapNotificationRow(row),
    readState: mapReadStateRow({
      notification_id: row.id,
      recipient_user_id: row.recipient_user_id,
      status: row.read_status,
      read_at: row.read_at,
      updated_at: row.read_updated_at,
    }),
  };
}

function mapNotificationRow(row: Record<string, unknown>): NotificationRecord {
  const actor = normalizeNotificationActorProjection(row.actor);
  const retention = validateNotificationRetentionPolicy(row.retention);
  return {
    ...createNotificationRecord({
      intentId: String(row.intent_id),
      deduplicationKey: String(row.deduplication_key ?? ''),
      recipient: { authority: 'SOURCE_DOMAIN', userId: String(row.recipient_user_id) },
      notificationType: String(row.notification_type) as NotificationIntent['notificationType'],
      category: String(row.category) as NotificationIntent['category'],
      priority: String(row.priority) as NotificationIntent['priority'],
      actor,
      target: (row.target ?? null) as NotificationIntent['target'],
      variables: row.variables as NotificationSemanticVariables,
      retention,
      createdAt: new Date(String(row.created_at)).toISOString(),
      sourceEvent: {
        eventId: String(row.source_event_id),
        eventType: String(row.source_event_type) as NotificationIntent['sourceEvent']['eventType'],
        eventVersion: Number(row.source_event_version),
        aggregateType: String(row.source_aggregate_type) as NotificationIntent['sourceEvent']['aggregateType'],
        aggregateId: String(row.source_aggregate_id),
        idempotencyKey: String(row.source_idempotency_key),
        payloadHash: String(row.source_payload_hash),
      },
    }, String(row.id)),
  };
}

function mapReadStateRow(row: Record<string, unknown>): NotificationReadState {
  return {
    notificationId: String(row.notification_id),
    recipientUserId: String(row.recipient_user_id),
    status: String(row.status) as NotificationReadState['status'],
    readAt: row.read_at ? new Date(String(row.read_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
