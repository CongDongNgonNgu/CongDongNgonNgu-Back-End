import { AttachmentValidationError } from '../validation/validation-error';
import { Bits, type Box } from './binary';
import { parseAvcConfiguration, inspectAvcSample } from './avc';
import { syntheticMp4 } from './synthetic-fixtures';
function source() {
  const bytes = Buffer.from(syntheticMp4.videoOnly.base64, 'base64'), start = bytes.indexOf(Buffer.from('avcC')) - 4;
  const box: Box = { type: 'avcC', start, end: start + bytes.readUInt32BE(start), data: bytes.subarray(start + 8, start + bytes.readUInt32BE(start)), depth: 7 };
  const config = parseAvcConfiguration(box);
  const stsz = bytes.indexOf(Buffer.from('stsz')) - 4, mdat = bytes.indexOf(Buffer.from('mdat')) - 4;
  const sample = bytes.subarray(mdat + 8, mdat + 8 + bytes.readUInt32BE(stsz + 20));
  return { config, sample };
}
function configuration(sps: Buffer, pps: Buffer): Box {
  const prefix = Buffer.from([1, 66, 0xc0, 10, 0xff, 0xe1]), a = Buffer.alloc(2), b = Buffer.alloc(3); a.writeUInt16BE(sps.length); b[0] = 1; b.writeUInt16BE(pps.length, 1);
  const data = Buffer.concat([prefix, a, sps, b, pps]); return { type: 'avcC', start: 0, end: data.length + 8, data, depth: 7 };
}
function spsWithAspect(aspect: number, numerator = 1, denominator = 1): Buffer {
  let bits = '';
  const add = (value: number, count: number) => { bits += value.toString(2).padStart(count, '0'); };
  const ue = (value: number) => { const binary = (value + 1).toString(2); bits += '0'.repeat(binary.length - 1) + binary; };
  add(66, 8); add(0xc0, 8); add(10, 8); ue(0); ue(0); ue(2); ue(1); add(0, 1); ue(7); ue(4); add(1, 1); add(1, 1);
  add(1, 1); ue(0); ue(0); ue(0); ue(4); // 128x80 coded, 128x72 cropped, 4:2:0.
  add(1, 1); add(1, 1); add(aspect, 8);
  if (aspect === 255) { add(numerator, 16); add(denominator, 16); }
  add(0, 8); // overscan/video-signal/chroma-location/timing/HRD/pic-structure/restriction absent.
  add(1, 1); while (bits.length % 8) add(0, 1);
  const raw = Buffer.from(bits.match(/.{8}/g)!.map(value => parseInt(value, 2))), escaped: number[] = [];
  let zeros = 0;
  for (const byte of raw) { if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; } escaped.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
  return Buffer.from([0x67, ...escaped]);
}
describe('AVC review regressions: exact RBSP termination and square VUI aspect', () => {
  it('consumes only the stop bit and bits to the next byte boundary', () => {
    expect(() => new Bits(Buffer.from([0x80])).trailing()).not.toThrow();
    expect(() => new Bits(Buffer.from([0x80, 0, 0])).trailing()).toThrow(AttachmentValidationError);
    const unaligned = new Bits(Buffer.from([0x10])); unaligned.read(3); expect(() => unaligned.trailing()).not.toThrow();
  });
  it.each(['sps', 'pps'] as const)('rejects a complete appended zero byte after %s trailing bits', type => {
    const { config } = source();
    const sps = type === 'sps' ? Buffer.concat([config.sps, Buffer.from([0])]) : config.sps;
    const pps = type === 'pps' ? Buffer.concat([config.pps, Buffer.from([0])]) : config.pps;
    expect(() => parseAvcConfiguration(configuration(sps, pps))).toThrow(AttachmentValidationError);
  });
  it('rejects an appended zero byte after AUD trailing bits', () => {
    const { config, sample } = source();
    expect(() => inspectAvcSample(Buffer.concat([Buffer.from([0, 0, 0, 2, 9, 0x10]), sample]), config)).not.toThrow();
    expect(() => inspectAvcSample(Buffer.concat([Buffer.from([0, 0, 0, 3, 9, 0x10, 0]), sample]), config)).toThrow(AttachmentValidationError);
  });
  it('accepts only square VUI SAR, including equal positive Extended_SAR values', () => {
    const { config } = source();
    for (const [aspect, n, d] of [[1, 1, 1], [255, 1, 1], [255, 17, 17]]) expect(() => parseAvcConfiguration(configuration(spsWithAspect(aspect, n, d), config.pps))).not.toThrow();
    for (const aspect of [0, ...Array.from({ length: 15 }, (_, i) => i + 2), 17, 254]) expect(() => parseAvcConfiguration(configuration(spsWithAspect(aspect), config.pps))).toThrow(AttachmentValidationError);
    for (const [n, d] of [[4, 3], [16, 9], [0, 1], [1, 0]]) expect(() => parseAvcConfiguration(configuration(spsWithAspect(255, n, d), config.pps))).toThrow(AttachmentValidationError);
  });
});
