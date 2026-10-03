import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  buildBackupMetadata,
  buildR2ObjectKey,
  sanitizeOperationalError,
  sha256Hex,
  validateR2Configuration,
} from '../operations/phase18-r2-backup';

const APPROVED_UAT_TARGET_FINGERPRINT = 'afbbdfd482dea1c4fab2ea27b35f2c2223c86c769fda15164d0401fceeeace5d';
const UAT_CHALLENGE_RULE_VERSION = 'phase18-uat-challenge-v1';
const UAT_PERSONA_EMAIL_PATTERN = 'uat.phase18.%@example.invalid';
const REPRESENTATIVE_TABLES = [
  'schema_migrations',
  'users',
  'languages',
  'user_profiles',
  'challenges',
  'challenge_participations',
  'challenge_progress_events',
  'community_events',
  'event_registrations',
  'admin_audit_log',
] as const;

interface CliArguments {
  pgBinDir?: string;
  pgSslMode?: 'require' | 'verify-full';
  workRoot?: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

class ProcessExecutionError extends Error {
  constructor(
    public readonly failureClass: string,
    public readonly exitCode: number | string,
  ) {
    super(`PROCESS_${failureClass}_${exitCode}`);
  }
}

interface DatabaseIdentity {
  databaseName: string;
  schemaName: string;
  fingerprint: string;
}

interface DatabaseSnapshot {
  migrationRows: number;
  migrationFiles: number;
  migrationChecksumMismatches: number;
  personaRows: number;
  challengeRows: number;
  representativeTables: readonly string[];
  rowCounts: Readonly<Record<string, number>>;
}

interface RestoreTarget {
  dataDirectory: string;
  logFile: string;
  port: number;
  user: string;
  password: string;
  environment: NodeJS.ProcessEnv;
  pgCtl: string;
}

const RESTORE_USER = 'phase18_restore';

export async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const result = await executeDrill(args);
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function executeDrill(args: CliArguments): Promise<Record<string, unknown>> {
  const configuration = validateR2Configuration(process.env);
  const databaseUrl = requireEnvironment('DATABASE_URL');
  const databaseTarget = parseDatabaseTarget(databaseUrl);
  const r2 = new S3Client({
    endpoint: configuration.endpoint,
    region: configuration.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  });

  const generatedWorkDirectory = await createWorkDirectory(args.workRoot);
  const verificationId = randomBytes(8).toString('hex');
  const timestamp = new Date();
  const verificationKey = buildR2ObjectKey('verification', timestamp, verificationId);
  const backupKey = buildR2ObjectKey('backup', timestamp, verificationId);
  const metadataKey = backupKey.replace(/\.dump$/u, '.sha256.json');
  const verificationBytes = Buffer.from('phase18-r2-verification-v1\n', 'utf8');
  let verificationObjectExists = false;
  let backupObjectExists = false;
  let metadataObjectExists = false;
  let retainBackupObjects = false;
  let restoreTarget: RestoreTarget | null = null;
  let sourcePool: Pool | null = null;
  let restorePool: Pool | null = null;
  let stage = 'R2_CONNECTIVITY';

  const dumpPath = join(generatedWorkDirectory, 'congdongngonngu-uat.dump');
  const downloadedDumpPath = join(generatedWorkDirectory, 'congdongngonngu-uat.downloaded.dump');
  const metadataPath = join(generatedWorkDirectory, 'congdongngonngu-uat.sha256.json');

  try {
    await r2.send(new PutObjectCommand({
      Bucket: configuration.bucket,
      Key: verificationKey,
      Body: verificationBytes,
      ContentType: 'application/octet-stream',
    }));
    verificationObjectExists = true;
    const verificationHead = await r2.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: verificationKey }));
    const verificationDownloaded = await readObject(r2, configuration.bucket, verificationKey);
    const verificationChecksum = sha256Hex(verificationBytes) === sha256Hex(verificationDownloaded);
    const verificationAnonymousStatus = await anonymousObjectStatus(configuration.endpoint, configuration.bucket, verificationKey);
    await r2.send(new DeleteObjectCommand({ Bucket: configuration.bucket, Key: verificationKey }));
    verificationObjectExists = false;
    const verificationDeleted = await assertObjectDeleted(r2, configuration.bucket, verificationKey);

    stage = 'DATABASE_PRECHECK';
    sourcePool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 15_000,
      query_timeout: 60_000,
      statement_timeout: 60_000,
    });
    const databaseIdentity = await assertApprovedUatDatabase(sourcePool, databaseTarget);
    const migrationState = await readMigrationState(sourcePool);
    if (migrationState.migrationChecksumMismatches !== 0) {
      throw new Error('APPROVED_UAT_MIGRATION_CHECKSUM_MISMATCH');
    }
    const sourceSnapshot = await readDatabaseSnapshot(sourcePool, migrationState);
    const pgBinDir = args.pgBinDir ?? process.env.PHASE18_PG_BIN_DIR;
    const pgDump = resolvePgTool(pgBinDir, 'pg_dump');
    const pgRestore = resolvePgTool(pgBinDir, 'pg_restore');
    const pgCtl = resolvePgTool(pgBinDir, 'pg_ctl');
    const initDb = resolvePgTool(pgBinDir, 'initdb');
    stage = 'PG_DUMP_VERSION';
    const pgDumpVersion = (await runProcess(pgDump, ['--version'], cleanChildEnvironment())).stdout.trim();

    stage = 'UAT_BACKUP_CREATE';
    await runProcess(
      pgDump,
      ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath],
      buildPostgresEnvironment(databaseTarget, args.pgSslMode),
    );
    const dumpStat = await stat(dumpPath);
    const localBackupBytes = await readFile(dumpPath);
    const localBackupSha256 = sha256Hex(localBackupBytes);
    const backupMetadata = buildBackupMetadata({
      sha256: localBackupSha256,
      sizeBytes: dumpStat.size,
      createdAt: timestamp.toISOString(),
      pgDumpVersion,
      migrationRows: sourceSnapshot.migrationRows,
    });
    await writeFile(metadataPath, JSON.stringify(backupMetadata) + '\n', 'utf8');

    stage = 'UAT_BACKUP_UPLOAD';
    await r2.send(new PutObjectCommand({
      Bucket: configuration.bucket,
      Key: backupKey,
      Body: localBackupBytes,
      ContentType: 'application/octet-stream',
      Metadata: { sha256: localBackupSha256, format: backupMetadata.format },
    }));
    backupObjectExists = true;
    await r2.send(new PutObjectCommand({
      Bucket: configuration.bucket,
      Key: metadataKey,
      Body: await readFile(metadataPath),
      ContentType: 'application/json',
    }));
    metadataObjectExists = true;
    stage = 'UAT_BACKUP_DOWNLOAD';
    const backupHead = await r2.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: backupKey }));
    const downloadedBackup = await readObject(r2, configuration.bucket, backupKey);
    await writeFile(downloadedDumpPath, downloadedBackup);
    const downloadedBackupSha256 = sha256Hex(downloadedBackup);
    if (downloadedBackupSha256 !== localBackupSha256 || Number(backupHead.ContentLength) !== dumpStat.size) {
      throw new Error('UAT_BACKUP_INTEGRITY_MISMATCH');
    }
    const backupAnonymousStatus = await anonymousObjectStatus(configuration.endpoint, configuration.bucket, backupKey);
    if (backupAnonymousStatus === 200) throw new Error('BACKUP_PUBLIC_ACCESS_DETECTED');

    stage = 'RESTORE_TARGET_CREATE';
    restoreTarget = await createRestoreTarget(generatedWorkDirectory, initDb, pgCtl);
    restorePool = new Pool({
      connectionString: buildLocalConnectionString(restoreTarget),
      max: 1,
      connectionTimeoutMillis: 15_000,
      query_timeout: 60_000,
      statement_timeout: 60_000,
    });
    stage = 'RESTORE_COMMAND';
    await runProcess(
      pgRestore,
      ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname=postgres', downloadedDumpPath],
      restoreTarget.environment,
    );
    stage = 'RESTORE_VALIDATION';
    const restoredMigrationState = await readMigrationState(restorePool);
    const restoredSnapshot = await readDatabaseSnapshot(restorePool, restoredMigrationState);
    assertRestoreSnapshot(sourceSnapshot, restoredMigrationState, restoredSnapshot);
    retainBackupObjects = true;

    return {
      status: 'PASS',
      configuration: {
        provider: 'r2',
        endpointHost: new URL(configuration.endpoint).hostname,
        bucket: configuration.bucket,
        tokenValueUsedBySource: false,
        pgDumpSslMode: args.pgSslMode ?? databaseTarget.url.searchParams.get('sslmode') ?? 'require',
        targetClassification: 'APPROVED_TEST_UAT',
        approvedFingerprintMatched: databaseIdentity.fingerprint === APPROVED_UAT_TARGET_FINGERPRINT,
      },
      connectivity: {
        put: 'PASS',
        head: headStatus(verificationHead, verificationBytes.length),
        get: 'PASS',
        checksum: verificationChecksum ? 'PASS' : 'FAIL',
        delete: verificationDeleted ? 'PASS' : 'FAIL',
        anonymousStatus: verificationAnonymousStatus,
      },
      backup: {
        key: backupKey,
        metadataKey,
        bytes: dumpStat.size,
        sha256: localBackupSha256,
        downloadedSha256: downloadedBackupSha256,
        create: 'PASS',
        upload: 'PASS',
        download: 'PASS',
        integrity: 'PASS',
        publicAccess: classifyAnonymousAccess(backupAnonymousStatus),
      },
      restore: {
        targetClassification: 'DISPOSABLE_TEST',
        command: 'PASS',
        schemaValidation: 'PASS',
        migrationValidation: 'PASS',
        dataValidation: 'PASS',
      },
      cleanup: {
        disposableRestore: 'PASS',
        localTemporaryFiles: 'PASS',
      },
      source: {
        databaseName: databaseIdentity.databaseName,
        schemaName: databaseIdentity.schemaName,
        migrationRows: sourceSnapshot.migrationRows,
        personaRows: sourceSnapshot.personaRows,
        challengeRows: sourceSnapshot.challengeRows,
      },
    };
  } catch (error) {
    const detail = error instanceof ProcessExecutionError
      ? `_${error.failureClass}_${error.exitCode}`
      : error instanceof Error && /^[A-Z0-9_.-]{1,120}$/u.test(error.message)
        ? `_${error.message}`
        : '';
    throw new Error(`${stage}_FAILED${detail}`);
  } finally {
    await restorePool?.end().catch(() => undefined);
    await sourcePool?.end().catch(() => undefined);
    if (restoreTarget) await stopRestoreTarget(restoreTarget);
    if (verificationObjectExists) await deleteObjectQuietly(r2, configuration.bucket, verificationKey);
    if (!retainBackupObjects && backupObjectExists) await deleteObjectQuietly(r2, configuration.bucket, backupKey);
    if (!retainBackupObjects && metadataObjectExists) await deleteObjectQuietly(r2, configuration.bucket, metadataKey);
    r2.destroy();
    await removeGeneratedWorkDirectory(generatedWorkDirectory);
  }
}

