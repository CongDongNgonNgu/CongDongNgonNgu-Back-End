import { Inject, Injectable } from '@nestjs/common';
import { NotificationFailure } from './notification.errors';
import {
  buildNotificationPreferenceMatrix,
  isMandatoryInAppPreference,
  isNotificationCategory,
  isNotificationChannelEnabled,
  isNotificationDeliveryChannel,
  isNotificationType,
  type NotificationChannelDecisionInput,
  type NotificationPreferenceChange,
  type NotificationPreferencesResponse,
} from './notification-preference.types';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  type NotificationPreferenceRepository,
} from './notification-preference.repository';

const MAX_PREFERENCE_CHANGES = 32;

@Injectable()
export class NotificationPreferenceService {
  get revision():number|undefined {return this.repository.revision;}
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly repository: NotificationPreferenceRepository,
  ) {}

  async get(userId: string): Promise<NotificationPreferencesResponse> {
    assertUserId(userId);
    return {
      scope: 'own',
      preferences: buildNotificationPreferenceMatrix(await this.repository.findOverrides(userId)),
    };
  }

  async update(
    userId: string,
    changes: readonly NotificationPreferenceChange[],
  ): Promise<NotificationPreferencesResponse> {
    assertUserId(userId);
    validateChanges(changes);
    await this.repository.saveOverrides(userId, changes);
    return this.get(userId);
  }

  async isChannelEnabled(
    userId: string,
    input: NotificationChannelDecisionInput,
  ): Promise<boolean> {
    assertUserId(userId);
    if (!isNotificationCategory(input.category) || !isNotificationDeliveryChannel(input.channel)) {
      throw new NotificationFailure(
        'NOTIFICATION_INVALID_PREFERENCES',
        400,
        'Notification preference is invalid',
      );
    }
    if (!isNotificationType(input.notificationType)) {
      throw new NotificationFailure(
        'NOTIFICATION_INVALID_PREFERENCES',
        400,
        'Notification preference is invalid',
      );
    }
    const matrix = (await this.get(userId)).preferences;
    return isNotificationChannelEnabled(matrix, input);
  }
}

function validateChanges(changes: readonly NotificationPreferenceChange[]): void {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_PREFERENCE_CHANGES) {
    throw new NotificationFailure(
      'NOTIFICATION_INVALID_PREFERENCES',
      400,
      'Notification preferences are invalid',
    );
  }

  const seen = new Set<string>();
  for (const change of changes) {
    if (
      !change ||
      !isNotificationCategory(change.category) ||
      !isNotificationDeliveryChannel(change.channel) ||
      typeof change.enabled !== 'boolean'
    ) {
      throw new NotificationFailure(
        'NOTIFICATION_INVALID_PREFERENCES',
        400,
        'Notification preferences are invalid',
      );
    }
    const key = `${change.category}:${change.channel}`;
    if (seen.has(key)) {
      throw new NotificationFailure(
        'NOTIFICATION_INVALID_PREFERENCES',
        400,
        'Notification preferences contain duplicate entries',
      );
    }
    seen.add(key);
    if (isMandatoryInAppPreference(change.category, change.channel) && !change.enabled) {
      throw new NotificationFailure(
        'NOTIFICATION_MANDATORY_PREFERENCE',
        422,
        'Required notification notices cannot be disabled',
      );
    }
  }
}

function assertUserId(userId: string): void {
  if (!isUuidV4(userId)) {
    throw new NotificationFailure(
      'NOTIFICATION_INVALID_OWNER',
      400,
      'Notification owner is invalid',
    );
  }
}

function isUuidV4(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
