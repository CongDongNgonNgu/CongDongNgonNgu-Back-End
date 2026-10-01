import { Inject, Injectable } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';
import type {
  NotificationRecord,
  NotificationReadState,
} from './notification.contracts';
import { NotificationFailure } from './notification.errors';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepository,
} from './notification.repository';
import { toNotificationResponse, type NotificationResponse } from './notification.projection';

type ReplayUnavailableReason = 'LAST_EVENT_NOT_AVAILABLE' | 'REPLAY_WINDOW_EXCEEDED' | 'LIVE_QUEUE_OVERFLOW';

export type NotificationRealtimeEvent =
  | {
      readonly type: 'ready';
      readonly data: {
        readonly protocolVersion: 1;
        readonly replay: 'NOT_REQUESTED' | 'AVAILABLE' | 'UNAVAILABLE';
        readonly retryAfterMs: number;
      };
      readonly retry: number;
    }
  | {
      readonly id: string;
      readonly type: 'notification';
      readonly data: NotificationResponse;
    }
  | {
      readonly type: 'replay-unavailable';
      readonly data: {
        readonly reason: ReplayUnavailableReason;
        readonly fallback: 'POLL_NOTIFICATIONS';
        readonly pollPath: '/notifications';
      };
    }
  | {
      readonly type: 'keepalive';
      readonly data: '';
    };

interface NotificationSubscriber {
  readonly userId: string;
  readonly observer: Subscriber<NotificationRealtimeEvent>;
  readonly seenNotificationIds: Set<string>;
  readonly pendingRecords: NotificationRecord[];
  replaying: boolean;
  pendingOverflow: boolean;
  heartbeat: ReturnType<typeof setInterval>;
}

const MAX_REPLAY_EVENTS = 100;
const MAX_CONNECTIONS_PER_USER = 10;
const MAX_SEEN_EVENT_IDS = 256;
const MAX_PENDING_RECORDS = MAX_REPLAY_EVENTS;
const HEARTBEAT_INTERVAL_MS = 25_000;
const INITIAL_RETRY_MS = 1_000;

