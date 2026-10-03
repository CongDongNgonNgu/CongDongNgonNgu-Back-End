import { Pool } from 'pg';
import type { QueryResultRow } from 'pg';
import { PasswordHasher } from '../auth/crypto/password-hasher';
import {
  UatSeedError,
  buildUatPersonas,
  parseUatSeedCliArgs,
  type UatPersona,
  type UatPersonaLanguage,
  type UatSeedTarget,
  validateUatSeedTarget,
} from './uat-seed';

export interface UatSeedDatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface UatSeedPoolClient extends UatSeedDatabaseClient {
  release(): void;
}

export interface UatSeedPool {
  connect(): Promise<UatSeedPoolClient>;
  end(): Promise<void>;
}

export interface UatSeededPersona {
  key: string;
  userId: string;
}

export interface UatSeedResult {
  personas: readonly UatSeededPersona[];
}

export async function seedUatPersonas(
  database: UatSeedDatabaseClient,
  passwordHash: string,
  personas: readonly UatPersona[] = buildUatPersonas(),
): Promise<UatSeedResult> {
  const languageRows = await database.query<{ id: string; code: string }>(
    `SELECT id::text AS id, code
       FROM languages
      WHERE code = ANY($1::text[])
        AND active = true`,
    [allLanguageCodes(personas)],
  );
  const languageIds = new Map(languageRows.rows.map((row) => [row.code, row.id]));
  const missingCodes = allLanguageCodes(personas).filter((code) => !languageIds.has(code));
  if (missingCodes.length > 0) {
    throw new UatSeedError(
      'UAT_SEED_LANGUAGE_MISSING',
      `Required active language catalog entries are missing: ${missingCodes.join(', ')}.`,
    );
  }

  let transactionStarted = false;
  try {
    await database.query('BEGIN');
    transactionStarted = true;
    const seeded: UatSeededPersona[] = [];

    for (const persona of personas) {
      const userId = await upsertUser(database, persona, passwordHash);
      await upsertRoles(database, userId, persona);
      await upsertProfile(database, userId, persona);
      await upsertProfileCollections(database, userId, persona);

      const relationIds = new Map<string, string>();
      for (const language of persona.languages) {
        const languageId = requireLanguageId(languageIds, language.code);
        const relationId = await upsertLanguage(database, userId, languageId, language);
        relationIds.set(language.code, relationId);
      }

      await upsertExchange(database, userId, persona, relationIds);
      seeded.push({ key: persona.key, userId });
    }

    await database.query('COMMIT');
    return { personas: seeded };
  } catch (error) {
    if (transactionStarted) await database.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function hashUatPassword(password: string): Promise<string> {
  return new PasswordHasher().hash(password);
}

export interface UatSeedCliDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (target: UatSeedTarget) => UatSeedPool;
  hashPassword?: (password: string) => Promise<string>;
  personas?: readonly UatPersona[];
}

interface CliWriter {
  write(value: string): unknown;
}

export async function executeUatSeedCli(
  argv: readonly string[],
  output: CliWriter = process.stdout,
  errorOutput: CliWriter = process.stderr,
  dependencies: UatSeedCliDependencies = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseUatSeedCliArgs(argv);
  } catch (error) {
    writeCliError(errorOutput, error);
    return 2;
  }

  const environment = dependencies.env ?? process.env;
  const personas = dependencies.personas ?? buildUatPersonas();
  if (environment.NODE_ENV?.toLowerCase() === 'production') {
    writeCliError(
      errorOutput,
      new UatSeedError('UAT_SEED_PRODUCTION_UNSUPPORTED', 'NODE_ENV=production cannot run the UAT seed.'),
    );
    return 2;
  }
  if (parsed.dryRun) {
    output.write(JSON.stringify({
      status: 'DRY_RUN',
      environment: parsed.environment,
      personaKeys: personas.map((persona) => persona.key),
    }) + '\n');
    return 0;
  }

  let target: UatSeedTarget;
  try {
    target = validateUatSeedTarget({
      environment: parsed.environment,
      nodeEnv: environment.NODE_ENV,
      databaseUrl: environment.DATABASE_URL,
      expectedDatabaseHost: environment.UAT_SEED_EXPECTED_DATABASE_HOST,
      expectedDatabaseName: environment.UAT_SEED_EXPECTED_DATABASE_NAME,
      allowedDatabaseHosts: splitList(environment.UAT_SEED_ALLOWED_DATABASE_HOSTS),
      confirmation: environment.UAT_SEED_CONFIRMATION,
      password: environment.UAT_SEED_PASSWORD,
    });
  } catch (error) {
    writeCliError(errorOutput, error);
    return 2;
  }

  const createPool = dependencies.createPool ?? createDefaultPool;
  const hashPassword = dependencies.hashPassword ?? hashUatPassword;
  let pool: UatSeedPool | null = null;
  let client: UatSeedPoolClient | null = null;
  try {
    pool = createPool(target);
    client = await pool.connect();
    const passwordHash = await hashPassword(target.password);
    const result = await seedUatPersonas(client, passwordHash, personas);
    output.write(JSON.stringify({
      status: 'PASS',
      environment: target.environment,
      seededPersonaCount: result.personas.length,
      seededPersonaKeys: result.personas.map((persona) => persona.key),
    }) + '\n');
    return 0;
  } catch (error) {
    writeCliError(errorOutput, error);
    return 2;
  } finally {
    client?.release();
    if (pool) await pool.end().catch(() => undefined);
  }
}

