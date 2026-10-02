export const EVENT_REGISTRATION_STATUSES = [
  'REGISTERED',
  'WAITLISTED',
  'CANCELLED',
] as const;
export type EventRegistrationStatus = (typeof EVENT_REGISTRATION_STATUSES)[number];

export const EVENT_INVITATION_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type EventInvitationStatus = (typeof EVENT_INVITATION_STATUSES)[number];

export const EVENT_REMINDER_KINDS = ['TWENTY_FOUR_HOURS', 'ONE_HOUR'] as const;
export type EventReminderKind = (typeof EVENT_REMINDER_KINDS)[number];

export const EVENT_REMINDER_STATUSES = [
  'SCHEDULED',
  'SUPPRESSED',
  'CANCELLED',
] as const;
export type EventReminderStatus = (typeof EVENT_REMINDER_STATUSES)[number];

export const EVENT_ATTENDANCE_EVIDENCE_TYPES = [
  'HOST_MARKED',
  'ROOM_PRESENCE',
] as const;
export type EventAttendanceEvidenceType =
  (typeof EVENT_ATTENDANCE_EVIDENCE_TYPES)[number];

export const EVENT_ATTENDANCE_LEARNING_HOOK = 'EVENT_ATTENDANCE_LEARNING_HOOK';

export interface EventRegistrationRecord {
  id: string;
  eventId: string;
  userId: string;
  status: EventRegistrationStatus;
  waitlistPosition: number | null;
  registeredAt: Date;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventRegistrationResult {
  record: EventRegistrationRecord;
  replayed: boolean;
  promoted: EventRegistrationRecord[];
}

export interface EventInvitationRecord {
  id: string;
  eventId: string;
  invitedUserId: string;
  invitedByUserId: string;
  status: EventInvitationStatus;
  invitedAt: Date;
  revokedAt: Date | null;
  updatedAt: Date;
}

export interface EventReminderIntent {
  id: string;
  eventId: string;
  userId: string;
  registrationId: string;
  kind: EventReminderKind;
  scheduledFor: Date;
  recipientTimezone: string;
  status: EventReminderStatus;
  suppressionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventReminderIntentInput {
  eventId: string;
  userId: string;
  registrationId: string;
  kind: EventReminderKind;
  scheduledFor: Date;
  recipientTimezone: string;
  status: EventReminderStatus;
  suppressionReason: string | null;
  now: Date;
}

export interface EventAttendanceRecord {
  id: string;
  eventId: string;
  userId: string;
  evidenceType: EventAttendanceEvidenceType;
  evidenceId: string;
  markedByUserId: string | null;
  occurredAt: Date;
  fingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventAttendanceResult {
  record: EventAttendanceRecord;
  replayed: boolean;
}

export interface EventAttendanceLearningHookInput {
  eventId: string;
  userId: string;
  languageCode: string;
  evidenceType: EventAttendanceEvidenceType;
  evidenceId: string;
  occurredAt: Date;
}

export interface EventAttendanceLearningHook {
  recordTrustedAttendance(input: EventAttendanceLearningHookInput): Promise<void>;
}

export class NoopEventAttendanceLearningHook
  implements EventAttendanceLearningHook {
  async recordTrustedAttendance(
    _input: EventAttendanceLearningHookInput,
  ): Promise<void> {
    // Challenge/reputation consumers can subscribe without granting client trust.
  }
}

export interface EventRegistrationResponse {
  id: string;
  eventId: string;
  status: EventRegistrationStatus;
  waitlistPosition: number | null;
  registeredAt: Date;
  cancelledAt: Date | null;
}

export function toPublicEventRegistration(
  record: EventRegistrationRecord,
): EventRegistrationResponse {
  return {
    id: record.id,
    eventId: record.eventId,
    status: record.status,
    waitlistPosition: record.waitlistPosition,
    registeredAt: new Date(record.registeredAt),
    cancelledAt: record.cancelledAt ? new Date(record.cancelledAt) : null,
  };
}

export function cloneEventRegistration(
  record: EventRegistrationRecord,
): EventRegistrationRecord {
  return {
    ...record,
    registeredAt: new Date(record.registeredAt),
    cancelledAt: record.cancelledAt ? new Date(record.cancelledAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function cloneEventReminderIntent(
  record: EventReminderIntent,
): EventReminderIntent {
  return {
    ...record,
    scheduledFor: new Date(record.scheduledFor),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export function cloneEventAttendance(
  record: EventAttendanceRecord,
): EventAttendanceRecord {
  return {
    ...record,
    occurredAt: new Date(record.occurredAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
