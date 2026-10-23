import { content } from '../validation/validation-error';
export interface Box { type: string; start: number; end: number; data: Buffer; depth: number }
export class Mp4Reader {
  private count = 0;
  constructor(readonly bytes: Buffer) {}
  boxes(start: number, end: number, depth: number, allowed: readonly string[]): Box[] {
    content(depth <= 8 && start >= 0 && end <= this.bytes.length && start <= end);
    const boxes: Box[] = [];
    for (let p = start; p < end;) {
      content(++this.count <= 256 && p + 8 <= end);
      const length = this.bytes.readUInt32BE(p), type = this.bytes.toString('latin1', p + 4, p + 8);
      content(length >= 8 && length !== 1 && p + length <= end && allowed.includes(type));
      boxes.push({ type, start: p, end: p + length, data: this.bytes.subarray(p + 8, p + length), depth });
      p += length;
    }
    return boxes;
  }
  children(box: Box, allowed: readonly string[], skip = 0): Box[] { return this.boxes(box.start + 8 + skip, box.end, box.depth + 1, allowed); }
}
export function one(boxes: Box[], type: string, required = true): Box | undefined {
  const matches = boxes.filter(box => box.type === type); content(matches.length <= 1 && (!required || matches.length === 1)); return matches[0];
}
export function exact(box: Box, bytes: number): Buffer { content(box.data.length === bytes); return box.data; }
export function full(box: Box, version = 0, flags = 0): Buffer {
  content(box.data.length >= 4 && box.data[0] === version && box.data.readUIntBE(1, 3) === flags); return box.data;
}
export function zeros(bytes: Buffer): void { content(bytes.every(byte => byte === 0)); }
export function identityMatrix(bytes: Buffer): void {
  content(bytes.length === 36);
  const expected = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  for (let i = 0; i < 9; i++) content(bytes.readInt32BE(i * 4) === expected[i]);
}
export class Bits {
  private offset = 0;
  constructor(readonly bytes: Buffer) {}
  read(count: number): number {
    content(Number.isInteger(count) && count >= 0 && count <= 32 && this.offset + count <= this.bytes.length * 8);
    let value = 0;
    for (let i = 0; i < count; i++, this.offset++) value = value * 2 + ((this.bytes[this.offset >>> 3] >>> (7 - (this.offset & 7))) & 1);
    return value;
  }
  ue(maximum = 65535): number {
    let zero = 0;
    while (!this.read(1)) content(++zero <= 16);
    const value = 2 ** zero - 1 + this.read(zero); content(value <= maximum); return value;
  }
  se(maximum = 32767): number { const n = this.ue(maximum * 2); return n & 1 ? (n + 1) / 2 : -n / 2; }
  get remaining(): number { return this.bytes.length * 8 - this.offset; }
  trailing(): void { content(this.read(1) === 1); while (this.offset % 8) content(this.read(1) === 0); content(this.remaining === 0); }
  padding(): void { while (this.remaining) content(this.read(1) === 0); }
}
export function rbsp(nal: Buffer): Buffer {
  content(nal.length >= 2 && !(nal[0] & 0x80));
  const out: number[] = []; let zeroes = 0;
  for (let p = 1; p < nal.length; p++) {
    const byte = nal[p];
    if (zeroes >= 2) {
      if (byte === 3) { content(p + 1 < nal.length && nal[p + 1] <= 3); zeroes = 0; continue; }
      content(byte > 2);
    }
    out.push(byte); zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  return Buffer.from(out);
}
