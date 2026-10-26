import { content } from '../validation/validation-error';
import { Bits, full, type Box } from './binary';
interface Descriptor { tag: number; data: Buffer }
function descriptors(bytes: Buffer, start = 0): Descriptor[] {
  const result: Descriptor[] = [];
  for (let p = start; p < bytes.length;) {
    content(result.length < 4 && p + 2 <= bytes.length);
    const tag = bytes[p++]; let size = 0, count = 0, next: number;
    do { content(p < bytes.length && ++count <= 4); next = bytes[p++]; size = size * 128 + (next & 127); } while (next & 128);
    content(size > 0 && p + size <= bytes.length); result.push({ tag, data: bytes.subarray(p, p + size) }); p += size;
  }
  return result;
}
/** MPEG4 AudioSpecificConfig is LC only; no PCE, SBR/PS, dependency or extension coding. Native decode remains required. */
export function parseAacConfiguration(box: Box, trackId: number, channels: number, sampleRate: number): void {
  const data = full(box), top = descriptors(data.subarray(4)); content(top.length === 1 && top[0].tag === 3);
  const es = top[0].data; content(es.length >= 3 && es.readUInt16BE() === trackId && (es[2] & 0xe0) === 0);
  const children = descriptors(es, 3); content(children.length === 2 && children[0].tag === 4 && children[1].tag === 6 && children[1].data.equals(Buffer.from([2])));
  const decoder = children[0].data; content(decoder.length >= 13 && decoder[0] === 0x40 && decoder[1] === 0x15);
  const config = descriptors(decoder, 13); content(config.length === 1 && config[0].tag === 5 && config[0].data.length >= 2 && config[0].data.length <= 8);
  const bits = new Bits(config[0].data); content(bits.read(5) === 2);
  const frequencyIndex = bits.read(4), rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const frequency = frequencyIndex === 15 ? bits.read(24) : rates[frequencyIndex];
  content(frequency > 0 && frequency <= 48000 && frequency === sampleRate && bits.read(4) === channels && [1, 2].includes(channels));
  content(bits.read(1) === 0 && bits.read(1) === 0 && bits.read(1) === 0);
  if (bits.remaining >= 17) { content(bits.read(11) === 0x2b7 && bits.read(5) === 5 && bits.read(1) === 0); }
  bits.padding();
}
