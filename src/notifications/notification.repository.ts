import { randomUUID } from 'node:crypto';
import {
  hashNotificationIntent,
  validateNotificationIntent,
} from './notification.contracts';
import type {
  NotificationIntent,
  NotificationReadState,
  NotificationRecord,
} from './notification.contracts';

export const NOTIFICATION_REPOSITORY = 'NOTIFICATION_REPOSITORY';

export type NotificationReadFilter = 'ALL' | 'UNREAD';

export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface NotificationListQuery {
  readonly limit: number;
  readonly status: NotificationReadFilter;
  readonly before?: NotificationCursor;
}

export interface NotificationRecordWithReadState {
  readonly record: NotificationRecord;
  readonly readState: NotificationReadState;
}

export interface NotificationPage {
  readonly items: NotificationRecordWithReadState[];
  readonly hasMore: boolean;
}

export type NotificationIntentClaim =
  | { readonly outcome: 'CREATED'; readonly record: NotificationRecord }
  | { readonly outcome: 'REPLAYED'; readonly record: NotificationRecord }
  | {
      readonly outcome: 'CONFLICT';
      readonly code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT';
      readonly deduplicationKey: string;
    };

export interface MarkManyReadResult {
  readonly updatedCount: number;
}

export interface NotificationRepository {
  claimIntent(intent: NotificationIntent, now?: Date): Promise<NotificationIntentClaim>;
  listForUser(userId: string, query: NotificationListQuery): Promise<NotificationPage>;
  countUnread(userId: string): Promise<number>;
  markRead(userId: string, notificationId: string, now: Date): Promise<NotificationReadState | null>;
  markManyRead(userId: string, notificationIds: readonly string[], now: Date): Promise<MarkManyReadResult>;
}

interface StoredNotification {
  readonly record: NotificationRecord;
  readonly fingerprint: string;
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly entriesByDeduplicationKey = new Map<string, StoredNotification>();
  private readonly readStates = new Map<string, NotificationReadState>();

  async claimIntent(intent: NotificationIntent, now = new Date()): Promise<NotificationIntentClaim> {
    const validated = validateNotificationIntent(intent);
    const fingerprint = hashNotificationIntent(validated);
    const existing = this.entriesByDeduplicationKey.get(validated.deduplicationKey);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        return { outcome: 'REPLAYED', record: cloneRecord(existing.record) };
      }
      return {
        outcome: 'CONFLICT',
        code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
        deduplicationKey: validated.deduplicationKey,
      };
    }

    const record = createNotificationRecord(validated);
    this.entriesByDeduplicationKey.set(validated.deduplicationKey, { record, fingerprint });
    this.readStates.set(record.id, {
      notificationId: record.id,
      recipientUserId: record.recipientUserId,
      status: 'UNREAD',
      readAt: null,
      updatedAt: now.toISOString(),
    });
    return { outcome: 'CREATED', record: cloneRecord(record) };
  }

  async listForUser(userId: string, query: NotificationListQuery): Promise<NotificationPage> {
    const candidates = [...this.entriesByDeduplicationKey.values()]
      .filter(({ record }) => record.recipientUserId === userId)
      .filter(({ record }) => {
        const state = this.readStates.get(record.id);
        return query.status === 'ALL' || state?.status === 'UNREAD';
      })
      .filter(({ record }) => isBeforeCursor(record, query.before))
      .sort(compareNewestFirst);
    const consumed = candidates.slice(0, query.limit + 1);
    return {
      items: consumed.slice(0, query.limit).map(({ record }) => ({
        record: cloneRecord(record),
        readState: cloneReadState(this.readStates.get(record.id)! ),
      })),
      hasMore: consumed.length > query.limit,
    };
  }

  async countUnread(userId: string): Promise<number> {
    let count = 0;
    for (const { record } of this.entriesByDeduplicationKey.values()) {
      if (record.recipientUserId === userId && this.readStates.get(record.id)?.status === 'UNREAD') count += 1;
    }
    return count;
  }

  async markRead(userId: string, notificationId: string, now: Date): Promise<NotificationReadState | null> {
    const entry = [...this.entriesByDeduplicationKey.values()]
      .find(({ record }) => record.id === notificationId && record.recipientUserId === userId);
    if (!entry) return null;
    const current = this.readStates.get(notificationId);
    if (!current) return null;
    if (current.status === 'UNREAD') {
      const readAt = now.toISOString();
      this.readStates.set(notificationId, {
        ...current,
        status: 'READ',
        readAt,
        updatedAt: readAt,
      });
    }
    return cloneReadState(this.readStates.get(notificationId)!);
  }

  async markManyRead(userId: string, notificationIds: readonly string[], now: Date): Promise<MarkManyReadResult> {
    const requested = new Set(notificationIds);
    let updatedCount = 0;
    for (const { record } of this.entriesByDeduplicationKey.values()) {
      if (record.recipientUserId !== userId || !requested.has(record.id)) continue;
      const state = this.readStates.get(record.id);
      if (!state || state.status === 'READ') continue;
      const readAt = now.toISOString();
      this.readStates.set(record.id, {
        ...state,
        status: 'READ',
        readAt,
        updatedAt: readAt,
      });
      updatedCount += 1;
    }
    return { updatedCount };
  }
}

export function createNotificationRecord(intent: NotificationIntent, id: string = randomUUID()): NotificationRecord {
  const validated = validateNotificationIntent(intent);
  return {
    id,
    intentId: validated.intentId,
    sourceEventId: validated.sourceEvent.eventId,
    recipientUserId: validated.recipient.userId,
    notificationType: validated.notificationType,
    category: validated.category,
    priority: validated.priority,
    actor: cloneJson(validated.actor),
    target: validated.target ? cloneJson(validated.target) : null,
    variables: cloneJson(validated.variables),
    retention: cloneJson(validated.retention),
    createdAt: validated.createdAt,
  };
}

function compareNewestFirst(left: StoredNotification, right: StoredNotification): number {
  const byCreatedAt = Date.parse(right.record.createdAt) - Date.parse(left.record.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return right.record.id.localeCompare(left.record.id);
}

function isBeforeCursor(record: NotificationRecord, cursor: NotificationCursor | undefined): boolean {
  if (!cursor) return true;
  const recordTime = Date.parse(record.createdAt);
  const cursorTime = cursor.createdAt.getTime();
  return recordTime < cursorTime || (recordTime === cursorTime && record.id < cursor.id);
}

function cloneRecord(record: NotificationRecord): NotificationRecord {
  return {
    ...record,
    actor: cloneJson(record.actor),
    target: record.target ? cloneJson(record.target) : null,
    variables: cloneJson(record.variables),
    retention: cloneJson(record.retention),
  };
}

function cloneReadState(state: NotificationReadState): NotificationReadState {
  return { ...state };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
