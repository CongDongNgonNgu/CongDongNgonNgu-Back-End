import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DELIVERY_CHANNELS,
  NOTIFICATION_TYPES,
} from './notification.contracts';
import type {
  NotificationCategory,
  NotificationDeliveryChannel,
  NotificationType,
} from './notification.contracts';

export type NotificationPreferenceChange = {
  readonly category: NotificationCategory;
  readonly channel: NotificationDeliveryChannel;
  readonly enabled: boolean;
};

export interface NotificationPreferenceOverride extends NotificationPreferenceChange {}

export interface NotificationPreferenceItem extends NotificationPreferenceChange {
  readonly locked: boolean;
}

export interface NotificationPreferencesResponse {
  readonly scope: 'own';
  readonly preferences: readonly NotificationPreferenceItem[];
}

export interface NotificationChannelDecisionInput {
  readonly category: NotificationCategory;
  readonly channel: NotificationDeliveryChannel;
  readonly notificationType: NotificationType;
}

/**
 * Security, account/system and payment/membership notices must remain visible
 * in the canonical in-app surface. Other channels remain independently
 * configurable so future adapters can opt in without changing this contract.
 */
export const MANDATORY_IN_APP_CATEGORIES = [
  'SECURITY',
  'MEMBERSHIP',
  'SYSTEM',
] as const satisfies readonly NotificationCategory[];

export const MANDATORY_NOTIFICATION_TYPES = [
  'SECURITY_NOTICE',
  'MEMBERSHIP_STATE',
  'PAYMENT_STATE',
] as const satisfies readonly NotificationType[];

export function defaultNotificationPreference(
  _category: NotificationCategory,
  channel: NotificationDeliveryChannel,
): boolean {
  return channel === 'IN_APP' || channel === 'SSE';
}

export function isMandatoryInAppPreference(
  category: NotificationCategory,
  channel: NotificationDeliveryChannel,
): boolean {
  return channel === 'IN_APP' && MANDATORY_IN_APP_CATEGORIES.includes(category as typeof MANDATORY_IN_APP_CATEGORIES[number]);
}

export function isMandatoryNotificationType(notificationType: NotificationType): boolean {
  return MANDATORY_NOTIFICATION_TYPES.includes(notificationType as typeof MANDATORY_NOTIFICATION_TYPES[number]);
}

export function buildNotificationPreferenceMatrix(
  overrides: readonly NotificationPreferenceOverride[],
): NotificationPreferenceItem[] {
  const byKey = new Map(
    overrides.map((override) => [preferenceKey(override.category, override.channel), override.enabled]),
  );
  return NOTIFICATION_CATEGORIES.flatMap((category) => NOTIFICATION_DELIVERY_CHANNELS.map((channel) => {
    const locked = isMandatoryInAppPreference(category, channel);
    return {
      category,
      channel,
      enabled: locked
        ? true
        : byKey.get(preferenceKey(category, channel)) ?? defaultNotificationPreference(category, channel),
      locked,
    };
  }));
}

export function isNotificationChannelEnabled(
  matrix: readonly NotificationPreferenceItem[],
  input: NotificationChannelDecisionInput,
): boolean {
  if (input.channel === 'IN_APP' && isMandatoryNotificationType(input.notificationType)) return true;
  return matrix.find((item) => (
    item.category === input.category && item.channel === input.channel
  ))?.enabled ?? defaultNotificationPreference(input.category, input.channel);
}

export function preferenceKey(
  category: NotificationCategory,
  channel: NotificationDeliveryChannel,
): string {
  return `${category}:${channel}`;
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function isNotificationDeliveryChannel(value: unknown): value is NotificationDeliveryChannel {
  return typeof value === 'string' && (NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}
