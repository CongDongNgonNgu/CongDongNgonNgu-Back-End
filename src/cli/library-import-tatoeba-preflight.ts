import {
  isUuid,
  preflightError,
  TatoebaPreflightError,
} from '../library/importers/tatoeba/tatoeba-preflight.contract';
import {
  createPostgresTatoebaImportPreflightRepository,
  type TatoebaPreflightRepositoryHandle,
} from '../library/importers/tatoeba/postgres-tatoeba-preflight.repository';
import { runTatoebaImportPreflight } from '../library/importers/tatoeba/tatoeba-preflight.service';
import {
  TATOEBA_IMPORT_DATABASE_URL_ENV,
  TATOEBA_IMPORT_EXPECTED_DATABASE_ENV,
  TATOEBA_IMPORT_TEST_ENVIRONMENT,
  type TatoebaImportEnvironment,
  type TatoebaImportPreflightRepository,
} from '../library/importers/tatoeba/tatoeba-preflight.types';

export interface ParsedTatoebaPreflightCliArgs {
  environment: TatoebaImportEnvironment;
  actorUserId: string;
}

interface CliWriter {
  write(value: string): unknown;
}

export interface TatoebaPreflightCliDependencies {
  env?: NodeJS.ProcessEnv;
  createRepository?: (
    databaseUrl: string,
    expectedDatabaseName: string,
  ) => TatoebaPreflightRepositoryHandle;
}

const VALUE_FLAGS = new Set(['--environment', '--actor-user-id']);

function requiredValue(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw preflightError('TATOEBA_IMPORT_ACTOR_ID_INVALID', `${flag} is required.`);
  return value;
}

export function parseTatoebaPreflightCliArgs(
  argv: readonly string[],
): ParsedTatoebaPreflightCliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!VALUE_FLAGS.has(argument)) {
      throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', `Unknown Tatoeba preflight argument: ${argument}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', `${argument} requires a value.`);
    }
    if (values.has(argument)) {
      throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', `${argument} may appear only once.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const environment = values.get('--environment');
  if (!environment) {
    throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_REQUIRED', '--environment TEST is required.');
  }
  if (environment === 'PRODUCTION' || environment === 'prod' || environment === 'production') {
    throw preflightError('TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED', 'Only TEST preflight is supported.');
  }
  if (environment !== TATOEBA_IMPORT_TEST_ENVIRONMENT) {
    throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', 'Only the exact TEST environment is supported.');
  }

  const actorUserId = requiredValue(values, '--actor-user-id');
  if (!isUuid(actorUserId)) {
    throw preflightError('TATOEBA_IMPORT_ACTOR_ID_INVALID', '--actor-user-id must be a UUID.');
  }
  return { environment: TATOEBA_IMPORT_TEST_ENVIRONMENT, actorUserId };
}

function writeCliError(errorOutput: CliWriter, error: unknown): void {
  const safeError = error instanceof TatoebaPreflightError
    ? error
    : preflightError('TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE', 'Tatoeba import preflight failed closed.');
  errorOutput.write(`${safeError.code}: ${safeError.message}\n`);
}

export async function executeTatoebaPreflightCli(
  argv: readonly string[],
  output: CliWriter = process.stdout,
  errorOutput: CliWriter = process.stderr,
  dependencies: TatoebaPreflightCliDependencies = {},
): Promise<number> {
  let parsed: ParsedTatoebaPreflightCliArgs;
  try {
    parsed = parseTatoebaPreflightCliArgs(argv);
  } catch (error) {
    writeCliError(errorOutput, error);
    return 2;
  }

  const environment = dependencies.env ?? process.env;
  const databaseUrl = environment[TATOEBA_IMPORT_DATABASE_URL_ENV];
  if (!databaseUrl) {
    writeCliError(errorOutput, preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_REQUIRED',
      `${TATOEBA_IMPORT_DATABASE_URL_ENV} is required for TEST preflight.`,
    ));
    return 2;
  }
  if (!/^postgres(?:ql)?:\/\//iu.test(databaseUrl)) {
    writeCliError(errorOutput, preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_INVALID',
      `${TATOEBA_IMPORT_DATABASE_URL_ENV} must be a PostgreSQL connection URL.`,
    ));
    return 2;
  }

  const expectedDatabaseName = environment[TATOEBA_IMPORT_EXPECTED_DATABASE_ENV];
  if (!expectedDatabaseName) {
    writeCliError(errorOutput, preflightError(
      'TATOEBA_IMPORT_TEST_TARGET_UNVERIFIED',
      `${TATOEBA_IMPORT_EXPECTED_DATABASE_ENV} is required to prove the TEST target.`,
    ));
    return 2;
  }

  const createRepository = dependencies.createRepository
    ?? createPostgresTatoebaImportPreflightRepository;
  let handle: TatoebaPreflightRepositoryHandle | null = null;
  try {
    handle = createRepository(databaseUrl, expectedDatabaseName);
    const result = await runTatoebaImportPreflight(parsed, handle.repository);
    output.write(`${JSON.stringify(result)}\n`);
    return result.status === 'PASS' ? 0 : 2;
  } catch (error) {
    writeCliError(errorOutput, error);
    return 2;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export async function main(): Promise<void> {
  process.exitCode = await executeTatoebaPreflightCli(process.argv.slice(2));
}

if (require.main === module) void main();
