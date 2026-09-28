import { tatoebaError } from './tatoeba.errors';

const OFFSET_AWARE_ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function validateSnapshotRetrievedAt(value: string): string {
  const match = OFFSET_AWARE_ISO_8601.exec(value);
  if (!match) {
    throw tatoebaError(
      'TATOEBA_IMPORT_ARGUMENT_INVALID',
      'Snapshot retrieval time must be a strict offset-aware ISO-8601 timestamp.',
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHours = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinutes = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (
    month < 1 || month > 12 ||
    day < 1 || day > (daysInMonth ?? 0) ||
    hours > 23 || minutes > 59 || seconds > 59 ||
    offsetHours > 23 || offsetMinutes > 59 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw tatoebaError(
      'TATOEBA_IMPORT_ARGUMENT_INVALID',
      'Snapshot retrieval time must be a valid offset-aware ISO-8601 timestamp.',
    );
  }

  return value;
}