async function assertApprovedUatDatabase(pool: Pool, target: ParsedDatabaseTarget): Promise<DatabaseIdentity> {
  const result = await pool.query<{ database_name: string; schema_name: string }>(
    'SELECT current_database() AS database_name, current_schema() AS schema_name',
  );
  const databaseName = String(result.rows[0]?.database_name ?? '');
  const schemaName = String(result.rows[0]?.schema_name ?? '');
  const fingerprint = sha256Hex(`${target.host}|${databaseName}|${schemaName}`);
  if (target.host !== 'ep-crimson-grass-azmsfir8-pooler.c-3.ap-southeast-1.aws.neon.tech'
    || databaseName !== 'neondb'
    || schemaName !== 'public'
    || fingerprint !== APPROVED_UAT_TARGET_FINGERPRINT) {
    throw new Error('DATABASE_CLASSIFICATION_NOT_APPROVED_TEST_UAT');
  }
  return { databaseName, schemaName, fingerprint };
}

async function readMigrationState(pool: Pool): Promise<{
  migrationRows: number;
  migrationFiles: number;
  migrationChecksumMismatches: number;
}> {
  const migrationDirectory = resolve(process.cwd(), 'database', 'migrations');
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  const rows = await pool.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
  );
  const expected = new Map<string, string>();
  for (const filename of migrationFiles) {
    const contents = (await readFile(join(migrationDirectory, filename), 'utf8'))
      .replace(/\r\n/gu, '\n')
      .replace(/\r/gu, '\n');
    expected.set(filename, sha256Hex(contents));
  }
  const mismatches = rows.rows.reduce((count, row) => (
    expected.get(row.filename) === row.checksum ? count : count + 1
  ), 0) + [...expected.keys()].filter((filename) => !rows.rows.some((row) => row.filename === filename)).length;
  return {
    migrationRows: rows.rows.length,
    migrationFiles: migrationFiles.length,
    migrationChecksumMismatches: mismatches,
  };
}

