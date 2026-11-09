import {
  assertMinimalNativeManifest,
  assertMinimalNativeBinary,
  assertMinimalNativeVersion,
  assertMinimalNativeHost,
  MINIMAL_NATIVE,
} from "./native-identity";

const configuration =
  "--disable-all --disable-autodetect --disable-iconv --disable-network --disable-doc --disable-debug --disable-shared --enable-static --disable-gpl --disable-nonfree --disable-version3 --enable-x86asm --x86asmexe=/build/nasm-source/nasm --enable-ffmpeg --enable-ffprobe --enable-avcodec --enable-avformat --enable-avfilter --enable-swscale --enable-swresample --enable-pthreads --enable-decoder='h264,aac,mjpeg' --enable-parser='h264,aac,mjpeg' --enable-demuxer='mov,image2,image_jpeg_pipe' --enable-muxer='mp4,image2,null' --enable-protocol='file,pipe' --enable-bsf='filter_units,h264_metadata' --enable-encoder='mjpeg,wrapped_avframe,pcm_s16le' --enable-filter='scale,format,aformat,aresample'";
const manifest = () => ({
  format: 1,
  platform: "linux",
  arch: "x64",
  version: "9.0.2",
  sourceCommit: "6dfaba896fddaea098abec8ac84ff67375a7c6f1",
  binaryHashes: {
    "bin/ffmpeg":
      "031ffb3a5ccd03437daf983c121b9f01d3974ed8e295057faa912925f84db5f3",
    "bin/ffprobe":
      "36e837d351e47d525dd6438f0141c2c7dc4bc7d49e27e3836acff137a601b9b3",
  },
  binaryBytes: { "bin/ffmpeg": 7081296, "bin/ffprobe": 6868128 },
});
const banner = (name: "ffmpeg" | "ffprobe") =>
  `${name} version 9.0.2 Copyright (c) ${name === "ffmpeg" ? "2000" : "2007"}-2026 the FFmpeg developers\nbuilt with gcc 14.3.0 (GCC)\nconfiguration: ${configuration}\nlibavutil 60.0.0\n`;

