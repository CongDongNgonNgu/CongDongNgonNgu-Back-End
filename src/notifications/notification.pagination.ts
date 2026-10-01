import { createHash } from 'node:crypto';
import type { NotificationCursor, NotificationReadFilter } from './notification.repository';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;

export class NotificationPaginationError extends Error {
  readonly code = 'NOTIFICATION_INVALID_CURSOR';

  constructor() {
    super('Notification pagination cursor is invalid');
    this.name = 'NotificationPaginationError';
  }
}

export function encodeNotificationCursor(
  userId: string,
  status: NotificationReadFilter,
  cursor: NotificationCursor,
): string {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    owner: ownerHash(userId),
    status,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  })).toString('base64url');
}

export function decodeNotificationCursor(
  input: unknown,
  userId: string,
  status: NotificationReadFilter,
): NotificationCursor | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' || input.length > MAX_CURSOR_LENGTH) throw new NotificationPaginationError();

  try {
    const decoded: unknown = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      (decoded as { v?: unknown }).v !== CURSOR_VERSION ||
      (decoded as { owner?: unknown }).owner !== ownerHash(userId) ||
      (decoded as { status?: unknown }).status !== status ||
      typeof (decoded as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (decoded as { id?: unknown }).id !== 'string'
    ) throw new NotificationPaginationError();

    const createdAtValue = (decoded as { createdAt: string }).createdAt;
    const createdAt = new Date(createdAtValue);
    const id = (decoded as { id: string }).id;
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== createdAtValue ||
      !isUuidV4(id)
    ) throw new NotificationPaginationError();
    return { createdAt, id };
  } catch (error) {
    if (error instanceof NotificationPaginationError) throw error;
    throw new NotificationPaginationError();
  }
}

function ownerHash(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
