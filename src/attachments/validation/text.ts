import { declaredAttachmentFormat } from './metadata';
import { AttachmentValidationError, content } from './validation-error';
/** Structural TXT policy only. Callers must use an inert .txt attachment download, never HTML rendering. */
export function validateTextFile(bytes: Buffer, declaration: { filename: string; mime: string }): string {
  if (declaredAttachmentFormat(declaration.filename, declaration.mime) !== 'txt') throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
  if (bytes.length > 65536) throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
  let offset = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  while (offset < bytes.length && [9, 10, 13, 32].includes(bytes[offset])) offset++;
  const prefix = bytes.subarray(offset);
  content(!/^%PDF-/i.test(prefix.subarray(0, 5).toString('ascii')));
  for (const signature of [[0x50, 0x4b, 3, 4], [0x50, 0x4b, 5, 6], [0x50, 0x4b, 7, 8], [0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46]]) content(!prefix.subarray(0, signature.length).equals(Buffer.from(signature)));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AttachmentValidationError('ATTACHMENT_INVALID_CONTENT'); }
  content(!text.includes('\ufeff') && !!text.trim());
  content(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text));
  const start = text.replace(/^[ \t\r\n]*/, '');
  content(!/^(?:<!doctype[ \t\r\n]+html(?=[ \t\r\n>])|<(?:html|svg|script)(?=[ \t\r\n/>])|<\?xml(?=[ \t\r\n?])|#!)/i.test(start));
  return text;
}
