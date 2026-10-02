import { createHash } from 'node:crypto';

export const NOTIFICATION_DOMAIN_EVENT_VERSION = 1 as const;
export const SUPPORTED_NOTIFICATION_DOMAIN_EVENT_VERSIONS = [
  NOTIFICATION_DOMAIN_EVENT_VERSION,
] as const;

export const NOTIFICATION_DOMAIN_EVENT_TYPES = [
  'community.comment.created',
  'community.response.accepted',
  'exchange.connection.requested',
  'reputation.milestone.achieved',
  'membership.subscription.activated',
  'membership.subscription.expired',
  'membership.payment.fulfilled',
  'moderation.notice.created',
] as const;
export type NotificationDomainEventType = typeof NOTIFICATION_DOMAIN_EVENT_TYPES[number];

export const NOTIFICATION_AGGREGATE_TYPES = [
  'COMMUNITY_POST',
  'COMMUNITY_COMMENT',
  'CORRECTION_RESPONSE',
  'EXCHANGE_CONNECTION',
  'REPUTATION_MILESTONE',
  'MEMBERSHIP_SUBSCRIPTION',
  'SYSTEM',
] as const;
export type NotificationAggregateType = typeof NOTIFICATION_AGGREGATE_TYPES[number];

export const NOTIFICATION_TARGET_KINDS = [
  'COMMUNITY_POST',
  'COMMUNITY_COMMENT',
  'CORRECTION_RESPONSE',
  'EXCHANGE_CONNECTION',
  'REPUTATION_MILESTONE',
  'MEMBERSHIP_SUBSCRIPTION',
  'SYSTEM',
] as const;
export type NotificationTargetKind = typeof NOTIFICATION_TARGET_KINDS[number];

export const NOTIFICATION_TYPES = [
  'COMMENT_REPLY',
  'CORRECTION_ACCEPTED',
  'ANSWER_ACCEPTED',
  'BUDDY_REQUEST',
  'ROOM_INVITE',
  'EVENT_REMINDER',
  'REPUTATION_MILESTONE',
  'MEMBERSHIP_STATE',
  'PAYMENT_STATE',
  'MODERATION_NOTICE',
  'SECURITY_NOTICE',
] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const NOTIFICATION_CATEGORIES = [
  'COMMUNITY',
  'CORRECTIONS',
  'EXCHANGE',
  'REPUTATION',
  'MEMBERSHIP',
  'SECURITY',
  'MODERATION',
  'SYSTEM',
] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

export const NOTIFICATION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type NotificationPriority = typeof NOTIFICATION_PRIORITIES[number];

export const NOTIFICATION_DELIVERY_CHANNELS = ['IN_APP', 'SSE', 'EMAIL', 'PUSH'] as const;
export type NotificationDeliveryChannel = typeof NOTIFICATION_DELIVERY_CHANNELS[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  'PENDING',
  'DELIVERED',
  'FAILED',
  'SKIPPED',
] as const;
export type NotificationDeliveryStatus = typeof NOTIFICATION_DELIVERY_STATUSES[number];

export const NOTIFICATION_READ_STATUSES = ['UNREAD', 'READ'] as const;
export type NotificationReadStatus = typeof NOTIFICATION_READ_STATUSES[number];

export type NotificationScalar = string | number | boolean | null;
export type NotificationSemanticVariables = Readonly<Record<string, NotificationScalar>>;

export interface NotificationTargetReference {
  readonly kind: NotificationTargetKind;
  readonly id: string | null;
  readonly path: string | null;
}

export type NotificationEventActor =
  | { readonly kind: 'USER'; readonly userId: string }
  | { readonly kind: 'SYSTEM'; readonly code: string }
  | { readonly kind: 'PROVIDER'; readonly code: string };

export interface NotificationRecipientBinding {
  readonly authority: 'SOURCE_DOMAIN';
  readonly userId: string;
}

