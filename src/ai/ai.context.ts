import { AiContractError } from './ai.contracts';

export const AI_LEARNER_CONTEXT_VERSION = 'ai.learner-context.v1' as const;

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const DECLARED_PROFICIENCIES = ['NATIVE', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
const ASSESSED_PROFICIENCIES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
const MAX_GOALS = 10;
const MAX_GOAL_LENGTH = 64;
const MAX_LANGUAGE_NAME_LENGTH = 80;

export type AiDeclaredProficiency = typeof DECLARED_PROFICIENCIES[number];
export type AiAssessedProficiency = typeof ASSESSED_PROFICIENCIES[number];
export type AiEffectiveProficiency = AiDeclaredProficiency;

export interface AiLearnerContext {
  readonly version: typeof AI_LEARNER_CONTEXT_VERSION;
  readonly targetLanguage: {
    readonly code: string;
    readonly name: string;
  };
  readonly proficiency: {
    readonly declared: AiDeclaredProficiency;
    readonly assessed: AiAssessedProficiency | null;
    readonly effective: AiEffectiveProficiency;
    readonly source: 'DECLARED' | 'ASSESSED';
  };
  readonly learningGoals: readonly string[];
}

export interface ProjectLearnerContextOptions {
  readonly targetLanguageCode?: string;
}

export function projectLearnerContext(
  profile: unknown,
  options: ProjectLearnerContextOptions = {},
): AiLearnerContext {
  if (!isRecord(profile)) {
    throw invalidContext();
  }

  const languages = profile.languages;
  if (!Array.isArray(languages)) {
    throw invalidContext();
  }

  const projectedLanguages = languages.map(projectLanguage);
  const languageCodes = new Set<string>();
  for (const language of projectedLanguages) {
    if (languageCodes.has(language.code)) {
      throw invalidContext();
    }
    languageCodes.add(language.code);
  }

  const learningLanguages = projectedLanguages.filter((language) => language.isLearning);
  const requestedCode = normalizeOptionalLanguageCode(options.targetLanguageCode);
  const selected = requestedCode
    ? learningLanguages.find((language) => language.code === requestedCode)
    : selectPrimaryLearningLanguage(learningLanguages);

  if (!selected) {
    throw new AiContractError(
      'AI_CONTEXT_TARGET_UNAVAILABLE',
      'AI learner context target is unavailable',
    );
  }
  if (!selected.active) {
    throw new AiContractError(
      'AI_CONTEXT_TARGET_UNAVAILABLE',
      'AI learner context target is unavailable',
    );
  }

  const learningGoals = normalizeGoals(profile.goals);
  const assessed = selected.assessedProficiency;
  return {
    version: AI_LEARNER_CONTEXT_VERSION,
    targetLanguage: {
      code: selected.code,
      name: selected.name,
    },
    proficiency: {
      declared: selected.declaredProficiency,
      assessed,
      effective: assessed ?? selected.declaredProficiency,
      source: assessed ? 'ASSESSED' : 'DECLARED',
    },
    learningGoals,
  };
}

interface ProjectedLanguage {
  code: string;
  name: string;
  active: boolean;
  isLearning: boolean;
  isPrimaryLearningTarget: boolean;
  declaredProficiency: AiDeclaredProficiency;
  assessedProficiency: AiAssessedProficiency | null;
}

function projectLanguage(value: unknown): ProjectedLanguage {
  if (!isRecord(value) || !isRecord(value.language)) {
    throw invalidContext();
  }

  const language = value.language;
  const code = readLanguageCode(language.code);
  const name = readBoundedText(language.englishName, MAX_LANGUAGE_NAME_LENGTH);
  const roles = value.roles;
  if (!Array.isArray(roles) || !roles.every((role) => (
    role === 'native' || role === 'known' || role === 'learning'
  ))) {
    throw invalidContext();
  }

  const declaredProficiency = readDeclaredProficiency(value.declaredProficiency);
  const assessedProficiency = readAssessedProficiency(value.assessedProficiency);
  if (typeof language.active !== 'boolean' || typeof value.isPrimaryLearningTarget !== 'boolean') {
    throw invalidContext();
  }

  return {
    code,
    name,
    active: language.active,
    isLearning: roles.includes('learning'),
    isPrimaryLearningTarget: value.isPrimaryLearningTarget,
    declaredProficiency,
    assessedProficiency,
  };
}

function selectPrimaryLearningLanguage(
  languages: readonly ProjectedLanguage[],
): ProjectedLanguage {
  const primary = languages.filter((language) => language.isPrimaryLearningTarget);
  if (primary.length > 1) {
    throw new AiContractError(
      'AI_CONTEXT_TARGET_AMBIGUOUS',
      'AI learner context target is ambiguous',
    );
  }
  if (primary.length === 0) {
    throw new AiContractError(
      'AI_CONTEXT_TARGET_UNAVAILABLE',
      'AI learner context target is unavailable',
    );
  }
  return primary[0];
}

function normalizeGoals(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_GOALS) {
    throw invalidContext();
  }

  const goals = new Set<string>();
  for (const item of value) {
    const goal = readBoundedText(item, MAX_GOAL_LENGTH).toLowerCase();
    if (goals.has(goal)) continue;
    goals.add(goal);
  }
  return [...goals].sort(compareStrings);
}

function normalizeOptionalLanguageCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidContext();
  const normalized = value.trim().toLowerCase();
  if (!LANGUAGE_CODE_PATTERN.test(normalized)) throw invalidContext();
  return normalized;
}

function readLanguageCode(value: unknown): string {
  if (typeof value !== 'string') throw invalidContext();
  const normalized = value.trim().toLowerCase();
  if (!LANGUAGE_CODE_PATTERN.test(normalized)) throw invalidContext();
  return normalized;
}

function readDeclaredProficiency(value: unknown): AiDeclaredProficiency {
  if (typeof value !== 'string' || !DECLARED_PROFICIENCIES.includes(value as AiDeclaredProficiency)) {
    throw invalidContext();
  }
  return value as AiDeclaredProficiency;
}

function readAssessedProficiency(value: unknown): AiAssessedProficiency | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ASSESSED_PROFICIENCIES.includes(value as AiAssessedProficiency)) {
    throw invalidContext();
  }
  return value as AiAssessedProficiency;
}

function readBoundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw invalidContext();
  const normalized = normalizeText(value);
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw invalidContext();
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidContext(): AiContractError {
  return new AiContractError(
    'AI_CONTEXT_INVALID',
    'AI learner context is invalid',
  );
}
