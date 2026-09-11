import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import {
  LANGUAGE_SLUG_PATTERN,
  ProfileRepositoryConflictError,
} from './language-catalog';
import {
  PROFILE_REPOSITORY,
  type ProfileRepository,
} from './profile.repository';
import { ProfileFailure } from './profile.errors';
import type {
  AvailabilityWindowRecord,
  DeclaredLanguageProficiency,
  LanguageCatalogRecord,
  LanguageRole,
  LanguageVisibility,
  ProfileRecord,
  ProfileSkill,
  ReplaceProfileInput,
  UserLanguageInput,
} from './profile.types';

const MAX_LANGUAGES = 20;
const MAX_GOALS = 10;
const MAX_SKILLS = 6;
const MAX_INTERESTS = 20;
const MAX_AVAILABILITY_WINDOWS = 14;
const MAX_SEARCH_LENGTH = 80;

const LANGUAGE_ROLES = new Set<LanguageRole>(['native', 'known', 'learning']);
const DECLARED_PROFICIENCIES = new Set<DeclaredLanguageProficiency>([
  'NATIVE',
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
  'C2',
]);
const PROFILE_SKILLS = new Set<ProfileSkill>([
  'speaking',
  'listening',
  'reading',
  'writing',
  'grammar',
  'vocabulary',
]);

export interface ProfileLanguageUpdateInput {
  languageCode: string;
  roles: readonly string[];
  declaredProficiency: string;
  isPrimaryLearningTarget?: boolean;
  visibility?: string;
}

export interface ProfileAvailabilityUpdateInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ProfileUpdateInput {
  displayName?: string;
  languages?: readonly ProfileLanguageUpdateInput[];
  goals?: readonly string[];
  skills?: readonly string[];
  interests?: readonly string[];
  timezone?: string | null;
  availability?: readonly ProfileAvailabilityUpdateInput[];
}

export interface ProfileLanguageResponse {
  code: string;
  slug: string;
  nativeName: string;
  englishName: string;
  vietnameseName: string;
  direction: 'ltr' | 'rtl';
  roles: LanguageRole[];
  declaredProficiency: DeclaredLanguageProficiency;
  assessedProficiency: string | null;
  isPrimaryLearningTarget: boolean;
  visibility: LanguageVisibility;
}

export interface PublicProfileLanguageResponse
  extends Omit<ProfileLanguageResponse, 'visibility'> {}

export interface OwnProfileResponse {
  scope: 'own';
  user: {
    id: string;
    email: string;
    displayName: string;
    status: UserRecord['status'];
    emailVerified: boolean;
  };
  languages: ProfileLanguageResponse[];
  goals: string[];
  skills: ProfileSkill[];
  interests: string[];
  timezone: string | null;
  availability: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>;
}

export interface PublicProfileResponse {
  scope: 'public';
  user: {
    id: string;
    displayName: string;
  };
  languages: PublicProfileLanguageResponse[];
  goals: string[];
  skills: ProfileSkill[];
  interests: string[];
}

export interface LanguageCatalogResponse {
  code: string;
  slug: string;
  nativeName: string;
  englishName: string;
  vietnameseName: string;
  direction: 'ltr' | 'rtl';
  active: boolean;
  launch: boolean;
  sortOrder: number;
}

