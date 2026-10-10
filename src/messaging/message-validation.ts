import { MessageFailure } from './message-failure';

export const MAX_MESSAGE_CODE_POINTS = 4000;
const MAX_POSTGRES_BIGINT = 9223372036854775807n;

export function normalizeMessageText(input: unknown): string {
  if (typeof input !== 'string') throw invalidText();
  const text = input.normalize('NFC').trim();
  // PostgreSQL text excludes NUL; lone surrogates are not Unicode scalar values.
  // Unicode mode leaves legitimate astral characters outside the surrogate class.
  if (!text || /[\u0000\uD800-\uDFFF]/u.test(text)
    || [...text].length > MAX_MESSAGE_CODE_POINTS) throw invalidText();
  return text;
}

export function parseSequence(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input)) throw invalidSequence();
  const sequence = BigInt(input);
  if (sequence > MAX_POSTGRES_BIGINT) throw invalidSequence();
  return sequence;
}

export function compareSequences(first: string, second: string): -1 | 0 | 1 {
  const a = parseSequence(first);
  const b = parseSequence(second);
  return a === b ? 0 : a < b ? -1 : 1;
}

function invalidText(): MessageFailure {
  return new MessageFailure('MESSAGE_INVALID_TEXT', 400, 'Message text must contain 1 to 4000 Unicode code points');
}

function invalidSequence(): MessageFailure {
  return new MessageFailure('MESSAGE_INVALID_SEQUENCE', 400, 'Message sequence is invalid');
}
