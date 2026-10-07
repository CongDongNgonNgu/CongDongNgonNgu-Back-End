import type { LibraryPublicResource } from './library.types';
export const LIBRARY_RELATION_TYPES = [
  'SAME_CONCEPT',
  'PREREQUISITE',
  'FOLLOW_UP',
  'DIRECT_TRANSLATION',
  'COLLECTION_MEMBER',
] as const;
export type LibraryRelationType = (typeof LIBRARY_RELATION_TYPES)[number];
export interface LibraryRelationRecord {
  anchorId: string;
  targetId: string;
  type: LibraryRelationType;
  reviewerUserId: string;
  reviewedAt: Date;
  evidenceReference: string;
  anchorSnapshot: string;
  targetSnapshot: string;
  revision: number;
  status: 'ACTIVE' | 'REVOKED';
}
export interface LibraryRelationReviewInput {
  anchorId: string;
  targetId: string;
  type: LibraryRelationType;
  evidenceReference: string;
}
export interface LibraryRelatedInput {
  relation?: unknown;
  language?: unknown;
  type?: unknown;
  level?: unknown;
  cursor?: unknown;
  limit?: unknown;
}
export interface LibraryRelatedPage {
  items: Array<{
    resource: LibraryPublicResource;
    relation: { type: LibraryRelationType };
  }>;
  nextCursor: string | null;
}

// Related-only capacity bound; canonical detail/lexical eligibility is unchanged.
export const LIBRARY_RELATED_MAX_PROVENANCE = 32;