export interface NotificationDomainEventPayload {
  readonly target: NotificationTargetReference | null;
  readonly variables: NotificationSemanticVariables;
}

export interface NotificationDomainEvent {
  readonly eventId: string;
  readonly eventType: NotificationDomainEventType;
  readonly eventVersion: number;
  readonly aggregateType: NotificationAggregateType;
  readonly aggregateId: string;
  readonly actor: NotificationEventActor | null;
  readonly recipient: NotificationRecipientBinding;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly payload: NotificationDomainEventPayload;
}

export type NotificationActorProjection =
  | { readonly kind: 'USER'; readonly displayName: string; readonly profilePath: string | null }
  | { readonly kind: 'SYSTEM'; readonly label: 'System' }
  | { readonly kind: 'PROVIDER'; readonly label: 'Service' }
  | { readonly kind: 'DELETED'; readonly label: 'Deleted member' };

export type NotificationRetentionPolicy =
  | { readonly mode: 'DAYS'; readonly days: number }
  | { readonly mode: 'UNTIL_READ'; readonly maxDays: number }
  | { readonly mode: 'INDEFINITE' };

export interface NotificationIntent {
  readonly intentId: string;
  readonly deduplicationKey: string;
  readonly recipient: NotificationRecipientBinding;
  readonly notificationType: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  readonly actor: NotificationActorProjection;
  readonly target: NotificationTargetReference | null;
  readonly variables: NotificationSemanticVariables;
  readonly retention: NotificationRetentionPolicy;
  readonly createdAt: string;
  readonly sourceEvent: {
    readonly eventId: string;
    readonly eventType: NotificationDomainEventType;
    readonly eventVersion: number;
    readonly aggregateType: NotificationAggregateType;
    readonly aggregateId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
  };
}

/**
 * Canonical notification content is immutable. Read state is deliberately
 * absent so a mark-read operation cannot rewrite notification history.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly intentId: string;
  readonly sourceEventId: string;
  readonly recipientUserId: string;
  readonly notificationType: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  readonly actor: NotificationActorProjection;
  readonly target: NotificationTargetReference | null;
  readonly variables: NotificationSemanticVariables;
  readonly retention: NotificationRetentionPolicy;
  readonly createdAt: string;
}

export interface NotificationReadState {
  readonly notificationId: string;
  readonly recipientUserId: string;
  readonly status: NotificationReadStatus;
  readonly readAt: string | null;
  readonly updatedAt: string;
}

/** Channel adapters own provider details; this contract carries no SDK data. */
export interface NotificationDeliveryAttempt {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: NotificationDeliveryChannel;
  readonly status: NotificationDeliveryStatus;
  readonly attemptNumber: number;
  readonly failureCode: string | null;
  readonly attemptedAt: string | null;
  readonly nextAttemptAt: string | null;
}

export type NotificationContractErrorCode =
  | 'INVALID_EVENT'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'UNSUPPORTED_EVENT_VERSION'
  | 'INVALID_EVENT_PAYLOAD'
  | 'INVALID_ACTOR'
  | 'INVALID_RECIPIENT'
  | 'RECIPIENT_AUTHORITY_INVALID'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_IDEMPOTENCY'
  | 'INVALID_TARGET'
  | 'INVALID_NOTIFICATION_INTENT'
  | 'INVALID_READ_STATE'
  | 'INVALID_DELIVERY_ATTEMPT'
  | 'NOTIFICATION_IDEMPOTENCY_CONFLICT';

