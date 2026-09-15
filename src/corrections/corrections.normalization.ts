import {
  CORRECTION_INTENTS,
  type CorrectionIntent,
} from './corrections.types';

export const MAX_PHASE06_SOURCE_CODE_POINTS = 20_000;
export const MAX_PHASE06_CONTEXT_CODE_POINTS = 5_000;
export const MAX_PHASE06_EXPLANATION_CODE_POINTS = 5_000;
export const MAX_PHASE06_TOPIC_CODE_POINTS = 80;

export class Phase06ValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'Phase06ValidationError';
  }
}

export function normalizePhase06Text(
  input: unknown,
  maxLength = MAX_PHASE06_SOURCE_CODE_POINTS,
): string {
  if (typeof input !== 'string') {
    throw new Phase06ValidationError('PHASE06_TEXT_INVALID');
  }

  const normalized = input.replace(/\r\n?/gu, '\n');
  if (normalized.trim().length === 0) {
    throw new Phase06ValidationError('PHASE06_TEXT_EMPTY');
  }
  if (Array.from(normalized).length > maxLength) {
    throw new Phase06ValidationError('PHASE06_TEXT_TOO_LONG');
  }
  return normalized;
}

export function normalizePhase06OptionalText(
  input: unknown,
  maxLength = MAX_PHASE06_CONTEXT_CODE_POINTS,
): string | null {
  if (input === undefined || input === null || input === '') return null;
  return normalizePhase06Text(input, maxLength);
}

export function normalizeCorrectionIntent(input: unknown): CorrectionIntent {
  if (typeof input !== 'string') {
    throw new Phase06ValidationError('CORRECTION_INTENT_INVALID');
  }
  const normalized = input.normalize('NFKC').trim().toUpperCase();
  if (!CORRECTION_INTENTS.includes(normalized as CorrectionIntent)) {
    throw new Phase06ValidationError('CORRECTION_INTENT_INVALID');
  }
  return normalized as CorrectionIntent;
}
