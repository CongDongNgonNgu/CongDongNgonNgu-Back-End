import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_LEARNING_STREAK_TIMEZONE,
  calculateLearningStreak,
  learningLocalDateKey,
  previousLearningDateKey,
  resolveLearningTimezone,
  type LearningStreakProjection,
} from './learning-streaks';
import {
  LearningXpRuleEngine,
  type LearningCompletionInput,
  type LearningXpDecision,
  type LearningXpSourceType,
} from './learning-xp.rules';
import {
  REPUTATION_LEDGER_REPOSITORY,
  type ReputationLedgerAppendResult,
  type ReputationLedgerRepository,
} from './reputation.repository';
import { ReputationService } from './reputation.service';
import type { ReputationLedgerEntry } from './reputation.types';
import { PROFILE_REPOSITORY, type ProfileRepository } from '../profile/profile.repository';

const LEARNING_LEDGER_PAGE_SIZE = 100;
const MAX_PROGRESS_ENTRIES = 100_000;
const XP_MILESTONE_THRESHOLDS = [100, 250, 500, 1_000] as const;
const STREAK_MILESTONE_THRESHOLDS = [3, 7, 14, 30] as const;

export interface LearningXpAwardResult {
  decision: LearningXpDecision;
  entry: ReputationLedgerEntry | null;
  created: boolean;
}

export interface ReverseLearningXpInput {
  entryId: string;
  reason: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface LearningMilestone {
  kind: 'XP' | 'STREAK';
  threshold: number;
  achievedOn: string;
}

export interface LearningActivitySummary {
  sourceType: LearningXpSourceType;
  xp: number;
  completedAt: string;
}

export interface LearningProgress {
  totalXp: number;
  currentStreak: number;
  longestStreak: number;
  streakTimezone: string;
  activeDays: string[];
  milestones: LearningMilestone[];
  recentQualifyingActivity: LearningActivitySummary[];
}

export class LearningXpServiceError extends Error {
  readonly name = 'LearningXpServiceError';

