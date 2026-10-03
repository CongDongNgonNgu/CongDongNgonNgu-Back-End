import type { QueryResultRow } from 'pg';
import {
  executeUatSeedCli,
  seedUatPersonas,
  type UatSeedDatabaseClient,
  type UatSeedPool,
  type UatSeedPoolClient,
} from './uat-seed.runner';
import { UAT_SEED_CONFIRMATION, buildUatPersonas, type UatPersona } from './uat-seed';

class TestWriter {
  value = '';

  write(value: string): void {
    this.value += value;
  }
}

function createDatabase(options: { failAfterBegin?: boolean } = {}): {
  database: UatSeedDatabaseClient;
  queries: string[];
} {
  const queries: string[] = [];
  let began = false;
  let userSequence = 0;
  let languageSequence = 0;
  const database: UatSeedDatabaseClient = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<{ rows: T[] }> {
      queries.push(text);
      if (text === 'BEGIN') {
        began = true;
        return { rows: [] as T[] };
      }
      if (options.failAfterBegin && began && text.includes('INSERT INTO user_profiles')) {
        throw new Error('simulated UAT seed failure');
      }
      if (text.includes('FROM languages')) {
        return {
          rows: [
            { id: 'language-en', code: 'en' },
            { id: 'language-vi', code: 'vi' },
          ] as unknown as T[],
        };
      }
      if (text.includes('INSERT INTO users')) {
        userSequence += 1;
        return { rows: [{ id: `user-${userSequence}` }] as unknown as T[] };
      }
      if (text.includes('INSERT INTO user_languages')) {
        languageSequence += 1;
        return { rows: [{ id: `user-language-${languageSequence}` }] as unknown as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { database, queries };
}

function createPool(client: UatSeedPoolClient): {
  pool: UatSeedPool;
  release: jest.Mock;
  end: jest.Mock;
} {
  const release = jest.fn();
  const end = jest.fn(async () => undefined);
  const pool: UatSeedPool = {
    connect: jest.fn(async () => client),
    end,
  };
  return { pool, release, end };
}

function getPersona(...keys: string[]): readonly UatPersona[] {
  const personas = buildUatPersonas();
  return keys.map((key) => {
    const persona = personas.find((item) => item.key === key);
    if (!persona) throw new Error(`Missing test persona ${key}`);
    return persona;
  });
}

describe('Phase 18 UAT seed runner', () => {
  it('seeds the manifest transactionally with upserts and never resets data', async () => {
    const { database, queries } = createDatabase();

    const result = await seedUatPersonas(database, 'hashed-test-password', getPersona('english-native-buddy', 'new-user'));

    expect(result.personas.map((persona) => persona.key)).toEqual([
      'english-native-buddy',
      'new-user',
    ]);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(queries.some((query) => query === 'ROLLBACK')).toBe(false);
    expect(queries.filter((query) => query.includes('ON CONFLICT')).length).toBeGreaterThan(0);
    expect(queries.some((query) => /\b(DELETE|TRUNCATE|DROP)\b/u.test(query))).toBe(false);
  });

  it('rolls back when any fixture write fails', async () => {
    const { database, queries } = createDatabase({ failAfterBegin: true });

    await expect(seedUatPersonas(database, 'hashed-test-password', getPersona('new-user')))
      .rejects.toThrow('simulated UAT seed failure');
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  it('supports dry-run without opening a database connection', async () => {
    const output = new TestWriter();
    const errorOutput = new TestWriter();
    const createPoolMock = jest.fn();

    const exitCode = await executeUatSeedCli(
      ['--environment', 'TEST', '--dry-run'],
      output,
      errorOutput,
      { createPool: createPoolMock },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.value)).toMatchObject({
      status: 'DRY_RUN',
      environment: 'TEST',
    });
    expect(errorOutput.value).toBe('');
    expect(createPoolMock).not.toHaveBeenCalled();
  });

  it('requires the explicit non-production target before creating a pool', async () => {
    const output = new TestWriter();
    const errorOutput = new TestWriter();
    const createPoolMock = jest.fn();

    const exitCode = await executeUatSeedCli(
      ['--environment', 'TEST'],
      output,
      errorOutput,
      {
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://seed-user:seed-password@localhost:5432/congdongngonngu_test',
          UAT_SEED_EXPECTED_DATABASE_HOST: 'localhost',
          UAT_SEED_EXPECTED_DATABASE_NAME: 'congdongngonngu_test',
          UAT_SEED_ALLOWED_DATABASE_HOSTS: 'localhost',
          UAT_SEED_CONFIRMATION,
        },
        createPool: createPoolMock,
      },
    );

    expect(exitCode).toBe(2);
    expect(errorOutput.value).toContain('UAT_SEED_PASSWORD_REQUIRED');
    expect(createPoolMock).not.toHaveBeenCalled();
  });

  it('runs the guarded seed and closes the pool on success', async () => {
    const { database, queries } = createDatabase();
    const client: UatSeedPoolClient = {
      ...database,
      release: jest.fn(),
    };
    const { pool, end } = createPool(client);
    const output = new TestWriter();
    const errorOutput = new TestWriter();

    const exitCode = await executeUatSeedCli(
      ['--environment', 'UAT'],
      output,
      errorOutput,
      {
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://seed-user:seed-password@localhost:5432/congdongngonngu_uat',
          UAT_SEED_EXPECTED_DATABASE_HOST: 'localhost',
          UAT_SEED_EXPECTED_DATABASE_NAME: 'congdongngonngu_uat',
          UAT_SEED_ALLOWED_DATABASE_HOSTS: 'localhost',
          UAT_SEED_CONFIRMATION,
          UAT_SEED_PASSWORD: 'UAT-only-password-with-12-chars',
        },
        createPool: jest.fn(() => pool),
        hashPassword: jest.fn(async () => 'hashed-test-password'),
        personas: getPersona('new-user'),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.value)).toMatchObject({
      status: 'PASS',
      environment: 'UAT',
      seededPersonaCount: 1,
      seededPersonaKeys: ['new-user'],
    });
    expect(errorOutput.value).toBe('');
    expect(queries).toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
