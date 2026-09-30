import { describe, expect, it } from "@jest/globals";
import { ANTI_FARMING_RULE_VERSION } from "./anti-farming.rules";
import {
  deriveContributorBadges,
  deriveContributorLevel,
} from "./gamification.rules";
import { LEARNING_XP_RULE_VERSION } from "./learning-xp.rules";
import {
  REPUTATION_RECONCILIATION_CONTRACT_VERSION,
  reconcileReputationSnapshot,
  type ReputationReconciliationSnapshot,
} from "./reputation.reconciliation";
import type { ReputationLedgerEntry } from "./reputation.types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const LEARNING_SOURCE_ID = "00000000-0000-4000-8000-000000000011";
const COMMUNITY_SOURCE_ID = "00000000-0000-4000-8000-000000000012";
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000000013";
const LEARNING_ENTRY_ID = "00000000-0000-4000-8000-000000000021";
const COMMUNITY_ENTRY_ID = "00000000-0000-4000-8000-000000000022";
const REVERSAL_ENTRY_ID = "00000000-0000-4000-8000-000000000023";

function entry(
  overrides: Partial<ReputationLedgerEntry> = {},
): ReputationLedgerEntry {
  return {
    id: LEARNING_ENTRY_ID,
    userId: USER_ID,
    system: "learning_xp",
    sourceType: "PRACTICE_COMPLETED",
    sourceId: LEARNING_SOURCE_ID,
    delta: 20,
    reason: "Completed a valid practice activity",
    ruleVersion: LEARNING_XP_RULE_VERSION,
    idempotencyKey: `learning:PRACTICE_COMPLETED:${LEARNING_SOURCE_ID}`,
    reversalOfEntryId: null,
    createdAt: new Date("2026-09-29T10:00:00.000Z"),
    ...overrides,
  };
}

function communityEntry(
  overrides: Partial<ReputationLedgerEntry> = {},
): ReputationLedgerEntry {
  return entry({
    id: COMMUNITY_ENTRY_ID,
    system: "community_reputation",
    sourceType: "CORRECTION_ACCEPTED",
    sourceId: COMMUNITY_SOURCE_ID,
    delta: 8,
    reason: "Accepted language correction",
    ruleVersion: "community-reputation-v1",
    idempotencyKey: `reputation:CORRECTION_ACCEPTED:${COMMUNITY_SOURCE_ID}`,
    createdAt: new Date("2026-09-29T11:00:00.000Z"),
    ...overrides,
  });
}

function cleanSnapshot(
  entries: readonly ReputationLedgerEntry[],
): ReputationReconciliationSnapshot {
  const badges = deriveContributorBadges(entries);
  return {
    derivedBalances: { learningXp: 20, communityReputation: 8 },
    expectedRewards: [
      {
        userId: USER_ID,
        system: "learning_xp",
        sourceType: "PRACTICE_COMPLETED",
        sourceId: LEARNING_SOURCE_ID,
        delta: 20,
        ruleVersion: LEARNING_XP_RULE_VERSION,
        idempotencyKey: `learning:PRACTICE_COMPLETED:${LEARNING_SOURCE_ID}`,
      },
      {
        userId: USER_ID,
        system: "community_reputation",
        sourceType: "CORRECTION_ACCEPTED",
        sourceId: COMMUNITY_SOURCE_ID,
        delta: 8,
        ruleVersion: "community-reputation-v1",
        idempotencyKey: `reputation:CORRECTION_ACCEPTED:${COMMUNITY_SOURCE_ID}`,
      },
    ],
    learningProgress: {
      timezone: "UTC",
      now: new Date("2026-09-30T12:00:00.000Z"),
      activeDays: ["2026-09-29"],
      currentStreak: 1,
      longestStreak: 1,
    },
    communityProgress: {
      communityReputation: 8,
      contributorLevel: deriveContributorLevel(8),
      badges,
      activeContributionCount: 1,
    },
    passportProjection: {
      totalXp: 20,
      communityReputation: 8,
      currentStreak: 1,
      longestStreak: 1,
      contributorLevelId: "HELPER",
      badgeStatuses: badges.map((badge) => ({
        id: badge.id,
        status: badge.status,
      })),
    },
    antiFarmingDecisions: [
      {
        sourceKey: `CORRECTION_ACCEPTED:${COMMUNITY_SOURCE_ID}`,
        expectedAllowed: true,
        actualAllowed: true,
        ruleVersion: ANTI_FARMING_RULE_VERSION,
      },
    ],
  };
}

function issueCodes(
  report: ReturnType<typeof reconcileReputationSnapshot>,
): string[] {
  return report.issues.map((issue) => issue.code);
}

