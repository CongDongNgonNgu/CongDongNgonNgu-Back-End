import { content } from '../validation/validation-error';
import { type Box, full, one } from './binary';
export interface Sample { offset: number; size: number }
export interface SampleTable { samples: Sample[]; deltas: number[]; duration: number; sync: Set<number> }
function rows(box: Box, stride: number, maximum: number): Buffer[] {
  const b = full(box); content(b.length >= 8); const count = b.readUInt32BE(4); content(count > 0 && count <= maximum && b.length === 8 + count * stride);
  return Array.from({ length: count }, (_, i) => b.subarray(8 + i * stride, 8 + (i + 1) * stride));
}
export function parseSampleTables(children: Box[], maximum: number, mediaStart: number, mediaEnd: number, video: boolean): SampleTable {
  const size = full(one(children, 'stsz')!); content(size.length >= 12);
  const fixedSize = size.readUInt32BE(4), sampleCount = size.readUInt32BE(8);
  content(sampleCount > 0 && sampleCount <= maximum && size.length === (fixedSize ? 12 : 12 + sampleCount * 4));
  const sizes = Array.from({ length: sampleCount }, (_, i) => fixedSize || size.readUInt32BE(12 + i * 4)); content(sizes.every(n => n > 0 && n <= mediaEnd - mediaStart));
  const timing = rows(one(children, 'stts')!, 8, maximum), deltas: number[] = [];
  let duration = 0;
  for (const row of timing) {
    const count = row.readUInt32BE(), delta = row.readUInt32BE(4); content(count > 0 && delta > 0 && deltas.length + count <= sampleCount);
    for (let i = 0; i < count; i++) deltas.push(delta);
    duration += count * delta; content(Number.isSafeInteger(duration));
  }
  content(deltas.length === sampleCount && (!video || new Set(deltas).size === 1));
  const chunkOffsets = rows(one(children, 'stco')!, 4, maximum).map(row => row.readUInt32BE());
  const mappings = rows(one(children, 'stsc')!, 12, maximum).map(row => ({ first: row.readUInt32BE(), count: row.readUInt32BE(4), description: row.readUInt32BE(8) }));
  content(mappings[0].first === 1);
  for (let i = 0; i < mappings.length; i++) content(mappings[i].first >= 1 && mappings[i].first <= chunkOffsets.length && (!i || mappings[i].first > mappings[i - 1].first) && mappings[i].count > 0 && mappings[i].count <= sampleCount && mappings[i].description === 1);
  const samples: Sample[] = []; let mapping = 0;
  for (let i = 0; i < chunkOffsets.length; i++) {
    while (mapping + 1 < mappings.length && mappings[mapping + 1].first <= i + 1) mapping++;
    let p = chunkOffsets[i]; content(p >= mediaStart && p < mediaEnd);
    for (let j = 0; j < mappings[mapping].count; j++) {
      content(samples.length < sampleCount); const n = sizes[samples.length]; content(p + n <= mediaEnd);
      samples.push({ offset: p, size: n }); p += n;
    }
  }
  content(samples.length === sampleCount);
  const syncBox = one(children, 'stss', false), sync = new Set<number>();
  if (syncBox) {
    const indices = rows(syncBox, 4, maximum).map(row => row.readUInt32BE());
    for (let i = 0; i < indices.length; i++) { content(indices[i] >= 1 && indices[i] <= sampleCount && (!i || indices[i] > indices[i - 1])); sync.add(indices[i]); }
  } else for (let i = 1; i <= sampleCount; i++) sync.add(i);
  if (!video) { content(!syncBox); roll(children, sampleCount); }
  else content(!one(children, 'sgpd', false) && !one(children, 'sbgp', false));
  return { samples, deltas, duration, sync };
}
function roll(children: Box[], sampleCount: number): void {
  const description = one(children, 'sgpd', false), mapping = one(children, 'sbgp', false); content(!!description === !!mapping);
  if (!description || !mapping) return;
  const d = full(description, 1); content(d.length >= 16 && d.toString('latin1', 4, 8) === 'roll' && d.readUInt32BE(8) === 2);
  const count = d.readUInt32BE(12); content(count > 0 && count <= sampleCount && d.length === 16 + count * 2);
  for (let i = 0; i < count; i++) content(d.readInt16BE(16 + i * 2) >= -sampleCount && d.readInt16BE(16 + i * 2) <= 0);
  const b = full(mapping); content(b.length >= 12 && b.toString('latin1', 4, 8) === 'roll');
  const entries = b.readUInt32BE(8); content(entries > 0 && entries <= sampleCount && b.length === 12 + entries * 8);
  let total = 0;
  for (let i = 0; i < entries; i++) { const n = b.readUInt32BE(12 + i * 8), index = b.readUInt32BE(16 + i * 8); content(n > 0 && index <= count); total += n; content(total <= sampleCount); }
  content(total === sampleCount);
}
