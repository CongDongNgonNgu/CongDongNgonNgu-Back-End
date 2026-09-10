import type { Pool } from 'pg';
import { ProfileRepositoryConflictError } from './language-catalog';
import type { ProfileRepository } from './profile.repository';
import type {
  LanguageCatalogRecord,
  ProfileRecord,
  ReplaceProfileInput,
  UserLanguageRecord,
} from './profile.types';

export class PostgresProfileRepository implements ProfileRepository {
  constructor(private readonly pool: Pool) {}

  async listActive(search = '', limit = 50): Promise<LanguageCatalogRecord[]> {
    const values: unknown[] = [];
    let where = 'WHERE active = true';
    const normalizedSearch = search.trim();
    if (normalizedSearch) {
      values.push('%' + normalizedSearch + '%');
      const parameter = '$' + values.length;
      where +=
        ' AND (code ILIKE ' + parameter +
        ' OR slug ILIKE ' + parameter +
        ' OR native_name ILIKE ' + parameter +
        ' OR english_name ILIKE ' + parameter +
        ' OR vietnamese_name ILIKE ' + parameter + ')';
    }
    values.push(limit);
    const result = await this.pool.query(
      'SELECT * FROM languages ' + where +
      ' ORDER BY sort_order ASC, english_name ASC LIMIT $' + values.length,
      values,
    );
    return result.rows.map(mapLanguage);
  }

