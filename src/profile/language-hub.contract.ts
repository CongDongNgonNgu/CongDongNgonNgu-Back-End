import type { LanguageCatalogResponse } from './profile.service';

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export type CefrLevel = typeof CEFR_LEVELS[number];

export type HubMetric =
  | {
      state: 'AVAILABLE';
      value: number;
    }
  | {
      state: 'REAL_ZERO';
      value: 0;
    }
  | {
      state: 'NOT_AVAILABLE_YET';
      value: null;
    };

export type HubSectionKey =
  | 'overview'
  | 'vocabulary'
  | 'grammar'
  | 'sentences'
  | 'pronunciation'
  | 'resources'
  | 'community'
  | 'questions'
  | 'practice'
  | 'exchange';

export type HubSectionStatus =
  | 'AVAILABLE'
  | 'EMPTY'
  | 'NOT_IMPLEMENTED'
  | 'DISABLED';

export interface HubSectionAvailability {
  key: HubSectionKey;
  status: HubSectionStatus;
  isNavigable: boolean;
  href: string | null;
}

export interface LanguageHubFilterSummary {
  levels: CefrLevel[];
  topic: string | null;
  levelOptions: CefrLevel[];
  levelRequired: false;
  topicState: 'NOT_AVAILABLE_YET';
}

export interface LanguageHubOverviewResponse {
  language: LanguageCatalogResponse;
  seo: {
    title: string;
    description: string;
    canonicalPath: string;
  };
  metrics: {
    learnerCount: HubMetric;
    contributorCount: HubMetric;
    resourceCount: HubMetric;
  };
  sections: HubSectionAvailability[];
  filters: LanguageHubFilterSummary;
}

const FUTURE_HUB_SECTION_KEYS: readonly HubSectionKey[] = [
  'vocabulary',
  'grammar',
  'sentences',
  'pronunciation',
  'resources',
  'community',
  'questions',
  'practice',
  'exchange',
];

export function buildLanguageHubOverview(
  language: LanguageCatalogResponse,
): LanguageHubOverviewResponse {
  const canonicalPath = '/languages/' + language.slug;
  return {
    language,
    seo: {
      title: language.englishName + ' Language Hub',
      description: 'Explore the ' + language.englishName + ' language hub on CongDongNgonNgu.vn.',
      canonicalPath,
    },
    metrics: {
      learnerCount: buildUnavailableMetric(),
      contributorCount: buildUnavailableMetric(),
      resourceCount: buildUnavailableMetric(),
    },
    sections: buildLanguageHubSections(language.slug),
    filters: buildLanguageHubFilterSummary(),
  };
}

export function buildLanguageHubSections(slug: string): HubSectionAvailability[] {
  const overviewPath = '/languages/' + slug;
  return [
    {
      key: 'overview',
      status: 'AVAILABLE',
      isNavigable: true,
      href: overviewPath,
    },
    ...FUTURE_HUB_SECTION_KEYS.map((key) => ({
      key,
      status: 'NOT_IMPLEMENTED' as const,
      isNavigable: false,
      href: null,
    })),
  ];
}

export function buildLanguageHubFilterSummary(): LanguageHubFilterSummary {
  return {
    levels: [],
    topic: null,
    levelOptions: [...CEFR_LEVELS],
    levelRequired: false,
    topicState: 'NOT_AVAILABLE_YET',
  };
}

function buildUnavailableMetric(): HubMetric {
  return {
    state: 'NOT_AVAILABLE_YET',
    value: null,
  };
}
