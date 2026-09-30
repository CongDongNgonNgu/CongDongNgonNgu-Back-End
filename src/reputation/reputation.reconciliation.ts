import { ANTI_FARMING_RULE_VERSION } from "./anti-farming.rules";
import {
  CONTRIBUTION_RULE_VERSION,
  CONTRIBUTION_SOURCE_TYPES,
} from "./reputation.rules";
import {
  deriveCommunityReputation,
  deriveContributorBadges,
  deriveContributorLevel,
  selectActiveCommunityContributionEntries,
  type ContributorBadgeProjection,
  type ContributorLevelProjection,
} from "./gamification.rules";
import {
  LEARNING_XP_RULE_VERSION,
  LEARNING_XP_SOURCE_TYPES,
} from "./learning-xp.rules";
import { calculateLearningStreak } from "./learning-streaks";
import { selectQualifyingLearningEntries } from "./learning-xp.service";
import {
  REPUTATION_SOURCE_TYPES,
  REPUTATION_SYSTEMS,
  type ReputationLedgerEntry,
  type ReputationSourceType,
  type ReputationSystem,
} from "./reputation.types";

export const REPUTATION_RECONCILIATION_CONTRACT_VERSION =
  "reputation.reconciliation.v1" as const;
export const REPUTATION_RECONCILIATION_MAX_ENTRIES = 100_000;

export type ReputationReconciliationStatus = "PASS" | "MISMATCH";
export type ReputationReconciliationIssueCode =
  | "RECONCILIATION_POLICY_INVALID"
  | "RECORD_LIMIT_EXCEEDED"
  | "RECORD_INVALID"
  | "LEDGER_VS_DERIVED_XP_BALANCE"
  | "LEDGER_VS_DERIVED_REPUTATION_BALANCE"
  | "DUPLICATE_LEDGER_ENTRY"
  | "MISSING_EXPECTED_REWARD"
  | "UNEXPECTED_REWARD"
  | "REVERSAL_MISMATCH"
  | "STREAK_PROJECTION_MISMATCH"
  | "BADGE_PROJECTION_MISMATCH"
  | "LEVEL_PROJECTION_MISMATCH"
  | "ANTI_FARMING_DECISION_MISMATCH"
  | "RULE_VERSION_MISMATCH"
  | "PASSPORT_PROJECTION_MISMATCH";

export interface ReputationReconciliationIssue {
  code: ReputationReconciliationIssueCode;
  entryId: string | null;
  sourceId: string | null;
}

export interface ReputationExpectedReward {
  userId: string;
  system: ReputationSystem;
  sourceType: ReputationSourceType;
  sourceId: string;
  delta: number;
  ruleVersion: string;
  idempotencyKey: string;
}

export interface ReputationReconciliationLearningProgress {
  timezone: string;
  now: Date;
  activeDays: readonly string[];
  currentStreak: number;
  longestStreak: number;
}

export type ReputationReconciliationCommunityProgress = {
  communityReputation: number;
  contributorLevel: ContributorLevelProjection;
  badges: readonly ContributorBadgeProjection[];
  activeContributionCount: number;
};

export interface ReputationReconciliationPassportProjection {
  totalXp: number;
  communityReputation: number;
  currentStreak: number;
  longestStreak: number;
  contributorLevelId: ContributorLevelProjection["id"];
  badgeStatuses: readonly Pick<ContributorBadgeProjection, "id" | "status">[];
}

export interface ReputationReconciliationAntiFarmingDecision {
  sourceKey: string;
  expectedAllowed: boolean;
  actualAllowed: boolean;
  ruleVersion: string;
}

export interface ReputationReconciliationSnapshot {
  derivedBalances: {
    learningXp: number;
    communityReputation: number;
  };
  expectedRewards?: readonly ReputationExpectedReward[];
  learningProgress?: ReputationReconciliationLearningProgress;
  communityProgress?: ReputationReconciliationCommunityProgress;
  passportProjection?: ReputationReconciliationPassportProjection;
  antiFarmingDecisions?: readonly ReputationReconciliationAntiFarmingDecision[];
}