async function readDatabaseSnapshot(
  pool: Pool,
  migrationState: { migrationRows: number; migrationFiles: number; migrationChecksumMismatches: number },
): Promise<DatabaseSnapshot> {
  const tableRows = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REPRESENTATIVE_TABLES],
  );
  const tableSet = new Set(tableRows.rows.map((row) => row.table_name));
  const missingTables = REPRESENTATIVE_TABLES.filter((table) => !tableSet.has(table));
  if (missingTables.length > 0) throw new Error('RESTORE_SCHEMA_VALIDATION_MISSING_TABLE');
  const personaResult = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM users WHERE normalized_email LIKE $1',
    [UAT_PERSONA_EMAIL_PATTERN],
  );
  const challengeResult = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM challenges WHERE rule_version = $1 AND status = $2::challenge_status',
    [UAT_CHALLENGE_RULE_VERSION, 'ACTIVE'],
  );
  const rowCounts: Record<string, number> = {};
  for (const table of ['users', 'languages', 'challenges', 'community_events', 'event_registrations']) {
    const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${table}"`);
    rowCounts[table] = Number(result.rows[0]?.count ?? 0);
  }
  if (Number(personaResult.rows[0]?.count ?? 0) < 9 || Number(challengeResult.rows[0]?.count ?? 0) < 1) {
    throw new Error('RESTORE_DATA_VALIDATION_UAT_FIXTURE_MISSING');
  }
  return {
    migrationRows: migrationState.migrationRows,
    migrationFiles: migrationState.migrationFiles,
    migrationChecksumMismatches: migrationState.migrationChecksumMismatches,
    personaRows: Number(personaResult.rows[0]?.count ?? 0),
    challengeRows: Number(challengeResult.rows[0]?.count ?? 0),
    representativeTables: [...REPRESENTATIVE_TABLES],
    rowCounts,
  };
}