  async findByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]> {
    if (codes.length === 0) return [];
    const result = await this.pool.query(
      'SELECT * FROM languages WHERE code = ANY($1::varchar[])',
      [codes],
    );
    return result.rows.map(mapLanguage);
  }

  async findActiveByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]> {
    const languages = await this.findByCodes(codes);
    return languages.filter((language) => language.active);
  }

  async findProfile(userId: string): Promise<ProfileRecord> {
    const [
      profileResult,
      languageResult,
      goalsResult,
      skillsResult,
      interestsResult,
      availabilityResult,
    ] = await Promise.all([
      this.pool.query('SELECT timezone FROM user_profiles WHERE user_id = $1', [userId]),
      this.pool.query(`SELECT
           ul.is_native,
           ul.is_known,
           ul.is_learning,
           ul.declared_proficiency,
           ul.assessed_proficiency,
           ul.is_primary_learning_target,
           ul.visibility,
           l.id AS language_id,
           l.code,
           l.slug,
           l.native_name,
           l.english_name,
           l.vietnamese_name,
           l.direction,
           l.active,
           l.launch,
           l.sort_order,
           l.created_at AS language_created_at,
           l.updated_at AS language_updated_at
         FROM user_languages ul
         INNER JOIN languages l ON l.id = ul.language_id
         WHERE ul.user_id = $1
         ORDER BY l.sort_order ASC, l.english_name ASC`,
      [userId]),
      this.pool.query(
        'SELECT goal_code FROM user_learning_goals WHERE user_id = $1 ORDER BY sort_order ASC, goal_code ASC',
        [userId],
      ),
      this.pool.query(
        'SELECT skill FROM user_profile_skills WHERE user_id = $1 ORDER BY skill ASC',
        [userId],
      ),
      this.pool.query(
        'SELECT interest_code FROM user_profile_interests WHERE user_id = $1 ORDER BY interest_code ASC',
        [userId],
      ),
      this.pool.query(
        'SELECT day_of_week, start_minute, end_minute FROM user_availability WHERE user_id = $1 ORDER BY day_of_week ASC, start_minute ASC',
        [userId],
      ),
    ]);

    return {
      languages: languageResult.rows.map(mapUserLanguage),
      goals: goalsResult.rows.map((row) => String(row.goal_code)),
      skills: skillsResult.rows.map((row) => String(row.skill) as ProfileRecord['skills'][number]),
      interests: interestsResult.rows.map((row) => String(row.interest_code)),
      timezone: profileResult.rows[0]?.timezone
        ? String(profileResult.rows[0].timezone)
        : null,
      availability: availabilityResult.rows.map((row) => ({
        dayOfWeek: Number(row.day_of_week),
        startMinute: Number(row.start_minute),
        endMinute: Number(row.end_minute),
      })),
    };
  }

  async replaceProfile(userId: string, input: ReplaceProfileInput): Promise<ProfileRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO user_profiles (user_id, timezone)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now()`,
        [userId, input.timezone],
      );
      await client.query(
        'UPDATE user_languages SET is_primary_learning_target = false, updated_at = now() WHERE user_id = $1',
        [userId],
      );
      await client.query(
        `DELETE FROM user_languages ul
         WHERE ul.user_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM languages l
             WHERE l.id = ul.language_id
               AND l.code = ANY($2::varchar[])
           )`,
        [userId, input.languages.map((language) => language.languageCode)],
      );
      await client.query('DELETE FROM user_learning_goals WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_profile_skills WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_profile_interests WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_availability WHERE user_id = $1', [userId]);

      for (const language of input.languages) {
        const result = await client.query(
          `INSERT INTO user_languages (
             user_id,
             language_id,
             is_native,
             is_known,
             is_learning,
             declared_proficiency,
             is_primary_learning_target,
             visibility
           )
           SELECT
             $1,
             id,
             $3,
             $4,
             $5,
             $6::declared_language_proficiency,
             $7,
             $8::language_visibility
           FROM languages
           WHERE code = $2 AND active = true
           ON CONFLICT (user_id, language_id)
           DO UPDATE SET
             is_native = EXCLUDED.is_native,
             is_known = EXCLUDED.is_known,
             is_learning = EXCLUDED.is_learning,
             declared_proficiency = EXCLUDED.declared_proficiency,
             is_primary_learning_target = EXCLUDED.is_primary_learning_target,
             visibility = EXCLUDED.visibility,
             updated_at = now()`,
          [
            userId,
            language.languageCode,
            language.roles.includes('native'),
            language.roles.includes('known'),
            language.roles.includes('learning'),
            language.declaredProficiency,
            language.isPrimaryLearningTarget,
            language.visibility,
          ],
        );
        if (result.rowCount !== 1) {
          throw new ProfileRepositoryConflictError('A language is unavailable');
        }
      }

      for (let index = 0; index < input.goals.length; index += 1) {
        await client.query(
          'INSERT INTO user_learning_goals (user_id, goal_code, sort_order) VALUES ($1, $2, $3)',
          [userId, input.goals[index], index],
        );
      }
      for (const skill of input.skills) {
        await client.query(
          'INSERT INTO user_profile_skills (user_id, skill) VALUES ($1, $2::profile_skill)',
          [userId, skill],
        );
      }
      for (const interest of input.interests) {
        await client.query(
          'INSERT INTO user_profile_interests (user_id, interest_code) VALUES ($1, $2)',
          [userId, interest],
        );
      }
      for (const window of input.availability) {
        await client.query(
          'INSERT INTO user_availability (user_id, day_of_week, start_minute, end_minute) VALUES ($1, $2, $3, $4)',
          [userId, window.dayOfWeek, window.startMinute, window.endMinute],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapProfileRepositoryError(error);
    } finally {
      client.release();
    }
    return this.findProfile(userId);
  }
}

function mapLanguage(row: Record<string, unknown>): LanguageCatalogRecord {
  return {
    id: String(row.id),
    code: String(row.code),
    slug: String(row.slug),
    nativeName: String(row.native_name),
    englishName: String(row.english_name),
    vietnameseName: String(row.vietnamese_name),
    direction: String(row.direction) as LanguageCatalogRecord['direction'],
    active: Boolean(row.active),
    launch: Boolean(row.launch),
    sortOrder: Number(row.sort_order),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapUserLanguage(row: Record<string, unknown>): UserLanguageRecord {
  const roles: UserLanguageRecord['roles'] = [];
  if (Boolean(row.is_native)) roles.push('native' as const);
  if (Boolean(row.is_known)) roles.push('known' as const);
  if (Boolean(row.is_learning)) roles.push('learning' as const);
  return {
    language: {
      id: String(row.language_id),
      code: String(row.code),
      slug: String(row.slug),
      nativeName: String(row.native_name),
      englishName: String(row.english_name),
      vietnameseName: String(row.vietnamese_name),
      direction: String(row.direction) as LanguageCatalogRecord['direction'],
      active: Boolean(row.active),
      launch: Boolean(row.launch),
      sortOrder: Number(row.sort_order),
      createdAt: new Date(String(row.language_created_at)),
      updatedAt: new Date(String(row.language_updated_at)),
    },
    roles,
    declaredProficiency: String(row.declared_proficiency) as UserLanguageRecord['declaredProficiency'],
    assessedProficiency: row.assessed_proficiency
      ? String(row.assessed_proficiency) as UserLanguageRecord['assessedProficiency']
      : null,
    isPrimaryLearningTarget: Boolean(row.is_primary_learning_target),
    visibility: String(row.visibility) as UserLanguageRecord['visibility'],
  };
}

function mapProfileRepositoryError(error: unknown): Error {
  if (error instanceof ProfileRepositoryConflictError) return error;
  if (isPostgresConflict(error)) return new ProfileRepositoryConflictError();
  return error instanceof Error ? error : new Error('Profile persistence failed');
}

function isPostgresConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === '23505' ||
      (error as { code?: unknown }).code === '23P01')
  );
}
