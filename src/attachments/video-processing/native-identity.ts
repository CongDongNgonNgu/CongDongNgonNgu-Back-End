type NativeTool = "ffmpeg" | "ffprobe";

// Independently measured minimal build from Phase30 CI41010699901. These pins
// are trusted code, never populated from the adjacent untrusted manifest.
export const MINIMAL_NATIVE = Object.freeze({
  ffmpeg: Object.freeze({
    bytes: 6470992,
    sha256: "2af1963c499a3005ad4d6037794b9e4bc383c7a1c0f545267297195d68f9ccee",
  }),
  ffprobe: Object.freeze({
    bytes: 6249632,
    sha256: "64c3340d0325afa37fff5015bfacf162095103dc2cbd319d799d70cc9633d24e",
  }),
});

const configuration =
  "--disable-all --disable-autodetect --disable-iconv --disable-network --disable-doc --disable-debug --disable-shared --enable-static --disable-gpl --disable-nonfree --disable-version3 --disable-x86asm --enable-ffmpeg --enable-ffprobe --enable-avcodec --enable-avformat --enable-avfilter --enable-swscale --enable-swresample --enable-pthreads --enable-decoder='h264,aac,mjpeg' --enable-parser='h264,aac,mjpeg' --enable-demuxer='mov,image2,image_jpeg_pipe' --enable-muxer='mp4,image2,null' --enable-protocol='file,pipe' --enable-bsf='filter_units,h264_metadata' --enable-encoder='mjpeg,wrapped_avframe,pcm_s16le' --enable-filter='scale,format,aformat,aresample'";
const unavailable = (): never => {
  throw Error("PROCESSING_UNAVAILABLE");
};

// Minimal FFmpeg imports GLIBC_2.35; GNU time has its own independent 2.34 floor.
export function assertMinimalNativeHost(
  platform: string,
  arch: string,
  glibc: unknown,
): void {
  if (
    platform !== "linux" ||
    arch !== "x64" ||
    typeof glibc !== "string" ||
    glibc.trim() !== glibc ||
    !/^\d+\.\d+$/.test(glibc)
  )
    return unavailable();
  const [major, minor] = glibc.split(".").map(Number);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 2 ||
    (major === 2 && minor < 35)
  )
    return unavailable();
}

export function assertMinimalNativeManifest(
  value: unknown,
  platform: string,
  arch: string,
): void {
  const manifest = value as {
    format?: unknown;
    platform?: unknown;
    arch?: unknown;
    version?: unknown;
    sourceCommit?: unknown;
    binaryHashes?: Record<string, unknown>;
    binaryBytes?: Record<string, unknown>;
  } | null;
  if (
    platform !== "linux" ||
    arch !== "x64" ||
    manifest?.format !== 1 ||
    manifest.platform !== "linux" ||
    manifest.arch !== "x64" ||
    manifest.version !== "9.0.2" ||
    manifest.sourceCommit !== "6dfaba896fddaea098abec8ac84ff67375a7c6f1"
  )
    return unavailable();
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const relative = "bin/" + name,
      pin = MINIMAL_NATIVE[name];
    if (
      manifest.binaryHashes?.[relative] !== pin.sha256 ||
      manifest.binaryBytes?.[relative] !== pin.bytes
    )
      return unavailable();
  }
}

/** Measurements must come from the actual file before executing it. */
export function assertMinimalNativeBinary(
  name: NativeTool,
  bytes: number,
  sha256: string,
): void {
  const pin = MINIMAL_NATIVE[name];
  if (bytes !== pin.bytes || sha256 !== pin.sha256) return unavailable();
}

export function assertMinimalNativeVersion(
  name: NativeTool,
  output: string,
): void {
  const lines = output.split("\n");
  const first = new RegExp(
    "^" +
      name +
      " version 9\\.0\\.2 Copyright \\(c\\) \\d{4}-\\d{4} the FFmpeg developers$",
  );
  const configurations = lines.filter((line) =>
    line.startsWith("configuration:"),
  );
  // The exact line was retained from the approved build's -version evidence.
  // No added codec, external library, network or license switch is permitted.
  if (
    !first.test(lines[0]) ||
    configurations.length !== 1 ||
    configurations[0] !== "configuration: " + configuration
  )
    return unavailable();
}