export interface ReputationReconciliationReport {
  version: typeof REPUTATION_RECONCILIATION_CONTRACT_VERSION;
  status: ReputationReconciliationStatus;
  entriesChecked: number;
  issues: readonly ReputationReconciliationIssue[];
  issuesTruncated: boolean;
  repairStatus: "NOT_APPLIED";
  mutationApplied: false;
}

export interface ReputationReconciliationOptions {
  maxEntries?: number;
}

const MAX_REPORTED_ISSUES = 100;
const LEARNING_SOURCE_TYPE_SET = new Set<string>(LEARNING_XP_SOURCE_TYPES);
const CONTRIBUTION_SOURCE_TYPE_SET = new Set<string>(CONTRIBUTION_SOURCE_TYPES);

export function reconcileReputationSnapshot(
  entries: readonly ReputationLedgerEntry[],
  snapshot: ReputationReconciliationSnapshot,
  options: ReputationReconciliationOptions = {},
): ReputationReconciliationReport {
  const maxEntries =
    options.maxEntries ?? REPUTATION_RECONCILIATION_MAX_ENTRIES;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > REPUTATION_RECONCILIATION_MAX_ENTRIES
  ) {
    return report(
      0,
      [
        {
          code: "RECONCILIATION_POLICY_INVALID",
          entryId: null,
          sourceId: null,
        },
      ],
      false,
    );
  }
  if (!Array.isArray(entries) || entries.length > maxEntries) {
    return report(
      0,
      [{ code: "RECORD_LIMIT_EXCEEDED", entryId: null, sourceId: null }],
      false,
    );
  }

  const issues: ReputationReconciliationIssue[] = [];
  let issuesTruncated = false;
  const addIssue = (
    code: ReputationReconciliationIssueCode,
    metadata: Partial<
      Pick<ReputationReconciliationIssue, "entryId" | "sourceId">
    > = {},
  ): void => {
    if (issues.length < MAX_REPORTED_ISSUES) {
      issues.push({
        code,
        entryId: metadata.entryId ?? null,
        sourceId: metadata.sourceId ?? null,
      });
    } else {
      issuesTruncated = true;
    }
  };

  const orderedEntries = entries.slice().sort(compareLedgerEntries);
  const validEntries: ReputationLedgerEntry[] = [];
  const entryIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const sourceKeys = new Set<string>();

  for (const entry of orderedEntries) {
    if (!isValidLedgerEntry(entry)) {
      addIssue("RECORD_INVALID", {
        entryId: typeof entry?.id === "string" ? entry.id : null,
        sourceId: typeof entry?.sourceId === "string" ? entry.sourceId : null,
      });
      continue;
    }

    if (entryIds.has(entry.id) || idempotencyKeys.has(entry.idempotencyKey)) {
      addIssue("DUPLICATE_LEDGER_ENTRY", {
        entryId: entry.id,
        sourceId: entry.sourceId,
      });
    }
    entryIds.add(entry.id);
    idempotencyKeys.add(entry.idempotencyKey);

    if (entry.delta > 0 && entry.reversalOfEntryId === null) {
      const sourceKey = `${entry.system}:${entry.sourceType}:${entry.sourceId}`;
      if (sourceKeys.has(sourceKey)) {
        addIssue("DUPLICATE_LEDGER_ENTRY", {
          entryId: entry.id,
          sourceId: entry.sourceId,
        });
      }
      sourceKeys.add(sourceKey);
    }

    const expectedRuleVersion = expectedLedgerRuleVersion(entry.sourceType);
    if (
      expectedRuleVersion === null ||
      entry.ruleVersion !== expectedRuleVersion
    ) {
      addIssue("RULE_VERSION_MISMATCH", {
        entryId: entry.id,
        sourceId: entry.sourceId,
      });
    }

    validEntries.push(entry);
  }

  reconcileReversals(
    validEntries,
    entryIds,
    new Map(validEntries.map((entry) => [entry.id, entry])),
    addIssue,
  );
  reconcileBalances(validEntries, snapshot, addIssue);
  reconcileExpectedRewards(validEntries, snapshot.expectedRewards, addIssue);
  reconcileLearningProgress(validEntries, snapshot.learningProgress, addIssue);
  reconcileCommunityProgress(
    validEntries,
    snapshot.communityProgress,
    addIssue,
  );
  reconcileAntiFarming(snapshot.antiFarmingDecisions, addIssue);
  reconcilePassportProjection(validEntries, snapshot, addIssue);

  return report(entries.length, issues, issuesTruncated);
}