@Injectable()
export class ProfileService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
  ) {}

  async listLanguages(search?: string, limit = 50): Promise<LanguageCatalogResponse[]> {
    if (search !== undefined && (typeof search !== 'string' || search.length > MAX_SEARCH_LENGTH)) {
      throw profileFailure('PROFILE_INVALID_SEARCH', 'Language search is invalid');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw profileFailure('PROFILE_INVALID_LIMIT', 'Language result limit is invalid');
    }
    const languages = await this.profiles.listActive(search?.trim(), limit);
    return languages.map(toLanguageCatalogResponse);
  }

  async getLanguageBySlug(slug: string): Promise<LanguageCatalogResponse> {
    const normalizedSlug = normalizeLanguageSlug(slug);
    const language = await this.profiles.findBySlug(normalizedSlug);
    if (!language) {
      throw profileFailure('LANGUAGE_NOT_FOUND', 'Language was not found', 404);
    }
    if (!language.active) {
      throw profileFailure('LANGUAGE_INACTIVE', 'Language is not active', 404);
    }
    return toLanguageCatalogResponse(language);
  }

  async getOwnProfile(userId: string): Promise<OwnProfileResponse> {
    const user = await this.requireActiveUser(userId);
    return this.toOwnProfile(user, await this.profiles.findProfile(userId));
  }

  async getPublicProfile(userId: string): Promise<PublicProfileResponse> {
    const user = await this.requireActiveUser(userId);
    const profile = await this.profiles.findProfile(userId);
    return {
      scope: 'public',
      user: {
        id: user.id,
        displayName: user.displayName,
      },
      languages: profile.languages
        .filter((language) => language.visibility === 'PUBLIC')
        .map((language) => this.toPublicProfileLanguage(language)),
      goals: [...profile.goals],
      skills: [...profile.skills],
      interests: [...profile.interests],
    };
  }

  async updateOwnProfile(userId: string, input: ProfileUpdateInput): Promise<OwnProfileResponse> {
    const currentUser = await this.requireActiveUser(userId);
    const currentProfile = await this.profiles.findProfile(userId);
    const displayName = input.displayName === undefined
      ? undefined
      : normalizeDisplayName(input.displayName);
    const replacement = await this.normalizeReplacement(currentProfile, input);

    let profile: ProfileRecord;
    try {
      profile = await this.profiles.replaceProfile(userId, replacement);
    } catch (error) {
      if (error instanceof ProfileRepositoryConflictError) {
        throw profileFailure('PROFILE_CONFLICT', 'Profile data conflicts with another update');
      }
      throw error;
    }

    let user = currentUser;
    if (displayName !== undefined) {
      user = (await this.identities.updateUser(userId, { displayName })) ?? currentUser;
    }
    return this.toOwnProfile(user, profile);
  }

  private async normalizeReplacement(
    current: ProfileRecord,
    input: ProfileUpdateInput,
  ): Promise<ReplaceProfileInput> {
    return {
      languages: input.languages === undefined
        ? current.languages.map((language) => ({
            languageCode: language.language.code,
            roles: language.roles,
            declaredProficiency: language.declaredProficiency,
            isPrimaryLearningTarget: language.isPrimaryLearningTarget,
            visibility: language.visibility,
          }))
        : await this.normalizeLanguages(input.languages),
      goals: input.goals === undefined ? [...current.goals] : normalizeGoals(input.goals),
      skills: input.skills === undefined ? [...current.skills] : normalizeSkills(input.skills),
      interests: input.interests === undefined
        ? [...current.interests]
        : normalizeInterests(input.interests),
      timezone: input.timezone === undefined
        ? current.timezone
        : normalizeTimezone(input.timezone),
      availability: input.availability === undefined
        ? current.availability.map((window) => ({ ...window }))
        : normalizeAvailability(input.availability),
    };
  }

  private async normalizeLanguages(
    input: readonly ProfileLanguageUpdateInput[] | null,
  ): Promise<UserLanguageInput[]> {
    if (!Array.isArray(input) || input.length > MAX_LANGUAGES) {
      throw profileFailure('PROFILE_INVALID_LANGUAGES', 'Too many or invalid language relations');
    }
    const normalizedCodes = input.map((relation) => normalizeLanguageCode(relation?.languageCode));
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      throw profileFailure('PROFILE_DUPLICATE_LANGUAGE', 'A language relation is duplicated');
    }

    const catalog = await this.profiles.findByCodes(normalizedCodes);
    const catalogByCode = new Map(catalog.map((language) => [language.code, language]));
    for (const code of normalizedCodes) {
      const language = catalogByCode.get(code);
      if (!language) {
        throw profileFailure('PROFILE_LANGUAGE_UNKNOWN', 'The selected language is not available');
      }
      if (!language.active) {
        throw profileFailure('PROFILE_LANGUAGE_INACTIVE', 'The selected language is not active');
      }
    }

    let primaryCount = 0;
    return input.map((relation, index) => {
      if (!relation || !Array.isArray(relation.roles) || relation.roles.length === 0 || relation.roles.length > 3) {
        throw profileFailure('PROFILE_INVALID_LANGUAGE_ROLES', 'Language roles are invalid');
      }
      const roles = (relation.roles as readonly string[]).map((role: string) => normalizeRole(role));
      if (new Set(roles).size !== roles.length) {
        throw profileFailure('PROFILE_DUPLICATE_LANGUAGE_ROLE', 'A language role is duplicated');
      }
      const declaredProficiency = normalizeDeclaredProficiency(relation.declaredProficiency);
      const isNative = roles.includes('native');
      if ((declaredProficiency === 'NATIVE') !== isNative) {
        throw profileFailure('PROFILE_INVALID_PROFICIENCY', 'Native proficiency must match the native role');
      }
      if (
        relation.isPrimaryLearningTarget !== undefined &&
        typeof relation.isPrimaryLearningTarget !== 'boolean'
      ) {
        throw profileFailure('PROFILE_INVALID_PRIMARY_TARGET', 'Primary learning target flag is invalid');
      }
      const isPrimaryLearningTarget = relation.isPrimaryLearningTarget ?? false;
      if (isPrimaryLearningTarget && !roles.includes('learning')) {
        throw profileFailure('PROFILE_INVALID_PRIMARY_TARGET', 'The primary target must be a learning language');
      }
      if (isPrimaryLearningTarget) primaryCount += 1;
      const visibility = normalizeVisibility(relation.visibility);
      return {
        languageCode: normalizedCodes[index],
        roles,
        declaredProficiency,
        isPrimaryLearningTarget,
        visibility,
      };
    }).map((relation) => {
      if (primaryCount > 1) {
        throw profileFailure('PROFILE_INVALID_PRIMARY_TARGET', 'Only one primary learning target is allowed');
      }
      return relation;
    });
  }

  private async requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await this.identities.findUserById(userId);
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw profileFailure('PROFILE_NOT_FOUND', 'Profile was not found', 404);
    }
    return user;
  }

  private toOwnProfile(user: UserRecord, profile: ProfileRecord): OwnProfileResponse {
    return {
      scope: 'own',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        emailVerified: Boolean(user.emailVerifiedAt),
      },
      languages: profile.languages.map((language) => this.toProfileLanguage(language)),
      goals: [...profile.goals],
      skills: [...profile.skills],
      interests: [...profile.interests],
      timezone: profile.timezone,
      availability: profile.availability.map((window) => ({
        dayOfWeek: window.dayOfWeek,
        startTime: formatMinute(window.startMinute),
        endTime: formatMinute(window.endMinute),
      })),
    };
  }

  private toProfileLanguage(
    language: ProfileRecord['languages'][number],
  ): ProfileLanguageResponse {
    return {
      code: language.language.code,
      slug: language.language.slug,
      nativeName: language.language.nativeName,
      englishName: language.language.englishName,
      vietnameseName: language.language.vietnameseName,
      direction: language.language.direction,
      roles: [...language.roles],
      declaredProficiency: language.declaredProficiency,
      assessedProficiency: language.assessedProficiency,
      isPrimaryLearningTarget: language.isPrimaryLearningTarget,
      visibility: language.visibility,
    };
  }

  private toPublicProfileLanguage(
    language: ProfileRecord['languages'][number],
  ): PublicProfileLanguageResponse {
    const profileLanguage = this.toProfileLanguage(language);
    return {
      code: profileLanguage.code,
      slug: profileLanguage.slug,
      nativeName: profileLanguage.nativeName,
      englishName: profileLanguage.englishName,
      vietnameseName: profileLanguage.vietnameseName,
      direction: profileLanguage.direction,
      roles: [...profileLanguage.roles],
      declaredProficiency: profileLanguage.declaredProficiency,
      assessedProficiency: profileLanguage.assessedProficiency,
      isPrimaryLearningTarget: profileLanguage.isPrimaryLearningTarget,
    };
  }
}

