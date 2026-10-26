import { normalizeAttachmentMetadata, declaredAttachmentFormat } from './metadata';
import { validateTextFile } from './text';
import { AttachmentValidationError } from './validation-error';
const declaration = { filename: 'lesson.txt', mime: 'text/plain' };
describe('frozen attachment text/metadata boundary', () => {
  it('preserves VI/EN and astral text, accepts exactly one leading BOM and byte boundary', () => {
    const text = 'Xin ch\u00e0o Vi\u1ec7t Nam. English. \ud83d\ude00\n\t';
    expect(validateTextFile(Buffer.from(text), declaration)).toBe(text);
    expect(validateTextFile(Buffer.from('\ufeff' + text), declaration)).toBe(text);
    expect(validateTextFile(Buffer.alloc(65536, 0x61), declaration)).toHaveLength(65536);
  });
  it.each([Buffer.alloc(0), Buffer.from(' \t\n'), Buffer.from([0xe2, 0x82]), Buffer.from([0xc0, 0xaf]), Buffer.from('a\0b'), Buffer.from('a\u0085b'), Buffer.from('\ufeff\ufeffx'), Buffer.from('x\ufeffy'), Buffer.alloc(65537, 0x61)])('rejects invalid text without reflecting content', bytes => {
    expect(() => validateTextFile(bytes, declaration)).toThrow(AttachmentValidationError);
  });
  it.each(['%PDF-1.4\nASCII PDF', '\ufeff%pDf-1.4', '\t <HTML>', '<!DOCTYPE html>', '<svg/>', '<?xml version="1.0"?>', '<script>1</script>', ' #!/bin/sh\nx', 'MZascii', Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from([0x7f, 0x45, 0x4c, 0x46])])('rejects renamed recognized foreign signatures %p', value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    expect(() => validateTextFile(bytes, declaration)).toThrow(AttachmentValidationError);
  });
  it('does not claim a general script/markup classifier', () => {
    for (const text of ['<htmlish> text', 'Explain %PDF- headers', 'const n = 1;', '<p>literal text</p>']) expect(validateTextFile(Buffer.from(text), declaration)).toBe(text);
  });
  it('normalizes NFC and counts Unicode code points', () => {
    expect(normalizeAttachmentMetadata({ filename: 'cafe\u0301.txt', caption: '\ud83d\ude00'.repeat(500) }).filename).toBe('caf\u00e9.txt');
    expect(() => normalizeAttachmentMetadata({ filename: 'x.txt', caption: 'x'.repeat(501) })).toThrow(AttachmentValidationError);
    expect(() => normalizeAttachmentMetadata({ filename: 'x.txt', alt: 'x'.repeat(301) })).toThrow(AttachmentValidationError);
  });
  it.each(['../x.txt', 'x\\y.txt', 'x\0.txt', 'x\u202etxt', '\ud800.txt', 'x'.repeat(181)])('rejects unsafe filenames %p', filename => {
    expect(() => normalizeAttachmentMetadata({ filename })).toThrow(AttachmentValidationError);
  });
  it('requires matching extension and exact declared MIME', () => {
    expect(declaredAttachmentFormat('PHOTO.JPEG', 'image/jpeg')).toBe('jpeg');
    for (const [filename, mime] of [['x.jpg', 'image/png'], ['x.svg', 'image/svg+xml'], ['x.txt', 'text/plain;charset=utf-8']]) expect(() => declaredAttachmentFormat(filename, mime)).toThrow(AttachmentValidationError);
    expect(() => validateTextFile(Buffer.from('valid'), { filename: 'x.jpg', mime: 'image/jpeg' })).toThrow(AttachmentValidationError);
  });
});