function reconcileReversals(
  entries: readonly ReputationLedgerEntry[],
  entryIds: ReadonlySet<string>,
  entriesById: ReadonlyMap<string, ReputationLedgerEntry>,
  addIssue: IssueReporter,
): void {
  const reversalsByTarget = new Map<string, number>();

  for (const entry of entries) {
    if (entry.delta < 0 && entry.reversalOfEntryId === null) {
      addIssue("REVERSAL_MISMATCH", {
        entryId: entry.id,
        sourceId: entry.sourceId,
      });
      continue;
    }
    if (entry.reversalOfEntryId === null) continue;

    const targetId = entry.reversalOfEntryId;
    reversalsByTarget.set(targetId, (reversalsByTarget.get(targetId) ?? 0) + 1);
    const target = entriesById.get(targetId);
    if (
      !entryIds.has(targetId) ||
      !target ||
      target.reversalOfEntryId !== null ||
      target.delta <= 0 ||
      entry.delta !== -target.delta ||
      entry.userId !== target.userId ||
      entry.system !== target.system ||
      entry.sourceType !== target.sourceType ||
      entry.sourceId !== target.sourceId
    ) {
      addIssue("REVERSAL_MISMATCH", {
        entryId: entry.id,
        sourceId: entry.sourceId,
      });
    }
  }

  for (const [targetId, count] of reversalsByTarget) {
    if (count > 1)
      addIssue("REVERSAL_MISMATCH", { entryId: targetId, sourceId: null });
  }
}

function reconcileBalances(
  entries: readonly ReputationLedgerEntry[],
  snapshot: ReputationReconciliationSnapshot,
  addIssue: IssueReporter,
): void {
  const expected = {
    learningXp: deriveBalance(entries, "learning_xp"),
    communityReputation: deriveBalance(entries, "community_reputation"),
  };
  if (snapshot.derivedBalances.learningXp !== expected.learningXp) {
    addIssue("LEDGER_VS_DERIVED_XP_BALANCE");
  }
  if (
    snapshot.derivedBalances.communityReputation !==
    expected.communityReputation
  ) {
    addIssue("LEDGER_VS_DERIVED_REPUTATION_BALANCE");
  }
}

function reconcileExpectedRewards(
  entries: readonly ReputationLedgerEntry[],
  expectedRewards: readonly ReputationExpectedReward[] | undefined,
  addIssue: IssueReporter,
): void {
  if (!expectedRewards) return;

  const observedAwards = entries.filter(
    (entry) => entry.delta > 0 && entry.reversalOfEntryId === null,
  );
  const observedByKey = new Map(
    observedAwards.map((entry) => [rewardKey(entry), entry]),
  );
  const expectedByKey = new Map(
    expectedRewards.map((reward) => [rewardKey(reward), reward]),
  );

  for (const expected of [...expectedRewards].sort(compareExpectedRewards)) {
    const observed = observedByKey.get(rewardKey(expected));
    if (!observed) {
      addIssue("MISSING_EXPECTED_REWARD", { sourceId: expected.sourceId });
      continue;
    }
    if (!matchesExpectedReward(observed, expected)) {
      addIssue("UNEXPECTED_REWARD", {
        entryId: observed.id,
        sourceId: observed.sourceId,
      });
    }
  }

  for (const observed of [...observedAwards].sort(compareLedgerEntries)) {
    if (!expectedByKey.has(rewardKey(observed))) {
      addIssue("UNEXPECTED_REWARD", {
        entryId: observed.id,
        sourceId: observed.sourceId,
      });
    }
  }
}

function reconcileLearningProgress(
  entries: readonly ReputationLedgerEntry[],
  progress: ReputationReconciliationLearningProgress | undefined,
  addIssue: IssueReporter,
): void {
  if (!progress) return;

  try {
    const qualifyingEntries = selectQualifyingLearningEntries(entries);
    const expected = calculateLearningStreak(
      qualifyingEntries.map((entry) => entry.createdAt),
      progress.timezone,
      progress.now,
    );
    const expectedActiveDays = expected.activeDays.slice(-90);
    if (
      progress.currentStreak !== expected.currentStreak ||
      progress.longestStreak !== expected.longestStreak ||
      !sameStringArray(progress.activeDays, expectedActiveDays)
    ) {
      addIssue("STREAK_PROJECTION_MISMATCH");
    }
  } catch {
    addIssue("STREAK_PROJECTION_MISMATCH");
  }
}