function normalizeLanguageCode(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 35) {
    throw profileFailure('PROFILE_INVALID_LANGUAGE', 'Language code is invalid');
  }
  return value.trim().toLowerCase();
}

function normalizeLanguageSlug(value: unknown): string {
  if (typeof value !== 'string') {
    throw profileFailure('LANGUAGE_INVALID_SLUG', 'Language slug is invalid');
  }
  const slug = value.normalize('NFKC').trim().toLowerCase();
  if (slug.length === 0 || slug.length > 64 || !LANGUAGE_SLUG_PATTERN.test(slug)) {
    throw profileFailure('LANGUAGE_INVALID_SLUG', 'Language slug is invalid');
  }
  return slug;
}

function toLanguageCatalogResponse(
  language: LanguageCatalogRecord,
): LanguageCatalogResponse {
  return {
    code: language.code,
    slug: language.slug,
    nativeName: language.nativeName,
    englishName: language.englishName,
    vietnameseName: language.vietnameseName,
    direction: language.direction,
    active: language.active,
    launch: language.launch,
    sortOrder: language.sortOrder,
  };
}

function normalizeRole(value: unknown): LanguageRole {
  if (typeof value !== 'string') {
    throw profileFailure('PROFILE_INVALID_LANGUAGE_ROLES', 'Language roles are invalid');
  }
  const role = value.trim().toLowerCase() as LanguageRole;
  if (!LANGUAGE_ROLES.has(role)) {
    throw profileFailure('PROFILE_INVALID_LANGUAGE_ROLES', 'Language roles are invalid');
  }
  return role;
}

