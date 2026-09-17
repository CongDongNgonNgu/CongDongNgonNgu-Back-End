import type {
  DeclaredLanguageProficiency,
  LanguageRole,
} from '../profile/profile.types';

export const EXCHANGE_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type ExchangeCefrLevel = typeof EXCHANGE_CEFR_LEVELS[number];

export const EXCHANGE_VISIBILITY_MODES = ['HIDDEN', 'SUMMARY'] as const;
export type ExchangeVisibilityMode = typeof EXCHANGE_VISIBILITY_MODES[number];

export const EXCHANGE_CONTACT_PERMISSIONS = ['NO_CONTACT', 'RELATIONSHIP_GATED'] as const;
export type ExchangeContactPermission = typeof EXCHANGE_CONTACT_PERMISSIONS[number];

export const EXCHANGE_TIMEZONE_COMPATIBILITIES = [
  'ANY',
  'SAME_TIMEZONE',
  'WITHIN_3_HOURS',
] as const;
export type ExchangeTimezoneCompatibility = typeof EXCHANGE_TIMEZONE_COMPATIBILITIES[number];

export interface ExchangePreferenceRecord {
  userId: string;
  exchangeOptIn: boolean;
  discoverable: boolean;
  offeredLanguageCodes: string[];
  wantedLanguageCodes: string[];
  preferredPartnerLevels: ExchangeCefrLevel[];
  matchingGoalCodes: string[];
  matchingInterestCodes: string[];
  timezoneVisibility: ExchangeVisibilityMode;
  availabilityVisibility: ExchangeVisibilityMode;
  contactPermission: ExchangeContactPermission;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ExchangePreferenceWriteInput {
  exchangeOptIn: boolean;
  discoverable: boolean;
  offeredLanguageCodes: readonly string[];
  wantedLanguageCodes: readonly string[];
  preferredPartnerLevels: readonly ExchangeCefrLevel[];
  matchingGoalCodes: readonly string[];
  matchingInterestCodes: readonly string[];
  timezoneVisibility: ExchangeVisibilityMode;
  availabilityVisibility: ExchangeVisibilityMode;
  contactPermission: ExchangeContactPermission;
}

export interface ExchangePreferencesResponse {
  scope: 'own';
  exchangeOptIn: boolean;
  discoverable: boolean;
  offeredLanguageCodes: string[];
  wantedLanguageCodes: string[];
  preferredPartnerLevels: ExchangeCefrLevel[];
  matchingGoalCodes: string[];
  matchingInterestCodes: string[];
  timezoneVisibility: ExchangeVisibilityMode;
  availabilityVisibility: ExchangeVisibilityMode;
  contactPermission: ExchangeContactPermission;
  createdAt: string | null;
  updatedAt: string | null;
}

export type ExchangeEligibilityReason =
  | 'EXCHANGE_USER_INACTIVE'
  | 'EXCHANGE_SELF'
  | 'EXCHANGE_NOT_OPTED_IN'
  | 'EXCHANGE_NOT_DISCOVERABLE'
  | 'EXCHANGE_NOT_READY'
  | 'EXCHANGE_INVALID_STATE'
  | 'EXCHANGE_BLOCKED';

export interface ExchangeEligibilityResult {
  eligible: boolean;
  reasons: ExchangeEligibilityReason[];
}

export interface PublicBuddyLanguageResponse {
  code: string;
  slug: string;
  nativeName: string;
  englishName: string;
  vietnameseName: string;
  direction: 'ltr' | 'rtl';
  offered: boolean;
  wanted: boolean;
  declaredProficiency: DeclaredLanguageProficiency;
  assessedProficiency: string | null;
}

export interface PublicBuddyProjection {
  scope: 'exchange-buddy';
  user: {
    id: string;
    displayName: string;
  };
  languages: PublicBuddyLanguageResponse[];
  goals: string[];
  interests: string[];
  timezoneSummary: {
    visibility: 'SUMMARY';
    identifier: string;
  } | null;
  availabilitySummary: {
    visibility: 'SUMMARY';
    hasAvailability: boolean;
  } | null;
}

export interface ExchangeDiscoveryQuery {
  offeredLanguageCodes: string[];
  wantedLanguageCodes: string[];
  preferredPartnerLevels: ExchangeCefrLevel[];
  matchingGoalCodes: string[];
  matchingInterestCodes: string[];
  timezoneCompatibility: ExchangeTimezoneCompatibility;
  page: number;
  pageSize: number;
}

export interface ExchangeDiscoveryCandidate {
  user: {
    id: string;
    displayName: string;
  };
  languages: PublicBuddyLanguageResponse[];
  goals: string[];
  interests: string[];
  normalizedScore: number;
  reasons: string[];
}

export interface ExchangeDiscoveryResponse {
  scope: 'exchange-discovery';
  candidates: ExchangeDiscoveryCandidate[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  filters: ExchangeDiscoveryQuery;
}

export function hasExchangeOfferRole(roles: readonly LanguageRole[]): boolean {
  return roles.includes('native') || roles.includes('known');
}

export function hasExchangeWantedRole(roles: readonly LanguageRole[]): boolean {
  return roles.includes('learning');
}