const SAFE_ERROR_MESSAGES: Readonly<Record<NotificationContractErrorCode, string>> = {
  INVALID_EVENT: 'Notification event is invalid',
  UNSUPPORTED_EVENT_TYPE: 'Notification event type is unsupported',
  UNSUPPORTED_EVENT_VERSION: 'Notification event version is unsupported',
  INVALID_EVENT_PAYLOAD: 'Notification event payload is invalid',
  INVALID_ACTOR: 'Notification actor is invalid',
  INVALID_RECIPIENT: 'Notification recipient is invalid',
  RECIPIENT_AUTHORITY_INVALID: 'Notification recipient authority is invalid',
  INVALID_TIMESTAMP: 'Notification timestamp is invalid',
  INVALID_IDEMPOTENCY: 'Notification idempotency identity is invalid',
  INVALID_TARGET: 'Notification target is invalid',
  INVALID_NOTIFICATION_INTENT: 'Notification intent is invalid',
  INVALID_READ_STATE: 'Notification read state is invalid',
  INVALID_DELIVERY_ATTEMPT: 'Notification delivery attempt is invalid',
  NOTIFICATION_IDEMPOTENCY_CONFLICT: 'Notification idempotency identity conflicts with existing facts',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u;
const SAFE_IDEMPOTENCY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/u;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9/_:.-]{0,239}$/u;
const SAFE_VARIABLE_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/u;
const SENSITIVE_VARIABLE_KEY_PATTERN = /(password|secret|token|api[_-]?key|raw|payload|signature|webhook|provider|connection.?string|credit.?card|payment.?reference|amount.?minor)/iu;
const MAX_VARIABLE_COUNT = 12;
const MAX_VARIABLE_VALUE_LENGTH = 256;
const MAX_VARIABLE_TOTAL_LENGTH = 2_048;
const MAX_RETENTION_DAYS = 3_650;

export class NotificationContractError extends Error {
  readonly name = 'NotificationContractError';

  constructor(readonly code: NotificationContractErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
  }
}

export function validateNotificationDomainEvent(value: unknown): NotificationDomainEvent {
  const root = asRecord(value, 'INVALID_EVENT');
  assertExactKeys(
    root,
    [
      'eventId',
      'eventType',
      'eventVersion',
      'aggregateType',
      'aggregateId',
      'actor',
      'recipient',
      'occurredAt',
      'correlationId',
      'causationId',
      'idempotencyKey',
      'payload',
    ],
    'INVALID_EVENT',
  );

  if (!isNotificationDomainEventType(root.eventType)) {
    throw contractError('UNSUPPORTED_EVENT_TYPE');
  }
  const eventVersion = root.eventVersion;
  if (typeof eventVersion !== 'number' || !Number.isSafeInteger(eventVersion)) {
    throw contractError('INVALID_EVENT');
  }
  if (!(SUPPORTED_NOTIFICATION_DOMAIN_EVENT_VERSIONS as readonly number[]).includes(eventVersion)) {
    throw contractError('UNSUPPORTED_EVENT_VERSION');
  }

  const eventId = requireUuid(root.eventId, 'INVALID_EVENT');
  const aggregateType = requireEnum(
    root.aggregateType,
    NOTIFICATION_AGGREGATE_TYPES,
    'INVALID_EVENT',
  );
  const aggregateId = requireUuid(root.aggregateId, 'INVALID_EVENT');
  const actor = parseEventActor(root.actor);
  const recipient = parseRecipient(root.recipient);
  const occurredAt = requireTimestamp(root.occurredAt);
  const correlationId = requireUuid(root.correlationId, 'INVALID_EVENT');
  const causationId = root.causationId === null
    ? null
    : requireUuid(root.causationId, 'INVALID_EVENT');
  const idempotencyKey = parseIdempotencyKey(root.idempotencyKey);
  const payload = parseEventPayload(root.payload);

  return deepFreeze({
    eventId,
    eventType: root.eventType,
    eventVersion,
    aggregateType,
    aggregateId,
    actor,
    recipient,
    occurredAt,
    correlationId,
    causationId,
    idempotencyKey,
    payload,
  });
}

export function serializeNotificationDomainEvent(event: NotificationDomainEvent): string {
  return stableStringify(validateNotificationDomainEvent(event));
}

