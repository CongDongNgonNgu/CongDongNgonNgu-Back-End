import type {
  NotificationPreferenceChange,
  NotificationPreferenceOverride,
} from './notification-preference.types';

export const NOTIFICATION_PREFERENCE_REPOSITORY = 'NOTIFICATION_PREFERENCE_REPOSITORY';

export interface NotificationPreferenceRepository {
  readonly revision?:number;
  findOverrides(userId: string): Promise<NotificationPreferenceOverride[]>;
  saveOverrides(userId: string, changes: readonly NotificationPreferenceChange[]): Promise<void>;
}

export class InMemoryNotificationPreferenceRepository implements NotificationPreferenceRepository {
  private mutationRevision=0;
  get revision():number {return this.mutationRevision;}
  private readonly overridesByUser = new Map<string, Map<string, NotificationPreferenceOverride>>();

  async findOverrides(userId: string): Promise<NotificationPreferenceOverride[]> {
    return [...(this.overridesByUser.get(userId)?.values() ?? [])]
      .map(cloneOverride)
      .sort(compareOverrides);
  }

  async saveOverrides(
    userId: string,
    changes: readonly NotificationPreferenceChange[],
  ): Promise<void> {
    const current = this.overridesByUser.get(userId) ?? new Map<string, NotificationPreferenceOverride>();
    for (const change of changes) {
      current.set(`${change.category}:${change.channel}`, { ...change });
    }
    this.overridesByUser.set(userId, current);
    this.mutationRevision+=1;
  }
}

function compareOverrides(
  left: NotificationPreferenceOverride,
  right: NotificationPreferenceOverride,
): number {
  return `${left.category}:${left.channel}`.localeCompare(`${right.category}:${right.channel}`);
}

function cloneOverride(override: NotificationPreferenceOverride): NotificationPreferenceOverride {
  return { ...override };
}