describe("reconcileReputationSnapshot", () => {
  it("passes a complete projection without mutating the immutable inputs", () => {
    const entries = [entry(), communityEntry()];
    const snapshot = cleanSnapshot(entries);
    const entriesBefore = structuredClone(entries);
    const snapshotBefore = structuredClone(snapshot);

    const report = reconcileReputationSnapshot(entries, snapshot);

    expect(report).toMatchObject({
      version: REPUTATION_RECONCILIATION_CONTRACT_VERSION,
      status: "PASS",
      entriesChecked: 2,
      repairStatus: "NOT_APPLIED",
      mutationApplied: false,
      issues: [],
    });
    expect(entries).toEqual(entriesBefore);
    expect(snapshot).toEqual(snapshotBefore);
  });

  it("reports balance, duplicate, missing, unexpected and rule-version mismatches", () => {
    const duplicate = communityEntry({
      id: "00000000-0000-4000-8000-000000000024",
    });
    const entries = [
      entry(),
      communityEntry({ ruleVersion: "community-reputation-v0" }),
      duplicate,
    ];
    const snapshot = cleanSnapshot(entries);
    snapshot.derivedBalances = { learningXp: 19, communityReputation: 7 };
    snapshot.expectedRewards = [
      ...(snapshot.expectedRewards?.filter(
        (reward) => reward.system === "learning_xp",
      ) ?? []),
      {
        userId: USER_ID,
        system: "community_reputation",
        sourceType: "CORRECTION_ACCEPTED",
        sourceId: MISSING_SOURCE_ID,
        delta: 8,
        ruleVersion: "community-reputation-v1",
        idempotencyKey: `reputation:CORRECTION_ACCEPTED:${MISSING_SOURCE_ID}`,
      },
    ];
    const report = reconcileReputationSnapshot(entries, snapshot);

    expect(report.status).toBe("MISMATCH");
    expect(issueCodes(report)).toEqual(
      expect.arrayContaining([
        "LEDGER_VS_DERIVED_XP_BALANCE",
        "LEDGER_VS_DERIVED_REPUTATION_BALANCE",
        "DUPLICATE_LEDGER_ENTRY",
        "MISSING_EXPECTED_REWARD",
        "UNEXPECTED_REWARD",
        "RULE_VERSION_MISMATCH",
      ]),
    );
  });

  it("detects unsafe reversal shapes and remains idempotent without repair", () => {
    const entries = [
      entry(),
      communityEntry(),
      communityEntry({
        id: REVERSAL_ENTRY_ID,
        delta: -7,
        reason: "Incorrect reversal fixture",
        idempotencyKey: `reversal:${COMMUNITY_ENTRY_ID}`,
        reversalOfEntryId: COMMUNITY_ENTRY_ID,
      }),
    ];
    const snapshot = cleanSnapshot(entries);
    snapshot.derivedBalances = { learningXp: 20, communityReputation: 1 };

    const first = reconcileReputationSnapshot(entries, snapshot);
    const second = reconcileReputationSnapshot(entries, snapshot);

    expect(issueCodes(first)).toContain("REVERSAL_MISMATCH");
    expect(first).toEqual(second);
    expect(first.repairStatus).toBe("NOT_APPLIED");
    expect(first.mutationApplied).toBe(false);
  });

  it("reconciles streak, badge, level, anti-farming and Passport projections", () => {
    const entries = [entry(), communityEntry()];
    const snapshot = cleanSnapshot(entries);
    snapshot.learningProgress = {
      ...snapshot.learningProgress!,
      activeDays: [],
      currentStreak: 0,
      longestStreak: 0,
    };
    snapshot.communityProgress = {
      ...snapshot.communityProgress!,
      contributorLevel: deriveContributorLevel(0),
      badges: snapshot.communityProgress!.badges.map((badge) => ({
        ...badge,
        status: badge.id === "CORRECTION_HELPER" ? "LOCKED" : badge.status,
      })),
    };
    snapshot.antiFarmingDecisions = [
      {
        sourceKey: `CORRECTION_ACCEPTED:${COMMUNITY_SOURCE_ID}`,
        expectedAllowed: true,
        actualAllowed: false,
        ruleVersion: "community-antifarming-v0",
      },
    ];
    snapshot.passportProjection = {
      ...snapshot.passportProjection!,
      totalXp: 0,
      communityReputation: 0,
      currentStreak: 0,
      longestStreak: 0,
      contributorLevelId: "NEWCOMER",
      badgeStatuses: [],
    };

    const report = reconcileReputationSnapshot(entries, snapshot);

    expect(issueCodes(report)).toEqual(
      expect.arrayContaining([
        "STREAK_PROJECTION_MISMATCH",
        "BADGE_PROJECTION_MISMATCH",
        "LEVEL_PROJECTION_MISMATCH",
        "ANTI_FARMING_DECISION_MISMATCH",
        "RULE_VERSION_MISMATCH",
        "PASSPORT_PROJECTION_MISMATCH",
      ]),
    );
  });

  it("bounds the immutable reconciliation input", () => {
    const report = reconcileReputationSnapshot(
      [entry(), communityEntry()],
      cleanSnapshot([]),
      { maxEntries: 1 },
    );

    expect(report).toMatchObject({
      status: "MISMATCH",
      entriesChecked: 0,
      issues: [{ code: "RECORD_LIMIT_EXCEEDED" }],
      repairStatus: "NOT_APPLIED",
      mutationApplied: false,
    });
  });

  it("classifies malformed ledger records without throwing or mutating input", () => {
    const malformed = null as unknown as ReputationLedgerEntry;
    const report = reconcileReputationSnapshot([malformed], {
      derivedBalances: { learningXp: 0, communityReputation: 0 },
    });

    expect(report.status).toBe("MISMATCH");
    expect(issueCodes(report)).toContain("RECORD_INVALID");
    expect(report.mutationApplied).toBe(false);
  });
});
