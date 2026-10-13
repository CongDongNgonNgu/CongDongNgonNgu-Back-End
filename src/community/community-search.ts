import { communityFailure } from './community.errors';
import { normalizeCommunityTopic } from './community.normalization';
import {
  COMMUNITY_POST_TYPES,
  type CommunityPostType,
} from './community.types';
export interface CommunitySearchFilters {
  q?: string;
  languageCode?: string;
  postType?: CommunityPostType;
  topic?: string;
  responseState?: 'UNANSWERED' | 'ANSWERED' | 'ACCEPTED';
  savedByMe: boolean;
  sort: 'NEWEST' | 'USEFUL';
  limit: number;
}
export interface CommunitySearchPosition {
  id: string;
  createdAt: string;
  helpfulCount: number;
}
export interface CommunitySearchInput {
  q?: unknown;
  languageCode?: unknown;
  postType?: unknown;
  topic?: unknown;
  responseState?: unknown;
  savedByMe?: unknown;
  sort?: unknown;
  limit?: unknown;
}
export function normalizeCommunitySearch(
  input: CommunitySearchInput,
): CommunitySearchFilters {
  const fail = () =>
    communityFailure('COMMUNITY_SEARCH_INVALID', 'Search filters are invalid');
  const result: CommunitySearchFilters = {
    savedByMe: false,
    sort: 'NEWEST',
    limit: 20,
  };
  if (input.q !== undefined) {
    if (typeof input.q !== 'string') return fail();
    const q = input.q.normalize('NFKC').trim();
    if (Array.from(q).length > 120 || /[\u0000-\u001f\u007f]/u.test(q))
      return fail();
    if (q) result.q = q;
  }
  if (input.languageCode !== undefined) {
    if (typeof input.languageCode !== 'string') return fail();
    const code = input.languageCode.normalize('NFKC').trim().toLowerCase();
    if (code.length > 35 || !/^[a-z]{2,35}(?:-[a-z0-9]{2,8})*$/.test(code))
      return fail();
    result.languageCode = code;
  }
  if (input.postType !== undefined) {
    if (
      typeof input.postType !== 'string' ||
      !COMMUNITY_POST_TYPES.includes(input.postType as CommunityPostType)
    )
      return fail();
    result.postType = input.postType as CommunityPostType;
  }
  if (input.topic !== undefined) {
    try {
      const topic = normalizeCommunityTopic(input.topic);
      if (topic) result.topic = topic;
    } catch {
      return fail();
    }
  }
  if (input.responseState !== undefined) {
    if (
      typeof input.responseState !== 'string' ||
      !['UNANSWERED', 'ANSWERED', 'ACCEPTED'].includes(input.responseState)
    )
      return fail();
    if (result.postType && result.postType !== 'QUESTION') return fail();
    result.postType = 'QUESTION';
    result.responseState =
      input.responseState as CommunitySearchFilters['responseState'];
  }
  if (input.savedByMe !== undefined) {
    if (
      !['true', 'false', true, false].includes(
        input.savedByMe as string | boolean,
      )
    )
      return fail();
    result.savedByMe = input.savedByMe === true || input.savedByMe === 'true';
  }
  if (input.sort !== undefined) {
    if (input.sort !== 'NEWEST' && input.sort !== 'USEFUL') return fail();
    result.sort = input.sort;
  }
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      return fail();
    result.limit = input.limit;
  }
  return result;
}
export function escapeLikeLiteral(q: string): string {
  return q.replace(/[\\%_]/g, (value) => '\\' + value);
}