function reconcileCommunityProgress(
  entries: readonly ReputationLedgerEntry[],
  progress: ReputationReconciliationCommunityProgress | undefined,
  addIssue: IssueReporter,
): void {
  if (!progress) return;

  const communityReputation = deriveCommunityReputation(entries);
  if (progress.communityReputation !== communityReputation) {
    addIssue("LEDGER_VS_DERIVED_REPUTATION_BALANCE");
  }

  const expectedLevel = deriveContributorLevel(communityReputation);
  if (!sameLevel(progress.contributorLevel, expectedLevel)) {
    addIssue("LEVEL_PROJECTION_MISMATCH");
  }
  if (progress.contributorLevel.ruleVersion !== expectedLevel.ruleVersion) {
    addIssue("RULE_VERSION_MISMATCH");
  }

  const expectedBadges = deriveContributorBadges(entries);
  if (!sameBadges(progress.badges, expectedBadges)) {
    addIssue("BADGE_PROJECTION_MISMATCH");
  }
  if (
    progress.badges.some(
      (badge) => badge.ruleVersion !== expectedBadges[0]?.ruleVersion,
    )
  ) {
    addIssue("RULE_VERSION_MISMATCH");
  }

  const expectedActiveContributionCount =
    selectActiveCommunityContributionEntries(entries).length;
  if (progress.activeContributionCount !== expectedActiveContributionCount) {
    addIssue("BADGE_PROJECTION_MISMATCH");
  }
}

function reconcileAntiFarming(
  decisions: readonly ReputationReconciliationAntiFarmingDecision[] | undefined,
  addIssue: IssueReporter,
): void {
  if (!decisions) return;
  for (const decision of [...decisions].sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey),
  )) {
    if (decision.expectedAllowed !== decision.actualAllowed) {
      addIssue("ANTI_FARMING_DECISION_MISMATCH");
    }
    if (decision.ruleVersion !== ANTI_FARMING_RULE_VERSION) {
      addIssue("RULE_VERSION_MISMATCH");
    }
  }
}