export function deserializeNotificationDomainEvent(serialized: string): NotificationDomainEvent {
  if (typeof serialized !== 'string' || serialized.length === 0 || serialized.length > 50_000) {
    throw contractError('INVALID_EVENT');
  }
  try {
    return validateNotificationDomainEvent(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof NotificationContractError) throw error;
    throw contractError('INVALID_EVENT');
  }
}

export function normalizeNotificationActorProjection(value: unknown): NotificationActorProjection {
  const root = asRecord(value, 'INVALID_ACTOR');
  if (root.kind === 'USER') {
    assertExactKeys(root, ['kind', 'displayName', 'profilePath'], 'INVALID_ACTOR', ['profilePath']);
    const displayName = normalizeDisplayName(root.displayName);
    const profilePath = root.profilePath === undefined || root.profilePath === null
      ? null
      : parseInternalPath(root.profilePath, 'INVALID_ACTOR');
    return deepFreeze({ kind: 'USER', displayName, profilePath });
  }
  if (root.kind === 'SYSTEM') {
    assertExactKeys(root, ['kind'], 'INVALID_ACTOR', ['label']);
    if (root.label !== undefined && root.label !== 'System') throw contractError('INVALID_ACTOR');
    return deepFreeze({ kind: 'SYSTEM', label: 'System' as const });
  }
  if (root.kind === 'PROVIDER') {
    assertExactKeys(root, ['kind'], 'INVALID_ACTOR', ['label']);
    if (root.label !== undefined && root.label !== 'Service') throw contractError('INVALID_ACTOR');
    return deepFreeze({ kind: 'PROVIDER', label: 'Service' as const });
  }
  if (root.kind === 'DELETED') {
    assertExactKeys(root, ['kind'], 'INVALID_ACTOR', ['label']);
    if (root.label !== undefined && root.label !== 'Deleted member') throw contractError('INVALID_ACTOR');
    return deepFreeze({ kind: 'DELETED', label: 'Deleted member' as const });
  }
  throw contractError('INVALID_ACTOR');
}

export function validateNotificationRetentionPolicy(value: unknown): NotificationRetentionPolicy {
  const root = asRecord(value, 'INVALID_NOTIFICATION_INTENT');
  if (root.mode === 'INDEFINITE') {
    assertExactKeys(root, ['mode'], 'INVALID_NOTIFICATION_INTENT');
    return deepFreeze({ mode: 'INDEFINITE' as const });
  }
  if (root.mode === 'DAYS') {
    assertExactKeys(root, ['mode', 'days'], 'INVALID_NOTIFICATION_INTENT');
    const days = boundedPositiveInteger(root.days, MAX_RETENTION_DAYS, 'INVALID_NOTIFICATION_INTENT');
    return deepFreeze({ mode: 'DAYS' as const, days });
  }
  if (root.mode === 'UNTIL_READ') {
    assertExactKeys(root, ['mode', 'maxDays'], 'INVALID_NOTIFICATION_INTENT');
    const maxDays = boundedPositiveInteger(root.maxDays, MAX_RETENTION_DAYS, 'INVALID_NOTIFICATION_INTENT');
    return deepFreeze({ mode: 'UNTIL_READ' as const, maxDays });
  }
  throw contractError('INVALID_NOTIFICATION_INTENT');
}

export interface CreateNotificationIntentInput {
  readonly event: NotificationDomainEvent;
  readonly notificationType: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  readonly actor: unknown;
  readonly retention: unknown;
}