export async function main(): Promise<void> {
  process.exitCode = await executeUatSeedCli(process.argv.slice(2));
}

async function upsertUser(
  database: UatSeedDatabaseClient,
  persona: UatPersona,
  passwordHash: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (
       email, normalized_email, display_name, password_hash, status, email_verified_at
     ) VALUES ($1, $1, $2, $3, 'ACTIVE'::user_status, now())
     ON CONFLICT (normalized_email) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       password_hash = EXCLUDED.password_hash,
       status = 'ACTIVE'::user_status,
       email_verified_at = COALESCE(users.email_verified_at, EXCLUDED.email_verified_at),
       updated_at = now()
     RETURNING id::text AS id`,
    [persona.email, persona.displayName, passwordHash],
  );
  const userId = result.rows[0]?.id;
  if (!userId) throw new UatSeedError('UAT_SEED_USER_WRITE_FAILED', 'A seeded user id was not returned.');
  return userId;
}

async function upsertRoles(
  database: UatSeedDatabaseClient,
  userId: string,
  persona: UatPersona,
): Promise<void> {
  for (const role of persona.roles) {
    await database.query(
      `INSERT INTO user_roles (user_id, role_key)
       VALUES ($1, $2::role_key)
       ON CONFLICT (user_id, role_key) DO NOTHING`,
      [userId, role],
    );
  }
}

async function upsertProfile(
  database: UatSeedDatabaseClient,
  userId: string,
  persona: UatPersona,
): Promise<void> {
  await database.query(
    `INSERT INTO user_profiles (user_id, timezone)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = EXCLUDED.timezone,
       updated_at = now()`,
    [userId, persona.timezone],
  );
}

async function upsertProfileCollections(
  database: UatSeedDatabaseClient,
  userId: string,
  persona: UatPersona,
): Promise<void> {
  for (const [sortOrder, goal] of persona.goals.entries()) {
    await database.query(
      `INSERT INTO user_learning_goals (user_id, goal_code, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, goal_code) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [userId, goal, sortOrder],
    );
  }
  for (const skill of persona.skills) {
    await database.query(
      `INSERT INTO user_profile_skills (user_id, skill)
       VALUES ($1, $2::profile_skill)
       ON CONFLICT (user_id, skill) DO NOTHING`,
      [userId, skill],
    );
  }
  for (const interest of persona.interests) {
    await database.query(
      `INSERT INTO user_profile_interests (user_id, interest_code)
       VALUES ($1, $2)
       ON CONFLICT (user_id, interest_code) DO NOTHING`,
      [userId, interest],
    );
  }
}

