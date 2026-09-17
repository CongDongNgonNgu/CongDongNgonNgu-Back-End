import { describe, expect, it } from '@jest/globals';
import { defaultExchangePreferences } from './exchange.repository';
import {
  DEFAULT_MATCHING_WEIGHTS,
  evaluateMatch,
  rankMatches,
  type MatchingParticipant,
} from './matching-engine';
import type {
  LanguageCatalogRecord,
  ProfileRecord,
  UserLanguageRecord,
} from '../profile/profile.types';

describe('matching engine', () => {
  it('requires reciprocal multilingual value and explains both directions', () => {
    const viewer = participant('viewer', {
      offeredLanguageCodes: ['vi', 'ja'],
      wantedLanguageCodes: ['en', 'fr'],
    }, profile([
      relation('vi', 'Tiếng Việt', ['native'], 'NATIVE'),
      relation('ja', '日本語', ['known'], 'B2'),
      relation('en', 'English', ['learning'], 'A2'),
      relation('fr', 'Français', ['learning'], 'B1'),
    ]));
    const candidate = participant('candidate', {
      offeredLanguageCodes: ['en', 'fr'],
      wantedLanguageCodes: ['vi'],
    }, profile([
      relation('en', 'English', ['known'], 'C1'),
      relation('fr', 'Français', ['known'], 'B2'),
      relation('vi', 'Tiếng Việt', ['learning'], 'A1'),
    ]));

    const result = evaluateMatch(viewer, candidate);

    expect(result).not.toBeNull();
    expect(result?.signals.forwardLanguageCodes).toEqual(['en', 'fr']);
    expect(result?.signals.backwardLanguageCodes).toEqual(['vi']);
    expect(result?.normalizedScore).toBeGreaterThan(0);
    expect(result?.reasons.join(' ')).toContain('English');
    expect(result?.reasons.join(' ')).toContain('Tiếng Việt');
  });

  it('returns no match when either reciprocal direction is missing', () => {
    const viewer = participant('viewer', {
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    }, profile([
      relation('vi', 'Tiếng Việt', ['native'], 'NATIVE'),
      relation('en', 'English', ['learning'], 'A2'),
    ]));
    const candidate = participant('candidate', {
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['ja'],
    }, profile([
      relation('en', 'English', ['known'], 'C1'),
      relation('ja', '日本語', ['learning'], 'A1'),
    ]));

    expect(evaluateMatch(viewer, candidate)).toBeNull();
  });

  it('scores level, timezone, availability, goals and interests from real data', () => {
    const viewer = participant('viewer', {
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
      preferredPartnerLevels: ['C1'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
    }, profile([
      relation('vi', 'Tiếng Việt', ['native'], 'NATIVE'),
      relation('en', 'English', ['learning'], 'A2'),
    ], {
      timezone: 'Asia/Ho_Chi_Minh',
      availability: [{ dayOfWeek: 1, startMinute: 480, endMinute: 600 }],
      goals: ['conversation'],
      interests: ['music'],
    }));
    const candidate = participant('candidate', {
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
      preferredPartnerLevels: ['A2'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
    }, profile([
      relation('en', 'English', ['known'], 'C1'),
      relation('vi', 'Tiếng Việt', ['learning'], 'A1'),
    ], {
      timezone: 'Asia/Tokyo',
      availability: [{ dayOfWeek: 1, startMinute: 600, endMinute: 720 }],
      goals: ['conversation'],
      interests: ['music'],
    }));

    const result = evaluateMatch(viewer, candidate);

    expect(result?.signals.levelCompatibility).toBe(1);
    expect(result?.signals.timezoneOffsetDifferenceMinutes).toBe(120);
    expect(result?.signals.availabilityOverlap).toBe(true);
    expect(result?.signals.sharedGoalCodes).toEqual(['conversation']);
    expect(result?.signals.sharedInterestCodes).toEqual(['music']);
    expect(result?.reasons.join(' ')).toEqual(expect.stringContaining('Múi giờ tương thích'));
    expect(result?.reasons.join(' ')).toEqual(expect.stringContaining('Có khoảng thời gian học phù hợp'));
    expect(result?.reasons.join(' ')).toEqual(expect.stringContaining('conversation'));
    expect(result?.reasons.join(' ')).toEqual(expect.stringContaining('music'));
  });

  it('does not penalize missing availability or claim a schedule that is absent', () => {
    const viewer = participant('viewer', {
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    }, profile([
      relation('vi', 'Tiếng Việt', ['native'], 'NATIVE'),
      relation('en', 'English', ['learning'], 'A2'),
    ], { timezone: 'Asia/Ho_Chi_Minh' }));
    const candidate = participant('candidate', {
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
    }, profile([
      relation('en', 'English', ['known'], 'C1'),
      relation('vi', 'Tiếng Việt', ['learning'], 'A1'),
    ], { timezone: 'Asia/Tokyo' }));

    const result = evaluateMatch(viewer, candidate);

    expect(result?.signals.availabilityOverlap).toBeNull();
    expect(result?.normalizedScore).toBeGreaterThan(0);
    expect(result?.reasons.join(' ')).not.toContain('khung giờ');
  });

  it('uses configurable weights and deterministic score then id ordering', () => {
    const viewer = participant('viewer', {
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    }, profile([
      relation('vi', 'Tiếng Việt', ['native'], 'NATIVE'),
      relation('en', 'English', ['learning'], 'A2'),
    ]));
    const candidate = participant('candidate', {
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
    }, profile([
      relation('en', 'English', ['known'], 'C1'),
      relation('vi', 'Tiếng Việt', ['learning'], 'A1'),
    ]));
    const result = evaluateMatch(viewer, candidate, {
      ...DEFAULT_MATCHING_WEIGHTS,
      reciprocalLanguage: 2,
      levelCompatibility: 0,
      timezoneAvailability: 0,
      sharedGoalsInterests: 0,
    });

    expect(result?.normalizedScore).toBe(1);
    expect(rankMatches([
      { userId: 'b', match: { normalizedScore: 0.8 } },
      { userId: 'c', match: { normalizedScore: 1 } },
      { userId: 'a', match: { normalizedScore: 1 } },
    ]).map((item) => item.userId)).toEqual(['a', 'c', 'b']);
  });
});

function participant(
  userId: string,
  preferenceInput: Partial<ReturnType<typeof defaultExchangePreferences>>,
  profileRecord: ProfileRecord,
): MatchingParticipant {
  return {
    userId,
    preferences: {
      ...defaultExchangePreferences(userId),
      exchangeOptIn: true,
      discoverable: true,
      ...preferenceInput,
    },
    profile: profileRecord,
  };
}

function profile(
  languages: UserLanguageRecord[],
  overrides: Partial<ProfileRecord> = {},
): ProfileRecord {
  return {
    languages,
    goals: [],
    skills: [],
    interests: [],
    timezone: null,
    availability: [],
    ...overrides,
  };
}

function relation(
  code: string,
  englishName: string,
  roles: Array<'native' | 'known' | 'learning'>,
  declaredProficiency: UserLanguageRecord['declaredProficiency'],
): UserLanguageRecord {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const catalog: LanguageCatalogRecord = {
    id: code,
    code,
    slug: code,
    nativeName: englishName,
    englishName,
    vietnameseName: englishName,
    direction: 'ltr',
    active: true,
    launch: true,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  };
  return {
    language: catalog,
    roles,
    declaredProficiency,
    assessedProficiency: null,
    isPrimaryLearningTarget: false,
    visibility: 'PUBLIC',
  };
}
