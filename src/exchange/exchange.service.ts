import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import type { ProfileRecord } from '../profile/profile.types';
import { ExchangeFailure } from './exchange.errors';
import {
  ExchangeRepositoryConflictError,
  EXCHANGE_PREFERENCE_REPOSITORY,
  type ExchangePreferenceRepository,
} from './exchange.repository';
import {
  EXCHANGE_CONNECTION_REPOSITORY,
  type ExchangeConnectionRepository,
} from './exchange-connection.repository';
import {
  EXCHANGE_CONNECTION_EVENT_SINK,
} from './exchange-connection.events';
import type {
  ExchangeConnectionEvent,
  ExchangeConnectionEventSink,
  ExchangeConnectionMutationResult,
  ExchangeConnectionRecord,
  ExchangeConnectionMutationOutcome,
  ExchangeRelationshipResponse,
} from './exchange-connection.types';
import {
  EXCHANGE_CEFR_LEVELS,
  EXCHANGE_CONTACT_PERMISSIONS,
  EXCHANGE_TIMEZONE_COMPATIBILITIES,
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
  type ExchangeDiscoveryCandidate,
  type ExchangeDiscoveryQuery,
  type ExchangeDiscoveryResponse,
  type ExchangeTimezoneCompatibility,
  type ExchangeVisibilityMode,
  type PublicBuddyProjection,
} from './exchange.types';
import {
  evaluateMatch,
  rankMatches,
  type MatchingParticipant,
  type MatchingResult,
} from './matching-engine';

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

