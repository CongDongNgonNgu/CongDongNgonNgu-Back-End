import { AttachmentValidationError, content } from '../validation/validation-error';
import { declaredAttachmentFormat } from '../validation/metadata';
import { type Box, Mp4Reader, one, exact, full, zeros, identityMatrix } from './binary';
import { parseAvcConfiguration, inspectAvcSample, type AvcConfig } from './avc';
import { parseAacConfiguration } from './aac';
import { parseSampleTables, type Sample } from './sample-tables';
import { inspectMovieMetadata } from './metadata';
export interface Mp4Structure {
  structuralOnly: true; requiresNativeValidation: true; width: number; height: number; durationSeconds: number; frameRate: number;
  videoSamples: number; audioSamples: number; seiUnits: number; audioChannels?: number; audioSampleRate?: number;
}
interface Track { id: number; kind: 'vide' | 'soun'; width: number; height: number; duration: number; frameRate: number; samples: Sample[]; seiUnits: number; channels?: number; sampleRate?: number }
/** Frozen narrow TEST grammar only. NEVER authorizes READY: pinned probe, fatal full decode, SEI stripping and normalized-output revalidation are separate mandatory gates. */
export function validateMp4Structure(bytes: Buffer, declaration: { filename: string; mime: string }): Mp4Structure {
  if (declaredAttachmentFormat(declaration.filename, declaration.mime) !== 'mp4') throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
  if (bytes.length > 3145728) throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
  try { return inspect(bytes); } catch (error) { if (error instanceof AttachmentValidationError) throw error; throw new AttachmentValidationError('ATTACHMENT_INVALID_CONTENT'); }
}
function inspect(bytes: Buffer): Mp4Structure {
  const reader = new Mp4Reader(bytes), top = reader.boxes(0, bytes.length, 0, ['ftyp', 'moov', 'mdat', 'free']);
  content(top[0]?.type === 'ftyp'); const type = one(top, 'ftyp')!, movie = one(top, 'moov')!, media = one(top, 'mdat')!, free = one(top, 'free', false);
  if (free) exact(free, 0);
  const brand = type.data; content(brand.length >= 12 && brand.length % 4 === 0 && brand.toString('latin1', 0, 4) === 'isom');
  const brands = new Set<string>(); for (let p = 8; p < brand.length; p += 4) { const name = brand.toString('latin1', p, p + 4); content(['isom', 'iso2', 'avc1', 'mp41'].includes(name) && !brands.has(name)); brands.add(name); }
  content(brands.has('isom'));
  const children = reader.children(movie, ['mvhd', 'trak', 'udta']), header = one(children, 'mvhd')!, metadata = one(children, 'udta', false);
  const h = exact(header, 100); full(header); const timescale = h.readUInt32BE(12), movieDuration = h.readUInt32BE(16); content(timescale > 0 && movieDuration > 0 && movieDuration / timescale <= 15);
  content(h.readUInt32BE(20) === 65536 && h.readUInt16BE(24) === 256); zeros(h.subarray(26, 36)); identityMatrix(h.subarray(36, 72)); zeros(h.subarray(72, 96));
  const trackBoxes = children.filter(box => box.type === 'trak'); content(trackBoxes.length >= 1 && trackBoxes.length <= 2);
  if (metadata) inspectMovieMetadata(reader, metadata);
  const tracks = trackBoxes.map(box => track(reader, box, timescale, movieDuration, media));
  content(new Set(tracks.map(item => item.id)).size === tracks.length && h.readUInt32BE(96) > Math.max(...tracks.map(item => item.id)));
  const videos = tracks.filter(item => item.kind === 'vide'), audios = tracks.filter(item => item.kind === 'soun'); content(videos.length === 1 && audios.length <= 1);
  const ranges = tracks.flatMap(item => item.samples).sort((a, b) => a.offset - b.offset); let end = media.start + 8;
  for (const range of ranges) { content(range.offset === end); end += range.size; } content(end === media.end); // Reject overlap and unclaimed payload, never parse hidden padding as safe media.
  const video = videos[0], audio = audios[0];
  return { structuralOnly: true, requiresNativeValidation: true, width: video.width, height: video.height, durationSeconds: video.duration, frameRate: video.frameRate, videoSamples: video.samples.length, audioSamples: audio?.samples.length ?? 0, seiUnits: video.seiUnits, ...(audio ? { audioChannels: audio.channels, audioSampleRate: audio.sampleRate } : {}) };
}
function track(reader: Mp4Reader, box: Box, movieTimescale: number, movieDuration: number, media: Box): Track {
  const children = reader.children(box, ['tkhd', 'edts', 'mdia']), tkhd = one(children, 'tkhd')!, edits = one(children, 'edts', false), mdia = one(children, 'mdia')!;
  const tk = exact(tkhd, 84); full(tkhd, 0, 3); zeros(tk.subarray(16, 20)); zeros(tk.subarray(24, 32)); zeros(tk.subarray(32, 34)); content(tk.readInt16BE(34) >= 0); zeros(tk.subarray(38, 40)); identityMatrix(tk.subarray(40, 76));
  const id = tk.readUInt32BE(12), duration = tk.readUInt32BE(20); content(id > 0 && duration > 0 && duration <= movieDuration);
  const mediaChildren = reader.children(mdia, ['mdhd', 'hdlr', 'minf']), mdhd = one(mediaChildren, 'mdhd')!, handler = one(mediaChildren, 'hdlr')!, minf = one(mediaChildren, 'minf')!;
  const md = exact(mdhd, 24); full(mdhd); const timescale = md.readUInt32BE(12), mediaDuration = md.readUInt32BE(16); content(timescale > 0 && mediaDuration > 0 && !(md.readUInt16BE(20) & 0x8000)); zeros(md.subarray(22));
  const hd = full(handler); content(hd.length >= 25 && hd[hd.length - 1] === 0); zeros(hd.subarray(4, 8)); zeros(hd.subarray(12, 24));
  new TextDecoder('utf-8', { fatal: true }).decode(hd.subarray(24, -1)); const kind = hd.toString('latin1', 8, 12); content(kind === 'vide' || kind === 'soun');
  const video = kind === 'vide'; content(tk.readUInt16BE(36) === (video ? 0 : 256));
  let editTime = 0;
  if (edits) {
    const elst = one(reader.children(edits, ['elst']), 'elst')!, el = exact(elst, 20); full(elst); content(el.readUInt32BE(4) === 1 && el.readUInt32BE(8) === duration);
    editTime = el.readInt32BE(12); content(editTime >= 0 && el.readInt16BE(16) === 1 && el.readInt16BE(18) === 0);
  }
  const selectedEnd = BigInt(editTime) * BigInt(movieTimescale) + BigInt(duration) * BigInt(timescale);
  content(selectedEnd <= BigInt(mediaDuration) * BigInt(movieTimescale) && (edits !== undefined || BigInt(duration) * BigInt(timescale) === BigInt(mediaDuration) * BigInt(movieTimescale)));
  const minfChildren = reader.children(minf, ['vmhd', 'smhd', 'dinf', 'stbl']), videoHeader = one(minfChildren, 'vmhd', false), audioHeader = one(minfChildren, 'smhd', false);
  content(video ? !!videoHeader && !audioHeader : !!audioHeader && !videoHeader);
  const mh = video ? exact(videoHeader!, 12) : exact(audioHeader!, 8); full(video ? videoHeader! : audioHeader!, 0, video ? 1 : 0); zeros(mh.subarray(4));
  const dref = one(reader.children(one(minfChildren, 'dinf')!, ['dref']), 'dref')!, dr = full(dref); content(dr.length >= 8 && dr.readUInt32BE(4) === 1);
  const urls = reader.children(dref, ['url '], 8); content(urls.length === 1); exact(urls[0], 4); full(urls[0], 0, 1);
  const stbl = one(minfChildren, 'stbl')!, table = reader.children(stbl, ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco', 'sgpd', 'sbgp']);
  const stsd = one(table, 'stsd')!, sd = full(stsd); content(sd.length >= 8 && sd.readUInt32BE(4) === 1);
  const entries = reader.children(stsd, [video ? 'avc1' : 'mp4a'], 8); content(entries.length === 1);
  const entry = entries[0]; let config: AvcConfig | undefined, channels: number | undefined, sampleRate: number | undefined;
  let width = 0, height = 0;
  const e = entry.data; content(e.length >= (video ? 78 : 28)); zeros(e.subarray(0, 6)); content(e.readUInt16BE(6) === 1);
  if (video) {
    zeros(e.subarray(8, 24)); width = e.readUInt16BE(24); height = e.readUInt16BE(26);
    content(width > 0 && width <= 1280 && height > 0 && height <= 720 && width * height <= 921600 && tk.readUInt32BE(76) === width * 65536 && tk.readUInt32BE(80) === height * 65536);
    content(e.readUInt32BE(28) === 72 * 65536 && e.readUInt32BE(32) === 72 * 65536 && e.readUInt32BE(36) === 0 && e.readUInt16BE(40) === 1 && e[42] <= 31 && e.readUInt16BE(74) === 24 && e.readUInt16BE(76) === 65535);
    const boxes = reader.children(entry, ['avcC', 'pasp', 'btrt'], 78); config = parseAvcConfiguration(one(boxes, 'avcC')!); content(config.width === width && config.height === height);
    const aspect = one(boxes, 'pasp', false); if (aspect) { const p = exact(aspect, 8); content(p.readUInt32BE() > 0 && p.readUInt32BE() === p.readUInt32BE(4)); }
    const bitrate = one(boxes, 'btrt', false); if (bitrate) exact(bitrate, 12);
  } else {
    zeros(e.subarray(8, 16)); channels = e.readUInt16BE(16); sampleRate = e.readUInt32BE(24) / 65536;
    content([1, 2].includes(channels) && e.readUInt16BE(18) === 16 && e.readUInt32BE(20) === 0 && sampleRate > 0 && sampleRate <= 48000 && Number.isInteger(sampleRate) && tk.readUInt32BE(76) === 0 && tk.readUInt32BE(80) === 0 && timescale === sampleRate);
    const boxes = reader.children(entry, ['esds', 'btrt'], 28); parseAacConfiguration(one(boxes, 'esds')!, id, channels, sampleRate); const bitrate = one(boxes, 'btrt', false); if (bitrate) exact(bitrate, 12);
  }
  const parsed = parseSampleTables(table, video ? 360 : 720, media.start + 8, media.end, video); content(parsed.duration === mediaDuration);
  const frameRate = video ? timescale / parsed.deltas[0] : 0;
  if (video) content(frameRate > 0 && frameRate <= 24 && mediaDuration / timescale <= 15 && (!config!.frameRate || config!.frameRate === frameRate));
  else content(parsed.deltas.every(delta => delta <= 1024));
  let seiUnits = 0;
  if (video) for (let i = 0; i < parsed.samples.length; i++) {
    const sample = parsed.samples[i], inspected = inspectAvcSample(reader.bytes.subarray(sample.offset, sample.offset + sample.size), config!);
    content(inspected.keyframe === parsed.sync.has(i + 1)); seiUnits += inspected.seiUnits;
  }
  return { id, kind, width, height, duration: duration / movieTimescale, frameRate, samples: parsed.samples, seiUnits, channels, sampleRate };
}
