import { Injectable } from '@nestjs/common';
import type { ContributionEventFact, ReputationSystem } from './reputation.types';

export const CONTRIBUTION_RULE_VERSION = 'community-reputation-v1' as const;

export const CONTRIBUTION_SOURCE_TYPES = [
  'USEFUL_ANSWER_ACCEPTED',
  'CORRECTION_ACCEPTED',
  'TRANSLATION_VERIFIED',
  'RESOURCE_VERIFIED',
  'REVIEW_VERIFICATION',
] as const;

export type ContributionSourceType = typeof CONTRIBUTION_SOURCE_TYPES[number];
export type ContributionSourceState = 'ACTIVE' | 'VERIFIED';
export type ContributionActorRole = 'MEMBER' | 'MODERATOR' | 'ADMIN';

export interface ContributionRuleDefinition {
  sourceType: ContributionSourceType;
  system: Extract<ReputationSystem, 'community_reputation'>;
  delta: number;
  reason: string;
  ruleVersion: string;
  requiredSourceState: ContributionSourceState;
  requiresPublicSource: boolean;
  requiresIndependentActor: boolean;
  requiredActorRoles?: readonly Exclude<ContributionActorRole, 'MEMBER'>[];
}

export const DEFAULT_CONTRIBUTION_RULES: readonly ContributionRuleDefinition[] = [
  {
    sourceType: 'USEFUL_ANSWER_ACCEPTED',
    system: 'community_reputation',
    delta: 5,
    reason: 'Accepted useful answer',
    ruleVersion: CONTRIBUTION_RULE_VERSION,
    requiredSourceState: 'ACTIVE',
    requiresPublicSource: true,
    requiresIndependentActor: true,
  },
  {
    sourceType: 'CORRECTION_ACCEPTED',
    system: 'community_reputation',
    delta: 8,
    reason: 'Accepted language correction',
    ruleVersion: CONTRIBUTION_RULE_VERSION,
    requiredSourceState: 'ACTIVE',
    requiresPublicSource: true,
    requiresIndependentActor: true,
  },
  {
    sourceType: 'TRANSLATION_VERIFIED',
    system: 'community_reputation',
    delta: 10,
    reason: 'Verified translation contribution',
    ruleVersion: CONTRIBUTION_RULE_VERSION,
    requiredSourceState: 'VERIFIED',
    requiresPublicSource: true,
    requiresIndependentActor: true,
    requiredActorRoles: ['MODERATOR', 'ADMIN'],
  },
  {
    sourceType: 'RESOURCE_VERIFIED',
    system: 'community_reputation',
    delta: 12,
    reason: 'Verified language resource contribution',
    ruleVersion: CONTRIBUTION_RULE_VERSION,
    requiredSourceState: 'VERIFIED',
    requiresPublicSource: true,
    requiresIndependentActor: true,
    requiredActorRoles: ['MODERATOR', 'ADMIN'],
  },
  {
    sourceType: 'REVIEW_VERIFICATION',
    system: 'community_reputation',
    delta: 3,
    reason: 'Completed trusted review verification',
    ruleVersion: CONTRIBUTION_RULE_VERSION,
    requiredSourceState: 'VERIFIED',
    requiresPublicSource: true,
    requiresIndependentActor: true,
    requiredActorRoles: ['MODERATOR', 'ADMIN'],
  },
];

export interface ContributionRuleInput {
  contributorUserId: string;
  sourceType: string;
  sourceId: string;
  actorUserId: string | null;
  actorRole: ContributionActorRole | null;
  sourceVisibility: 'PUBLIC' | 'PRIVATE';
  sourceState: ContributionSourceState;
  occurredAt: Date;
  /** Server-derived, normalized content/source identity for V1 abuse checks. */
  sourceFingerprint?: string | null;
  /** Previously observed server facts; never client-controlled flags. */
  priorContributionFacts?: readonly ContributionEventFact[];
}

export type ContributionRuleRejectionCode =
  | 'INVALID_SOURCE'
  | 'RULE_NOT_FOUND'
  | 'SELF_REWARD_FORBIDDEN'
  | 'SOURCE_NOT_ELIGIBLE'
  | 'REVIEWER_REQUIRED'
  | 'DUPLICATE_SOURCE_EVENT'
  | 'REPEATED_LOW_VALUE_SOURCE'
  | 'COORDINATED_REWARD_PATTERN'
  | 'ANTI_FARMING_FACTS_INVALID';

