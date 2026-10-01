import type { Pool, PoolClient } from 'pg';
import type {
  NotificationPreferenceChange,
  NotificationPreferenceOverride,
} from './notification-preference.types';
import type { NotificationPreferenceRepository } from './notification-preference.repository';

export class PostgresNotificationPreferenceRepository implements NotificationPreferenceRepository {
  constructor(private readonly pool: Pool) {}

  async findOverrides(userId: string): Promise<NotificationPreferenceOverride[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT category, channel, enabled
         FROM notification_preferences
        WHERE user_id = $1::uuid
        ORDER BY category ASC, channel ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      category: String(row.category) as NotificationPreferenceOverride['category'],
      channel: String(row.channel) as NotificationPreferenceOverride['channel'],
      enabled: Boolean(row.enabled),
    }));
  }

  async saveOverrides(
    userId: string,
    changes: readonly NotificationPreferenceChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const change of changes) {
        await upsertPreference(client, userId, change);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function upsertPreference(
  client: PoolClient,
  userId: string,
  change: NotificationPreferenceChange,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_preferences (user_id, category, channel, enabled)
     VALUES ($1::uuid, $2, $3, $4)
     ON CONFLICT (user_id, category, channel)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [userId, change.category, change.channel, change.enabled],
  );
}
