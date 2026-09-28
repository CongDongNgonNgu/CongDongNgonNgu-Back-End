import { TatoebaImportError, tatoebaError } from '../library/importers/tatoeba/tatoeba.errors';
import {
  runTatoebaDryRun,
  writeTatoebaDryRunReport,
  type TatoebaDryRunOptions,
} from '../library/importers/tatoeba/tatoeba.dry-run';
import { parseConfiguredDirections, parseConfiguredLanguages } from '../library/importers/tatoeba/tatoeba.languages';

export interface ParsedTatoebaCliArgs extends TatoebaDryRunOptions {
  dryRun: true;
  reportPath: string | null;
}

interface CliWriter {
  write(value: string): unknown;
}

const VALUE_FLAGS = new Set([
  '--sentences-detailed',
  '--sentences-cc0',
  '--links',
  '--sentence-limit',
  '--link-limit',
  '--languages',
  '--directions',
  '--api-concurrency',
  '--api-timeout-ms',
  '--api-retries',
  '--api-max-response-bytes',
  '--report',
]);

function parsePositiveInteger(flag: string, raw: string, allowZero = false): number {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(raw)) throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${flag} must be a bounded decimal integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${flag} exceeds safe integer bounds.`);
  return value;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${flag} is required.`);
  return value;
}

export function parseTatoebaCliArgs(argv: readonly string[]): ParsedTatoebaCliArgs {
  let dryRun = false;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (dryRun) throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', '--dry-run may appear only once.');
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) {
      throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `Unknown Tatoeba importer argument: ${argument}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${argument} requires a value.`);
    }
    if (values.has(argument)) throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', `${argument} may appear only once.`);
    values.set(argument, value);
    index += 1;
  }

  if (!dryRun) {
    throw tatoebaError(
      'TATOEBA_IMPORT_WRITE_MODE_NOT_IMPLEMENTED',
      'TATOEBA_IMPORT_WRITE_MODE_NOT_IMPLEMENTED: pass --dry-run; no write mode exists.',
    );
  }

  const languages = parseConfiguredLanguages(required(values, '--languages'));
  const directions = parseConfiguredDirections(required(values, '--directions'));
  const sentenceLimit = parsePositiveInteger('--sentence-limit', required(values, '--sentence-limit'));
  const linkLimit = parsePositiveInteger('--link-limit', required(values, '--link-limit'));
  return {
    dryRun: true,
    sentencesDetailedPath: required(values, '--sentences-detailed'),
    sentencesCc0Path: required(values, '--sentences-cc0'),
    linksPath: required(values, '--links'),
    languages,
    directions,
    sentenceLimit,
    linkLimit,
    apiConcurrency: values.has('--api-concurrency') ? parsePositiveInteger('--api-concurrency', values.get('--api-concurrency')!) : undefined,
    apiTimeoutMs: values.has('--api-timeout-ms') ? parsePositiveInteger('--api-timeout-ms', values.get('--api-timeout-ms')!) : undefined,
    apiRetries: values.has('--api-retries') ? parsePositiveInteger('--api-retries', values.get('--api-retries')!, true) : undefined,
    apiMaxResponseBytes: values.has('--api-max-response-bytes') ? parsePositiveInteger('--api-max-response-bytes', values.get('--api-max-response-bytes')!) : undefined,
    reportPath: values.get('--report') ?? null,
  };
}

export async function executeTatoebaCli(
  argv: readonly string[],
  output: CliWriter = process.stdout,
  errorOutput: CliWriter = process.stderr,
): Promise<number> {
  if (!argv.includes('--dry-run')) {
    errorOutput.write('TATOEBA_IMPORT_WRITE_MODE_NOT_IMPLEMENTED: pass --dry-run; no write mode exists.\n');
    return 2;
  }
  try {
    const parsed = parseTatoebaCliArgs(argv);
    const report = await runTatoebaDryRun(parsed);
    if (parsed.reportPath) await writeTatoebaDryRunReport(report, parsed.reportPath);
    else output.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (caught) {
    const error = caught instanceof TatoebaImportError
      ? caught
      : new TatoebaImportError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Tatoeba dry-run failed closed.');
    errorOutput.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await executeTatoebaCli(process.argv.slice(2));
}

if (require.main === module) void main();