function normalizeDeclaredProficiency(value: unknown): DeclaredLanguageProficiency {
  if (typeof value !== 'string') {
    throw profileFailure('PROFILE_INVALID_PROFICIENCY', 'Declared proficiency is invalid');
  }
  const proficiency = value.trim().toUpperCase() as DeclaredLanguageProficiency;
  if (!DECLARED_PROFICIENCIES.has(proficiency)) {
    throw profileFailure('PROFILE_INVALID_PROFICIENCY', 'Declared proficiency is invalid');
  }
  return proficiency;
}

function normalizeVisibility(value: unknown): LanguageVisibility {
  if (value === undefined) return 'PUBLIC';
  if (typeof value !== 'string') {
    throw profileFailure('PROFILE_INVALID_VISIBILITY', 'Language visibility is invalid');
  }
  const visibility = value.trim().toUpperCase() as LanguageVisibility;
  if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE') {
    throw profileFailure('PROFILE_INVALID_VISIBILITY', 'Language visibility is invalid');
  }
  return visibility;
}

function normalizeGoals(input: readonly string[] | null): string[] {
  if (!Array.isArray(input) || input.length > MAX_GOALS) {
    throw profileFailure('PROFILE_INVALID_GOALS', 'Goals are invalid or too numerous');
  }
  const goals = input.map((goal) => {
    if (typeof goal !== 'string') {
      throw profileFailure('PROFILE_INVALID_GOALS', 'Goals are invalid');
    }
    const normalized = goal.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
      throw profileFailure('PROFILE_INVALID_GOALS', 'Goals are invalid');
    }
    return normalized;
  });
  if (new Set(goals).size !== goals.length) {
    throw profileFailure('PROFILE_DUPLICATE_GOAL', 'A goal is duplicated');
  }
  return goals;
}

function normalizeSkills(input: readonly string[] | null): ProfileSkill[] {
  if (!Array.isArray(input) || input.length > MAX_SKILLS) {
    throw profileFailure('PROFILE_INVALID_SKILLS', 'Skills are invalid or too numerous');
  }
  const skills = input.map((skill) => {
    if (typeof skill !== 'string') {
      throw profileFailure('PROFILE_INVALID_SKILLS', 'Skills are invalid');
    }
    const normalized = skill.trim().toLowerCase() as ProfileSkill;
    if (!PROFILE_SKILLS.has(normalized)) {
      throw profileFailure('PROFILE_INVALID_SKILLS', 'Skills are invalid');
    }
    return normalized;
  });
  if (new Set(skills).size !== skills.length) {
    throw profileFailure('PROFILE_DUPLICATE_SKILL', 'A skill is duplicated');
  }
  return skills;
}