  constructor(
    readonly code: 'LEARNING_ENTRY_NOT_FOUND' | 'LEARNING_ENTRY_NOT_OWNED' | 'LEARNING_PROGRESS_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class LearningXpService {
  constructor(
    private readonly rules: LearningXpRuleEngine,
    @Inject(REPUTATION_LEDGER_REPOSITORY)
    private readonly repository: ReputationLedgerRepository,
    private readonly reputation: ReputationService,
    @Inject(PROFILE_REPOSITORY)
    private readonly profiles: ProfileRepository,
  ) {}

  async recordCompletion(input: LearningCompletionInput, now = new Date()): Promise<LearningXpAwardResult> {
    const decision = this.rules.evaluate(input, now);
    if (!decision.eligible) return { decision, entry: null, created: false };

    const result = await this.repository.append({
      userId: input.userId,
      system: 'learning_xp',
      sourceType: decision.sourceType,
      sourceId: decision.sourceId,
      delta: decision.delta,
      reason: decision.reason,
      ruleVersion: decision.ruleVersion,
      idempotencyKey: decision.idempotencyKey,
      reversalOfEntryId: null,
      createdAt: input.completedAt,
    });
    return { decision, entry: result.entry, created: result.created };
  }

  async reverseCompletion(input: ReverseLearningXpInput): Promise<ReputationLedgerAppendResult> {
    const original = await this.repository.findById(input.entryId);
    if (!original) {
      throw new LearningXpServiceError(
        'LEARNING_ENTRY_NOT_FOUND',
        'The learning XP ledger entry does not exist',
      );
    }
    if (original.system !== 'learning_xp') {
      throw new LearningXpServiceError(
        'LEARNING_ENTRY_NOT_OWNED',
        'The ledger entry is not a learning XP award',
      );
    }
    return this.reputation.reverseEntry(input);
  }

  async getProgress(userId: string, now = new Date()): Promise<LearningProgress> {
    const profile = await this.profiles.findProfile(userId);
    const timezone = resolveLearningTimezone(profile.timezone ?? DEFAULT_LEARNING_STREAK_TIMEZONE);
    const entries = await this.listAllLearningEntries(userId);
    const qualifyingEntries = selectQualifyingLearningEntries(entries);
    const streak = calculateLearningStreak(
      qualifyingEntries.map((entry) => entry.createdAt),
      timezone,
      now,
    );
    const totalXp = await this.repository.getBalance(userId, 'learning_xp');

    return {
      totalXp,
      currentStreak: streak.currentStreak,
      longestStreak: streak.longestStreak,
      streakTimezone: timezone,
      activeDays: streak.activeDays.slice(-90),
      milestones: deriveMilestones(entries, streak, timezone),
      recentQualifyingActivity: qualifyingEntries
        .slice()
        .sort(compareNewestFirst)
        .slice(0, 20)
        .map((entry) => ({
          sourceType: entry.sourceType as LearningXpSourceType,
          xp: entry.delta,
          completedAt: entry.createdAt.toISOString(),
        })),
    };
  }

  private async listAllLearningEntries(userId: string): Promise<ReputationLedgerEntry[]> {
    const entries: ReputationLedgerEntry[] = [];
    let before: { createdAt: Date; id: string } | undefined;

    while (true) {
      const page = await this.repository.listByUser({
        userId,
        system: 'learning_xp',
        limit: LEARNING_LEDGER_PAGE_SIZE,
        before,
      });
      entries.push(...page);
      if (entries.length > MAX_PROGRESS_ENTRIES) {
        throw new LearningXpServiceError(
          'LEARNING_PROGRESS_TOO_LARGE',
          'Learning progress exceeds the bounded projection limit',
        );
      }
      if (page.length < LEARNING_LEDGER_PAGE_SIZE) return entries;

      const last = page[page.length - 1];
      before = { createdAt: last.createdAt, id: last.id };
    }
  }
}

export function selectQualifyingLearningEntries(
  entries: ReadonlyArray<ReputationLedgerEntry>,
): ReputationLedgerEntry[] {
  const groups = new Map<string, { net: number; award: ReputationLedgerEntry | null }>();

  for (const entry of entries) {
    if (entry.system !== 'learning_xp') continue;
    const key = `${entry.sourceType}:${entry.sourceId}`;
    const group = groups.get(key) ?? { net: 0, award: null };
    group.net += entry.delta;
    if (entry.delta > 0 && entry.reversalOfEntryId === null) group.award = entry;
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group): group is { net: number; award: ReputationLedgerEntry } => group.net > 0 && group.award !== null)
    .map((group) => group.award);
}

function deriveMilestones(
  entries: ReadonlyArray<ReputationLedgerEntry>,
  streak: LearningStreakProjection,
  timezone: string,
): LearningMilestone[] {
  const milestones: LearningMilestone[] = [];
  const reachedXp = new Set<number>();
  let runningXp = 0;

  for (const entry of entries.slice().sort(compareOldestFirst)) {
    runningXp += entry.delta;
    for (const threshold of XP_MILESTONE_THRESHOLDS) {
      if (runningXp >= threshold && !reachedXp.has(threshold)) {
        reachedXp.add(threshold);
        milestones.push({
          kind: 'XP',
          threshold,
          achievedOn: localDateKeyForEntry(entry, timezone),
        });
      }
    }
  }

  const reachedStreak = new Set<number>();
  let runLength = 0;
  let previousDay: string | null = null;
  for (const day of streak.activeDays) {
    runLength = previousDay !== null && previousLearningDateKey(day) === previousDay
      ? runLength + 1
      : 1;
    for (const threshold of STREAK_MILESTONE_THRESHOLDS) {
      if (runLength >= threshold && !reachedStreak.has(threshold)) {
        reachedStreak.add(threshold);
        milestones.push({ kind: 'STREAK', threshold, achievedOn: day });
      }
    }
    previousDay = day;
  }

  return milestones.sort((left, right) => {
    const byDate = left.achievedOn.localeCompare(right.achievedOn);
    if (byDate !== 0) return byDate;
    return `${left.kind}:${left.threshold}`.localeCompare(`${right.kind}:${right.threshold}`);
  });
}

function localDateKeyForEntry(entry: ReputationLedgerEntry, timezone: string): string {
  return learningLocalDateKey(entry.createdAt, timezone);
}

function compareNewestFirst(left: ReputationLedgerEntry, right: ReputationLedgerEntry): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}

function compareOldestFirst(left: ReputationLedgerEntry, right: ReputationLedgerEntry): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}
