import type { Pool, PoolClient } from 'pg';
import {
  defaultExchangePreferences,
  ExchangeRepositoryConflictError,
  type ExchangePreferenceRepository,
} from './exchange.repository';
import type {
  ExchangePreferenceRecord,
  ExchangePreferenceWriteInput,
} from './exchange.types';

export class PostgresExchangePreferenceRepository implements ExchangePreferenceRepository {
  constructor(private readonly pool: Pool) {}

  async findPreferences(userId: string): Promise<ExchangePreferenceRecord> {
    const [preferenceResult, languageResult, levelResult, goalResult, interestResult] = await Promise.all([
      this.pool.query(
        `SELECT user_id, exchange_opt_in, discoverable, timezone_visibility,
                availability_visibility, contact_permission, created_at, updated_at
           FROM language_exchange_preferences
          WHERE user_id = $1`,
        [userId],
      ),
      this.pool.query(
        `SELECT lel.direction, l.code
           FROM language_exchange_languages lel
           INNER JOIN user_languages ul ON ul.id = lel.user_language_id
           INNER JOIN languages l ON l.id = ul.language_id
          WHERE lel.user_id = $1
          ORDER BY l.sort_order ASC, l.english_name ASC, l.code ASC, lel.direction ASC`,
        [userId],
      ),
      this.pool.query(
        `SELECT level
           FROM language_exchange_partner_levels
          WHERE user_id = $1
          ORDER BY level ASC`,
        [userId],
      ),
      this.pool.query(
        `SELECT goal_code
           FROM language_exchange_goals
          WHERE user_id = $1
          ORDER BY goal_code ASC`,
        [userId],
      ),
      this.pool.query(
        `SELECT interest_code
           FROM language_exchange_interests
          WHERE user_id = $1
          ORDER BY interest_code ASC`,
        [userId],
      ),
    ]);

    const row = preferenceResult.rows[0] as Record<string, unknown> | undefined;
    if (!row) return defaultExchangePreferences(userId);
    const record = {
      ...defaultExchangePreferences(userId),
      userId: String(row.user_id),
      exchangeOptIn: Boolean(row.exchange_opt_in),
      discoverable: Boolean(row.discoverable),
      timezoneVisibility: String(row.timezone_visibility) as ExchangePreferenceRecord['timezoneVisibility'],
      availabilityVisibility: String(row.availability_visibility) as ExchangePreferenceRecord['availabilityVisibility'],
      contactPermission: String(row.contact_permission) as ExchangePreferenceRecord['contactPermission'],
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      offeredLanguageCodes: languageResult.rows
        .filter((item) => String(item.direction) === 'OFFER')
        .map((item) => String(item.code)),
      wantedLanguageCodes: languageResult.rows
        .filter((item) => String(item.direction) === 'WANT')
        .map((item) => String(item.code)),
      preferredPartnerLevels: levelResult.rows.map((item) => String(item.level)) as ExchangePreferenceRecord['preferredPartnerLevels'],
      matchingGoalCodes: goalResult.rows.map((item) => String(item.goal_code)),
      matchingInterestCodes: interestResult.rows.map((item) => String(item.interest_code)),
    };
    return record;
  }

  async listDiscoverableUserIds(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT lep.user_id
         FROM language_exchange_preferences lep
         INNER JOIN users u ON u.id = lep.user_id
        WHERE lep.exchange_opt_in = true
          AND lep.discoverable = true
          AND u.status = 'ACTIVE'::user_status
          AND u.email_verified_at IS NOT NULL
        ORDER BY lep.user_id ASC`,
    );
    return result.rows.map((row) => String(row.user_id));
  }

  async savePreferences(
    userId: string,
    input: ExchangePreferenceWriteInput,
  ): Promise<ExchangePreferenceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO language_exchange_preferences (
           user_id, exchange_opt_in, discoverable, timezone_visibility,
           availability_visibility, contact_permission
         )
         VALUES ($1, $2, $3, $4::exchange_visibility_mode,
                 $5::exchange_visibility_mode, $6::exchange_contact_permission)
         ON CONFLICT (user_id)
         DO UPDATE SET
           exchange_opt_in = EXCLUDED.exchange_opt_in,
           discoverable = EXCLUDED.discoverable,
           timezone_visibility = EXCLUDED.timezone_visibility,
           availability_visibility = EXCLUDED.availability_visibility,
           contact_permission = EXCLUDED.contact_permission,
           updated_at = now()`,
        [
          userId,
          input.exchangeOptIn,
          input.discoverable,
          input.timezoneVisibility,
          input.availabilityVisibility,
          input.contactPermission,
        ],
      );
      await client.query('DELETE FROM language_exchange_languages WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM language_exchange_partner_levels WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM language_exchange_goals WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM language_exchange_interests WHERE user_id = $1', [userId]);

      for (const code of input.offeredLanguageCodes) {
        await insertLanguageSelection(client, userId, code, 'OFFER');
      }
      for (const code of input.wantedLanguageCodes) {
        await insertLanguageSelection(client, userId, code, 'WANT');
      }
      for (const level of input.preferredPartnerLevels) {
        const result = await client.query(
          `INSERT INTO language_exchange_partner_levels (user_id, level)
           VALUES ($1, $2)`,
          [userId, level],
        );
        if (result.rowCount !== 1) throw new ExchangeRepositoryConflictError();
      }
      for (const goal of input.matchingGoalCodes) {
        const result = await client.query(
          `INSERT INTO language_exchange_goals (user_id, goal_code)
           SELECT $1, goal_code
             FROM user_learning_goals
            WHERE user_id = $1 AND goal_code = $2`,
          [userId, goal],
        );
        if (result.rowCount !== 1) throw new ExchangeRepositoryConflictError();
      }
      for (const interest of input.matchingInterestCodes) {
        const result = await client.query(
          `INSERT INTO language_exchange_interests (user_id, interest_code)
           SELECT $1, interest_code
             FROM user_profile_interests
            WHERE user_id = $1 AND interest_code = $2`,
          [userId, interest],
        );
        if (result.rowCount !== 1) throw new ExchangeRepositoryConflictError();
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapExchangeRepositoryError(error);
    } finally {
      client.release();
    }
    return this.findPreferences(userId);
  }
}

async function insertLanguageSelection(
  client: PoolClient,
  userId: string,
  code: string,
  direction: 'OFFER' | 'WANT',
): Promise<void> {
  const result = await client.query(
    `INSERT INTO language_exchange_languages (user_id, user_language_id, direction)
     SELECT ul.user_id, ul.id, $3::exchange_language_direction
       FROM user_languages ul
       INNER JOIN languages l ON l.id = ul.language_id
      WHERE ul.user_id = $1 AND l.code = $2 AND l.active = true`,
    [userId, code, direction],
  );
  if (result.rowCount !== 1) throw new ExchangeRepositoryConflictError();
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return new Date(value);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapExchangeRepositoryError(error: unknown): Error {
  if (error instanceof ExchangeRepositoryConflictError) return error;
  if (isPostgresConflict(error)) return new ExchangeRepositoryConflictError();
  return error instanceof Error ? error : new Error('Exchange preference persistence failed');
}

function isPostgresConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23503' || code === '23505' || code === '23514';
}