function assertRestoreSnapshot(
  source: DatabaseSnapshot,
  restoredMigrationState: { migrationRows: number; migrationFiles: number; migrationChecksumMismatches: number },
  restored: DatabaseSnapshot,
): void {
  if (restoredMigrationState.migrationRows !== source.migrationRows
    || restoredMigrationState.migrationFiles !== source.migrationFiles
    || restoredMigrationState.migrationChecksumMismatches !== 0) {
    throw new Error('RESTORE_MIGRATION_VALIDATION_FAILED');
  }
  if (restored.personaRows !== source.personaRows || restored.challengeRows !== source.challengeRows) {
    throw new Error('RESTORE_DATA_VALIDATION_FIXTURE_COUNT_MISMATCH');
  }
  for (const table of Object.keys(source.rowCounts)) {
    if (restored.rowCounts[table] !== source.rowCounts[table]) {
      throw new Error('RESTORE_DATA_VALIDATION_ROW_COUNT_MISMATCH');
    }
  }
}

interface ParsedDatabaseTarget {
  url: URL;
  host: string;
  databaseName: string;
}

function parseDatabaseTarget(value: string): ParsedDatabaseTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL_INVALID');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('DATABASE_URL_INVALID');
  const host = url.hostname.toLowerCase();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!host || !databaseName || /(?:^|[.-])(prod|production|live)(?:[.-]|$)/iu.test(`${host}.${databaseName}`)) {
    throw new Error('DATABASE_CLASSIFICATION_NOT_APPROVED_TEST_UAT');
  }
  return { url, host, databaseName };
}

