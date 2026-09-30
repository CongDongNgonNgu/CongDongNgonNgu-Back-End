import { Injectable } from '@nestjs/common';
import {
  CONTRIBUTION_SOURCE_TYPES,
  type ContributionRuleInput,
} from './reputation.rules';
import type { ContributionEventFact } from './reputation.types';

export const ANTI_FARMING_RULE_VERSION = 'community-antifarming-v1' as const;
export const MAX_SOURCE_FINGERPRINT_LENGTH = 128;

export type AntiFarmingRejectionCode =
  | 'SELF_REWARD_FORBIDDEN'
  | 'DUPLICATE_SOURCE_EVENT'
  | 'REPEATED_LOW_VALUE_SOURCE'
  | 'COORDINATED_REWARD_PATTERN'
  | 'ANTI_FARMING_FACTS_INVALID';

export type AntiFarmingObservationCode =
  | 'EXACT_REPLAY'
  | 'REUSED_ACTOR_CONTRIBUTOR_PAIR';

export interface AntiFarmingObservation {
  code: AntiFarmingObservationCode;
  severity: 'OBSERVE';
}

export interface AllowedAntiFarmingDecision {
  allowed: true;
  ruleVersion: string;
  observations: readonly AntiFarmingObservation[];
}

export interface RejectedAntiFarmingDecision {
  allowed: false;
  code: AntiFarmingRejectionCode;
  ruleVersion: string;
  observations: readonly AntiFarmingObservation[];
}

export type AntiFarmingDecision =
  | AllowedAntiFarmingDecision
  | RejectedAntiFarmingDecision;

/**
 * V1 anti-farming intentionally uses only server facts already available at
 * the contribution boundary. It has no opaque score, client flag, cooldown,
 * daily cap or process-local clock window.
 */
@Injectable()
export class AntiFarmingRuleEngine {
  evaluate(input: ContributionRuleInput): AntiFarmingDecision {
    if (!isContributionInputValid(input)) {
      return rejected('ANTI_FARMING_FACTS_INVALID');
    }

    if (input.actorUserId === input.contributorUserId) {
      return rejected('SELF_REWARD_FORBIDDEN');
    }

    const priorFacts = input.priorContributionFacts ?? [];
    if (!priorFacts.every(isContributionFactValid)) {
      return rejected('ANTI_FARMING_FACTS_INVALID');
    }

    const sourceType = input.sourceType;
    const sameSource = priorFacts.filter((fact) => (
      fact.sourceType === sourceType && fact.sourceId === input.sourceId
    ));
    if (sameSource.length > 0) {
      const isReplay = sameSource.some((fact) => (
        fact.contributorUserId === input.contributorUserId &&
        fact.actorUserId === input.actorUserId &&
        fingerprintsMatchForReplay(fact.sourceFingerprint, input.sourceFingerprint)
      ));
      if (isReplay) {
        return allowed([{ code: 'EXACT_REPLAY', severity: 'OBSERVE' }]);
      }
      return rejected('DUPLICATE_SOURCE_EVENT');
    }

    const fingerprint = normalizeFingerprint(input.sourceFingerprint);
    if (fingerprint !== null) {
      const repeatedFingerprint = priorFacts.filter((fact) => (
        fact.sourceType === sourceType &&
        fact.sourceId !== input.sourceId &&
        normalizeFingerprint(fact.sourceFingerprint) === fingerprint
      ));
      if (repeatedFingerprint.some((fact) => fact.contributorUserId === input.contributorUserId)) {
        return rejected('REPEATED_LOW_VALUE_SOURCE');
      }
      if (
        input.actorUserId !== null &&
        repeatedFingerprint.some((fact) => (
          fact.actorUserId === input.actorUserId &&
          fact.contributorUserId !== input.contributorUserId
        ))
      ) {
        return rejected('COORDINATED_REWARD_PATTERN');
      }
    }

    const pairWasReused = priorFacts.some((fact) => (
      fact.sourceType === sourceType &&
      fact.sourceId !== input.sourceId &&
      fact.contributorUserId === input.contributorUserId &&
      fact.actorUserId !== null &&
      fact.actorUserId === input.actorUserId
    ));
    return allowed(pairWasReused
      ? [{ code: 'REUSED_ACTOR_CONTRIBUTOR_PAIR', severity: 'OBSERVE' }]
      : []);
  }
}

function allowed(observations: readonly AntiFarmingObservation[]): AllowedAntiFarmingDecision {
  return {
    allowed: true,
    ruleVersion: ANTI_FARMING_RULE_VERSION,
    observations,
  };
}

function rejected(code: AntiFarmingRejectionCode): RejectedAntiFarmingDecision {
  return {
    allowed: false,
    code,
    ruleVersion: ANTI_FARMING_RULE_VERSION,
    observations: [],
  };
}

function isContributionInputValid(input: ContributionRuleInput): boolean {
  return (
    isUuid(input.contributorUserId) &&
    isUuid(input.sourceId) &&
    CONTRIBUTION_SOURCE_TYPES.includes(input.sourceType as typeof CONTRIBUTION_SOURCE_TYPES[number]) &&
    isUuidOrNull(input.actorUserId) &&
    isFingerprintValid(input.sourceFingerprint) &&
    input.occurredAt instanceof Date &&
    Number.isFinite(input.occurredAt.getTime())
  );
}

function isContributionFactValid(fact: ContributionEventFact): boolean {
  return (
    isUuid(fact.contributorUserId) &&
    isUuidOrNull(fact.actorUserId) &&
    CONTRIBUTION_SOURCE_TYPES.includes(fact.sourceType as typeof CONTRIBUTION_SOURCE_TYPES[number]) &&
    isUuid(fact.sourceId) &&
    isFingerprintValid(fact.sourceFingerprint) &&
    fact.occurredAt instanceof Date &&
    Number.isFinite(fact.occurredAt.getTime())
  );
}

function isFingerprintValid(value: string | null | undefined): boolean {
  return value === undefined || value === null || (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_SOURCE_FINGERPRINT_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim();
}

function fingerprintsMatchForReplay(
  previous: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (previous === undefined || current === undefined) return true;
  return normalizeFingerprint(previous) === normalizeFingerprint(current);
}

function isUuidOrNull(value: string | null): boolean {
  return value === null || isUuid(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
