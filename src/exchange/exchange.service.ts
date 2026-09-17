import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import type { ProfileRecord } from '../profile/profile.types';
import { ExchangeFailure } from './exchange.errors';
import {
  EXCHANGE_PREFERENCE_REPOSITORY,
  type ExchangePreferenceRepository,
} from './exchange.repository';
import {
  EXCHANGE_CEFR_LEVELS,
  EXCHANGE_CONTACT_PERMISSIONS,
  EXCHANGE_VISIBILITY_MODES,
  hasExchangeOfferRole,
  hasExchangeWantedRole,
  type ExchangeCefrLevel,
  type ExchangeEligibilityReason,
  type ExchangeEligibilityResult,
  type ExchangePreferenceRecord,
  type ExchangePreferencesResponse,
  type ExchangePreferenceWriteInput,
  type ExchangeContactPermission,
  type ExchangeVisibilityMode,
  type PublicBuddyProjection,
} from './exchange.types';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const PROFILE_GOAL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LANGUAGE_SELECTIONS = 20;
const MAX_GOAL_SELECTIONS = 10;
const MAX_INTEREST_SELECTIONS = 20;

export interface ExchangePreferenceUpdateInput {
  exchangeOptIn?: boolean;
  discoverable?: boolean;
  offeredLanguageCodes?: readonly string[];
  wantedLanguageCodes?: readonly string[];
  preferredPartnerLevels?: readonly string[];
  matchingGoalCodes?: readonly string[];
  matchingInterestCodes?: readonly string[];
  timezoneVisibility?: string;
  availabilityVisibility?: string;
  contactPermission?: string;
}

export const EXCHANGE_SAFETY_GATE = 'EXCHANGE_SAFETY_GATE';

export interface ExchangeSafetyGate {
  isBlocked(viewerUserId: string, candidateUserId: string): Promise<boolean>;
}

@Injectable()
export class NoopExchangeSafetyGate implements ExchangeSafetyGate {
  async isBlocked(_viewerUserId: string, _candidateUserId: string): Promise<boolean> {
    return false;
  }
}