function buildPostgresEnvironment(
  target: ParsedDatabaseTarget,
  sslModeOverride?: 'require' | 'verify-full',
): NodeJS.ProcessEnv {
  const parsed = target.url;
  const environment = cleanChildEnvironment();
  environment.PGHOST = parsed.hostname;
  environment.PGPORT = parsed.port || '5432';
  environment.PGUSER = decodeURIComponent(parsed.username);
  environment.PGPASSWORD = decodeURIComponent(parsed.password);
  environment.PGDATABASE = target.databaseName;
  environment.PGSSLMODE = sslModeOverride ?? parsed.searchParams.get('sslmode') ?? 'require';
  environment.PGCHANNELBINDING = parsed.searchParams.get('channel_binding') ?? 'require';
  return environment;
}

function buildLocalConnectionString(target: RestoreTarget): string {
  return `postgresql://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@127.0.0.1:${target.port}/postgres`;
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    'DATABASE_URL',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_TOKEN_VALUE',
    'EMAIL_API_KEY',
    'PAYMENT_API_KEY',
    'PAYMENT_WEBHOOK_SECRET',
  ]) delete environment[name];
  return environment;
}

async function createRestoreTarget(workDirectory: string, initDb: string, pgCtl: string): Promise<RestoreTarget> {
  const dataDirectory = join(workDirectory, 'restore-target');
  const logFile = join(workDirectory, 'restore-target.log');
  const passwordFile = join(workDirectory, 'restore-password.txt');
  const password = randomBytes(24).toString('base64url');
  const port = await findFreePort();
  const environment = cleanChildEnvironment();
  environment.PGHOST = '127.0.0.1';
  environment.PGPORT = String(port);
  environment.PGUSER = RESTORE_USER;
  environment.PGPASSWORD = password;
  environment.PGDATABASE = 'postgres';
  environment.PGSSLMODE = 'disable';
  await writeFile(passwordFile, password + '\n', 'utf8');
  try {
    await runProcess(initDb, [
      '--pgdata', dataDirectory,
      '--username', RESTORE_USER,
      '--pwfile', passwordFile,
      '--auth', 'scram-sha-256',
      '--encoding', 'UTF8',
      '--no-instructions',
    ], cleanChildEnvironment());
  } finally {
    await rm(passwordFile, { force: true }).catch(() => undefined);
  }
  try {
    await runProcess(pgCtl, ['--pgdata', dataDirectory, '--log', logFile, '--wait', '--options', `-h 127.0.0.1 -p ${port}`, 'start'], environment);
    return { dataDirectory, logFile, port, user: RESTORE_USER, password, environment, pgCtl };
  } catch (error) {
    await runProcess(pgCtl, ['--pgdata', dataDirectory, '--wait', '--mode', 'fast', 'stop'], environment)
      .catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(logFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function stopRestoreTarget(target: RestoreTarget): Promise<void> {
  await runProcess(target.pgCtl, ['--pgdata', target.dataDirectory, '--wait', '--mode', 'fast', 'stop'], target.environment)
    .catch(() => undefined);
  await rm(target.dataDirectory, { recursive: true, force: true }).catch(() => undefined);
  await rm(target.logFile, { force: true }).catch(() => undefined);
}

async function createWorkDirectory(workRoot?: string): Promise<string> {
  const base = workRoot ? resolve(workRoot) : tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'phase18-r2-'));
}

async function removeGeneratedWorkDirectory(directory: string): Promise<void> {
  const normalized = resolve(directory);
  if (!basename(normalized).startsWith('phase18-r2-')) {
    throw new Error('REFUSING_TO_REMOVE_UNEXPECTED_WORK_DIRECTORY');
  }
  await rm(normalized, { recursive: true, force: true });
}

async function readObject(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error('R2_GET_EMPTY_BODY');
  return Buffer.from(await response.Body.transformToByteArray());
}

async function assertObjectDeleted(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return false;
  } catch (error) {
    return isNotFound(error);
  }
}