@Injectable()
export class NotificationRealtimeService {
  private readonly subscribersByUser = new Map<string, Set<NotificationSubscriber>>();

  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository) {}

  stream(userId: string, lastEventId?: string): Observable<NotificationRealtimeEvent> {
    assertUuid(userId, 'NOTIFICATION_INVALID_OWNER', 'Notification owner is invalid');
    const normalizedLastEventId = normalizeLastEventId(lastEventId);

    return new Observable<NotificationRealtimeEvent>((observer) => {
      const subscribers = this.subscribersByUser.get(userId);
      if (subscribers && subscribers.size >= MAX_CONNECTIONS_PER_USER) {
        observer.error(new NotificationFailure(
          'NOTIFICATION_STREAM_LIMIT',
          429,
          'Too many notification connections',
        ));
        return undefined;
      }

      const connection: NotificationSubscriber = {
        userId,
        observer,
        seenNotificationIds: new Set(normalizedLastEventId ? [normalizedLastEventId] : []),
        pendingRecords: [],
        replaying: Boolean(normalizedLastEventId),
        pendingOverflow: false,
        heartbeat: setInterval(() => {
          if (!observer.closed) observer.next({ type: 'keepalive', data: '' });
        }, HEARTBEAT_INTERVAL_MS),
      };
      connection.heartbeat.unref?.();
      this.addSubscriber(connection);
      void this.replay(connection, normalizedLastEventId);
      return () => this.removeSubscriber(connection);
    });
  }

  publish(record: NotificationRecord): void {
    for (const subscriber of this.subscribersByUser.get(record.recipientUserId) ?? []) {
      if (subscriber.replaying) {
        if (subscriber.pendingRecords.length < MAX_PENDING_RECORDS) subscriber.pendingRecords.push(record);
        else subscriber.pendingOverflow = true;
        continue;
      }
      this.emitRecord(subscriber, record);
    }
  }

  private async replay(connection: NotificationSubscriber, lastEventId: string | undefined): Promise<void> {
    try {
      let replay: 'NOT_REQUESTED' | 'AVAILABLE' | 'UNAVAILABLE' = 'NOT_REQUESTED';
      let replayed: { readonly record: NotificationRecord; readonly readState: NotificationReadState }[] = [];
      let replayHasMore = false;
      if (lastEventId) {
        const cursor = await this.repository.findNotificationCursorForUser(connection.userId, lastEventId);
        if (!cursor) {
          replay = 'UNAVAILABLE';
        } else {
          replay = 'AVAILABLE';
          const replayPage = await this.repository.listForUserAfter(connection.userId, cursor, MAX_REPLAY_EVENTS);
          replayed = replayPage.items;
          replayHasMore = replayPage.hasMore;
        }
      }

      if (connection.observer.closed) return;
      connection.observer.next({
        type: 'ready',
        data: {
          protocolVersion: 1,
          replay,
          retryAfterMs: INITIAL_RETRY_MS,
        },
        retry: INITIAL_RETRY_MS,
      });

      if (replay === 'UNAVAILABLE') {
        this.emitReplayUnavailable(connection, 'LAST_EVENT_NOT_AVAILABLE');
      } else {
        for (const item of replayed) {
          if (connection.observer.closed) return;
          this.emitRecord(connection, item.record, item.readState);
        }
        if (replayHasMore) this.emitReplayUnavailable(connection, 'REPLAY_WINDOW_EXCEEDED');
      }
      connection.replaying = false;
      if (connection.pendingOverflow) {
        this.emitReplayUnavailable(connection, 'LIVE_QUEUE_OVERFLOW');
        connection.pendingRecords.length = 0;
      }
      const pending = connection.pendingRecords.splice(0);
      for (const record of pending) {
        if (connection.observer.closed) return;
        this.emitRecord(connection, record);
      }
    } catch (error) {
      if (!connection.observer.closed) connection.observer.error(error);
    }
  }

  private emitReplayUnavailable(connection: NotificationSubscriber, reason: ReplayUnavailableReason): void {
    if (connection.observer.closed) return;
    connection.observer.next({
      type: 'replay-unavailable',
      data: {
        reason,
        fallback: 'POLL_NOTIFICATIONS',
        pollPath: '/notifications',
      },
    });
  }

  private addSubscriber(connection: NotificationSubscriber): void {
    const subscribers = this.subscribersByUser.get(connection.userId) ?? new Set<NotificationSubscriber>();
    subscribers.add(connection);
    this.subscribersByUser.set(connection.userId, subscribers);
  }

  private removeSubscriber(connection: NotificationSubscriber): void {
    clearInterval(connection.heartbeat);
    const subscribers = this.subscribersByUser.get(connection.userId);
    if (!subscribers) return;
    subscribers.delete(connection);
    if (subscribers.size === 0) this.subscribersByUser.delete(connection.userId);
  }

  private emitRecord(
    connection: NotificationSubscriber,
    record: NotificationRecord,
    readState?: NotificationReadState,
  ): void {
    if (connection.observer.closed || connection.seenNotificationIds.has(record.id)) return;
    connection.seenNotificationIds.add(record.id);
    if (connection.seenNotificationIds.size > MAX_SEEN_EVENT_IDS) {
      const oldest = connection.seenNotificationIds.values().next().value as string | undefined;
      if (oldest) connection.seenNotificationIds.delete(oldest);
    }
    connection.observer.next({
      id: record.id,
      type: 'notification',
      data: toNotificationResponse(record, readState?.status === 'READ', readState?.readAt ?? null),
    });
  }
}

function normalizeLastEventId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 100 || !isUuidV4(value)) {
    throw new NotificationFailure('NOTIFICATION_INVALID_STREAM_CURSOR', 400, 'Last event id is invalid');
  }
  return value;
}

function assertUuid(
  value: string,
  code: 'NOTIFICATION_INVALID_OWNER',
  message: string,
): void {
  if (!isUuidV4(value)) throw new NotificationFailure(code, 400, message);
}

function isUuidV4(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
