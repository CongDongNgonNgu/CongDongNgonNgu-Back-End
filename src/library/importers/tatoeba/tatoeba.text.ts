import { TATOEBA_LIBRARY_TEXT_MAX_CHARS } from './tatoeba.constants';

export type TatoebaLibraryTextEligibility =
  | { ok: true; characterLength: number }
  | { ok: false; reason: 'TATOEBA_EMPTY_TEXT' | 'TATOEBA_TEXT_TOO_LONG'; characterLength: number };

/** Matches PostgreSQL char_length for valid UTF-8 text by counting Unicode code points. */
export function libraryTextCharacterLength(text: string): number {
  return Array.from(text).length;
}

/** Inspects text without normalizing or otherwise changing the candidate value. */
export function validateTatoebaLibraryText(text: string): TatoebaLibraryTextEligibility {
  const characterLength = libraryTextCharacterLength(text);
  if (characterLength > TATOEBA_LIBRARY_TEXT_MAX_CHARS) {
    return { ok: false, reason: 'TATOEBA_TEXT_TOO_LONG', characterLength };
  }
  if (/^\s*$/u.test(text)) {
    return { ok: false, reason: 'TATOEBA_EMPTY_TEXT', characterLength };
  }
  return { ok: true, characterLength };
}
