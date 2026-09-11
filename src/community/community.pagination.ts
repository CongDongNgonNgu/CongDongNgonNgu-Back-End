import { randomUUID } from 'node:crypto';
import type { CommunityPostCursor } from './community.types';
import { CommunityValidationError } from './community.normalization';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;

export function encodeCommunityCursor(cursor: CommunityPostCursor): string {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  })).toString('base64url');
}

export function decodeCommunityCursor(input: unknown): CommunityPostCursor | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' || input.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      (decoded as { v?: unknown }).v !== CURSOR_VERSION ||
      typeof (decoded as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (decoded as { id?: unknown }).id !== 'string'
    ) {
      throw invalidCursor();
    }
    const createdAt = new Date((decoded as { createdAt: string }).createdAt);
    const id = (decoded as { id: string }).id;
    if (!Number.isFinite(createdAt.getTime()) || !isUuid(id)) throw invalidCursor();
    return { createdAt, id };
  } catch (error) {
    if (error instanceof CommunityValidationError) throw error;
    throw invalidCursor();
  }
}

function invalidCursor(): CommunityValidationError {
  return new CommunityValidationError('COMMUNITY_INVALID_CURSOR');
}

function isUuid(value: string): boolean {
  void randomUUID;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