function normalizeInterests(input: readonly string[] | null): string[] {
  if (!Array.isArray(input) || input.length > MAX_INTERESTS) {
    throw profileFailure('PROFILE_INVALID_INTERESTS', 'Interests are invalid or too numerous');
  }
  const interests = input.map((interest) => {
    if (typeof interest !== 'string') {
      throw profileFailure('PROFILE_INVALID_INTERESTS', 'Interests are invalid');
    }
    const normalized = interest.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length === 0 || normalized.length > 64) {
      throw profileFailure('PROFILE_INVALID_INTERESTS', 'Interests are invalid');
    }
    return normalized;
  });
  if (new Set(interests).size !== interests.length) {
    throw profileFailure('PROFILE_DUPLICATE_INTEREST', 'An interest is duplicated');
  }
  return interests;
}

function normalizeTimezone(input: string | null): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') {
    throw profileFailure('PROFILE_INVALID_TIMEZONE', 'Timezone must be an IANA identifier');
  }
  const timezone = input.trim();
  if (!timezone || timezone.length > 64 || !isIanaTimezone(timezone)) {
    throw profileFailure('PROFILE_INVALID_TIMEZONE', 'Timezone must be an IANA identifier');
  }
  return timezone;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeAvailability(
  input: readonly ProfileAvailabilityUpdateInput[] | null,
): AvailabilityWindowRecord[] {
  if (!Array.isArray(input) || input.length > MAX_AVAILABILITY_WINDOWS) {
    throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability is invalid or too numerous');
  }
  const windows = input.map((window) => {
    if (
      !window ||
      !Number.isInteger(window.dayOfWeek) ||
      window.dayOfWeek < 1 ||
      window.dayOfWeek > 7
    ) {
      throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability day is invalid');
    }
    const startMinute = parseTime(window.startTime, false);
    const endMinute = parseTime(window.endTime, true);
    if (startMinute >= endMinute) {
      throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability range must be positive');
    }
    return { dayOfWeek: window.dayOfWeek, startMinute, endMinute };
  });

  const byDay = new Map<number, AvailabilityWindowRecord[]>();
  for (const window of windows) {
    const day = byDay.get(window.dayOfWeek) ?? [];
    day.push(window);
    byDay.set(window.dayOfWeek, day);
  }
  for (const day of byDay.values()) {
    day.sort((left, right) => left.startMinute - right.startMinute);
    for (let index = 1; index < day.length; index += 1) {
      if (day[index - 1].endMinute > day[index].startMinute) {
        throw profileFailure('PROFILE_AVAILABILITY_OVERLAP', 'Availability windows must not overlap');
      }
    }
  }
  return windows;
}

function parseTime(value: unknown, allowEndOfDay: boolean): number {
  if (typeof value !== 'string') {
    throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability time is invalid');
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability time is invalid');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23 || (hour === 24 && minute !== 0)) {
    if (!(allowEndOfDay && value === '24:00')) {
      throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability time is invalid');
    }
  }
  if (allowEndOfDay && value === '24:00') return 1440;
  if (hour > 23) {
    throw profileFailure('PROFILE_INVALID_AVAILABILITY', 'Availability time is invalid');
  }
  return hour * 60 + minute;
}

function formatMinute(value: number): string {
  if (value === 1440) return '24:00';
  const hour = Math.floor(value / 60).toString().padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return hour + ':' + minute;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw profileFailure('PROFILE_INVALID_DISPLAY_NAME', 'Display name is invalid');
  }
  const displayName = value.trim();
  if (displayName.length < 2 || displayName.length > 120 || !/\S/.test(displayName)) {
    throw profileFailure('PROFILE_INVALID_DISPLAY_NAME', 'Display name is invalid');
  }
  return displayName;
}

function profileFailure(
  code: string,
  message: string,
  status = 400,
): ProfileFailure {
  return new ProfileFailure(code, status, message);
}