export function createNotificationIntent(input: CreateNotificationIntentInput): NotificationIntent {
  const event = validateNotificationDomainEvent(input.event);
  const notificationType = requireEnum(input.notificationType, NOTIFICATION_TYPES, 'INVALID_NOTIFICATION_INTENT');
  const category = requireEnum(input.category, NOTIFICATION_CATEGORIES, 'INVALID_NOTIFICATION_INTENT');
  const priority = requireEnum(input.priority, NOTIFICATION_PRIORITIES, 'INVALID_NOTIFICATION_INTENT');
  const actor = normalizeNotificationActorProjection(input.actor);
  const retention = validateNotificationRetentionPolicy(input.retention);
  const deduplicationKey = [
    'notification-intent-v1',
    event.eventId,
    event.eventVersion,
    event.eventType,
    event.recipient.userId,
    notificationType,
  ].join(':');
  const sourceEvent = {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    idempotencyKey: event.idempotencyKey,
    payloadHash: sha256(stableStringify(event)),
  } as const;

  return deepFreeze({
    intentId: sha256(deduplicationKey),
    deduplicationKey,
    recipient: event.recipient,
    notificationType,
    category,
    priority,
    actor,
    target: event.payload.target,
    variables: event.payload.variables,
    retention,
    createdAt: event.occurredAt,
    sourceEvent,
  });
}

export function validateNotificationIntent(value: unknown): NotificationIntent {
  const root = asRecord(value, 'INVALID_NOTIFICATION_INTENT');
  assertExactKeys(
    root,
    [
      'intentId',
      'deduplicationKey',
      'recipient',
      'notificationType',
      'category',
      'priority',
      'actor',
      'target',
      'variables',
      'retention',
      'createdAt',
      'sourceEvent',
    ],
    'INVALID_NOTIFICATION_INTENT',
  );
  if (typeof root.intentId !== 'string' || !/^[0-9a-f]{64}$/u.test(root.intentId)) {
    throw contractError('INVALID_NOTIFICATION_INTENT');
  }
  const deduplicationKey = root.deduplicationKey;
  if (typeof deduplicationKey !== 'string' || deduplicationKey.length > 300) {
    throw contractError('INVALID_NOTIFICATION_INTENT');
  }
  if (root.intentId !== sha256(deduplicationKey)) {
    throw contractError('INVALID_NOTIFICATION_INTENT');
  }
  const recipient = parseRecipient(root.recipient, 'INVALID_NOTIFICATION_INTENT');
  const notificationType = requireEnum(root.notificationType, NOTIFICATION_TYPES, 'INVALID_NOTIFICATION_INTENT');
  const category = requireEnum(root.category, NOTIFICATION_CATEGORIES, 'INVALID_NOTIFICATION_INTENT');
  const priority = requireEnum(root.priority, NOTIFICATION_PRIORITIES, 'INVALID_NOTIFICATION_INTENT');
  const actor = normalizeNotificationActorProjection(root.actor);
  const target = parseTarget(root.target, 'INVALID_NOTIFICATION_INTENT');
  const variables = parseVariables(root.variables, 'INVALID_NOTIFICATION_INTENT');
  const retention = validateNotificationRetentionPolicy(root.retention);
  const createdAt = requireTimestamp(root.createdAt, 'INVALID_NOTIFICATION_INTENT');
  const sourceEvent = parseIntentSourceEvent(root.sourceEvent);

  return deepFreeze({
    intentId: root.intentId,
    deduplicationKey,
    recipient,
    notificationType,
    category,
    priority,
    actor,
    target,
    variables,
    retention,
    createdAt,
    sourceEvent,
  });
}

export function serializeNotificationIntent(intent: NotificationIntent): string {
  return stableStringify(validateNotificationIntent(intent));
}

export function hashNotificationIntent(intent: NotificationIntent): string {
  return sha256(serializeNotificationIntent(intent));
}

export type NotificationIntentClaim =
  | { readonly outcome: 'CREATED'; readonly intent: NotificationIntent }
  | { readonly outcome: 'REPLAYED'; readonly intent: NotificationIntent }
  | {
      readonly outcome: 'CONFLICT';
      readonly code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT';
      readonly deduplicationKey: string;
    };

/**
 * Deterministic local harness for the claim/replay/conflict contract. It is
 * intentionally not a persistence implementation; 12B owns that boundary.
 */
