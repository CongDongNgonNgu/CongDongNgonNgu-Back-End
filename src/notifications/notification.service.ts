import { Inject, Injectable, Optional } from '@nestjs/common';
import type { NotificationIntent } from './notification.contracts';
import { NotificationPaginationError, decodeNotificationCursor, encodeNotificationCursor } from './notification.pagination';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationReadFilter,
  type NotificationRepository,
} from './notification.repository';
import { NotificationFailure } from './notification.errors';
import { NotificationPreferenceService } from './notification-preference.service';
import { type NotificationResponse } from './notification.projection';
import { NotificationRealtimeService } from './notification-realtime.service';
import { CONNECTION_NOTIFICATION_ACCESS,countCurrentUnread,projectCurrentNotification,type ConnectionNotificationAccess } from './connection-notification-access';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface ListNotificationsInput {
  readonly limit?: number;
  readonly status?: NotificationReadFilter;
  readonly cursor?: string;
}

export type { NotificationResponse } from './notification.projection';

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
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository,
    @Optional() private readonly realtime?: NotificationRealtimeService,
    @Optional() private readonly preferences?: NotificationPreferenceService,
    @Optional() @Inject(CONNECTION_NOTIFICATION_ACCESS) private readonly connectionAccess?:ConnectionNotificationAccess,
  ) {}

  async publish(intent: NotificationIntent, now = new Date()) {
    const claim = await this.repository.claimIntent(intent, now);
    if (claim.outcome === 'CREATED' && this.realtime && await this.isRealtimeEnabled(intent)) {
      this.realtime.publish(claim.record);
    }
    return claim;
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
      countCurrentUnread(userId,this.repository,this.connectionAccess),
    ]);
    const items = await Promise.all(page.items.map(async({record,readState})=>
      (await projectCurrentNotification(record,readState.status==='READ',readState.readAt,this.connectionAccess)).response));
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
    return { unreadCount: await countCurrentUnread(userId,this.repository,this.connectionAccess) };
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
      unreadCount: await countCurrentUnread(userId,this.repository,this.connectionAccess),
    };
  }

  private async isRealtimeEnabled(intent: NotificationIntent): Promise<boolean> {
    if (!this.preferences) return true;
    return this.preferences.isChannelEnabled(intent.recipient.userId, {
      category: intent.category,
      channel: 'SSE',
      notificationType: intent.notificationType,
    });
  }
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
