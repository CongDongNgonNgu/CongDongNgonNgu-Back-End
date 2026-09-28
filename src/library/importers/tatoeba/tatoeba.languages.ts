import { TATOEBA_LANGUAGE_MAPPING, TATOEBA_SUPPORTED_PROJECT_LANGUAGES } from './tatoeba.constants';
import { tatoebaError } from './tatoeba.errors';
import type { TatoebaConfiguredDirection, TatoebaProjectLanguage } from './tatoeba.types';

export function mapTatoebaLanguage(code: string | null | undefined): TatoebaProjectLanguage | null {
  if (!code) return null;
  return TATOEBA_LANGUAGE_MAPPING[code] ?? null;
}

export function isProjectLanguage(value: string): value is TatoebaProjectLanguage {
  return (TATOEBA_SUPPORTED_PROJECT_LANGUAGES as readonly string[]).includes(value);
}

export function parseConfiguredLanguages(input: string): TatoebaProjectLanguage[] {
  const values = input.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => !isProjectLanguage(value))) {
    throw tatoebaError('TATOEBA_DIRECTION_INVALID', 'Configured languages must use supported project codes.');
  }
  const result: TatoebaProjectLanguage[] = [];
  for (const value of values) {
    const language = value as TatoebaProjectLanguage;
    if (result.includes(language)) {
      throw tatoebaError('TATOEBA_DIRECTION_INVALID', `Duplicate configured language: ${value}.`);
    }
    result.push(language);
  }
  return result;
}

export function parseConfiguredDirections(input: string): TatoebaConfiguredDirection[] {
  const values = input.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw tatoebaError('TATOEBA_DIRECTION_INVALID', 'At least one language direction is required.');
  }
  const result: TatoebaConfiguredDirection[] = [];
  for (const value of values) {
    const parts = value.split(':');
    if (parts.length !== 2 || !isProjectLanguage(parts[0]) || !isProjectLanguage(parts[1]) || parts[0] === parts[1]) {
      throw tatoebaError('TATOEBA_DIRECTION_INVALID', `Invalid configured direction: ${value}.`);
    }
    const direction = {
      sourceLanguage: parts[0],
      targetLanguage: parts[1],
    } satisfies TatoebaConfiguredDirection;
    if (result.some((item) => item.sourceLanguage === direction.sourceLanguage && item.targetLanguage === direction.targetLanguage)) {
      throw tatoebaError('TATOEBA_DIRECTION_INVALID', `Duplicate configured direction: ${value}.`);
    }
    result.push(direction);
  }
  return result;
}