export class InMemoryNotificationIntentRegistry {
  private readonly entries = new Map<string, { intent: NotificationIntent; fingerprint: string }>();

  claim(input: NotificationIntent): NotificationIntentClaim {
    const intent = validateNotificationIntent(input);
    const fingerprint = sha256(stableStringify(intent));
    const existing = this.entries.get(intent.deduplicationKey);
    if (!existing) {
      this.entries.set(intent.deduplicationKey, { intent, fingerprint });
      return { outcome: 'CREATED', intent };
    }
    if (existing.fingerprint === fingerprint) {
      return { outcome: 'REPLAYED', intent: existing.intent };
    }
    return {
      outcome: 'CONFLICT',
      code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
      deduplicationKey: intent.deduplicationKey,
    };
  }
}

export function validateNotificationReadState(value: unknown): NotificationReadState {
  const root = asRecord(value, 'INVALID_READ_STATE');
  assertExactKeys(root, ['notificationId', 'recipientUserId', 'status', 'readAt', 'updatedAt'], 'INVALID_READ_STATE');
  const notificationId = requireUuid(root.notificationId, 'INVALID_READ_STATE');
  const recipientUserId = requireUuid(root.recipientUserId, 'INVALID_READ_STATE');
  const status = requireEnum(root.status, NOTIFICATION_READ_STATUSES, 'INVALID_READ_STATE');
  const readAt = root.readAt === null ? null : requireTimestamp(root.readAt, 'INVALID_READ_STATE');
  const updatedAt = requireTimestamp(root.updatedAt, 'INVALID_READ_STATE');
  if ((status === 'UNREAD' && readAt !== null) || (status === 'READ' && readAt === null)) {
    throw contractError('INVALID_READ_STATE');
  }
  return deepFreeze({ notificationId, recipientUserId, status, readAt, updatedAt });
}

export function validateNotificationDeliveryAttempt(value: unknown): NotificationDeliveryAttempt {
  const root = asRecord(value, 'INVALID_DELIVERY_ATTEMPT');
  assertExactKeys(
    root,
    ['id', 'notificationId', 'channel', 'status', 'attemptNumber', 'failureCode', 'attemptedAt', 'nextAttemptAt'],
    'INVALID_DELIVERY_ATTEMPT',
  );
  const id = requireUuid(root.id, 'INVALID_DELIVERY_ATTEMPT');
  const notificationId = requireUuid(root.notificationId, 'INVALID_DELIVERY_ATTEMPT');
  const channel = requireEnum(root.channel, NOTIFICATION_DELIVERY_CHANNELS, 'INVALID_DELIVERY_ATTEMPT');
  const status = requireEnum(root.status, NOTIFICATION_DELIVERY_STATUSES, 'INVALID_DELIVERY_ATTEMPT');
  const attemptNumber = boundedPositiveInteger(root.attemptNumber, 10, 'INVALID_DELIVERY_ATTEMPT');
  const failureCode = root.failureCode === null ? null : parseFailureCode(root.failureCode);
  const attemptedAt = root.attemptedAt === null ? null : requireTimestamp(root.attemptedAt, 'INVALID_DELIVERY_ATTEMPT');
  const nextAttemptAt = root.nextAttemptAt === null ? null : requireTimestamp(root.nextAttemptAt, 'INVALID_DELIVERY_ATTEMPT');
  return deepFreeze({ id, notificationId, channel, status, attemptNumber, failureCode, attemptedAt, nextAttemptAt });
}

export interface SanitizedNotificationError {
  readonly code: string;
  readonly message: string;
}

export function sanitizeNotificationError(error: unknown): SanitizedNotificationError {
  if (error instanceof NotificationContractError) {
    return { code: error.code, message: SAFE_ERROR_MESSAGES[error.code] };
  }
  return {
    code: 'NOTIFICATION_CONTRACT_INVALID',
    message: 'Notification contract is invalid',
  };
}

