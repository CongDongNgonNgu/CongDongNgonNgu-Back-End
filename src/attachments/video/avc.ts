import { content } from '../validation/validation-error';
import { Bits, rbsp, type Box } from './binary';
export interface AvcConfig { sps: Buffer; pps: Buffer; spsId: number; ppsId: number; width: number; height: number; frameRate?: number; nalLength: 4 }
function hrd(bits: Bits): void {
  const count = bits.ue(31) + 1; bits.read(4); bits.read(4);
  for (let i = 0; i < count; i++) { bits.ue(); bits.ue(); bits.read(1); }
  bits.read(5); bits.read(5); bits.read(5); bits.read(5);
}
function vui(bits: Bits): number | undefined {
  if (bits.read(1)) {
    const aspect = bits.read(8); content(aspect === 1 || aspect === 255);
    if (aspect === 255) { const width = bits.read(16), height = bits.read(16); content(width > 0 && width === height); }
  }
  if (bits.read(1)) bits.read(1);
  if (bits.read(1)) { bits.read(3); bits.read(1); if (bits.read(1)) { bits.read(8); bits.read(8); bits.read(8); } }
  if (bits.read(1)) { bits.ue(5); bits.ue(5); }
  let rate: number | undefined;
  if (bits.read(1)) { const units = bits.read(32), scale = bits.read(32), fixed = bits.read(1); content(units > 0 && scale > 0 && fixed === 1); rate = scale / (2 * units); content(rate > 0 && rate <= 24); }
  const nalHrd = bits.read(1); if (nalHrd) hrd(bits);
  const vclHrd = bits.read(1); if (vclHrd) hrd(bits);
  if (nalHrd || vclHrd) bits.read(1);
  bits.read(1);
  if (bits.read(1)) { bits.read(1); bits.ue(16); bits.ue(16); bits.ue(16); bits.ue(16); const reorder = bits.ue(16), buffer = bits.ue(16); content(reorder === 0 && buffer >= reorder); }
  return rate;
}
function sps(nal: Buffer): Omit<AvcConfig, 'sps' | 'pps' | 'ppsId' | 'nalLength'> {
  content((nal[0] & 31) === 7 && (nal[0] >>> 5) > 0);
  const bits = new Bits(rbsp(nal));
  content(bits.read(8) === 66); const constraints = bits.read(8); content((constraints & 0x40) !== 0 && (constraints & 3) === 0);
  content(bits.read(8) > 0); const spsId = bits.ue(31);
  bits.ue(12); const order = bits.ue(2);
  if (order === 0) bits.ue(12);
  if (order === 1) { bits.read(1); bits.se(); bits.se(); const count = bits.ue(255); for (let i = 0; i < count; i++) bits.se(); }
  bits.ue(16); bits.read(1);
  const columns = bits.ue(79) + 1, rows = bits.ue(44) + 1;
  content(bits.read(1) === 1); bits.read(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits.read(1)) { left = bits.ue(640); right = bits.ue(640); top = bits.ue(360); bottom = bits.ue(360); }
  const width = columns * 16 - 2 * (left + right), height = rows * 16 - 2 * (top + bottom);
  content(width > 0 && width <= 1280 && height > 0 && height <= 720 && width * height <= 921600);
  const frameRate = bits.read(1) ? vui(bits) : undefined;
  bits.trailing(); return { spsId, width, height, frameRate };
}
function pps(nal: Buffer, spsId: number): number {
  content((nal[0] & 31) === 8 && (nal[0] >>> 5) > 0);
  const bits = new Bits(rbsp(nal)), id = bits.ue(255); content(bits.ue(31) === spsId);
  content(bits.read(1) === 0); bits.read(1); content(bits.ue(7) === 0);
  bits.ue(31); bits.ue(31); bits.read(1); content(bits.read(2) === 0);
  const qp = bits.se(51), qs = bits.se(51), chroma = bits.se(12); content(qp >= -26 && qp <= 25 && qs >= -26 && qs <= 25 && chroma >= -12 && chroma <= 12);
  bits.read(1); bits.read(1); bits.read(1);
  bits.trailing(); return id;
}
export function parseAvcConfiguration(box: Box): AvcConfig {
  const b = box.data;
  content(b.length >= 11 && b[0] === 1 && b[1] === 66 && (b[2] & 0x40) !== 0 && (b[2] & 3) === 0 && b[3] > 0 && b[4] === 0xff && b[5] === 0xe1);
  const spsSize = b.readUInt16BE(6); content(spsSize >= 4 && 8 + spsSize + 3 <= b.length);
  const spsBytes = b.subarray(8, 8 + spsSize); let p = 8 + spsSize;
  content(b[p++] === 1); const ppsSize = b.readUInt16BE(p); p += 2; content(ppsSize >= 2 && p + ppsSize === b.length);
  const ppsBytes = b.subarray(p), parsed = sps(spsBytes);
  content(spsBytes[1] === b[1] && spsBytes[2] === b[2] && spsBytes[3] === b[3]);
  return { ...parsed, sps: spsBytes, pps: ppsBytes, ppsId: pps(ppsBytes, parsed.spsId), nalLength: 4 };
}
export function inspectAvcSample(bytes: Buffer, config: AvcConfig): { seiUnits: number; keyframe: boolean } {
  let p = 0, seiUnits = 0, slices = 0, keyframe = false;
  while (p < bytes.length) {
    content(p + 4 <= bytes.length); const length = bytes.readUInt32BE(p); p += 4;
    content(length >= 2 && p + length <= bytes.length);
    const nal = bytes.subarray(p, p + length); p += length;
    content(!(nal[0] & 0x80)); const type = nal[0] & 31; content([1, 5, 6, 7, 8, 9].includes(type));
    if (type === 7) content(nal.equals(config.sps));
    else if (type === 8) content(nal.equals(config.pps));
    else if (type === 6) {
      content((nal[0] & 0x60) === 0); const payload = rbsp(nal); content(payload.length >= 3); let offset = 0;
      while (offset < payload.length - 1) {
        let tag = 0, size = 0, value: number;
        do { content(offset < payload.length); value = payload[offset++]; tag += value; } while (value === 255);
        do { content(offset < payload.length); value = payload[offset++]; size += value; } while (value === 255);
        content(tag <= 65535 && offset + size < payload.length); offset += size;
      }
      content(offset === payload.length - 1 && payload[offset] === 0x80); seiUnits++;
    } else if (type === 9) { content((nal[0] & 0x60) === 0); const bits = new Bits(rbsp(nal)); bits.read(3); bits.trailing(); }
    else {
      if (type === 5) { content((nal[0] & 0x60) !== 0); keyframe = true; }
      const bits = new Bits(rbsp(nal)); bits.ue(3599); content([0, 2, 5, 7].includes(bits.ue(9))); content(bits.ue(255) === config.ppsId); slices++;
      // Compressed macroblock syntax is deliberately delegated to mandatory fatal full native decoding.
    }
  }
  content(p === bytes.length && slices > 0); return { seiUnits, keyframe };
}