@Injectable()
export class ExchangeService {
  constructor(
    @Inject(EXCHANGE_PREFERENCE_REPOSITORY)
    private readonly repository: ExchangePreferenceRepository,
    @Inject(PROFILE_REPOSITORY)
    private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY)
    private readonly identities: IdentityRepository,
    @Inject(EXCHANGE_SAFETY_GATE)
    private readonly safetyGate: ExchangeSafetyGate,
  ) {}

  async getOwnPreferences(userId: string): Promise<ExchangePreferencesResponse> {
    await this.requireActiveUser(userId);
    return toPreferencesResponse(await this.repository.findPreferences(userId));
  }

  async updateOwnPreferences(
    userId: string,
    input: ExchangePreferenceUpdateInput,
  ): Promise<ExchangePreferencesResponse> {
    await this.requireActiveUser(userId);
    const current = await this.repository.findPreferences(userId);
    const profile = await this.profiles.findProfile(userId);
    const normalized = await this.normalizePreferences(current, profile, input);
    return toPreferencesResponse(await this.repository.savePreferences(userId, normalized));
  }

  async getEligibility(
    candidateUserId: string,
    viewerUserId: string | null = null,
  ): Promise<ExchangeEligibilityResult> {
    if (viewerUserId === candidateUserId) return ineligible('EXCHANGE_SELF');
    const user = await this.identities.findUserById(candidateUserId);
    if (!isActiveUser(user)) return ineligible('EXCHANGE_USER_INACTIVE');

    const [profile, preferences] = await Promise.all([
      this.profiles.findProfile(candidateUserId),
      this.repository.findPreferences(candidateUserId),
    ]);
    if (!preferences.exchangeOptIn) return ineligible('EXCHANGE_NOT_OPTED_IN');
    if (!preferences.discoverable) return ineligible('EXCHANGE_NOT_DISCOVERABLE');

    try {
      await this.validateStoredPreferences(profile, preferences);
    } catch {
      return ineligible('EXCHANGE_INVALID_STATE');
    }
    if (preferences.offeredLanguageCodes.length === 0 || preferences.wantedLanguageCodes.length === 0) {
      return ineligible('EXCHANGE_NOT_READY');
    }
    if (viewerUserId && await this.safetyGate.isBlocked(viewerUserId, candidateUserId)) {
      return ineligible('EXCHANGE_BLOCKED');
    }
    return { eligible: true, reasons: [] };
  }

  async getPublicBuddyProjection(
    candidateUserId: string,
    viewerUserId: string,
  ): Promise<PublicBuddyProjection> {
    const eligibility = await this.getEligibility(candidateUserId, viewerUserId);
    if (!eligibility.eligible) {
      throw new ExchangeFailure('EXCHANGE_PROFILE_UNAVAILABLE', 404, 'Buddy profile was not found');
    }
    const user = await this.identities.findUserById(candidateUserId);
    const profile = await this.profiles.findProfile(candidateUserId);
    const preferences = await this.repository.findPreferences(candidateUserId);
    if (!isActiveUser(user)) {
      throw new ExchangeFailure('EXCHANGE_PROFILE_UNAVAILABLE', 404, 'Buddy profile was not found');
    }
    return {
      scope: 'exchange-buddy',
      user: { id: user.id, displayName: user.displayName },
      languages: profile.languages
        .filter((language) => (
          preferences.offeredLanguageCodes.includes(language.language.code) ||
          preferences.wantedLanguageCodes.includes(language.language.code)
        ))
        .map((language) => ({
          code: language.language.code,
          slug: language.language.slug,
          nativeName: language.language.nativeName,
          englishName: language.language.englishName,
          vietnameseName: language.language.vietnameseName,
          direction: language.language.direction,
          offered: preferences.offeredLanguageCodes.includes(language.language.code),
          wanted: preferences.wantedLanguageCodes.includes(language.language.code),
          declaredProficiency: language.declaredProficiency,
          assessedProficiency: language.assessedProficiency,
        })),
      goals: [...preferences.matchingGoalCodes],
      interests: [...preferences.matchingInterestCodes],
      timezoneSummary: preferences.timezoneVisibility === 'SUMMARY' && profile.timezone
        ? { visibility: 'SUMMARY', identifier: profile.timezone }
        : null,
      availabilitySummary: preferences.availabilityVisibility === 'SUMMARY'
        ? { visibility: 'SUMMARY', hasAvailability: profile.availability.length > 0 }
        : null,
    };
  }

  private async normalizePreferences(
    current: ExchangePreferenceRecord,
    profile: ProfileRecord,
    input: ExchangePreferenceUpdateInput,
  ): Promise<ExchangePreferenceWriteInput> {
    const exchangeOptIn = input.exchangeOptIn ?? current.exchangeOptIn;
    const discoverable = input.discoverable ?? current.discoverable;
    if (typeof exchangeOptIn !== 'boolean' || typeof discoverable !== 'boolean') {
      throw exchangeFailure('EXCHANGE_INVALID_STATE', 'Exchange preference flags are invalid');
    }
    const offeredLanguageCodes = normalizeCodes(
      input.offeredLanguageCodes ?? current.offeredLanguageCodes,
      MAX_LANGUAGE_SELECTIONS,
      'EXCHANGE_INVALID_LANGUAGES',
      LANGUAGE_CODE_PATTERN,
    );
    const wantedLanguageCodes = normalizeCodes(
      input.wantedLanguageCodes ?? current.wantedLanguageCodes,
      MAX_LANGUAGE_SELECTIONS,
      'EXCHANGE_INVALID_LANGUAGES',
      LANGUAGE_CODE_PATTERN,
    );
    const preferredPartnerLevels = normalizeLevels(
      input.preferredPartnerLevels ?? current.preferredPartnerLevels,
    );
    const matchingGoalCodes = normalizeCodes(
      input.matchingGoalCodes ?? current.matchingGoalCodes,
      MAX_GOAL_SELECTIONS,
      'EXCHANGE_INVALID_GOALS',
      PROFILE_GOAL_PATTERN,
    );
    const matchingInterestCodes = normalizeInterests(
      input.matchingInterestCodes ?? current.matchingInterestCodes,
    );
    const timezoneVisibility = normalizeVisibility(
      input.timezoneVisibility ?? current.timezoneVisibility,
    );
    const availabilityVisibility = normalizeVisibility(
      input.availabilityVisibility ?? current.availabilityVisibility,
    );
    const contactPermission = normalizeContactPermission(
      input.contactPermission ?? current.contactPermission,
    );

    await this.validateLanguageSelections(profile, offeredLanguageCodes, wantedLanguageCodes);
    const profileGoals = new Set(profile.goals);
    if (matchingGoalCodes.some((goal) => !profileGoals.has(goal))) {
      throw exchangeFailure('EXCHANGE_GOAL_NOT_IN_PROFILE', 'Exchange goals must come from the language profile');
    }
    const profileInterests = new Set(profile.interests);
    if (matchingInterestCodes.some((interest) => !profileInterests.has(interest))) {
      throw exchangeFailure('EXCHANGE_INTEREST_NOT_IN_PROFILE', 'Exchange interests must come from the language profile');
    }
    if (exchangeOptIn && (offeredLanguageCodes.length === 0 || wantedLanguageCodes.length === 0)) {
      throw exchangeFailure('EXCHANGE_NOT_READY', 'Exchange opt-in requires an offered and wanted language');
    }
    return {
      exchangeOptIn,
      discoverable,
      offeredLanguageCodes,
      wantedLanguageCodes,
      preferredPartnerLevels,
      matchingGoalCodes,
      matchingInterestCodes,
      timezoneVisibility,
      availabilityVisibility,
      contactPermission,
    };
  }

  private async validateStoredPreferences(
    profile: ProfileRecord,
    preferences: ExchangePreferenceRecord,
  ): Promise<void> {
    if (
      typeof preferences.exchangeOptIn !== 'boolean' ||
      typeof preferences.discoverable !== 'boolean' ||
      !EXCHANGE_VISIBILITY_MODES.includes(preferences.timezoneVisibility) ||
      !EXCHANGE_VISIBILITY_MODES.includes(preferences.availabilityVisibility) ||
      !EXCHANGE_CONTACT_PERMISSIONS.includes(preferences.contactPermission)
    ) {
      throw exchangeFailure('EXCHANGE_INVALID_STATE', 'Exchange preference state is invalid');
    }
    const offered = normalizeCodes(
      preferences.offeredLanguageCodes,
      MAX_LANGUAGE_SELECTIONS,
      'EXCHANGE_INVALID_LANGUAGES',
      LANGUAGE_CODE_PATTERN,
    );
    const wanted = normalizeCodes(
      preferences.wantedLanguageCodes,
      MAX_LANGUAGE_SELECTIONS,
      'EXCHANGE_INVALID_LANGUAGES',
      LANGUAGE_CODE_PATTERN,
    );
    normalizeLevels(preferences.preferredPartnerLevels);
    const goals = normalizeCodes(
      preferences.matchingGoalCodes,
      MAX_GOAL_SELECTIONS,
      'EXCHANGE_INVALID_GOALS',
      PROFILE_GOAL_PATTERN,
    );
    const interests = normalizeInterests(preferences.matchingInterestCodes);
    await this.validateLanguageSelections(profile, offered, wanted);
    if (goals.some((goal) => !profile.goals.includes(goal))) {
      throw exchangeFailure('EXCHANGE_GOAL_NOT_IN_PROFILE', 'Exchange goal is not in the profile');
    }
    if (interests.some((interest) => !profile.interests.includes(interest))) {
      throw exchangeFailure('EXCHANGE_INTEREST_NOT_IN_PROFILE', 'Exchange interest is not in the profile');
    }
  }

  private async validateLanguageSelections(
    profile: ProfileRecord,
    offeredLanguageCodes: readonly string[],
    wantedLanguageCodes: readonly string[],
  ): Promise<void> {
    const codes = [...new Set([...offeredLanguageCodes, ...wantedLanguageCodes])];
    const catalog = await this.profiles.findByCodes(codes);
    const catalogByCode = new Map(catalog.map((language) => [language.code, language]));
    const profileByCode = new Map(profile.languages.map((language) => [language.language.code, language]));
    for (const code of codes) {
      const relation = profileByCode.get(code);
      const language = catalogByCode.get(code);
      if (!relation || !language) {
        throw exchangeFailure('EXCHANGE_LANGUAGE_NOT_IN_PROFILE', 'Exchange language must come from the language profile');
      }
      if (!language.active) {
        throw exchangeFailure('EXCHANGE_LANGUAGE_INACTIVE', 'Exchange language is not active');
      }
      if (relation.visibility !== 'PUBLIC') {
        throw exchangeFailure('EXCHANGE_LANGUAGE_PRIVATE', 'Private language relations cannot be offered or wanted publicly');
      }
    }
    for (const code of offeredLanguageCodes) {
      const relation = profileByCode.get(code);
      if (!relation || !hasExchangeOfferRole(relation.roles)) {
        throw exchangeFailure('EXCHANGE_LANGUAGE_NOT_OFFERED', 'Offered languages must be native or known languages');
      }
    }
    for (const code of wantedLanguageCodes) {
      const relation = profileByCode.get(code);
      if (!relation || !hasExchangeWantedRole(relation.roles)) {
        throw exchangeFailure('EXCHANGE_LANGUAGE_NOT_WANTED', 'Wanted languages must be learning languages');
      }
    }
  }

  private async requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await this.identities.findUserById(userId);
    if (!isActiveUser(user)) {
      throw exchangeFailure('EXCHANGE_USER_NOT_FOUND', 'Exchange preferences were not found', 404);
    }
    return user;
  }
}

