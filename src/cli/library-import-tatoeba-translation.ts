import { readFile, stat } from 'node:fs/promises';

import {
  preflightError,
  TatoebaPreflightError,
} from '../library/importers/tatoeba/tatoeba-preflight.contract';
import {
  TATOEBA_IMPORT_DATABASE_URL_ENV,
  TATOEBA_IMPORT_EXPECTED_DATABASE_ENV,
  TATOEBA_IMPORT_EXPECTED_DATABASE_HOST_ENV,
  TATOEBA_IMPORT_EXPECTED_DATABASE_USER_ENV,
  TATOEBA_IMPORT_TEST_ENVIRONMENT,
  type TatoebaImportEnvironment,
} from '../library/importers/tatoeba/tatoeba-preflight.types';
import {
  parseTatoebaPreflightDatabaseTarget,
  type TatoebaPreflightDatabaseTarget,
} from '../library/importers/tatoeba/tatoeba-preflight.target';
import {
  createPostgresTatoebaTranslationImportRepository,
} from '../library/importers/tatoeba/postgres-tatoeba-translation-import.repository';
import { TatoebaTranslationImportService } from '../library/importers/tatoeba/tatoeba-translation-import.service';
import type {
  TatoebaTranslationImportOutcome,
  TatoebaTranslationImportRepositoryHandle,
  TatoebaTranslationImportTarget,
} from '../library/importers/tatoeba/tatoeba-translation-import.types';
import type { TatoebaTranslationCandidate } from '../library/importers/tatoeba/tatoeba.types';

const MAX_CANDIDATE_FILE_BYTES = 256_000;

export interface ParsedTatoebaTranslationImportCliArgs {
  environment: TatoebaImportEnvironment;
  actorUserId: string;
  candidateFile: string;
}

export interface TatoebaTranslationImportCliDependencies {
  env?: NodeJS.ProcessEnv;
  createRepository?: (target: TatoebaTranslationImportTarget) => TatoebaTranslationImportRepositoryHandle;
  readCandidate?: (candidateFile: string) => Promise<TatoebaTranslationCandidate>;
}

interface CliWriter {
  write(value: string): unknown;
}

function nextValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${flag} requires a value.`);
  }
  return value;
}

export function parseTatoebaTranslationImportCliArgs(
  argv: readonly string[],
): ParsedTatoebaTranslationImportCliArgs {
  let environment: string | undefined;
  let actorUserId: string | undefined;
  let candidateFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--environment') {
      if (environment !== undefined) throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', '--environment may appear only once.');
      environment = nextValue(argv, index, argument);
      index += 1;
    } else if (argument === '--actor-user-id') {
      if (actorUserId !== undefined) throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', '--actor-user-id may appear only once.');
      actorUserId = nextValue(argv, index, argument);
      index += 1;
    } else if (argument === '--candidate-file') {
      if (candidateFile !== undefined) throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', '--candidate-file may appear only once.');
      candidateFile = nextValue(argv, index, argument);
      index += 1;
    } else {
      throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Unknown Tatoeba translation import argument.');
    }
  }

  if (!environment) throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_REQUIRED', '--environment TEST is required.');
  if (environment === 'PRODUCTION' || environment === 'prod' || environment === 'production') {
    throw preflightError('TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED', 'Only the exact TEST environment is supported.');
  }
  if (environment !== TATOEBA_IMPORT_TEST_ENVIRONMENT) {
    throw preflightError('TATOEBA_IMPORT_ENVIRONMENT_INVALID', 'Only the exact TEST environment is supported.');
  }
  if (!actorUserId) throw preflightError('TATOEBA_IMPORT_ACTOR_ID_INVALID', '--actor-user-id is required.');
  if (!candidateFile) throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', '--candidate-file is required.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(actorUserId)) {
    throw preflightError('TATOEBA_IMPORT_ACTOR_ID_INVALID', '--actor-user-id must be a UUID.');
  }
  return { environment: TATOEBA_IMPORT_TEST_ENVIRONMENT, actorUserId, candidateFile };
}

async function readTatoebaTranslationCandidate(candidateFile: string): Promise<TatoebaTranslationCandidate> {
  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    fileStats = await stat(candidateFile);
  } catch {
    throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'The translation candidate file could not be read.');
  }
  if (!fileStats.isFile() || fileStats.size > MAX_CANDIDATE_FILE_BYTES) {
    throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'The translation candidate file is outside the bounded input contract.');
  }
  let raw: string;
  try {
    raw = await readFile(candidateFile, 'utf8');
  } catch {
    throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'The translation candidate file could not be read.');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as TatoebaTranslationCandidate;
  } catch {
    throw preflightError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'The translation candidate file must contain one JSON object.');
  }
}

function safeUnknownError(): TatoebaPreflightError {
  return preflightError('TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE', 'Tatoeba direct translation import failed closed.');
}

export async function executeTatoebaTranslationImportCli(
  argv: readonly string[],
  output: CliWriter = process.stdout,
  errorOutput: CliWriter = process.stderr,
  dependencies: TatoebaTranslationImportCliDependencies = {},
): Promise<number> {
  let handle: TatoebaTranslationImportRepositoryHandle | null = null;
  try {
    const parsed = parseTatoebaTranslationImportCliArgs(argv);
    const environment = dependencies.env ?? process.env;
    const target = parseTatoebaPreflightDatabaseTarget(
      environment[TATOEBA_IMPORT_DATABASE_URL_ENV],
      environment[TATOEBA_IMPORT_EXPECTED_DATABASE_HOST_ENV],
      environment[TATOEBA_IMPORT_EXPECTED_DATABASE_ENV],
      environment[TATOEBA_IMPORT_EXPECTED_DATABASE_USER_ENV],
    );
    const candidate = await (dependencies.readCandidate ?? readTatoebaTranslationCandidate)(parsed.candidateFile);
    handle = (dependencies.createRepository ?? createPostgresTatoebaTranslationImportRepository)({
      ...target,
      environment: parsed.environment,
    });
    const result: TatoebaTranslationImportOutcome = await new TatoebaTranslationImportService(handle.repository).importTranslation({
      actorUserId: parsed.actorUserId,
      candidate,
    });
    output.write(`${JSON.stringify(result)}\n`);
    return result.status === 'QUARANTINED' ? 1 : 0;
  } catch (error) {
    const safeError = error instanceof TatoebaPreflightError ? error : safeUnknownError();
    errorOutput.write(`${safeError.code}: ${safeError.message}\n`);
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void executeTatoebaTranslationImportCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
