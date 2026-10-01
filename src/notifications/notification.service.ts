import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationActorProjection,
  NotificationIntent,
  NotificationTargetKind,
} from './notification.contracts';
import { NotificationPaginationError, decodeNotificationCursor, encodeNotificationCursor } from './notification.pagination';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationReadFilter,
  type NotificationRepository,
} from './notification.repository';
import { NotificationFailure } from './notification.errors';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface ListNotificationsInput {
  readonly limit?: number;
  readonly status?: NotificationReadFilter;
  readonly cursor?: string;
}

export interface NotificationResponse {
  readonly id: string;
  readonly notificationType: string;
  readonly category: string;
  readonly priority: string;
  readonly actor: NotificationActorProjection;
  readonly target: {
    readonly kind: NotificationTargetKind;
    readonly path: string | null;
  } | null;
  readonly variables: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: string;
  readonly read: boolean;
  readonly readAt: string | null;
}

export interface NotificationListResponse {
  readonly items: NotificationResponse[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

export interface NotificationReadResponse {
  readonly notificationId: string;
  readonly read: true;
  readonly readAt: string;
  readonly updatedAt: string;
}

export interface NotificationReadManyResponse {
  readonly updatedCount: number;
  readonly unreadCount: number;
}

@Injectable()
export class NotificationService {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository) {}

  async publish(intent: NotificationIntent, now = new Date()) {
    return this.repository.claimIntent(intent, now);
  }

  async list(userId: string, input: ListNotificationsInput = {}): Promise<NotificationListResponse> {
    assertUserId(userId);
    const limit = normalizeLimit(input.limit);
    const status = input.status ?? 'ALL';
    let before;
    try {
      before = decodeNotificationCursor(input.cursor, userId, status);
    } catch (error) {
      if (error instanceof NotificationPaginationError) {
        throw new NotificationFailure('NOTIFICATION_INVALID_CURSOR', 400, 'Pagination cursor is invalid');
      }
      throw error;
    }
    const [page, unreadCount] = await Promise.all([
      this.repository.listForUser(userId, { limit, status, before }),
      this.repository.countUnread(userId),
    ]);
    const items = page.items.map(({ record, readState }) => toResponse(record, readState.status === 'READ', readState.readAt));
    const last = items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last
        ? encodeNotificationCursor(userId, status, {
            createdAt: new Date(last.createdAt),
            id: last.id,
          })
        : null,
      unreadCount,
    };
  }

  async unreadCount(userId: string): Promise<{ unreadCount: number }> {
    assertUserId(userId);
    return { unreadCount: await this.repository.countUnread(userId) };
  }

  async markOneRead(userId: string, notificationId: string, now = new Date()): Promise<NotificationReadResponse> {
    assertUserId(userId);
    assertUuid(notificationId, 'NOTIFICATION_INVALID_IDS', 'Notification id is invalid');
    const state = await this.repository.markRead(userId, notificationId, now);
    if (!state) throw new NotificationFailure('NOTIFICATION_NOT_FOUND', 404, 'Notification is not available');
    return {
      notificationId: state.notificationId,
      read: true,
      readAt: state.readAt!,
      updatedAt: state.updatedAt,
    };
  }

  async markManyRead(
    userId: string,
    notificationIds: readonly string[],
    now = new Date(),
  ): Promise<NotificationReadManyResponse> {
    assertUserId(userId);
    if (
      !Array.isArray(notificationIds) ||
      notificationIds.length < 1 ||
      notificationIds.length > 100 ||
      notificationIds.some((id) => !isUuidV4(id))
    ) {
      throw new NotificationFailure('NOTIFICATION_INVALID_IDS', 400, 'Notification ids are invalid');
    }
    const uniqueIds = [...new Set(notificationIds)];
    const result = await this.repository.markManyRead(userId, uniqueIds, now);
    return {
      updatedCount: result.updatedCount,
      unreadCount: await this.repository.countUnread(userId),
    };
  }
}

function toResponse(
  record: import('./notification.contracts').NotificationRecord,
  read: boolean,
  readAt: string | null,
): NotificationResponse {
  return {
    id: record.id,
    notificationType: record.notificationType,
    category: record.category,
    priority: record.priority,
    actor: cloneJson(record.actor),
    target: record.target
      ? { kind: record.target.kind, path: record.target.path }
      : null,
    variables: cloneJson(record.variables),
    createdAt: record.createdAt,
    read,
    readAt,
  };
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new NotificationFailure('NOTIFICATION_INVALID_LIMIT', 400, 'Page size is invalid');
  }
  return limit;
}

function assertUserId(userId: string): void {
  assertUuid(userId, 'NOTIFICATION_INVALID_OWNER', 'Notification owner is invalid');
}

function assertUuid(value: string, code: 'NOTIFICATION_INVALID_OWNER' | 'NOTIFICATION_INVALID_IDS', message: string): void {
  if (!isUuidV4(value)) throw new NotificationFailure(code, 400, message);
}

function isUuidV4(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