function isActiveUser(user: UserRecord | null): user is UserRecord {
  return Boolean(user && user.status === 'ACTIVE' && user.emailVerifiedAt);
}

function toPreferencesResponse(record: ExchangePreferenceRecord): ExchangePreferencesResponse {
  return {
    scope: 'own',
    exchangeOptIn: record.exchangeOptIn,
    discoverable: record.discoverable,
    offeredLanguageCodes: [...record.offeredLanguageCodes],
    wantedLanguageCodes: [...record.wantedLanguageCodes],
    preferredPartnerLevels: [...record.preferredPartnerLevels],
    matchingGoalCodes: [...record.matchingGoalCodes],
    matchingInterestCodes: [...record.matchingInterestCodes],
    timezoneVisibility: record.timezoneVisibility,
    availabilityVisibility: record.availabilityVisibility,
    contactPermission: record.contactPermission,
    createdAt: record.createdAt?.toISOString() ?? null,
    updatedAt: record.updatedAt?.toISOString() ?? null,
  };
}

function normalizeCodes(
  input: readonly string[],
  max: number,
  code: string,
  pattern: RegExp,
): string[] {
  if (!Array.isArray(input) || input.length > max) {
    throw exchangeFailure(code, 'Exchange selection is invalid or too large');
  }
  const values = input.map((value) => {
    if (typeof value !== 'string') throw exchangeFailure(code, 'Exchange selection is invalid');
    const normalized = value.trim().toLowerCase();
    if (!pattern.test(normalized)) throw exchangeFailure(code, 'Exchange selection is invalid');
    return normalized;
  });
  if (new Set(values).size !== values.length) {
    throw exchangeFailure(code, 'Exchange selection contains duplicates');
  }
  return values;
}

