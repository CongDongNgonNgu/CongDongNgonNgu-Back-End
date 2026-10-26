# Frozen MP4 structural preflight

`validateMp4Structure(bytes, { filename, mime })` accepts only the frozen narrow MP4 grammar and returns `structuralOnly: true` and `requiresNativeValidation: true`. It never returns READY, trusted media, a safe URL or a successful processing claim. Run this parser inside the bounded processing child, not as a substitute for the processing lease or resource watchdog.

Mandatory subsequent gates remain pinned ffprobe inspection, fatal complete video/audio decoding, stripping every AVC type-6 SEI unit and all supplied container metadata, bounded derivative/thumbnail generation, normalized-output structural checks, zero retained SEI, permitted server-generated tool metadata only, and exact deployed resource/authorization/storage acceptance. None is implemented or enabled by this slice.

The accepted subset includes version-0 movie/track/media headers, an optional single nonnegative unit-rate edit within media bounds, 32-bit sample/chunk tables, one SPS/PPS configuration, progressive constrained-baseline 8-bit 4:2:0 AVC, and optional version-0 LC-AAC sample entry. Audio roll grouping uses version-1 fixed-two-byte sgpd and version-0 sbgp. Other versions/edits, FMO/CABAC/PPS extensions, non-square sample aspect ratios and any unknown structure reject. These are fail-closed interoperability restrictions, not new accepted types. All mdat bytes must belong to exactly one declared sample; padding/overlap/unclaimed bytes reject. Compressed macroblock/AAC entropy validation is deliberately left to the mandatory native full decoder.

The tiny embedded fixtures contain only generated color/silence (128x72, 4fps, 0.5s). They were produced with the already-approved pinned LGPL FFmpeg n9.0.2-29-g6dfaba896f, libopenh264 constrained_baseline/yuv420p, optional AAC-LC stereo 48kHz, and faststart. Their SHA-256 values are checked by tests. They contain no real-user media. Existing Phase30 synthetic expanded source and normalized fixtures were also parsed locally, including 720p/15s/360video samples/705audio samples and complex source SEI counts22 versus normalized0. This is parser regression evidence only, not a repeated processor benchmark or Render acceptance.

Structural semantics were checked against these primary references (no external source code copied):
- https://www.w3.org/TR/mse-byte-stream-format-isobmff/
- https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mov.c
- https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_ps.c
- https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpeg4audio.c
