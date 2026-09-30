import type { ReputationLedgerEntry, ReputationSourceType } from './reputation.types';

export const GAMIFICATION_RULE_VERSION = 'community-gamification-v1' as const;

export type ContributorLevelId =
  | 'NEWCOMER'
  | 'HELPER'
  | 'CONTRIBUTOR'
  | 'TRUSTED_CONTRIBUTOR'
  | 'COMMUNITY_STEWARD';

export interface ContributorLevelDefinition {
  id: ContributorLevelId;
  title: string;
  minReputation: number;
}

/**
 * Contributor levels are a projection of current community reputation only.
 * They never grant an authorization role or moderation privilege.
 */
export const CONTRIBUTOR_LEVELS: readonly ContributorLevelDefinition[] = [
  { id: 'NEWCOMER', title: 'Newcomer', minReputation: 0 },
  { id: 'HELPER', title: 'Helper', minReputation: 5 },
  { id: 'CONTRIBUTOR', title: 'Contributor', minReputation: 25 },
  { id: 'TRUSTED_CONTRIBUTOR', title: 'Trusted contributor', minReputation: 50 },
  { id: 'COMMUNITY_STEWARD', title: 'Community steward', minReputation: 100 },
];

export type ContributorBadgeId =
  | 'FIRST_TRUSTED_CONTRIBUTION'
  | 'CORRECTION_HELPER'
  | 'TRANSLATION_KEEPER'
  | 'RESOURCE_STEWARD'
  | 'REVIEW_GUARDIAN';

export type CommunityBadgeSourceType =
  | 'ANY_COMMUNITY'
  | Extract<
      ReputationSourceType,
      | 'CORRECTION_ACCEPTED'
      | 'TRANSLATION_VERIFIED'
      | 'RESOURCE_VERIFIED'
      | 'REVIEW_VERIFICATION'
    >;

export interface ContributorBadgeDefinition {
  id: ContributorBadgeId;
  title: string;
  description: string;
  sourceType: CommunityBadgeSourceType;
  threshold: number;
  ruleVersion: string;
}

/**
 * Badges are finite, inspectable projections of verified contribution events.
 * No raw page/reaction/volume event is a badge source.
 */
export const CONTRIBUTOR_BADGES: readonly ContributorBadgeDefinition[] = [
  {
    id: 'FIRST_TRUSTED_CONTRIBUTION',
    title: 'First trusted contribution',
    description: 'One active, independently verified community contribution.',
    sourceType: 'ANY_COMMUNITY',
    threshold: 1,
    ruleVersion: GAMIFICATION_RULE_VERSION,
  },
  {
    id: 'CORRECTION_HELPER',
    title: 'Correction helper',
    description: 'One accepted public language correction.',
    sourceType: 'CORRECTION_ACCEPTED',
    threshold: 1,
    ruleVersion: GAMIFICATION_RULE_VERSION,
  },
  {
    id: 'TRANSLATION_KEEPER',
    title: 'Translation keeper',
    description: 'One publicly visible translation verified by an authorized reviewer.',
    sourceType: 'TRANSLATION_VERIFIED',
    threshold: 1,
    ruleVersion: GAMIFICATION_RULE_VERSION,
  },
  {
    id: 'RESOURCE_STEWARD',
    title: 'Resource steward',
    description: 'One public language resource verified by an authorized reviewer.',
    sourceType: 'RESOURCE_VERIFIED',
    threshold: 1,
    ruleVersion: GAMIFICATION_RULE_VERSION,
  },
  {
    id: 'REVIEW_GUARDIAN',
    title: 'Review guardian',
    description: 'One trusted review verification completed by an authorized reviewer.',
    sourceType: 'REVIEW_VERIFICATION',
    threshold: 1,
    ruleVersion: GAMIFICATION_RULE_VERSION,
  },
];

export type ContributorBadgeStatus = 'LOCKED' | 'EARNED' | 'REVOKED';

export interface ContributorBadgeProjection {
  id: ContributorBadgeId;
  title: string;
  description: string;
  sourceType: CommunityBadgeSourceType;
  threshold: number;
  ruleVersion: string;
  status: ContributorBadgeStatus;
  evidenceSourceIds: string[];
  awardedAt: string | null;
  revokedAt: string | null;
}

export interface ContributorLevelProjection extends ContributorLevelDefinition {
  ruleVersion: string;
  nextLevel: ContributorLevelDefinition | null;
}

interface ContributionEvidenceGroup {
  sourceType: ReputationSourceType;
  sourceId: string;
  positiveAwards: ReputationLedgerEntry[];
  netDelta: number;
}