describe("code-pinned minimal Linux FFmpeg identity", () => {
  it("accepts Linux x64 GLIBC at the minimum 2.35 and newer versions", () => {
    for (const version of ["2.35", "2.36", "2.43", "3.0"])
      expect(() =>
        assertMinimalNativeHost("linux", "x64", version),
      ).not.toThrow();
  });
  it("rejects foreign hosts and GLIBC 2.34, musl, unknown or malformed versions", () => {
    for (const [platform, arch, version] of [
      ["win32", "x64", "2.35"],
      ["linux", "arm64", "2.35"],
      ["linux", "x64", "2.34"],
      ["linux", "x64", "1.99"],
      ["linux", "x64", undefined],
      ["linux", "x64", null],
      ["linux", "x64", "musl"],
      ["linux", "x64", ""],
      ["linux", "x64", "2.35-custom"],
      ["linux", "x64", "2.3.5"],
      ["linux", "x64", "2.35\n"],
      ["linux", "x64", "99999999999999999999.0"],
    ])
      expect(() => assertMinimalNativeHost(platform!, arch!, version)).toThrow(
        "PROCESSING_UNAVAILABLE",
      );
  });
  it("accepts the approved manifest and immutable binary measurements", () => {
    expect(() =>
      assertMinimalNativeManifest(manifest(), "linux", "x64"),
    ).not.toThrow();
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const file = manifest();
      expect(() =>
        assertMinimalNativeBinary(
          name,
          file.binaryBytes[`bin/${name}`],
          file.binaryHashes[`bin/${name}`],
        ),
      ).not.toThrow();
    }
    expect(Object.isFrozen(MINIMAL_NATIVE)).toBe(true);
    expect(Object.isFrozen(MINIMAL_NATIVE.ffmpeg)).toBe(true);
  });
  it("rejects the previous classic pair after exact SIMD identity selection", () => {
    for (const [name, bytes, digest] of [
      ["ffmpeg", 6470992, "2af1963c499a3005ad4d6037794b9e4bc383c7a1c0f545267297195d68f9ccee"],
      ["ffprobe", 6249632, "64c3340d0325afa37fff5015bfacf162095103dc2cbd319d799d70cc9633d24e"],
    ] as const) expect(() => assertMinimalNativeBinary(name, bytes, digest)).toThrow("PROCESSING_UNAVAILABLE");
  });
  it("rejects classic assembly configuration and alternate assembler paths", () => {
    const valid = banner("ffmpeg");
    for (const changed of [
      valid.replace("--enable-x86asm --x86asmexe=/build/nasm-source/nasm", "--disable-x86asm"),
      valid.replace("--x86asmexe=/build/nasm-source/nasm", "--x86asmexe=/tmp/nasm"),
    ]) expect(() => assertMinimalNativeVersion("ffmpeg", changed)).toThrow("PROCESSING_UNAVAILABLE");
  });
  it("rejects a self-consistent attacker manifest and measured replacement binary", () => {
    const forged = manifest();
    forged.binaryHashes["bin/ffmpeg"] = "a".repeat(64);
    expect(() => assertMinimalNativeManifest(forged, "linux", "x64")).toThrow(
      "PROCESSING_UNAVAILABLE",
    );
    expect(() =>
      assertMinimalNativeBinary(
        "ffmpeg",
        7081296,
        forged.binaryHashes["bin/ffmpeg"],
      ),
    ).toThrow("PROCESSING_UNAVAILABLE");
  });
  it.each(["ffmpeg", "ffprobe"] as const)(
    "rejects %s byte-size or digest drift",
    (name) => {
      const pin = MINIMAL_NATIVE[name];
      expect(() =>
        assertMinimalNativeBinary(name, pin.bytes + 1, pin.sha256),
      ).toThrow("PROCESSING_UNAVAILABLE");
      expect(() =>
        assertMinimalNativeBinary(name, pin.bytes, "0".repeat(64)),
      ).toThrow("PROCESSING_UNAVAILABLE");
    },
  );
  it("rejects missing, foreign, historical and forged provenance", () => {
    for (const changed of [
      null,
      {},
      { ...manifest(), format: 2 },
      { ...manifest(), platform: "win32" },
      { ...manifest(), arch: "arm64" },
      { ...manifest(), version: "n9.0.2-29-g6dfaba896f" },
      { ...manifest(), sourceCommit: "a".repeat(40) },
      { ...manifest(), binaryBytes: {} },
      { ...manifest(), binaryHashes: {} },
    ]) {
      expect(() =>
        assertMinimalNativeManifest(changed, "linux", "x64"),
      ).toThrow("PROCESSING_UNAVAILABLE");
    }
    expect(() =>
      assertMinimalNativeManifest(manifest(), "win32", "x64"),
    ).toThrow("PROCESSING_UNAVAILABLE");
    expect(() =>
      assertMinimalNativeManifest(manifest(), "linux", "arm64"),
    ).toThrow("PROCESSING_UNAVAILABLE");
  });
  it.each(["ffmpeg", "ffprobe"] as const)(
    "accepts the exact approved %s version/configuration",
    (name) => {
      expect(() =>
        assertMinimalNativeVersion(name, banner(name)),
      ).not.toThrow();
    },
  );
  it.each(["ffmpeg", "ffprobe"] as const)(
    "rejects %s version or configuration drift including hidden duplicate config lines",
    (name) => {
      const valid = banner(name);
      for (const changed of [
        valid.replace("version 9.0.2 ", "version 9.0.3 "),
        valid.replace("version 9.0.2 ", "version 9.0.2-custom "),
        valid.replace("--disable-network", "--enable-network"),
        valid.replace("--disable-gpl", "--enable-gpl"),
        valid.replace("--disable-nonfree", "--enable-nonfree"),
        valid.replace(
          "--enable-decoder='h264,aac,mjpeg'",
          "--enable-decoder='h264,aac,mjpeg,libopenh264'",
        ),
        valid.replace("--disable-iconv ", ""),
        valid.replace(configuration, configuration + " --enable-libx264"),
        valid + `configuration: ${configuration}\n`,
        valid.replace(name + " version", "other version"),
      ]) {
        expect(() => assertMinimalNativeVersion(name, changed)).toThrow(
          "PROCESSING_UNAVAILABLE",
        );
      }
    },
  );
});
