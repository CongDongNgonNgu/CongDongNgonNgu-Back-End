import { AttachmentValidationError, content } from './validation-error';
import { declaredAttachmentFormat } from './metadata';
import { parseJpeg } from './jpeg';
import { parsePng } from './png';
import { parseWebp } from './webp';
import type { ImageStructure } from './structure';
export type { ImageStructure } from './structure';
/** Framing is a prerequisite, never a substitute for bounded fatal full decode and sanitization. */
export function validateImageStructure(bytes: Buffer, declaration: { filename: string; mime: string }): ImageStructure {
  const format = declaredAttachmentFormat(declaration.filename, declaration.mime);
  if (!['jpeg', 'png', 'webp'].includes(format)) throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
  if (bytes.length > 4194304) throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
  content(bytes.length > 0);
  try {
    if (format === 'jpeg') return parseJpeg(bytes);
    if (format === 'png') return parsePng(bytes);
    return parseWebp(bytes);
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw new AttachmentValidationError('ATTACHMENT_INVALID_CONTENT');
  }
}
