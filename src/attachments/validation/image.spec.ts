import { deflateSync } from 'node:zlib';
import { validateImageStructure } from './image';
import { AttachmentValidationError } from './validation-error';
// Deterministic framing fixtures; passing this parser never replaces fatal native full decoding.
function crc(bytes: Buffer): number { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type: string, data: Buffer): Buffer { const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); head.write(type, 4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([head, data, tail]); }
function png(width = 1, height = 1, extra: Buffer[] = []): Buffer { const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', h), ...extra, pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))]); }
function segment(marker: number, data: Buffer): Buffer { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(data.length + 2, 2); return Buffer.concat([h, data]); }
function jpeg(width = 1, height = 1, extra: Buffer[] = []): Buffer { const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); const huff = Buffer.from([0, 1, ...Array<number>(15).fill(0), 0]); return Buffer.concat([Buffer.from([0xff, 0xd8]), ...extra, segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])), segment(0xc4, huff), segment(0xc4, Buffer.from([0x10, ...huff.subarray(1)])), segment(0xc0, sof), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x3f, 0xff, 0xd9])]); }
function webChunk(type: string, data: Buffer): Buffer { const h = Buffer.alloc(8); h.write(type); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, ...(data.length % 2 ? [Buffer.from([0])] : [])]); }
function webp(chunks = [webChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 0]))]): Buffer { const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), h = Buffer.alloc(8); h.write('RIFF'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); }
const declarations = { jpeg: { filename: 'test.jpg', mime: 'image/jpeg' }, png: { filename: 'test.png', mime: 'image/png' }, webp: { filename: 'test.webp', mime: 'image/webp' } };
describe('bounded frozen image framing', () => {
  it('rejects malformed metadata compression headers without inflating metadata', () => {
    for (const chunk of [pngChunk('zTXt', Buffer.from('key\0\0not zlib')), pngChunk('iCCP', Buffer.from('profile\0\0not zlib')), pngChunk('iTXt', Buffer.from([0x6b, 0, 0, 0, 0, 0, 0xff]))]) expect(() => validateImageStructure(png(1, 1, [chunk]), declarations.png)).toThrow(AttachmentValidationError);
    expect(validateImageStructure(png(1, 1, [pngChunk('zTXt', Buffer.concat([Buffer.from('key\0\0'), deflateSync(Buffer.from('synthetic'))]))]), declarations.png).format).toBe('png');
  });
  it('rejects resumed IDAT chunks and out-of-range 8-bit transparency', () => {
    const valid = png(), headerEnd = 33, dataEnd = valid.length - 12;
    const split = Buffer.concat([valid.subarray(0, dataEnd), pngChunk('tEXt', Buffer.from('k\0v')), valid.subarray(headerEnd, dataEnd), valid.subarray(dataEnd)]);
    expect(() => validateImageStructure(split, declarations.png)).toThrow(AttachmentValidationError);
    expect(() => validateImageStructure(png(1, 1, [pngChunk('tRNS', Buffer.from([1, 0, 0, 0, 0, 0]))]), declarations.png)).toThrow(AttachmentValidationError);
  });
  it('does not mask high-bit bytes into ASCII FourCC identities', () => {
    const chunk = pngChunk('tEXt', Buffer.from('key\0value')); chunk[4] |= 0x80; chunk.writeUInt32BE(crc(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
    expect(() => validateImageStructure(png(1, 1, [chunk]), declarations.png)).toThrow(AttachmentValidationError);
    const riff = webp(); riff[0] |= 0x80;
    expect(() => validateImageStructure(riff, declarations.webp)).toThrow(AttachmentValidationError);
  });
  it('handles permitted reordered WebP metadata, alpha and VP8 headers', () => {
    const lossy = Buffer.from([0x90, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0, 0, 0, 0, 0]);
    expect(validateImageStructure(webp([webChunk('VP8 ', lossy)]), declarations.webp).width).toBe(1);
    const x = Buffer.alloc(10); x[0] = 8;
    expect(validateImageStructure(webp([webChunk('VP8X', x), webChunk('EXIF', Buffer.from([0x49, 0x49, 42, 0, 0, 0, 0, 0])), webChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 0]))]), declarations.webp).metadataBytes).toBe(8);
    const alphaX = Buffer.alloc(10); alphaX[0] = 16;
    expect(validateImageStructure(webp([webChunk('VP8X', alphaX), webChunk('ALPH', Buffer.from([0, 255])), webChunk('VP8 ', lossy)]), declarations.webp).width).toBe(1);
  });

  it.each([['jpeg', jpeg()], ['png', png()], ['webp', webp()]] as const)('recognizes %s framing and refuses trailing/concatenated/truncated data', (format, bytes) => {
    expect(validateImageStructure(bytes, declarations[format])).toMatchObject({ format, width: 1, height: 1 });
    for (const invalid of [Buffer.concat([bytes, Buffer.from('<script>')]), Buffer.concat([bytes, bytes]), bytes.subarray(0, bytes.length - 1)]) expect(() => validateImageStructure(invalid, declarations[format])).toThrow(AttachmentValidationError);
  });
  it('rejects MIME/signature mismatch, oversized bytes/pixels/edges', () => {
    expect(() => validateImageStructure(jpeg(), declarations.png)).toThrow(AttachmentValidationError);
    for (const bytes of [png(2000, 1501), png(3000, 1000), Buffer.alloc(4194305)]) expect(() => validateImageStructure(bytes, declarations.png)).toThrow(AttachmentValidationError);
  });
  it('checks PNG CRC, chunk ordering, animation and unknown critical/ancillary chunks', () => {
    expect(pngChunk('IEND', Buffer.alloc(0)).subarray(-4).toString('hex')).toBe('ae426082');
    const corrupt = png(); corrupt[30] ^= 1;
    for (const bytes of [corrupt, png(1, 1, [pngChunk('acTL', Buffer.alloc(8))]), png(1, 1, [pngChunk('zzZZ', Buffer.alloc(0))]), png(1, 1, [pngChunk('IEND', Buffer.alloc(0))])]) expect(() => validateImageStructure(bytes, declarations.png)).toThrow(AttachmentValidationError);
  });
  it('bounds permitted disposable metadata and rejects malformed text metadata', () => {
    const text = Buffer.concat([Buffer.from('key\0'), Buffer.alloc(262141, 0x61)]);
    expect(validateImageStructure(png(1, 1, [pngChunk('tEXt', text.subarray(0, 262144))]), declarations.png).metadataBytes).toBe(262144);
    for (const extra of [pngChunk('tEXt', Buffer.concat([text, Buffer.from('x')])), pngChunk('tEXt', Buffer.from('missing nul'))]) expect(() => validateImageStructure(png(1, 1, [extra]), declarations.png)).toThrow(AttachmentValidationError);
  });
  it('rejects nonbaseline JPEG, unknown APP signatures and missing scan tables', () => {
    const progressive = jpeg(); progressive[progressive.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc2;
    for (const bytes of [progressive, jpeg(1, 1, [segment(0xe1, Buffer.from('html'))]), jpeg(1, 1, [segment(0xe3, Buffer.from('unknown'))])]) expect(() => validateImageStructure(bytes, declarations.jpeg)).toThrow(AttachmentValidationError);
    const missing = jpeg(); const dht = missing.indexOf(Buffer.from([0xff, 0xc4])); const len = missing.readUInt16BE(dht + 2); const removed = Buffer.concat([missing.subarray(0, dht), missing.subarray(dht + 2 + len)]);
    expect(() => validateImageStructure(removed, declarations.jpeg)).toThrow(AttachmentValidationError);
  });
  it('rejects animated WebP, unknown chunks, inconsistent flags/dimensions and nonzero padding', () => {
    const x = Buffer.alloc(10); x[0] = 2;
    for (const bytes of [webp([webChunk('VP8X', x), webChunk('ANIM', Buffer.alloc(6))]), webp([webChunk('JUNK', Buffer.alloc(2))]), webp([webChunk('VP8X', Buffer.alloc(10)), webChunk('VP8L', Buffer.from([0x2f, 1, 0, 0, 0, 0]))])]) expect(() => validateImageStructure(bytes, declarations.webp)).toThrow(AttachmentValidationError);
    const padded = webp([webChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 0, 0]))]); padded[padded.length - 1] = 1;
    expect(() => validateImageStructure(padded, declarations.webp)).toThrow(AttachmentValidationError);
  });
});
