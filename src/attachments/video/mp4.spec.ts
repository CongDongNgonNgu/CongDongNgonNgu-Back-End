import { createHash } from 'node:crypto';
import { validateMp4Structure } from './mp4';
import { syntheticMp4 } from './synthetic-fixtures';
import { parseAvcConfiguration, inspectAvcSample } from './avc';
import { Mp4Reader, type Box } from './binary';
import { parseSampleTables } from './sample-tables';
import { inspectMovieMetadata } from './metadata';
import { AttachmentValidationError } from '../validation/validation-error';
const declaration = { filename: 'synthetic.mp4', mime: 'video/mp4' };
function fixture(audio = false): Buffer { const value = audio ? syntheticMp4.withAudio : syntheticMp4.videoOnly; const bytes = Buffer.from(value.base64, 'base64'); expect(createHash('sha256').update(bytes).digest('hex')).toBe(value.sha256); return bytes; }
function offset(bytes: Buffer, type: string): number { let index = 0; while ((index = bytes.indexOf(Buffer.from(type, 'latin1'), index)) >= 0) { if (index >= 4) { const size = bytes.readUInt32BE(index - 4); if (size >= 8 && index - 4 + size <= bytes.length) return index - 4; } index++; } throw Error('missing fixture box'); }
function mutate(type: string, edit: (bytes: Buffer, box: number) => void, audio = false): Buffer { const bytes = fixture(audio); edit(bytes, offset(bytes, type)); return bytes; }
function invalid(bytes: Buffer): void { expect(() => validateMp4Structure(bytes, declaration)).toThrow(AttachmentValidationError); }
describe('strict frozen MP4 structural preflight, never native decode or READY', () => {
  it.each([false, true])('accepts the tiny approved synthetic baseline fixture, audio=%s, as structural-only', audio => {
    expect(validateMp4Structure(fixture(audio), declaration)).toMatchObject({ structuralOnly: true, requiresNativeValidation: true, width: 128, height: 72, frameRate: 4, durationSeconds: 0.5, videoSamples: 2, audioSamples: audio ? 25 : 0 });
  });
  it('requires declared MIME/extension, byte cap and complete exact container framing', () => {
    expect(() => validateMp4Structure(fixture(), { ...declaration, filename: 'x.txt' })).toThrow(AttachmentValidationError);
    expect(() => validateMp4Structure(fixture(), { ...declaration, mime: 'text/plain' })).toThrow(AttachmentValidationError);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(3145729), fixture().subarray(0, -1), Buffer.concat([fixture(), Buffer.from([0])]), Buffer.concat([fixture(), fixture()])]) invalid(bytes);
    for (const size of [0, 1, 7, 0xffffffff]) invalid(mutate('moov', (b, p) => b.writeUInt32BE(size, p)));
  });
  it('rejects unapproved brands, unknown/fragmented boxes and nonempty free payload', () => {
    invalid(mutate('ftyp', (b, p) => b.write('qt  ', p + 8)));
    invalid(mutate('ftyp', (b, p) => b.write('dash', p + 16)));
    for (const [type, replacement] of [['moov', 'moof'], ['free', 'uuid'], ['stco', 'co64'], ['avc1', 'encv'], ['mp4a', 'enca']]) invalid(mutate(type, (b, p) => b.write(replacement, p + 4), type === 'mp4a'));
    invalid(mutate('free', (b, p) => b.writeUInt32BE(9, p)));
  });
  it('rejects external data references and wrong sample-entry reference index', () => {
    invalid(mutate('dref', (b, p) => b[p + 23] = 0));
    invalid(mutate('dref', (b, p) => b.writeUInt32BE(2, p + 12)));
    invalid(mutate('avc1', (b, p) => b.writeUInt16BE(2, p + 14)));
    invalid(mutate('mp4a', (b, p) => b.writeUInt16BE(2, p + 14), true));
  });
  it('validates sample table counts, mapping, offsets and nonoverlap', () => {
    invalid(mutate('stsz', (b, p) => b.writeUInt32BE(361, p + 16)));
    invalid(mutate('stsc', (b, p) => b.writeUInt32BE(2, p + 16)));
    invalid(mutate('stsc', (b, p) => b.writeUInt32BE(2, p + 24)));
    invalid(mutate('stco', (b, p) => b.writeUInt32BE(0, p + 16)));
    invalid(mutate('stco', (b, p) => b.writeUInt32BE(b.length - 1, p + 16)));
    invalid(mutate('stco', (b, p) => b.writeUInt32BE(b.readUInt32BE(p + 16), p + 20)));
    invalid(mutate('stts', (b, p) => b.writeUInt32BE(1, p + 16)));
    invalid(mutate('stss', (b, p) => b.writeUInt32BE(3, p + 16)));
  });
  it('rejects excess FPS/duration/dimensions and transform matrices', () => {
    invalid(mutate('stts', (b, p) => b.writeUInt32BE(1, p + 20)));
    invalid(mutate('avc1', (b, p) => b.writeUInt16BE(1281, p + 32)));
    invalid(mutate('tkhd', (b, p) => b.writeInt32BE(0, p + 48)));
    invalid(mutate('mdhd', (b, p) => b.writeUInt32BE(0, p + 20)));
    invalid(mutate('elst', (b, p) => b.writeInt32BE(90000, p + 20)));
  });
  it('rejects AVC profile, malformed lengths, extra parameters and unsupported NAL types', () => {
    invalid(mutate('avcC', (b, p) => b[p + 9] = 100));
    invalid(mutate('avcC', (b, p) => b[p + 12] = 0xfe));
    invalid(mutate('avcC', (b, p) => b[p + 13] = 0xe2));
    invalid(mutate('avcC', (b, p) => b.writeUInt16BE(65535, p + 14)));
    const bytes = fixture(); const data = offset(bytes, 'mdat') + 8; bytes[data + 4] = 0x67; invalid(bytes);
    const badLength = fixture(); badLength.writeUInt32BE(0x7fffffff, offset(badLength, 'mdat') + 8); invalid(badLength);
  });
  it('rejects unapproved/malformed metadata and treats the accepted bounded tags as discard-only', () => {
    for (const type of ['\xa9nam', '\xa9cmt', '\xa9too']) {
      const bytes = mutate('\xa9too', (b, p) => b.write(type, p + 4, 4, 'latin1'));
      expect(validateMp4Structure(bytes, declaration).structuralOnly).toBe(true);
    }
    invalid(mutate('\xa9too', (b, p) => b.write('\xa9xyz', p + 4, 4, 'latin1')));
    invalid(mutate('data', (b, p) => b[p + 11] = 2));
    invalid(mutate('data', (b, p) => b.writeUInt32BE(1, p + 12)));
    invalid(mutate('data', (b, p) => b[p + b.readUInt32BE(p) - 1] = 255));
    const oversized = Buffer.alloc(16385); oversized.writeUInt32BE(oversized.length); oversized.write('udta', 4);
    const reader = new Mp4Reader(oversized), box = reader.boxes(0, oversized.length, 0, ['udta'])[0];
    expect(() => inspectMovieMetadata(reader, box)).toThrow(AttachmentValidationError);
  });
  it('rejects an empty SEI message container rather than treating it as a valid strip candidate', () => {
    const bytes = fixture(), position = offset(bytes, 'avcC');
    const config = parseAvcConfiguration({ type: 'avcC', start: position, end: position + bytes.readUInt32BE(position), data: bytes.subarray(position + 8, position + bytes.readUInt32BE(position)), depth: 7 });
    const sampleSize = bytes.readUInt32BE(offset(bytes, 'stsz') + 20), media = offset(bytes, 'mdat');
    const sample = bytes.subarray(media + 8, media + 8 + sampleSize);
    expect(() => inspectAvcSample(Buffer.concat([Buffer.from([0, 0, 0, 2, 6, 0x80]), sample]), config)).toThrow(AttachmentValidationError);
  });
  it('rejects AAC HE/SBR, malformed descriptor lengths, dependency flags and mismatched channel configuration', () => {
    const source = fixture(true), esds = offset(source, 'esds');
    const config = source.indexOf(Buffer.from([0x05, 0x80, 0x80, 0x80, 0x05]), esds) + 5;
    expect(config).toBeGreaterThan(esds);
    for (const [position, value] of [[config, 0x29], [config + 1, 0x98], [config + 4, 0x80], [esds + 15, 0x7f], [esds + 19, 0x20]]) {
      const bytes = fixture(true); bytes[position] = value; invalid(bytes);
    }
  });
  it('enforces complete depth/box traversal budgets before allocation', () => {
    const atom = Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
    const bytes = Buffer.concat(Array.from({ length: 257 }, () => atom));
    expect(() => new Mp4Reader(bytes).boxes(0, bytes.length, 0, ['free'])).toThrow(AttachmentValidationError);
    expect(() => new Mp4Reader(atom).boxes(0, atom.length, 9, ['free'])).toThrow(AttachmentValidationError);
  });
  it('rejects variable frame deltas even when timing rows otherwise exactly cover samples', () => {
    const bytes = fixture(), reader = new Mp4Reader(bytes);
    const boxes = ['stsz', 'stsc', 'stco', 'stss'].map(type => { const start = offset(bytes, type); return { type, start, end: start + bytes.readUInt32BE(start), data: bytes.subarray(start + 8, start + bytes.readUInt32BE(start)), depth: 5 } as Box; });
    const timing = Buffer.alloc(24); timing.writeUInt32BE(2, 4); timing.writeUInt32BE(1, 8); timing.writeUInt32BE(4096, 12); timing.writeUInt32BE(1, 16); timing.writeUInt32BE(2048, 20);
    boxes.push({ type: 'stts', start: 0, end: 32, data: timing, depth: 5 });
    const start = offset(bytes, 'mdat');
    expect(() => parseSampleTables(boxes, 360, start + 8, bytes.length, true)).toThrow(AttachmentValidationError);
  });
  it('rejects duplicate track IDs, AAC sample-entry mismatch and invalid roll recovery indices', () => {
    const bytes = fixture(true), first = offset(bytes, 'tkhd'); const second = bytes.indexOf(Buffer.from('tkhd'), first + 8) - 4;
    bytes.writeUInt32BE(bytes.readUInt32BE(first + 20), second + 20); invalid(bytes);
    invalid(mutate('mp4a', (b, p) => b.writeUInt16BE(3, p + 24), true));
    invalid(mutate('sbgp', (b, p) => b.writeUInt32BE(2, p + 24), true));
    invalid(mutate('sgpd', (b, p) => b.write('seig', p + 12), true));
  });
});