function reconcilePassportProjection(
  entries: readonly ReputationLedgerEntry[],
  snapshot: ReputationReconciliationSnapshot,
  addIssue: IssueReporter,
): void {
  const projection = snapshot.passportProjection;
  if (!projection) return;

  const expectedCommunityReputation = deriveCommunityReputation(entries);
  const expectedLevel = deriveContributorLevel(expectedCommunityReputation);
  const expectedBadges = deriveContributorBadges(entries);
  const learningProgress = snapshot.learningProgress;
  let learningMatches = true;
  if (learningProgress) {
    try {
      const qualifyingEntries = selectQualifyingLearningEntries(entries);
      const expectedStreak = calculateLearningStreak(
        qualifyingEntries.map((entry) => entry.createdAt),
        learningProgress.timezone,
        learningProgress.now,
      );
      learningMatches =
        projection.currentStreak === expectedStreak.currentStreak &&
        projection.longestStreak === expectedStreak.longestStreak;
    } catch {
      learningMatches = false;
    }
  }

  const badgeStatuses = expectedBadges
    .map((badge) => ({ id: badge.id, status: badge.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const observedBadgeStatuses = [...projection.badgeStatuses]
    .map((badge) => ({ id: badge.id, status: badge.status }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (
    projection.totalXp !== deriveBalance(entries, "learning_xp") ||
    projection.communityReputation !== expectedCommunityReputation ||
    projection.contributorLevelId !== expectedLevel.id ||
    !learningMatches ||
    JSON.stringify(observedBadgeStatuses) !== JSON.stringify(badgeStatuses)
  ) {
    addIssue("PASSPORT_PROJECTION_MISMATCH");
  }
}

function report(
  entriesChecked: number,
  issues: readonly ReputationReconciliationIssue[],
  issuesTruncated: boolean,
): ReputationReconciliationReport {
  return {
    version: REPUTATION_RECONCILIATION_CONTRACT_VERSION,
    status: issues.length > 0 || issuesTruncated ? "MISMATCH" : "PASS",
    entriesChecked,
    issues,
    issuesTruncated,
    repairStatus: "NOT_APPLIED",
    mutationApplied: false,
  };
}

type IssueReporter = (
  code: ReputationReconciliationIssueCode,
  metadata?: Partial<
    Pick<ReputationReconciliationIssue, "entryId" | "sourceId">
  >,
) => void;

function deriveBalance(
  entries: readonly ReputationLedgerEntry[],
  system: ReputationSystem,
): number {
  return entries
    .filter((entry) => entry.system === system)
    .reduce((balance, entry) => balance + entry.delta, 0);
}

function expectedLedgerRuleVersion(sourceType: string): string | null {
  if (LEARNING_SOURCE_TYPE_SET.has(sourceType)) return LEARNING_XP_RULE_VERSION;
  if (CONTRIBUTION_SOURCE_TYPE_SET.has(sourceType))
    return CONTRIBUTION_RULE_VERSION;
  return null;
}

function rewardKey(
  value: Pick<ReputationExpectedReward, "system" | "sourceType" | "sourceId">,
): string {
  return `${value.system}:${value.sourceType}:${value.sourceId}`;
}

function matchesExpectedReward(
  observed: ReputationLedgerEntry,
  expected: ReputationExpectedReward,
): boolean {
  return (
    observed.userId === expected.userId &&
    observed.system === expected.system &&
    observed.sourceType === expected.sourceType &&
    observed.sourceId === expected.sourceId &&
    observed.delta === expected.delta &&
    observed.ruleVersion === expected.ruleVersion &&
    observed.idempotencyKey === expected.idempotencyKey
  );
}

function sameLevel(
  left: ContributorLevelProjection,
  right: ContributorLevelProjection,
): boolean {
  return (
    JSON.stringify({
      id: left.id,
      title: left.title,
      minReputation: left.minReputation,
      ruleVersion: left.ruleVersion,
      nextLevel: left.nextLevel,
    }) ===
    JSON.stringify({
      id: right.id,
      title: right.title,
      minReputation: right.minReputation,
      ruleVersion: right.ruleVersion,
      nextLevel: right.nextLevel,
    })
  );
}

function sameBadges(
  left: readonly ContributorBadgeProjection[],
  right: readonly ContributorBadgeProjection[],
): boolean {
  const normalize = (badges: readonly ContributorBadgeProjection[]) =>
    badges
      .map((badge) => ({
        id: badge.id,
        title: badge.title,
        description: badge.description,
        sourceType: badge.sourceType,
        threshold: badge.threshold,
        ruleVersion: badge.ruleVersion,
        status: badge.status,
        evidenceSourceIds: [...badge.evidenceSourceIds].sort(),
        awardedAt: badge.awardedAt,
        revokedAt: badge.revokedAt,
      }))
      .sort((leftBadge, rightBadge) =>
        leftBadge.id.localeCompare(rightBadge.id),
      );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareLedgerEntries(
  left: ReputationLedgerEntry,
  right: ReputationLedgerEntry,
): number {
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function compareExpectedRewards(
  left: ReputationExpectedReward,
  right: ReputationExpectedReward,
): number {
  return rewardKey(left).localeCompare(rewardKey(right));
}

function isValidLedgerEntry(entry: ReputationLedgerEntry): boolean {
  return (
    isUuid(entry?.id) &&
    isUuid(entry?.userId) &&
    REPUTATION_SYSTEMS.includes(entry?.system) &&
    REPUTATION_SOURCE_TYPES.includes(entry?.sourceType) &&
    isUuid(entry?.sourceId) &&
    Number.isSafeInteger(entry?.delta) &&
    entry.delta !== 0 &&
    typeof entry.reason === "string" &&
    entry.reason.trim().length > 0 &&
    typeof entry.ruleVersion === "string" &&
    entry.ruleVersion.trim().length > 0 &&
    typeof entry.idempotencyKey === "string" &&
    entry.idempotencyKey.trim().length > 0 &&
    (entry.reversalOfEntryId === null || isUuid(entry.reversalOfEntryId)) &&
    entry.createdAt instanceof Date &&
    Number.isFinite(entry.createdAt.getTime())
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