function parseEventActor(value: unknown): NotificationEventActor | null {
  if (value === null) return null;
  const root = asRecord(value, 'INVALID_ACTOR');
  if (root.kind === 'USER') {
    assertExactKeys(root, ['kind', 'userId'], 'INVALID_ACTOR');
    return deepFreeze({ kind: 'USER', userId: requireUuid(root.userId, 'INVALID_ACTOR') });
  }
  if (root.kind === 'SYSTEM' || root.kind === 'PROVIDER') {
    assertExactKeys(root, ['kind', 'code'], 'INVALID_ACTOR');
    const code = parseSafeCode(root.code, 'INVALID_ACTOR');
    return deepFreeze({ kind: root.kind, code } as NotificationEventActor);
  }
  throw contractError('INVALID_ACTOR');
}

function parseRecipient(value: unknown, invalidCode: NotificationContractErrorCode = 'INVALID_RECIPIENT'): NotificationRecipientBinding {
  const root = asRecord(value, invalidCode);
  assertExactKeys(root, ['authority', 'userId'], invalidCode);
  if (root.authority !== 'SOURCE_DOMAIN') throw contractError('RECIPIENT_AUTHORITY_INVALID');
  return deepFreeze({
    authority: 'SOURCE_DOMAIN' as const,
    userId: requireUuid(root.userId, invalidCode),
  });
}

function parseEventPayload(value: unknown): NotificationDomainEventPayload {
  const root = asRecord(value, 'INVALID_EVENT_PAYLOAD');
  assertExactKeys(root, ['target', 'variables'], 'INVALID_EVENT_PAYLOAD');
  return deepFreeze({
    target: parseTarget(root.target, 'INVALID_EVENT_PAYLOAD'),
    variables: parseVariables(root.variables, 'INVALID_EVENT_PAYLOAD'),
  });
}

function parseTarget(value: unknown, invalidCode: NotificationContractErrorCode): NotificationTargetReference | null {
  if (value === null) return null;
  const root = asRecord(value, invalidCode);
  assertExactKeys(root, ['kind', 'id', 'path'], invalidCode);
  const kind = requireEnum(root.kind, NOTIFICATION_TARGET_KINDS, invalidCode);
  const id = root.id === null ? null : requireUuid(root.id, invalidCode);
  const path = root.path === null ? null : parseInternalPath(root.path, invalidCode);
  if (kind !== 'SYSTEM' && id === null) throw contractError('INVALID_TARGET');
  return deepFreeze({ kind, id, path });
}

function parseVariables(value: unknown, invalidCode: NotificationContractErrorCode): NotificationSemanticVariables {
  const root = asRecord(value, invalidCode);
  const keys = Object.keys(root);
  if (keys.length > MAX_VARIABLE_COUNT) throw contractError(invalidCode);
  let totalLength = 0;
  const variables: Record<string, NotificationScalar> = {};
  for (const key of keys.sort()) {
    if (!SAFE_VARIABLE_KEY_PATTERN.test(key) || SENSITIVE_VARIABLE_KEY_PATTERN.test(key)) {
      throw contractError(invalidCode);
    }
    const valueForKey = root[key];
    if (typeof valueForKey === 'string') {
      if (valueForKey.length > MAX_VARIABLE_VALUE_LENGTH || hasControlCharacters(valueForKey)) {
        throw contractError(invalidCode);
      }
      totalLength += valueForKey.length;
      variables[key] = valueForKey;
    } else if (typeof valueForKey === 'number') {
      if (!Number.isSafeInteger(valueForKey)) throw contractError(invalidCode);
      variables[key] = valueForKey;
    } else if (typeof valueForKey === 'boolean' || valueForKey === null) {
      variables[key] = valueForKey;
    } else {
      throw contractError(invalidCode);
    }
  }
  if (totalLength > MAX_VARIABLE_TOTAL_LENGTH) throw contractError(invalidCode);
  return deepFreeze(variables);
}