export function deriveContributorLevel(reputation: number): ContributorLevelProjection {
  if (!Number.isSafeInteger(reputation)) throw new Error('REPUTATION_BALANCE_INVALID');

  const normalizedReputation = Math.max(0, reputation);
  let current = CONTRIBUTOR_LEVELS[0];
  for (const level of CONTRIBUTOR_LEVELS) {
    if (normalizedReputation >= level.minReputation) current = level;
  }
  const currentIndex = CONTRIBUTOR_LEVELS.findIndex((level) => level.id === current.id);
  return {
    ...current,
    ruleVersion: GAMIFICATION_RULE_VERSION,
    nextLevel: CONTRIBUTOR_LEVELS[currentIndex + 1] ?? null,
  };
}

export function deriveContributorBadges(
  entries: ReadonlyArray<ReputationLedgerEntry>,
): ContributorBadgeProjection[] {
  const groups = groupContributionEvidence(entries);
  const historicalAwards = groups
    .map((group) => group.positiveAwards.slice().sort(compareOldestFirst)[0])
    .filter((entry): entry is ReputationLedgerEntry => entry !== undefined);
  const activeAwards = groups
    .filter((group) => group.netDelta > 0)
    .map((group) => group.positiveAwards.slice().sort(compareOldestFirst)[0])
    .filter((entry): entry is ReputationLedgerEntry => entry !== undefined);
  const reversalsByEntryId = new Map<string, ReputationLedgerEntry[]>();

  for (const entry of entries) {
    if (entry.reversalOfEntryId === null) continue;
    const reversals = reversalsByEntryId.get(entry.reversalOfEntryId) ?? [];
    reversals.push(entry);
    reversalsByEntryId.set(entry.reversalOfEntryId, reversals);
  }

  return CONTRIBUTOR_BADGES.map((definition) => {
    const historicalEvidence = matchingEvidence(historicalAwards, definition);
    const activeEvidence = matchingEvidence(activeAwards, definition);
    const activeQualified = activeEvidence.length >= definition.threshold;
    const historicallyQualified = historicalEvidence.length >= definition.threshold;
    const status: ContributorBadgeStatus = activeQualified
      ? 'EARNED'
      : historicallyQualified
        ? 'REVOKED'
        : 'LOCKED';
    const evidence = status === 'EARNED' ? activeEvidence : historicalEvidence;
    const revokedAt = status === 'REVOKED'
      ? latestReversalDate(historicalEvidence, reversalsByEntryId)
      : null;

    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      sourceType: definition.sourceType,
      threshold: definition.threshold,
      ruleVersion: definition.ruleVersion,
      status,
      evidenceSourceIds: evidence.map((entry) => entry.sourceId).sort(),
      awardedAt: historicallyQualified
        ? historicalEvidence.slice().sort(compareOldestFirst)[0].createdAt.toISOString()
        : null,
      revokedAt,
    };
  });
}

export function selectActiveCommunityContributionEntries(
  entries: ReadonlyArray<ReputationLedgerEntry>,
): ReputationLedgerEntry[] {
  return groupContributionEvidence(entries)
    .filter((group) => group.netDelta > 0)
    .map((group) => group.positiveAwards.slice().sort(compareOldestFirst)[0])
    .filter((entry): entry is ReputationLedgerEntry => entry !== undefined)
    .sort(compareNewestFirst);
}

export function deriveCommunityReputation(
  entries: ReadonlyArray<ReputationLedgerEntry>,
): number {
  let balance = 0;
  for (const entry of entries) {
    if (entry.system !== 'community_reputation') continue;
    balance += entry.delta;
    if (!Number.isSafeInteger(balance)) throw new Error('REPUTATION_BALANCE_INVALID');
  }
  return balance;
}

function groupContributionEvidence(
  entries: ReadonlyArray<ReputationLedgerEntry>,
): ContributionEvidenceGroup[] {
  const groups = new Map<string, ContributionEvidenceGroup>();
  for (const entry of entries) {
    if (entry.system !== 'community_reputation') continue;
    const key = `${entry.sourceType}:${entry.sourceId}`;
    const group = groups.get(key) ?? {
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      positiveAwards: [],
      netDelta: 0,
    };
    group.netDelta += entry.delta;
    if (entry.delta > 0 && entry.reversalOfEntryId === null) group.positiveAwards.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function matchingEvidence(
  entries: ReadonlyArray<ReputationLedgerEntry>,
  definition: ContributorBadgeDefinition,
): ReputationLedgerEntry[] {
  return entries.filter((entry) => (
    definition.sourceType === 'ANY_COMMUNITY' || entry.sourceType === definition.sourceType
  ));
}

function latestReversalDate(
  evidence: ReadonlyArray<ReputationLedgerEntry>,
  reversalsByEntryId: ReadonlyMap<string, ReputationLedgerEntry[]>,
): string | null {
  const dates = evidence.flatMap((entry) => reversalsByEntryId.get(entry.id) ?? []);
  if (dates.length === 0) return null;
  return dates.slice().sort(compareNewestFirst)[0].createdAt.toISOString();
}

function compareOldestFirst(left: ReputationLedgerEntry, right: ReputationLedgerEntry): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

function compareNewestFirst(left: ReputationLedgerEntry, right: ReputationLedgerEntry): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}
