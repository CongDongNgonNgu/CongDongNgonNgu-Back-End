import { createHash } from 'node:crypto';
import { LibraryValidationError } from './library.normalization';
import type { LibrarySearchCursor, NormalizedLibrarySearchFilters } from './library.types';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeLibrarySearchCursor(
  cursor: LibrarySearchCursor,
  filters: NormalizedLibrarySearchFilters,
): string {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    updatedAt: cursor.updatedAt.toISOString(),
    id: cursor.id,
    filters: librarySearchFilterFingerprint(filters),
  })).toString('base64url');
}

export function decodeLibrarySearchCursor(
  input: unknown,
  filters: NormalizedLibrarySearchFilters,
): LibrarySearchCursor | undefined {
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
      typeof (decoded as { updatedAt?: unknown }).updatedAt !== 'string' ||
      typeof (decoded as { id?: unknown }).id !== 'string' ||
      typeof (decoded as { filters?: unknown }).filters !== 'string' ||
      (decoded as { filters: string }).filters !== librarySearchFilterFingerprint(filters)
    ) {
      throw invalidCursor();
    }

    const updatedAt = new Date((decoded as { updatedAt: string }).updatedAt);
    const id = (decoded as { id: string }).id;
    if (!Number.isFinite(updatedAt.getTime()) || !UUID_V4_PATTERN.test(id)) {
      throw invalidCursor();
    }
    return { updatedAt, id };
  } catch (error) {
    if (error instanceof LibraryValidationError) throw error;
    throw invalidCursor();
  }
}

export function librarySearchFilterFingerprint(
  filters: NormalizedLibrarySearchFilters,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      filters.q,
      filters.languageCode,
      filters.resourceType,
      filters.topic,
      filters.cefrLevel,
    ]))
    .digest('base64url');
}

function invalidCursor(): LibraryValidationError {
  return new LibraryValidationError('LIBRARY_INVALID_CURSOR');
}
