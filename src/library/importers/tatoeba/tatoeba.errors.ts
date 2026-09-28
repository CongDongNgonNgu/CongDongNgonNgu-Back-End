export type TatoebaErrorCode =
  | 'TATOEBA_MALFORMED_BULK_ROW'
  | 'TATOEBA_INVALID_UTF8'
  | 'TATOEBA_LINE_TOO_LONG'
  | 'TATOEBA_INPUT_LIMIT_EXCEEDED'
  | 'TATOEBA_INVALID_ID'
  | 'TATOEBA_EMPTY_TEXT'
  | 'TATOEBA_UNSUPPORTED_LANGUAGE'
  | 'TATOEBA_DIRECTION_INVALID'
  | 'TATOEBA_LICENSE_PROBLEM'
  | 'TATOEBA_LICENSE_UNKNOWN'
  | 'TATOEBA_OWNER_REQUIRED'
  | 'TATOEBA_OWNER_MISMATCH'
  | 'TATOEBA_TEXT_MISMATCH'
  | 'TATOEBA_LANGUAGE_MISMATCH'
  | 'TATOEBA_CC0_MISMATCH'
  | 'TATOEBA_UNAPPROVED'
  | 'TATOEBA_API_NOT_FOUND'
  | 'TATOEBA_API_UNAVAILABLE'
  | 'TATOEBA_API_MALFORMED_RESPONSE'
  | 'TATOEBA_API_RESPONSE_TOO_LARGE'
  | 'TATOEBA_API_HOST_REJECTED'
  | 'TATOEBA_API_ID_INVALID'
  | 'TATOEBA_REPORT_BOUNDS_EXCEEDED'
  | 'TATOEBA_REPORT_WRITE_FAILED'
  | 'TATOEBA_IMPORT_ARGUMENT_INVALID'
  | 'TATOEBA_IMPORT_WRITE_MODE_NOT_IMPLEMENTED';

export class TatoebaImportError extends Error {
  constructor(
    readonly code: TatoebaErrorCode,
    message: string,
    readonly details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = 'TatoebaImportError';
  }
}

export function tatoebaError(
  code: TatoebaErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): TatoebaImportError {
  return new TatoebaImportError(code, message, details);
}

export function safeTatoebaDetails(
  details: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/path|filename/i.test(key)) continue;
    if (
      typeof value === 'string' &&
      (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) || value.includes('\\'))
    ) continue;
    safe[key] = value;
  }
  return safe;
}
