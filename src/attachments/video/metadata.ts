import { content } from '../validation/validation-error';
import { type Box, Mp4Reader, one, full, zeros } from './binary';
function utf8(bytes: Buffer): void { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); content(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)); }
/** A bounded discard-only metadata grammar. Never returns supplied metadata to the caller or native tool. */
export function inspectMovieMetadata(reader: Mp4Reader, box: Box): void {
  content(box.end - box.start <= 16384);
  const children = reader.children(box, ['meta', 'loci']);
  one(children, 'meta', false); one(children, 'loci', false);
  for (const child of children) {
    if (child.type === 'loci') {
      const b = full(child); content(b.length >= 22 && !(b.readUInt16BE(4) & 0x8000));
      const nameEnd = b.indexOf(0, 6); content(nameEnd >= 6 && nameEnd + 14 <= b.length); utf8(b.subarray(6, nameEnd));
      content(b[nameEnd + 1] <= 2);
      const longitude = b.readInt32BE(nameEnd + 2) / 65536, latitude = b.readInt32BE(nameEnd + 6) / 65536;
      content(Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90);
      const bodyEnd = b.indexOf(0, nameEnd + 14); content(bodyEnd >= nameEnd + 14); utf8(b.subarray(nameEnd + 14, bodyEnd));
      content(b[b.length - 1] === 0); utf8(b.subarray(bodyEnd + 1, b.length - 1));
      continue;
    }
    full(child); const nested = reader.children(child, ['hdlr', 'ilst'], 4);
    const handler = one(nested, 'hdlr')!, list = one(nested, 'ilst')!;
    const h = full(handler); content(h.length >= 24 && h.toString('latin1', 8, 12) === 'mdir'); zeros(h.subarray(4, 8));
    content(h.subarray(12, 16).equals(Buffer.from('appl')) || h.subarray(12, 16).every(x => x === 0)); zeros(h.subarray(16, 24));
    const fields = reader.children(list, ['\xa9nam', '\xa9cmt', '\xa9too']);
    for (const type of ['\xa9nam', '\xa9cmt', '\xa9too']) one(fields, type, false);
    for (const field of fields) {
      const atoms = reader.children(field, ['data']); content(atoms.length === 1);
      const data = full(atoms[0], 0, 1); content(data.length >= 8); zeros(data.subarray(4, 8)); utf8(data.subarray(8));
    }
  }
}