async function upsertLanguage(
  database: UatSeedDatabaseClient,
  userId: string,
  languageId: string,
  language: UatPersonaLanguage,
): Promise<string> {
  if (language.isPrimaryLearningTarget) {
    await database.query(
      `UPDATE user_languages
          SET is_primary_learning_target = false,
              updated_at = now()
        WHERE user_id = $1
          AND is_primary_learning_target = true
          AND language_id <> $2`,
      [userId, languageId],
    );
  }
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_languages (
       user_id, language_id, is_native, is_known, is_learning,
       declared_proficiency, is_primary_learning_target, visibility
     ) VALUES ($1, $2, $3, $4, $5, $6::declared_language_proficiency, $7, $8::language_visibility)
     ON CONFLICT (user_id, language_id) DO UPDATE SET
       is_native = EXCLUDED.is_native,
       is_known = EXCLUDED.is_known,
       is_learning = EXCLUDED.is_learning,
       declared_proficiency = EXCLUDED.declared_proficiency,
       is_primary_learning_target = EXCLUDED.is_primary_learning_target,
       visibility = EXCLUDED.visibility,
       updated_at = now()
     RETURNING id::text AS id`,
    [
      userId,
      languageId,
      language.isNative,
      language.isKnown,
      language.isLearning,
      language.declaredProficiency,
      language.isPrimaryLearningTarget,
      language.visibility,
    ],
  );
  const relationId = result.rows[0]?.id;
  if (!relationId) throw new UatSeedError('UAT_SEED_LANGUAGE_WRITE_FAILED', 'A seeded language relation id was not returned.');
  return relationId;
}

async function upsertExchange(
  database: UatSeedDatabaseClient,
  userId: string,
  persona: UatPersona,
  relationIds: ReadonlyMap<string, string>,
): Promise<void> {
  const exchange = persona.exchange;
  await database.query(
    `INSERT INTO language_exchange_preferences (
       user_id, exchange_opt_in, discoverable, timezone_visibility,
       availability_visibility, contact_permission
     ) VALUES ($1, $2, $3, $4::exchange_visibility_mode, $5::exchange_visibility_mode, $6::exchange_contact_permission)
     ON CONFLICT (user_id) DO UPDATE SET
       exchange_opt_in = EXCLUDED.exchange_opt_in,
       discoverable = EXCLUDED.discoverable,
       timezone_visibility = EXCLUDED.timezone_visibility,
       availability_visibility = EXCLUDED.availability_visibility,
       contact_permission = EXCLUDED.contact_permission,
       updated_at = now()`,
    [
      userId,
      exchange?.enabled ?? false,
      exchange?.discoverable ?? false,
      exchange ? 'SUMMARY' : 'HIDDEN',
      'HIDDEN',
      exchange ? 'RELATIONSHIP_GATED' : 'NO_CONTACT',
    ],
  );
  if (!exchange) return;

  for (const code of exchange.offers) {
    await upsertExchangeLanguage(database, userId, relationIds, code, 'OFFER');
  }
  for (const code of exchange.wants) {
    await upsertExchangeLanguage(database, userId, relationIds, code, 'WANT');
  }
  for (const level of exchange.partnerLevels) {
    await database.query(
      `INSERT INTO language_exchange_partner_levels (user_id, level)
       VALUES ($1, $2)
       ON CONFLICT (user_id, level) DO NOTHING`,
      [userId, level],
    );
  }
  for (const goal of exchange.goals) {
    await database.query(
      `INSERT INTO language_exchange_goals (user_id, goal_code)
       VALUES ($1, $2)
       ON CONFLICT (user_id, goal_code) DO NOTHING`,
      [userId, goal],
    );
  }
  for (const interest of exchange.interests) {
    await database.query(
      `INSERT INTO language_exchange_interests (user_id, interest_code)
       VALUES ($1, $2)
       ON CONFLICT (user_id, interest_code) DO NOTHING`,
      [userId, interest],
    );
  }
}

async function upsertExchangeLanguage(
  database: UatSeedDatabaseClient,
  userId: string,
  relationIds: ReadonlyMap<string, string>,
  code: string,
  direction: 'OFFER' | 'WANT',
): Promise<void> {
  const userLanguageId = relationIds.get(code);
  if (!userLanguageId) {
    throw new UatSeedError('UAT_SEED_EXCHANGE_LANGUAGE_INVALID', `Exchange language ${code} is not in the persona profile.`);
  }
  await database.query(
    `INSERT INTO language_exchange_languages (user_id, user_language_id, direction)
     VALUES ($1, $2, $3::exchange_language_direction)
     ON CONFLICT (user_id, user_language_id, direction) DO NOTHING`,
    [userId, userLanguageId, direction],
  );
}

function allLanguageCodes(personas: readonly UatPersona[]): string[] {
  return [...new Set(personas.flatMap((persona) => persona.languages.map((language) => language.code)))];
}

function requireLanguageId(languageIds: ReadonlyMap<string, string>, code: string): string {
  const id = languageIds.get(code);
  if (!id) throw new UatSeedError('UAT_SEED_LANGUAGE_MISSING', `Language ${code} is not available in the active catalog.`);
  return id;
}

function createDefaultPool(target: UatSeedTarget): UatSeedPool {
  const pool = new Pool({ connectionString: target.databaseUrl, max: 1 });
  return {
    async connect(): Promise<UatSeedPoolClient> {
      const client = await pool.connect();
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<{ rows: T[] }> {
          const result = await client.query<T>(text, values ? [...values] : []);
          return { rows: result.rows };
        },
        release(): void {
          client.release();
        },
      };
    },
    end: () => pool.end(),
  };
}

function splitList(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function writeCliError(errorOutput: CliWriter, error: unknown): void {
  if (error instanceof UatSeedError) {
    const message = error.message.startsWith(error.code + ': ')
      ? error.message.slice(error.code.length + 2)
      : error.message;
    errorOutput.write(`${error.code}: ${message}\n`);
    return;
  }
  errorOutput.write('UAT_SEED_FAILED: UAT seed failed closed.\n');
}

if (require.main === module) void main();
