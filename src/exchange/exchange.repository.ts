import type {
  ExchangePreferenceRecord,
  ExchangePreferenceWriteInput,
} from './exchange.types';

export const EXCHANGE_PREFERENCE_REPOSITORY = 'EXCHANGE_PREFERENCE_REPOSITORY';

export class ExchangeRepositoryConflictError extends Error {
  constructor(message = 'Exchange preferences conflict with canonical profile data') {
    super(message);
    this.name = 'ExchangeRepositoryConflictError';
  }
}

export interface ExchangePreferenceRepository {
  findPreferences(userId: string): Promise<ExchangePreferenceRecord>;
  listDiscoverableUserIds(): Promise<string[]>;
  savePreferences(
    userId: string,
    input: ExchangePreferenceWriteInput,
  ): Promise<ExchangePreferenceRecord>;
}

export function defaultExchangePreferences(userId: string): ExchangePreferenceRecord {
  return {
    userId,
    exchangeOptIn: false,
    discoverable: false,
    offeredLanguageCodes: [],
    wantedLanguageCodes: [],
    preferredPartnerLevels: [],
    matchingGoalCodes: [],
    matchingInterestCodes: [],
    timezoneVisibility: 'HIDDEN',
    availabilityVisibility: 'HIDDEN',
    contactPermission: 'NO_CONTACT',
    createdAt: null,
    updatedAt: null,
  };
}

export class InMemoryExchangePreferenceRepository implements ExchangePreferenceRepository {
  private readonly preferences = new Map<string, ExchangePreferenceRecord>();

  async findPreferences(userId: string): Promise<ExchangePreferenceRecord> {
    return clonePreferences(this.preferences.get(userId) ?? defaultPreferences(userId));
  }

  async listDiscoverableUserIds(): Promise<string[]> {
    return [...this.preferences.values()]
      .filter((record) => record.exchangeOptIn && record.discoverable)
      .map((record) => record.userId)
      .sort((left, right) => left.localeCompare(right));
  }

  async savePreferences(
    userId: string,
    input: ExchangePreferenceWriteInput,
  ): Promise<ExchangePreferenceRecord> {
    const current = this.preferences.get(userId);
    const now = new Date();
    const record: ExchangePreferenceRecord = {
      userId,
      ...input,
      offeredLanguageCodes: [...input.offeredLanguageCodes],
      wantedLanguageCodes: [...input.wantedLanguageCodes],
      preferredPartnerLevels: [...input.preferredPartnerLevels],
      matchingGoalCodes: [...input.matchingGoalCodes],
      matchingInterestCodes: [...input.matchingInterestCodes],
      createdAt: current?.createdAt ? new Date(current.createdAt) : now,
      updatedAt: now,
    };
    this.preferences.set(userId, record);
    return clonePreferences(record);
  }
}

function defaultPreferences(userId: string): ExchangePreferenceRecord {
  return defaultExchangePreferences(userId);
}

function clonePreferences(record: ExchangePreferenceRecord): ExchangePreferenceRecord {
  return {
    ...record,
    offeredLanguageCodes: [...record.offeredLanguageCodes],
    wantedLanguageCodes: [...record.wantedLanguageCodes],
    preferredPartnerLevels: [...record.preferredPartnerLevels],
    matchingGoalCodes: [...record.matchingGoalCodes],
    matchingInterestCodes: [...record.matchingInterestCodes],
    createdAt: record.createdAt ? new Date(record.createdAt) : null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : null,
  };
}
