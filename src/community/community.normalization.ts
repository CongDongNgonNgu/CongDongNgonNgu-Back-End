import {
  COMMUNITY_CEFR_LEVELS,
  COMMUNITY_POST_TYPES,
  COMMUNITY_REPORT_CATEGORIES,
  COMMUNITY_REPORT_TARGET_TYPES,
  COMMUNITY_REACTION_TYPES,
  COMMUNITY_VISIBILITIES,
  type CommunityCefrLevel,
  type CommunityPostType,
  type CommunityReportCategory,
  type CommunityReportTargetType,
  type CommunityReactionType,
  type CommunityVisibility,
} from './community.types';

export const MAX_POST_CONTENT_LENGTH = 20_000;
export const MAX_COMMENT_CONTENT_LENGTH = 5_000;
export const MAX_REPORT_DETAILS_LENGTH = 1_000;
export const MAX_TOPIC_LENGTH = 80;

export class CommunityValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommunityValidationError';
  }
}

export function normalizeCommunityContent(
  input: unknown,
  maxLength = MAX_POST_CONTENT_LENGTH,
): string {
  if (typeof input !== 'string') throw new CommunityValidationError('COMMUNITY_CONTENT_INVALID');

  const normalized = input
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\r\n]+/gu, ' ').trim())
    .join('\n')
    .trim();

  if (Array.from(normalized.replace(/\s/gu, '')).length === 0) {
    throw new CommunityValidationError('COMMUNITY_CONTENT_EMPTY');
  }
  if (Array.from(normalized).length > maxLength) {
    throw new CommunityValidationError('COMMUNITY_CONTENT_TOO_LONG');
  }
  return normalized;
}

export function normalizeCommunityTopic(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new CommunityValidationError('COMMUNITY_TOPIC_INVALID');

  const topic = input
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');
  if (topic.length === 0) return null;
  if (
    Array.from(topic).length > MAX_TOPIC_LENGTH ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(topic)
  ) {
    throw new CommunityValidationError('COMMUNITY_TOPIC_INVALID');
  }
  return topic;
}

export function normalizePostType(input: unknown): CommunityPostType {
  const value = normalizeUpperString(input);
  if (!COMMUNITY_POST_TYPES.includes(value as CommunityPostType)) {
    throw new CommunityValidationError('COMMUNITY_POST_TYPE_INVALID');
  }
  return value as CommunityPostType;
}

export function normalizeCefrLevel(input: unknown): CommunityCefrLevel | null {
  if (input === undefined || input === null || input === '') return null;
  const value = normalizeUpperString(input);
  if (!COMMUNITY_CEFR_LEVELS.includes(value as CommunityCefrLevel)) {
    throw new CommunityValidationError('COMMUNITY_CEFR_INVALID');
  }
  return value as CommunityCefrLevel;
}

export function normalizeVisibility(input: unknown): CommunityVisibility {
  if (input === undefined || input === null || input === '') return 'PUBLIC';
  const value = normalizeUpperString(input);
  if (!COMMUNITY_VISIBILITIES.includes(value as CommunityVisibility)) {
    throw new CommunityValidationError('COMMUNITY_VISIBILITY_INVALID');
  }
  return value as CommunityVisibility;
}

export function normalizeReactionType(input: unknown): CommunityReactionType {
  const value = normalizeUpperString(input);
  if (!COMMUNITY_REACTION_TYPES.includes(value as CommunityReactionType)) {
    throw new CommunityValidationError('COMMUNITY_REACTION_INVALID');
  }
  return value as CommunityReactionType;
}

export function normalizeReportTargetType(input: unknown): CommunityReportTargetType {
  const value = normalizeUpperString(input);
  if (!COMMUNITY_REPORT_TARGET_TYPES.includes(value as CommunityReportTargetType)) {
    throw new CommunityValidationError('COMMUNITY_REPORT_TARGET_INVALID');
  }
  return value as CommunityReportTargetType;
}

export function normalizeReportCategory(input: unknown): CommunityReportCategory {
  const value = normalizeUpperString(input);
  if (!COMMUNITY_REPORT_CATEGORIES.includes(value as CommunityReportCategory)) {
    throw new CommunityValidationError('COMMUNITY_REPORT_CATEGORY_INVALID');
  }
  return value as CommunityReportCategory;
}

export function normalizeOptionalReportDetails(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  return normalizeCommunityContent(input, MAX_REPORT_DETAILS_LENGTH);
}

function normalizeUpperString(input: unknown): string {
  if (typeof input !== 'string') throw new CommunityValidationError('COMMUNITY_VALUE_INVALID');
  return input.normalize('NFKC').trim().toUpperCase();
}
