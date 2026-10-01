import type {
  NotificationActorProjection,
  NotificationRecord,
  NotificationTargetKind,
} from './notification.contracts';

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

export function toNotificationResponse(
  record: NotificationRecord,
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