export interface ExchangeDiscoveryInput {
  offeredLanguageCodes?: unknown;
  wantedLanguageCodes?: unknown;
  preferredPartnerLevels?: unknown;
  matchingGoalCodes?: unknown;
  matchingInterestCodes?: unknown;
  timezoneCompatibility?: unknown;
  page?: unknown;
  pageSize?: unknown;
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
    @Inject(EXCHANGE_CONNECTION_REPOSITORY)
    private readonly connections: ExchangeConnectionRepository,
    @Inject(EXCHANGE_CONNECTION_EVENT_SINK)
    private readonly connectionEvents: ExchangeConnectionEventSink,
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
    try {
      return toPreferencesResponse(await this.repository.savePreferences(userId, normalized));
    } catch (error) {
      if (error instanceof ExchangeRepositoryConflictError) {
        throw exchangeFailure(
          'EXCHANGE_PROFILE_CONFLICT',
          'Exchange preferences changed while saving',
          409,
        );
      }
      throw error;
    }
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
      languages: toPublicBuddyLanguages(profile, preferences),
      goals: [...preferences.matchingGoalCodes],
      interests: [...preferences.matchingInterestCodes],
      timezoneSummary: preferences.timezoneVisibility === 'SUMMARY' && profile.timezone
        ? { visibility: 'SUMMARY', hasTimezone: true }
        : null,
      availabilitySummary: preferences.availabilityVisibility === 'SUMMARY'
        ? { visibility: 'SUMMARY', hasAvailability: profile.availability.length > 0 }
        : null,
      relationship: await this.getRelationshipResponse(viewerUserId, candidateUserId),
    };
  }

  async getRelationship(
    viewerUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(viewerUserId);
    await this.requireActiveUser(targetUserId);
    this.assertDifferentUsers(viewerUserId, targetUserId);
    return this.getRelationshipResponse(viewerUserId, targetUserId);
  }

  async requestConnection(
    requesterUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(requesterUserId);
    this.assertDifferentUsers(requesterUserId, targetUserId);
    const eligibility = await this.getEligibility(targetUserId, requesterUserId);
    if (!eligibility.eligible) {
      throw new ExchangeFailure('EXCHANGE_PROFILE_UNAVAILABLE', 404, 'Buddy profile was not found');
    }
    const result = await this.connections.requestConnection(requesterUserId, targetUserId);
    return this.completeConnectionMutation(requesterUserId, targetUserId, result);
  }

  async acceptConnection(
    actorUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(actorUserId);
    await this.requireActiveUser(targetUserId);
    this.assertDifferentUsers(actorUserId, targetUserId);
    const result = await this.connections.acceptConnection(actorUserId, targetUserId);
    return this.completeConnectionMutation(actorUserId, targetUserId, result);
  }

  async declineConnection(
    actorUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(actorUserId);
    await this.requireActiveUser(targetUserId);
    this.assertDifferentUsers(actorUserId, targetUserId);
    const result = await this.connections.declineConnection(actorUserId, targetUserId);
    return this.completeConnectionMutation(actorUserId, targetUserId, result);
  }

  async cancelConnection(
    actorUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(actorUserId);
    await this.requireActiveUser(targetUserId);
    this.assertDifferentUsers(actorUserId, targetUserId);
    const result = await this.connections.cancelConnection(actorUserId, targetUserId);
    return this.completeConnectionMutation(actorUserId, targetUserId, result);
  }

  async disconnect(
    actorUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    await this.requireActiveUser(actorUserId);
    await this.requireActiveUser(targetUserId);
    this.assertDifferentUsers(actorUserId, targetUserId);
    const result = await this.connections.disconnect(actorUserId, targetUserId);
    return this.completeConnectionMutation(actorUserId, targetUserId, result);
  }

  async discover(
    userId: string,
    input: ExchangeDiscoveryInput = {},
  ): Promise<ExchangeDiscoveryResponse> {
    await this.requireActiveUser(userId);
    const query = normalizeDiscoveryQuery(input);
    const [viewerProfile, viewerPreferences] = await Promise.all([
      this.profiles.findProfile(userId),
      this.repository.findPreferences(userId),
    ]);
    await this.validateStoredPreferences(viewerProfile, viewerPreferences);
    const viewer: MatchingParticipant = {
      userId,
      profile: viewerProfile,
      preferences: viewerPreferences,
    };
    const candidateIds = await this.repository.listDiscoverableUserIds();
    const matches = (await Promise.all(
      candidateIds
        .filter((candidateUserId) => candidateUserId !== userId)
        .map(async (candidateUserId) => {
          const candidate = await this.loadDiscoveryParticipant(candidateUserId, userId);
          if (!candidate) return null;
          const match = evaluateMatch(viewer, candidate.participant);
          if (!match || !passesDiscoveryFilters(query, candidate.participant.preferences, match)) {
            return null;
          }
          return {
            userId: candidateUserId,
            match,
            candidate: toDiscoveryCandidate(candidate.user, candidate.participant, match),
          };
        }),
    )).filter((item): item is {
      userId: string;
      match: MatchingResult;
      candidate: ExchangeDiscoveryCandidate;
    } => item !== null);
    const ranked = rankMatches(matches);
    const totalItems = ranked.length;
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize);
    const start = (query.page - 1) * query.pageSize;
    return {
      scope: 'exchange-discovery',
      candidates: ranked.slice(start, start + query.pageSize).map((item) => item.candidate),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages,
      },
      filters: query,
    };
  }

  private async loadDiscoveryParticipant(
    candidateUserId: string,
    viewerUserId: string,
  ): Promise<{ user: UserRecord; participant: MatchingParticipant } | null> {
    const [user, profile, preferences] = await Promise.all([
      this.identities.findUserById(candidateUserId),
      this.profiles.findProfile(candidateUserId),
      this.repository.findPreferences(candidateUserId),
    ]);
    if (!isActiveUser(user) || !preferences.exchangeOptIn || !preferences.discoverable) return null;
    if (preferences.offeredLanguageCodes.length === 0 || preferences.wantedLanguageCodes.length === 0) return null;
    try {
      await this.validateStoredPreferences(profile, preferences);
    } catch {
      return null;
    }
    if (await this.safetyGate.isBlocked(viewerUserId, candidateUserId)) return null;
    return {
      user,
      participant: { userId: candidateUserId, profile, preferences },
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

  private async getRelationshipResponse(
    viewerUserId: string,
    targetUserId: string,
  ): Promise<ExchangeRelationshipResponse> {
    const record = await this.connections.findRelationship(viewerUserId, targetUserId);
    return toRelationshipResponse(viewerUserId, targetUserId, record);
  }

  private async completeConnectionMutation(
    actorUserId: string,
    targetUserId: string,
    result: ExchangeConnectionMutationResult,
  ): Promise<ExchangeRelationshipResponse> {
    if (result.outcome === 'INVALID_ACTION') {
      throw new ExchangeFailure(
        'EXCHANGE_CONNECTION_ACTION_INVALID',
        409,
        'This connection action is not available for the current relationship state',
      );
    }
    await this.publishConnectionEvent(actorUserId, targetUserId, result);
    return toRelationshipResponse(actorUserId, targetUserId, result.record);
  }

  private async publishConnectionEvent(
    actorUserId: string,
    targetUserId: string,
    result: ExchangeConnectionMutationResult,
  ): Promise<void> {
    const eventType = eventTypeForOutcome(result.outcome);
    const connectionId = result.connectionId ?? result.record?.id;
    if (!eventType || !connectionId) return;
    const event: ExchangeConnectionEvent = {
      type: eventType,
      connectionId,
      actorUserId,
      targetUserId,
      requesterUserId: result.requesterUserId ?? result.record?.requesterId ?? actorUserId,
      occurredAt: new Date().toISOString(),
    };
    await this.connectionEvents.publish(event);
  }

  private assertDifferentUsers(viewerUserId: string, targetUserId: string): void {
    if (viewerUserId === targetUserId) {
      throw new ExchangeFailure('EXCHANGE_SELF_CONNECTION', 400, 'You cannot connect with yourself');
    }
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

function normalizeDiscoveryQuery(input: ExchangeDiscoveryInput): ExchangeDiscoveryQuery {
  const page = normalizePage(input.page, 1, 100, 'page');
  const pageSize = normalizePage(input.pageSize, 10, 20, 'pageSize');
  const timezoneCompatibility = normalizeTimezoneCompatibility(input.timezoneCompatibility);
  return {
    offeredLanguageCodes: normalizeFilterCodes(input.offeredLanguageCodes, 20, 'EXCHANGE_INVALID_FILTERS'),
    wantedLanguageCodes: normalizeFilterCodes(input.wantedLanguageCodes, 20, 'EXCHANGE_INVALID_FILTERS'),
    preferredPartnerLevels: normalizeFilterLevels(input.preferredPartnerLevels),
    matchingGoalCodes: normalizeFilterCodes(input.matchingGoalCodes, MAX_GOAL_SELECTIONS, 'EXCHANGE_INVALID_FILTERS', PROFILE_GOAL_PATTERN),
    matchingInterestCodes: normalizeFilterInterests(input.matchingInterestCodes),
    timezoneCompatibility,
    page,
    pageSize,
  };
}

function normalizeFilterCodes(
  input: unknown,
  max: number,
  code: string,
  pattern = LANGUAGE_CODE_PATTERN,
): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw exchangeFailure(code, 'Discovery filters are invalid');
  return normalizeCodes(input as readonly string[], max, code, pattern);
}

function normalizeFilterLevels(input: unknown): ExchangeCefrLevel[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery filters are invalid');
  try {
    return normalizeLevels(input as readonly string[]);
  } catch {
    throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery level filters are invalid');
  }
}

function normalizeFilterInterests(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery filters are invalid');
  try {
    return normalizeInterests(input as readonly string[]);
  } catch {
    throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery interest filters are invalid');
  }
}

function normalizeTimezoneCompatibility(input: unknown): ExchangeTimezoneCompatibility {
  if (input === undefined) return 'ANY';
  if (typeof input !== 'string') throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery timezone filter is invalid');
  const normalized = input.trim().toUpperCase() as ExchangeTimezoneCompatibility;
  if (!EXCHANGE_TIMEZONE_COMPATIBILITIES.includes(normalized)) {
    throw exchangeFailure('EXCHANGE_INVALID_FILTERS', 'Discovery timezone filter is invalid');
  }
  return normalized;
}

function normalizePage(input: unknown, fallback: number, max: number, field: string): number {
  const value = input === undefined ? fallback : typeof input === 'string' ? Number(input) : input;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw exchangeFailure('EXCHANGE_INVALID_FILTERS', `Discovery ${field} is invalid`);
  }
  return Number(value);
}

function passesDiscoveryFilters(
  query: ExchangeDiscoveryQuery,
  preferences: ExchangePreferenceRecord,
  match: MatchingResult,
): boolean {
  if (!overlaps(query.offeredLanguageCodes, preferences.offeredLanguageCodes)) return false;
  if (!overlaps(query.wantedLanguageCodes, preferences.wantedLanguageCodes)) return false;
  if (!overlaps(query.preferredPartnerLevels, preferences.preferredPartnerLevels)) return false;
  if (!overlaps(query.matchingGoalCodes, preferences.matchingGoalCodes)) return false;
  if (!overlaps(query.matchingInterestCodes, preferences.matchingInterestCodes)) return false;
  if (query.timezoneCompatibility === 'SAME_TIMEZONE' && match.signals.timezoneOffsetDifferenceMinutes !== 0) {
    return false;
  }
  if (query.timezoneCompatibility === 'WITHIN_3_HOURS' && !match.signals.timezoneCompatible) {
    return false;
  }
  return true;
}

function overlaps(filter: readonly string[], values: readonly string[]): boolean {
  if (filter.length === 0) return true;
  const valueSet = new Set(values);
  return filter.some((value) => valueSet.has(value));
}

function toDiscoveryCandidate(
  user: UserRecord,
  participant: MatchingParticipant,
  match: MatchingResult,
): ExchangeDiscoveryCandidate {
  const { preferences, profile } = participant;
  return {
    user: { id: user.id, displayName: user.displayName },
    languages: toPublicBuddyLanguages(profile, preferences),
    goals: [...preferences.matchingGoalCodes],
    interests: [...preferences.matchingInterestCodes],
    normalizedScore: match.normalizedScore,
    reasons: [...match.reasons],
  };
}

function toPublicBuddyLanguages(
  profile: ProfileRecord,
  preferences: ExchangePreferenceRecord,
): PublicBuddyProjection['languages'] {
  const offered = new Set(preferences.offeredLanguageCodes);
  const wanted = new Set(preferences.wantedLanguageCodes);
  return profile.languages
    .filter((language) => language.visibility === 'PUBLIC')
    .filter((language) => offered.has(language.language.code) || wanted.has(language.language.code))
    .map((language) => ({
      code: language.language.code,
      slug: language.language.slug,
      nativeName: language.language.nativeName,
      englishName: language.language.englishName,
      vietnameseName: language.language.vietnameseName,
      direction: language.language.direction,
      offered: offered.has(language.language.code),
      wanted: wanted.has(language.language.code),
      declaredProficiency: language.declaredProficiency,
      assessedProficiency: language.assessedProficiency,
    }));
}

function toRelationshipResponse(
  viewerUserId: string,
  targetUserId: string,
  record: ExchangeConnectionRecord | null,
): ExchangeRelationshipResponse {
  if (!record) {
    return {
      scope: 'exchange-relationship',
      targetUserId,
      state: 'NONE',
      canRequest: true,
      canAccept: false,
      canDecline: false,
      canCancel: false,
      canDisconnect: false,
    };
  }
  if (record.status === 'CONNECTED') {
    return {
      scope: 'exchange-relationship',
      targetUserId,
      state: 'CONNECTED',
      canRequest: false,
      canAccept: false,
      canDecline: false,
      canCancel: false,
      canDisconnect: true,
    };
  }
  const outgoing = record.requesterId === viewerUserId;
  return {
    scope: 'exchange-relationship',
    targetUserId,
    state: outgoing ? 'OUTGOING_PENDING' : 'INCOMING_PENDING',
    canRequest: false,
    canAccept: !outgoing,
    canDecline: !outgoing,
    canCancel: outgoing,
    canDisconnect: false,
  };
}

function eventTypeForOutcome(
  outcome: ExchangeConnectionMutationOutcome,
): ExchangeConnectionEvent['type'] | null {
  switch (outcome) {
    case 'REQUESTED':
      return 'exchange.connection.requested';
    case 'CONNECTED':
    case 'ACCEPTED':
      return 'exchange.connection.connected';
    case 'DECLINED':
      return 'exchange.connection.declined';
    case 'CANCELLED':
      return 'exchange.connection.cancelled';
    case 'DISCONNECTED':
      return 'exchange.connection.disconnected';
    default:
      return null;
  }
}
