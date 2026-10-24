/** Native output is untrusted, bounded to 128KiB by the runner. Never return private tags. */
export function inspectProbe(value: unknown, normalized = false): { width: number; height: number; durationSeconds: number; frameRate: number } {
 const check = (ok: unknown): void => { if (!ok) throw Error('PROCESSING_INVALID'); };
 const p = value as { format?: Record<string, any>; streams?: Record<string, any>[]; chapters?: unknown[] };
 check(p && p.format && Array.isArray(p.streams) && p.streams.length >= 1 && p.streams.length <= 2);
 const format = p.format!, streams = p.streams!;
 check(typeof format.format_name === 'string' && format.format_name.split(',').includes('mp4'));
 const durationSeconds = Number(format.duration); check(Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 15);
 check(!p.chapters?.length);
 const video = streams.filter(s => s.codec_type === 'video'), audio = streams.filter(s => s.codec_type === 'audio');
 check(video.length === 1 && audio.length <= 1 && streams.length === video.length + audio.length);
 const v = video[0]; check(v.codec_name === 'h264' && v.profile === 'Constrained Baseline' && v.pix_fmt === 'yuv420p');
 check(Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0 && v.width <= 1280 && v.height <= 720 && v.width * v.height <= 921600);
 const rate = (text: unknown): number => { check(typeof text === 'string' && /^\d+\/\d+$/.test(text as string)); const [a,b] = (text as string).split('/').map(Number); check(a > 0 && b > 0 && Number.isSafeInteger(a) && Number.isSafeInteger(b)); return a/b; };
 const frameRate = rate(v.avg_frame_rate); check(frameRate > 0 && frameRate <= 24 && frameRate === rate(v.r_frame_rate));
 check(v.sample_aspect_ratio === undefined || v.sample_aspect_ratio === '1:1' || v.sample_aspect_ratio === 'N/A');
 for (const s of streams) {
  check(!s.side_data_list?.length);
  if (s.duration !== undefined) check(Number(s.duration) > 0 && Number(s.duration) <= 15);
  if (s.codec_type === 'audio') check(s.codec_name === 'aac' && s.profile === 'LC' && [1,2].includes(s.channels) && Number(s.sample_rate) > 0 && Number(s.sample_rate) <= 48000);
  if (normalized) for (const [key,text] of Object.entries(s.tags ?? {})) check((key === 'language' && text === 'und') || (key === 'handler_name' && ['VideoHandler','SoundHandler'].includes(String(text))) || (key === 'vendor_id' && text === '[0][0][0][0]'));
 }
 if (normalized) for (const [key,text] of Object.entries(format.tags ?? {})) check((key === 'major_brand' && text === 'isom') || (key === 'minor_version' && text === '512') || (key === 'compatible_brands' && text === 'isomiso2avc1mp41') || (key === 'encoder' && text === 'Lavf63.1.102'));
 return { width: v.width, height: v.height, durationSeconds, frameRate };
}
