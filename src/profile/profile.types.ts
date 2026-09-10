export type LanguageDirection = 'ltr' | 'rtl';

export type LanguageRole = 'native' | 'known' | 'learning';

export type DeclaredLanguageProficiency =
  | 'NATIVE'
  | 'A1'
  | 'A2'
  | 'B1'
  | 'B2'
  | 'C1'
  | 'C2';

export type AssessedLanguageProficiency =
  | 'A1'
  | 'A2'
  | 'B1'
  | 'B2'
  | 'C1'
  | 'C2';

export type LanguageVisibility = 'PUBLIC' | 'PRIVATE';

export type ProfileSkill =
  | 'speaking'
  | 'listening'
  | 'reading'
  | 'writing'
  | 'grammar'
  | 'vocabulary';

export interface LanguageCatalogSeed {
  code: string;
  slug: string;
  nativeName: string;
  englishName: string;
  vietnameseName: string;
  direction: LanguageDirection;
  active: boolean;
  launch: boolean;
  sortOrder: number;
}

export interface LanguageCatalogRecord extends LanguageCatalogSeed {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserLanguageInput {
  languageCode: string;
  roles: readonly LanguageRole[];
  declaredProficiency: DeclaredLanguageProficiency;
  isPrimaryLearningTarget: boolean;
  visibility: LanguageVisibility;
}

export interface UserLanguageRecord {
  language: LanguageCatalogRecord;
  roles: LanguageRole[];
  declaredProficiency: DeclaredLanguageProficiency;
  assessedProficiency: AssessedLanguageProficiency | null;
  isPrimaryLearningTarget: boolean;
  visibility: LanguageVisibility;
}

export interface AvailabilityWindowRecord {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface ProfileRecord {
  languages: UserLanguageRecord[];
  goals: string[];
  skills: ProfileSkill[];
  interests: string[];
  timezone: string | null;
  availability: AvailabilityWindowRecord[];
}

export interface ReplaceProfileInput {
  languages: readonly UserLanguageInput[];
  goals: readonly string[];
  skills: readonly ProfileSkill[];
  interests: readonly string[];
  timezone: string | null;
  availability: readonly AvailabilityWindowRecord[];
}
