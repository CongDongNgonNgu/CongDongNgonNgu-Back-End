export const COMMUNITY_POST_TYPES = [
  'DISCUSSION',
  'QUESTION',
  'RESOURCE',
  'LEARNING_JOURNAL',
  'CULTURE',
  'PRONUNCIATION_REQUEST',
  'CORRECTION_REQUEST',
  'CHALLENGE',
] as const;

export type CommunityPostType = typeof COMMUNITY_POST_TYPES[number];

export const COMMUNITY_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CommunityCefrLevel = typeof COMMUNITY_CEFR_LEVELS[number];

export const COMMUNITY_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;
export type CommunityVisibility = typeof COMMUNITY_VISIBILITIES[number];

export const COMMUNITY_MODERATION_STATES = ['ACTIVE', 'HIDDEN', 'DELETED'] as const;
export type CommunityModerationState = typeof COMMUNITY_MODERATION_STATES[number];

export const COMMUNITY_REACTION_TYPES = ['HELPFUL'] as const;
export type CommunityReactionType = typeof COMMUNITY_REACTION_TYPES[number];

export const COMMUNITY_REPORT_TARGET_TYPES = ['POST', 'COMMENT'] as const;
export type CommunityReportTargetType = typeof COMMUNITY_REPORT_TARGET_TYPES[number];

export const COMMUNITY_REPORT_CATEGORIES = [
  'SPAM',
  'HARASSMENT',
  'HATE',
  'MISINFORMATION',
  'SEXUAL_CONTENT',
  'OTHER',
] as const;
export type CommunityReportCategory = typeof COMMUNITY_REPORT_CATEGORIES[number];

export interface CommunityPostRecord {
  id: string;
  authorUserId: string;
  targetLanguageCode: string;
  postType: CommunityPostType;
  content: string;
  cefrLevel: CommunityCefrLevel | null;
  topic: string | null;
  visibility: CommunityVisibility;
  moderationState: CommunityModerationState;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
}

export interface CommunityCommentRecord {
  id: string;
  postId: string;
  authorUserId: string;
  parentCommentId: string | null;
  depth: 0 | 1;
  content: string;
  moderationState: CommunityModerationState;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
}

export interface CommunityCommentThreadRecord {
  comment: CommunityCommentRecord;
  replies: CommunityCommentRecord[];
}

export interface CommunityPostCursor {
  createdAt: Date;
  id: string;
}

export interface CommunityListResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface CommunityInteractionSummary {
  helpfulCount: number;
  viewerReacted: boolean;
  commentCount: number;
  viewerSaved: boolean;
}

export interface CommunityReportInput {
  reporterUserId: string;
  targetType: CommunityReportTargetType;
  targetId: string;
  category: CommunityReportCategory;
  details: string | null;
  createdAt: Date;
}
