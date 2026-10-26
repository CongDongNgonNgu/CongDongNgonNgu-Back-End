import { AttachmentValidationError } from './validation-error';
export type AttachmentFormat = 'jpeg' | 'png' | 'webp' | 'txt' | 'mp4';
const forbidden = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\uD800-\uDFFF]/u;
function field(input: unknown, maximum: number, required: boolean): string {
  if (input === undefined && !required) return '';
  if (typeof input !== 'string' || forbidden.test(input)) throw new AttachmentValidationError('ATTACHMENT_INVALID_METADATA');
  const value = input.normalize('NFC').trim();
  if ((required && !value) || Array.from(value).length > maximum) throw new AttachmentValidationError('ATTACHMENT_INVALID_METADATA');
  return value;
}
export function normalizeAttachmentMetadata(input: { filename: unknown; caption?: unknown; alt?: unknown }): { filename: string; caption: string; alt: string } {
  const filename = field(input.filename, 180, true);
  if (/[\\/:]/u.test(filename) || Buffer.byteLength(filename, 'utf8') > 720) throw new AttachmentValidationError('ATTACHMENT_INVALID_METADATA');
  return { filename, caption: field(input.caption, 500, false), alt: field(input.alt, 300, false) };
}
export function declaredAttachmentFormat(filename: string, mime: string): AttachmentFormat {
  const safe = normalizeAttachmentMetadata({ filename }).filename;
  const extension = /\.([a-z0-9]+)$/i.exec(safe)?.[1].toLowerCase();
  const types: Record<string, [AttachmentFormat, string]> = { jpg: ['jpeg', 'image/jpeg'], jpeg: ['jpeg', 'image/jpeg'], png: ['png', 'image/png'], webp: ['webp', 'image/webp'], txt: ['txt', 'text/plain'], mp4: ['mp4', 'video/mp4'] };
  const pair = extension ? types[extension] : undefined;
  if (!pair || mime !== pair[1]) throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
  return pair[0];
}
