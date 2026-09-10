import { randomUUID } from 'node:crypto';
import type {
  LanguageCatalogRecord,
  LanguageCatalogSeed,
} from './profile.types';

export const INITIAL_LANGUAGE_CATALOG: readonly LanguageCatalogSeed[] = [
  {
    code: 'vi',
    slug: 'vietnamese',
    nativeName: 'Tiếng Việt',
    englishName: 'Vietnamese',
    vietnameseName: 'Tiếng Việt',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 10,
  },
  {
    code: 'en',
    slug: 'english',
    nativeName: 'English',
    englishName: 'English',
    vietnameseName: 'Tiếng Anh',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 20,
  },
  {
    code: 'zh',
    slug: 'chinese',
    nativeName: '中文',
    englishName: 'Chinese',
    vietnameseName: 'Tiếng Trung',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 30,
  },
  {
    code: 'ja',
    slug: 'japanese',
    nativeName: '日本語',
    englishName: 'Japanese',
    vietnameseName: 'Tiếng Nhật',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 40,
  },
  {
    code: 'ko',
    slug: 'korean',
    nativeName: '한국어',
    englishName: 'Korean',
    vietnameseName: 'Tiếng Hàn',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 50,
  },
  {
    code: 'fr',
    slug: 'french',
    nativeName: 'Français',
    englishName: 'French',
    vietnameseName: 'Tiếng Pháp',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 60,
  },
  {
    code: 'de',
    slug: 'german',
    nativeName: 'Deutsch',
    englishName: 'German',
    vietnameseName: 'Tiếng Đức',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 70,
  },
  {
    code: 'es',
    slug: 'spanish',
    nativeName: 'Español',
    englishName: 'Spanish',
    vietnameseName: 'Tiếng Tây Ban Nha',
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 80,
  },
];

export class ProfileRepositoryConflictError extends Error {
  constructor(message = 'Profile data conflicts with an existing record') {
    super(message);
    this.name = 'ProfileRepositoryConflictError';
  }
}

export interface LanguageCatalogRepository {
  listActive(search?: string, limit?: number): Promise<LanguageCatalogRecord[]>;
  findByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]>;
  findActiveByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]>;
}

export class InMemoryLanguageCatalogRepository implements LanguageCatalogRepository {
  protected readonly languagesByCode = new Map<string, LanguageCatalogRecord>();
  protected readonly codesBySlug = new Map<string, string>();

  constructor() {
    this.seedSync(INITIAL_LANGUAGE_CATALOG);
  }

  async listActive(search = '', limit = 50): Promise<LanguageCatalogRecord[]> {
    const normalizedSearch = search.trim().toLowerCase();
    return [...this.languagesByCode.values()]
      .filter((language) => language.active)
      .filter((language) => {
        if (!normalizedSearch) return true;
        return [
          language.code,
          language.slug,
          language.nativeName,
          language.englishName,
          language.vietnameseName,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      })
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .slice(0, limit)
      .map(cloneLanguage);
  }

  async findByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]> {
    return codes
      .map((code) => this.languagesByCode.get(normalizeCode(code)))
      .filter((language): language is LanguageCatalogRecord => Boolean(language))
      .map(cloneLanguage);
  }

  async findActiveByCodes(codes: readonly string[]): Promise<LanguageCatalogRecord[]> {
    const languages = await this.findByCodes(codes);
    return languages.filter((language) => language.active);
  }

  async seed(seeds: readonly LanguageCatalogSeed[]): Promise<void> {
    this.seedSync(seeds);
  }

  async setActive(code: string, active: boolean): Promise<void> {
    const language = this.languagesByCode.get(normalizeCode(code));
    if (!language) return;
    language.active = active;
    language.updatedAt = new Date();
  }

  private seedSync(seeds: readonly LanguageCatalogSeed[]): void {
    const payloadCodes = new Set<string>();
    const payloadSlugs = new Set<string>();
    for (const seed of seeds) {
      const code = normalizeCode(seed.code);
      const slug = normalizeSlug(seed.slug);
      if (payloadCodes.has(code)) {
        throw new ProfileRepositoryConflictError('Duplicate language code');
      }
      if (payloadSlugs.has(slug)) {
        throw new ProfileRepositoryConflictError('Duplicate language slug');
      }
      payloadCodes.add(code);
      payloadSlugs.add(slug);
    }

    for (const seed of seeds) {
      const code = normalizeCode(seed.code);
      const slug = normalizeSlug(seed.slug);
      const existing = this.languagesByCode.get(code);
      const conflictingCode = this.codesBySlug.get(slug);
      if (conflictingCode && conflictingCode !== code) {
        throw new ProfileRepositoryConflictError('Language slug already exists');
      }
      const now = new Date();
      const record: LanguageCatalogRecord = existing
        ? {
            ...existing,
            ...seed,
            code,
            slug,
            updatedAt: now,
          }
        : {
            ...seed,
            id: randomUUID(),
            code,
            slug,
            createdAt: now,
            updatedAt: now,
          };
      if (existing && existing.slug !== slug) {
        this.codesBySlug.delete(existing.slug);
      }
      this.languagesByCode.set(code, record);
      this.codesBySlug.set(slug, code);
    }
  }
}

function normalizeCode(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function cloneLanguage(language: LanguageCatalogRecord): LanguageCatalogRecord {
  return {
    ...language,
    createdAt: new Date(language.createdAt),
    updatedAt: new Date(language.updatedAt),
  };
}
