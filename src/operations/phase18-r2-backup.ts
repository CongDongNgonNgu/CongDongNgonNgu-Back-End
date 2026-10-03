import { createHash } from 'node:crypto';

export interface R2BackupEnvironment {
  NODE_ENV?: string;
  STORAGE_PROVIDER?: string;
  STORAGE_API_URL?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_BUCKET?: string;
}

export interface R2BackupConfiguration {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: 'auto';
}

export interface BackupMetadata {
  format: 'phase18-uat-postgresql-backup-v1';
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  pgDumpVersion: string;
  migrationRows: number;
}

const R2_S3_HOST = /(^|\.)r2\.cloudflarestorage\.com$/i;
const SAFE_SUFFIX = /^[A-Za-z0-9-]+$/;

export function validateR2Configuration(
  environment: R2BackupEnvironment,
): R2BackupConfiguration {
  const nodeEnvironment = (environment.NODE_ENV ?? 'development').trim().toLowerCase();
  if (nodeEnvironment === 'production') {
    throw new Error('R2 backup is TEST/UAT only');
  }
  if (environment.STORAGE_PROVIDER?.trim().toLowerCase() !== 'r2') {
    throw new Error('STORAGE_PROVIDER=r2 is required');
  }

  const endpoint = requireValue(environment.STORAGE_API_URL, 'STORAGE_API_URL');
  const accessKeyId = requireValue(environment.STORAGE_ACCESS_KEY_ID, 'STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = requireValue(environment.STORAGE_SECRET_ACCESS_KEY, 'STORAGE_SECRET_ACCESS_KEY');
  const bucket = requireValue(environment.STORAGE_BUCKET, 'STORAGE_BUCKET');

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error('STORAGE_API_URL must be a valid HTTPS R2 S3 endpoint');
  }
  if (parsedEndpoint.protocol !== 'https:' || !R2_S3_HOST.test(parsedEndpoint.hostname)) {
    throw new Error('STORAGE_API_URL must use an R2 S3 endpoint');
  }
  if (parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) {
    throw new Error('STORAGE_API_URL must not contain credentials or query values');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(bucket)) {
    throw new Error('STORAGE_BUCKET contains unsupported characters');
  }

  return {
    endpoint: parsedEndpoint.toString().replace(/\/$/, ''),
    accessKeyId,
    secretAccessKey,
    bucket,
    region: 'auto',
  };
}

export function buildR2ObjectKey(
  kind: 'verification' | 'backup',
  timestamp: Date,
  suffix: string,
): string {
  if (!SAFE_SUFFIX.test(suffix)) throw new Error('R2 object suffix is invalid');
  const iso = timestamp.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '/');
  const compactTimestamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace(' ', '').replace('T', 'T');
  if (kind === 'verification') return `phase18-verification/${suffix}/probe.bin`;
  return `backups/uat/database/${date}/congdongngonngu-uat-${compactTimestamp}-${suffix}.dump`;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildBackupMetadata(input: Omit<BackupMetadata, 'format'>): BackupMetadata {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('Backup SHA-256 must be lowercase hexadecimal');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new Error('Backup size must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.migrationRows) || input.migrationRows < 0) {
    throw new Error('Migration row count must be a non-negative safe integer');
  }
  return { format: 'phase18-uat-postgresql-backup-v1', ...input };
}

export function sanitizeOperationalError(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const safeCode = /^[A-Z0-9_.-]{1,80}$/.test(code) ? ` (${code})` : '';
  const message = error instanceof Error ? error.message : '';
  const safeMessage = /^[A-Z0-9_.-]{1,120}$/.test(message) ? ` (${message})` : '';
  return `${fallback}${safeCode || safeMessage}`;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