function parseIntentSourceEvent(value: unknown): NotificationIntent['sourceEvent'] {
  const root = asRecord(value, 'INVALID_NOTIFICATION_INTENT');
  assertExactKeys(
    root,
    ['eventId', 'eventType', 'eventVersion', 'aggregateType', 'aggregateId', 'idempotencyKey', 'payloadHash'],
    'INVALID_NOTIFICATION_INTENT',
  );
  if (typeof root.payloadHash !== 'string' || !/^[0-9a-f]{64}$/u.test(root.payloadHash)) {
    throw contractError('INVALID_NOTIFICATION_INTENT');
  }
  const eventType = requireEnum(root.eventType, NOTIFICATION_DOMAIN_EVENT_TYPES, 'INVALID_NOTIFICATION_INTENT');
  const eventVersion = root.eventVersion;
  if (
    typeof eventVersion !== 'number' ||
    !Number.isSafeInteger(eventVersion) ||
    !SUPPORTED_NOTIFICATION_DOMAIN_EVENT_VERSIONS.includes(eventVersion as 1)
  ) {
    throw contractError('INVALID_NOTIFICATION_INTENT');
  }
  return deepFreeze({
    eventId: requireUuid(root.eventId, 'INVALID_NOTIFICATION_INTENT'),
    eventType,
    eventVersion,
    aggregateType: requireEnum(root.aggregateType, NOTIFICATION_AGGREGATE_TYPES, 'INVALID_NOTIFICATION_INTENT'),
    aggregateId: requireUuid(root.aggregateId, 'INVALID_NOTIFICATION_INTENT'),
    idempotencyKey: parseIdempotencyKey(root.idempotencyKey, 'INVALID_NOTIFICATION_INTENT'),
    payloadHash: root.payloadHash,
  });
}

function parseIdempotencyKey(value: unknown, code: NotificationContractErrorCode = 'INVALID_IDEMPOTENCY'): string {
  if (typeof value !== 'string' || !SAFE_IDEMPOTENCY_PATTERN.test(value)) throw contractError(code);
  return value;
}

function parseFailureCode(value: unknown): string {
  return parseSafeCode(value, 'INVALID_DELIVERY_ATTEMPT');
}

function parseSafeCode(value: unknown, code: NotificationContractErrorCode): string {
  if (typeof value !== 'string' || !SAFE_CODE_PATTERN.test(value)) throw contractError(code);
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 || hasControlCharacters(value)) {
    throw contractError('INVALID_ACTOR');
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > 120) throw contractError('INVALID_ACTOR');
  return normalized;
}

function parseInternalPath(value: unknown, code: NotificationContractErrorCode): string {
  if (typeof value !== 'string' || !SAFE_PATH_PATTERN.test(value)) throw contractError(code);
  return value;
}

function requireTimestamp(value: unknown, code: NotificationContractErrorCode = 'INVALID_TIMESTAMP'): string {
  if (typeof value !== 'string') throw contractError(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw contractError(code);
  return value;
}

function requireUuid(value: unknown, code: NotificationContractErrorCode): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw contractError(code);
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  maximum: number,
  code: NotificationContractErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw contractError(code);
  }
  return Number(value);
}

function requireEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  code: NotificationContractErrorCode,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) throw contractError(code);
  return value as T[number];
}

function asRecord(value: unknown, code: NotificationContractErrorCode): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw contractError(code);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  code: NotificationContractErrorCode,
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw contractError(code);
  }
}

function isNotificationDomainEventType(value: unknown): value is NotificationDomainEventType {
  return typeof value === 'string' && NOTIFICATION_DOMAIN_EVENT_TYPES.includes(value as NotificationDomainEventType);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}

function contractError(code: NotificationContractErrorCode): NotificationContractError {
  return new NotificationContractError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