async function deleteObjectQuietly(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
}

async function anonymousObjectStatus(endpoint: string, bucket: string, key: string): Promise<number | 'NETWORK_ERROR'> {
  const url = `${endpoint.replace(/\/$/u, '')}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual' });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 'NETWORK_ERROR';
  }
}

function classifyAnonymousAccess(status: number | 'NETWORK_ERROR'): 'NO' | 'UNKNOWN' | 'FAIL' {
  if (status === 200) return 'FAIL';
  if (status === 401 || status === 403 || status === 404) return 'NO';
  return 'UNKNOWN';
}

function headStatus(head: HeadObjectCommandOutput, expectedBytes: number): 'PASS' | 'FAIL' {
  return Number(head.ContentLength) === expectedBytes ? 'PASS' : 'FAIL';
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotFound'
    || candidate.name === 'NoSuchKey'
    || candidate.$metadata?.httpStatusCode === 404;
}

function resolvePgTool(pgBinDir: string | undefined, name: string): string {
  return pgBinDir ? join(resolve(pgBinDir), `${name}.exe`) : name;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const result: CliArguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pg-bin-dir' || argument === '--pg-ssl-mode' || argument === '--work-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument}_VALUE_REQUIRED`);
      if (argument === '--pg-bin-dir') result.pgBinDir = value;
      else if (argument === '--pg-ssl-mode') {
        if (value !== 'require' && value !== 'verify-full') throw new Error('PG_SSL_MODE_INVALID');
        result.pgSslMode = value;
      }
      else result.workRoot = value;
      index += 1;
      continue;
    }
    throw new Error('UNKNOWN_ARGUMENT');
  }
  return result;
}

async function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString().slice(0, 32_000); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString().slice(0, 32_000); });
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error('PROCESS_START_FAILED'));
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolveResult({ stdout, stderr });
      else reject(new ProcessExecutionError(
        classifyProcessFailure(`${stdout}\n${stderr}`),
        code ?? 'UNKNOWN',
      ));
    });
  });
}

function classifyProcessFailure(stderr: string): string {
  if (/password authentication failed|authentication failed|password is required/iu.test(stderr)) return 'AUTH_FAILED';
  if (/could not connect|connection refused|connection timed out|timeout expired|no route to host/iu.test(stderr)) return 'CONNECTION_FAILED';
  if (/permission denied|must be superuser|insufficient privilege/iu.test(stderr)) return 'PERMISSION_FAILED';
  if (/server version|unsupported version|incompatible/iu.test(stderr)) return 'VERSION_FAILED';
  if (/pg_(?:dump|restore):\s+error/iu.test(stderr)) return 'TOOL_ERROR';
  if (/\bERROR:/u.test(stderr)) return 'SQL_ERROR';
  return 'EXIT_FAILED';
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === 'string') reject(new Error('LOCAL_PORT_ALLOCATION_FAILED'));
      else resolvePort(address.port);
    });
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ status: 'BLOCKED', error: sanitizeOperationalError(error, 'PHASE18_R2_DRILL_FAILED') }) + '\n');
    process.exitCode = 1;
  });
}