export interface EligibleContributionDecision {
  eligible: true;
  system: 'community_reputation';
  sourceType: ContributionSourceType;
  sourceId: string;
  delta: number;
  reason: string;
  ruleVersion: string;
  idempotencyKey: string;
}

export interface RejectedContributionDecision {
  eligible: false;
  code: ContributionRuleRejectionCode;
  sourceType: string;
  sourceId: string;
  ruleVersion: string | null;
  idempotencyKey: null;
}

export type ContributionRuleDecision =
  | EligibleContributionDecision
  | RejectedContributionDecision;

@Injectable()
export class ContributionRuleEngine {
  private readonly rules: ReadonlyMap<string, ContributionRuleDefinition>;

  constructor(definitions: readonly ContributionRuleDefinition[] = DEFAULT_CONTRIBUTION_RULES) {
    const rules = new Map<string, ContributionRuleDefinition>();
    for (const definition of definitions) {
      if (
        rules.has(definition.sourceType) ||
        !Number.isSafeInteger(definition.delta) ||
        definition.delta <= 0 ||
        definition.delta > 100_000 ||
        typeof definition.ruleVersion !== 'string' ||
        definition.ruleVersion.trim() === '' ||
        typeof definition.reason !== 'string' ||
        definition.reason.trim() === ''
      ) {
        throw new Error('REPUTATION_RULE_CONFIGURATION_INVALID');
      }
      rules.set(definition.sourceType, Object.freeze({
        ...definition,
        requiredActorRoles: definition.requiredActorRoles
          ? Object.freeze([...definition.requiredActorRoles])
          : undefined,
      }));
    }
    this.rules = rules;
  }

  evaluate(input: ContributionRuleInput): ContributionRuleDecision {
    const sourceType = input.sourceType;
    const sourceId = input.sourceId;
    const rule = this.rules.get(sourceType);

    if (
      !isUuid(input.contributorUserId) ||
      !isUuid(sourceId) ||
      !(input.occurredAt instanceof Date) ||
      !Number.isFinite(input.occurredAt.getTime())
    ) {
      return rejected('INVALID_SOURCE', sourceType, sourceId, rule?.ruleVersion ?? null);
    }
    if (!rule) return rejected('RULE_NOT_FOUND', sourceType, sourceId, null);
    if (rule.requiresIndependentActor && (
      !input.actorUserId ||
      !isUuid(input.actorUserId) ||
      input.actorUserId === input.contributorUserId
    )) {
      return rejected(
        input.actorUserId === input.contributorUserId
          ? 'SELF_REWARD_FORBIDDEN'
          : 'SOURCE_NOT_ELIGIBLE',
        sourceType,
        sourceId,
        rule.ruleVersion,
      );
    }
    if (
      (rule.requiresPublicSource && input.sourceVisibility !== 'PUBLIC') ||
      input.sourceState !== rule.requiredSourceState
    ) {
      return rejected('SOURCE_NOT_ELIGIBLE', sourceType, sourceId, rule.ruleVersion);
    }
    if (
      rule.requiredActorRoles &&
      (!input.actorRole || !rule.requiredActorRoles.includes(input.actorRole as 'MODERATOR' | 'ADMIN'))
    ) {
      return rejected('REVIEWER_REQUIRED', sourceType, sourceId, rule.ruleVersion);
    }

    return {
      eligible: true,
      system: rule.system,
      sourceType: rule.sourceType,
      sourceId,
      delta: rule.delta,
      reason: rule.reason,
      ruleVersion: rule.ruleVersion,
      idempotencyKey: `reputation:${rule.sourceType}:${sourceId}`,
    };
  }
}

function rejected(
  code: ContributionRuleRejectionCode,
  sourceType: string,
  sourceId: string,
  ruleVersion: string | null,
): RejectedContributionDecision {
  return {
    eligible: false,
    code,
    sourceType,
    sourceId,
    ruleVersion,
    idempotencyKey: null,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
