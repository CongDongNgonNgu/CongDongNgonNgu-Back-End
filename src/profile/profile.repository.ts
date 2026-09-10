import {
  InMemoryLanguageCatalogRepository,
  ProfileRepositoryConflictError,
  type LanguageCatalogRepository,
} from './language-catalog';
import type {
  ProfileRecord,
  ReplaceProfileInput,
  UserLanguageRecord,
} from './profile.types';

export const PROFILE_REPOSITORY = 'PROFILE_REPOSITORY';

export interface ProfileRepository extends LanguageCatalogRepository {
  findProfile(userId: string): Promise<ProfileRecord>;
  replaceProfile(userId: string, input: ReplaceProfileInput): Promise<ProfileRecord>;
}

export class InMemoryProfileRepository
  extends InMemoryLanguageCatalogRepository
  implements ProfileRepository {
  private readonly profiles = new Map<string, ProfileRecord>();

  async findProfile(userId: string): Promise<ProfileRecord> {
    return cloneProfile(this.profiles.get(userId) ?? emptyProfile());
  }

  async replaceProfile(userId: string, input: ReplaceProfileInput): Promise<ProfileRecord> {
    const codes = input.languages.map((language) => language.languageCode);
    if (new Set(codes).size !== codes.length) {
      throw new ProfileRepositoryConflictError('A user language relation already exists');
    }
    const languages = await this.findActiveByCodes(codes);
    if (languages.length !== codes.length) {
      throw new ProfileRepositoryConflictError('A language is unavailable');
    }
    const catalogByCode = new Map(languages.map((language) => [language.code, language]));
    const existingByCode = new Map(
      (this.profiles.get(userId)?.languages ?? [])
        .map((language) => [language.language.code, language]),
    );
    const languageRecords: UserLanguageRecord[] = input.languages.map((language) => ({
      language: catalogByCode.get(language.languageCode)!,
      roles: [...language.roles],
      declaredProficiency: language.declaredProficiency,
      assessedProficiency: existingByCode.get(language.languageCode)?.assessedProficiency ?? null,
      isPrimaryLearningTarget: language.isPrimaryLearningTarget,
      visibility: language.visibility,
    }));
    const profile: ProfileRecord = {
      languages: languageRecords,
      goals: [...input.goals],
      skills: [...input.skills],
      interests: [...input.interests],
      timezone: input.timezone,
      availability: input.availability.map((window) => ({ ...window })),
    };
    this.profiles.set(userId, profile);
    return cloneProfile(profile);
  }
}

function emptyProfile(): ProfileRecord {
  return {
    languages: [],
    goals: [],
    skills: [],
    interests: [],
    timezone: null,
    availability: [],
  };
}

function cloneProfile(profile: ProfileRecord): ProfileRecord {
  return {
    languages: profile.languages.map((language) => ({
      ...language,
      language: {
        ...language.language,
        createdAt: new Date(language.language.createdAt),
        updatedAt: new Date(language.language.updatedAt),
      },
      roles: [...language.roles],
    })),
    goals: [...profile.goals],
    skills: [...profile.skills],
    interests: [...profile.interests],
    timezone: profile.timezone,
    availability: profile.availability.map((window) => ({ ...window })),
  };
}