function normalizeInterests(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > MAX_INTEREST_SELECTIONS) {
    throw exchangeFailure('EXCHANGE_INVALID_INTERESTS', 'Exchange interests are invalid or too large');
  }
  const values = input.map((value) => {
    if (typeof value !== 'string') throw exchangeFailure('EXCHANGE_INVALID_INTERESTS', 'Exchange interest is invalid');
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length === 0 || normalized.length > 64) {
      throw exchangeFailure('EXCHANGE_INVALID_INTERESTS', 'Exchange interest is invalid');
    }
    return normalized;
  });
  if (new Set(values).size !== values.length) {
    throw exchangeFailure('EXCHANGE_INVALID_INTERESTS', 'Exchange interests contain duplicates');
  }
  return values;
}

function normalizeLevels(input: readonly string[]): ExchangeCefrLevel[] {
  if (!Array.isArray(input) || input.length > EXCHANGE_CEFR_LEVELS.length) {
    throw exchangeFailure('EXCHANGE_INVALID_LEVELS', 'Preferred partner levels are invalid');
  }
  const values = input.map((value) => {
    if (typeof value !== 'string') throw exchangeFailure('EXCHANGE_INVALID_LEVELS', 'Preferred partner levels are invalid');
    const normalized = value.trim().toUpperCase() as ExchangeCefrLevel;
    if (!EXCHANGE_CEFR_LEVELS.includes(normalized)) {
      throw exchangeFailure('EXCHANGE_INVALID_LEVELS', 'Preferred partner levels are invalid');
    }
    return normalized;
  });
  if (new Set(values).size !== values.length) {
    throw exchangeFailure('EXCHANGE_INVALID_LEVELS', 'Preferred partner levels contain duplicates');
  }
  return EXCHANGE_CEFR_LEVELS.filter((level) => values.includes(level));
}

function normalizeVisibility(input: string): ExchangeVisibilityMode {
  if (typeof input !== 'string') throw exchangeFailure('EXCHANGE_INVALID_VISIBILITY', 'Exchange visibility is invalid');
  const normalized = input.trim().toUpperCase() as ExchangeVisibilityMode;
  if (!EXCHANGE_VISIBILITY_MODES.includes(normalized)) {
    throw exchangeFailure('EXCHANGE_INVALID_VISIBILITY', 'Exchange visibility is invalid');
  }
  return normalized;
}

function normalizeContactPermission(input: string): ExchangeContactPermission {
  if (typeof input !== 'string') throw exchangeFailure('EXCHANGE_INVALID_CONTACT_PERMISSION', 'Contact permission is invalid');
  const normalized = input.trim().toUpperCase() as ExchangeContactPermission;
  if (!EXCHANGE_CONTACT_PERMISSIONS.includes(normalized)) {
    throw exchangeFailure('EXCHANGE_INVALID_CONTACT_PERMISSION', 'Contact permission is invalid');
  }
  return normalized;
}

function ineligible(reason: ExchangeEligibilityReason): ExchangeEligibilityResult {
  return { eligible: false, reasons: [reason] };
}

function exchangeFailure(code: string, message: string, status = 400): ExchangeFailure {
  return new ExchangeFailure(code, status, message);
}
