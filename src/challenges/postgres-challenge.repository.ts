import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  ChallengeProgressReplayConflictError,
  ChallengeRepositoryConflictError,
  ChallengeRepositoryNotFoundError,
  type AppendChallengeProgressInput,
  type AppendChallengeProgressResult,
  type ChallengeListQuery,
  type ChallengeRepository,
  type CreateChallengeRepositoryInput,
  type JoinChallengeResult,
} from './challenge.repository';
import type {
  ChallengeActivityType,
  ChallengeParticipationRecord,
  ChallengeProgressEventRecord,
  ChallengeProgressProjection,
  ChallengeRecord,
  ChallengeStatus,
} from './challenge.types';

export class PostgresChallengeRepository implements ChallengeRepository {
  constructor(private readonly pool: Pool) {}

  async createChallenge(input: CreateChallengeRepositoryInput): Promise<ChallengeRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO challenges (
          created_by_user_id, title, description, challenge_type, language_id, level, topic,
          starts_at, ends_at, timezone, goal_unit, goal_target, eligible_activity_types,
          rule_version, reward_event_type, reward_rule_version, status, created_at, updated_at
        )
        SELECT $1, $2, $3, $4::challenge_type, l.id, $6, $7,
          $8, $9, $10, $11::challenge_goal_unit, $12, $13::challenge_activity_type[],
          $14, $15, $16, $17::challenge_status, $18, $19
        FROM languages l
        WHERE l.code = $5 AND l.active = true
        RETURNING *, (SELECT code FROM languages WHERE id = challenges.language_id) AS language_code
      `,
      [
        input.createdByUserId,
        input.title,
        input.description,
        input.challengeType,
        input.languageCode,
        input.level,
        input.topic,
        input.startAt,
        input.endAt,
        input.timezone,
        input.goal.unit,
        input.goal.target,
        input.eligibleActivityTypes,
        input.ruleVersion,
        input.reward?.eventType ?? null,
        input.reward?.ruleVersion ?? null,
        input.status,
        input.createdAt,
        input.updatedAt,
      ],
    );
    if (result.rows.length !== 1) {
      throw new ChallengeRepositoryConflictError('Challenge language is unavailable');
    }
    return mapChallengeRow(result.rows[0]);
  }

  async findChallengeById(id: string): Promise<ChallengeRecord | null> {
    const result = await this.pool.query(
      `SELECT c.*, l.code AS language_code
         FROM challenges c
         JOIN languages l ON l.id = c.language_id
        WHERE c.id = $1`,
      [id],
    );
    return result.rows[0] ? mapChallengeRow(result.rows[0]) : null;
  }

  async listChallenges(query: ChallengeListQuery): Promise<ChallengeRecord[]> {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (query.status) {
      values.push(query.status);
      filters.push(`c.status = $${values.length}::challenge_status`);
    }
    if (query.languageCode) {
      values.push(query.languageCode);
      filters.push(`l.code = $${values.length}`);
    }
    values.push(query.limit);
    const result = await this.pool.query(
      `SELECT c.*, l.code AS language_code
         FROM challenges c
         JOIN languages l ON l.id = c.language_id
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY c.starts_at ASC, c.id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapChallengeRow);
  }

  async getParticipantCount(challengeId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
         FROM challenge_participations
        WHERE challenge_id = $1
          AND status <> 'LEFT'::challenge_participation_status`,
      [challengeId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async joinChallenge(challengeId: string, userId: string, now: Date): Promise<JoinChallengeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query(
        `SELECT * FROM challenge_participations WHERE challenge_id = $1 AND user_id = $2 FOR UPDATE`,
        [challengeId, userId],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.status !== 'LEFT') {
        await client.query('COMMIT');
        return { record: mapParticipationRow(existing), replayed: true };
      }
      const result = existing
        ? await client.query(
            `UPDATE challenge_participations
                SET status = 'JOINED', joined_at = $3, left_at = NULL, updated_at = $3
              WHERE id = $1
              RETURNING *`,
            [existing.id, challengeId, now],
          )
        : await client.query(
            `INSERT INTO challenge_participations
              (challenge_id, user_id, status, progress_value, joined_at, created_at, updated_at)
             VALUES ($1, $2, 'JOINED', 0, $3, $3, $3)
             RETURNING *`,
            [challengeId, userId, now],
          );
      if (result.rows.length !== 1) throw new ChallengeRepositoryNotFoundError('Challenge participation was not created');
      await client.query('COMMIT');
      return { record: mapParticipationRow(result.rows[0]), replayed: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isForeignKeyViolation(error)) throw new ChallengeRepositoryNotFoundError('Challenge does not exist');
      if (isUniqueViolation(error)) throw new ChallengeRepositoryConflictError('Challenge participation already exists');
      throw error;
    } finally {
      client.release();
    }
  }

  async leaveChallenge(challengeId: string, userId: string, now: Date): Promise<ChallengeParticipationRecord> {
    const result = await this.pool.query(
      `UPDATE challenge_participations
          SET status = CASE WHEN status = 'COMPLETED' THEN status ELSE 'LEFT' END,
              left_at = CASE WHEN status = 'COMPLETED' THEN left_at ELSE $3 END,
              updated_at = $3
        WHERE challenge_id = $1 AND user_id = $2
        RETURNING *`,
      [challengeId, userId, now],
    );
    if (!result.rows[0]) throw new ChallengeRepositoryNotFoundError('Challenge participation does not exist');
    return mapParticipationRow(result.rows[0]);
  }

  async findParticipation(challengeId: string, userId: string): Promise<ChallengeParticipationRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM challenge_participations WHERE challenge_id = $1 AND user_id = $2`,
      [challengeId, userId],
    );
    return result.rows[0] ? mapParticipationRow(result.rows[0]) : null;
  }

  async appendProgress(input: AppendChallengeProgressInput): Promise<AppendChallengeProgressResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const participationResult = await client.query(
        `SELECT p.*, c.goal_target
           FROM challenge_participations p
           JOIN challenges c ON c.id = p.challenge_id
          WHERE p.challenge_id = $1 AND p.user_id = $2
          FOR UPDATE`,
        [input.challengeId, input.userId],
      );
      const participation = participationResult.rows[0];
      if (!participation) throw new ChallengeRepositoryNotFoundError('Challenge participation does not exist');
      if (participation.status === 'COMPLETED') {
        throw new ChallengeRepositoryConflictError('Challenge is already complete');
      }

      const insert = await client.query(
        `INSERT INTO challenge_progress_events
          (challenge_id, user_id, activity_type, source_id, units, occurred_at, rule_version,
           idempotency_key, fingerprint, created_at)
         VALUES ($1, $2, $3::challenge_activity_type, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (challenge_id, user_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.challengeId,
          input.userId,
          input.activityType,
          input.sourceId,
          input.units,
          input.occurredAt,
          input.ruleVersion,
          input.idempotencyKey,
          input.fingerprint,
          input.createdAt,
        ],
      );
      if (insert.rows.length === 0) {
        const existing = await client.query(
          `SELECT * FROM challenge_progress_events
            WHERE challenge_id = $1 AND user_id = $2 AND idempotency_key = $3`,
          [input.challengeId, input.userId, input.idempotencyKey],
        );
        if (!existing.rows[0] || existing.rows[0].fingerprint !== input.fingerprint) {
          throw new ChallengeProgressReplayConflictError();
        }
        await client.query('COMMIT');
        return {
          event: mapProgressEventRow(existing.rows[0]),
          participation: mapParticipationRow(participation),
          replayed: true,
        };
      }

      let updated;
      try {
        updated = await client.query(
          `UPDATE challenge_participations p
              SET progress_value = p.progress_value + $2,
                  status = CASE WHEN p.progress_value + $2 >= c.goal_target
                    THEN 'COMPLETED'::challenge_participation_status ELSE p.status END,
                  completed_at = CASE WHEN p.progress_value + $2 >= c.goal_target
                    THEN COALESCE(p.completed_at, $3) ELSE p.completed_at END,
                  updated_at = $3
             FROM challenges c
            WHERE p.id = $1 AND p.challenge_id = c.id
            RETURNING p.*`,
          [participation.id, input.units, input.createdAt],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new ChallengeProgressReplayConflictError();
        throw error;
      }
      if (updated.rows.length !== 1) throw new ChallengeRepositoryNotFoundError('Challenge participation disappeared');
      await client.query('COMMIT');
      return {
        event: mapProgressEventRow(insert.rows[0]),
        participation: mapParticipationRow(updated.rows[0]),
        replayed: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getProgress(challengeId: string, userId: string): Promise<ChallengeProgressProjection | null> {
    const result = await this.pool.query(
      `SELECT p.*, c.goal_unit, c.goal_target, c.reward_event_type, c.reward_rule_version
         FROM challenge_participations p
         JOIN challenges c ON c.id = p.challenge_id
        WHERE p.challenge_id = $1 AND p.user_id = $2`,
      [challengeId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const progressValue = Number(row.progress_value);
    const goalTarget = Number(row.goal_target);
    return {
      challengeId,
      userId,
      status: row.status,
      progressValue,
      goal: { unit: row.goal_unit, target: goalTarget },
      completionPercent: Math.min(100, Math.floor((progressValue / goalTarget) * 100)),
      completedAt: row.completed_at ? toDate(row.completed_at) : null,
      rewardEvent: row.status === 'COMPLETED' && row.reward_event_type
        ? {
            eventType: row.reward_event_type,
            challengeId,
            userId,
            ruleVersion: row.reward_rule_version,
            occurredAt: row.completed_at ? toDate(row.completed_at) : new Date(),
          }
        : null,
    };
  }
}

function mapChallengeRow(row: QueryResultRow): ChallengeRecord {
  return {
    id: String(row.id),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    title: String(row.title),
    description: String(row.description),
    challengeType: row.challenge_type,
    languageCode: String(row.language_code),
    level: row.level ?? null,
    topic: row.topic ?? null,
    startAt: toDate(row.starts_at),
    endAt: toDate(row.ends_at),
    timezone: String(row.timezone),
    goal: { unit: row.goal_unit, target: Number(row.goal_target) },
    eligibleActivityTypes: [...(row.eligible_activity_types as ChallengeActivityType[])],
    ruleVersion: String(row.rule_version),
    reward: row.reward_event_type
      ? { eventType: String(row.reward_event_type), ruleVersion: String(row.reward_rule_version) }
      : null,
    status: row.status as ChallengeStatus,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapParticipationRow(row: QueryResultRow): ChallengeParticipationRecord {
  return {
    id: String(row.id),
    challengeId: String(row.challenge_id),
    userId: String(row.user_id),
    status: row.status,
    joinedAt: toDate(row.joined_at),
    leftAt: row.left_at ? toDate(row.left_at) : null,
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
    progressValue: Number(row.progress_value),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapProgressEventRow(row: QueryResultRow): ChallengeProgressEventRecord {
  return {
    id: String(row.id),
    challengeId: String(row.challenge_id),
    userId: String(row.user_id),
    activityType: row.activity_type,
    sourceId: String(row.source_id),
    units: Number(row.units),
    occurredAt: toDate(row.occurred_at),
    ruleVersion: String(row.rule_version),
    idempotencyKey: String(row.idempotency_key),
    fingerprint: String(row.fingerprint),
    createdAt: toDate(row.created_at),
  };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === '23503';
}

function isPostgresError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original repository failure.
  }
}
