import {
  assertNativeTimeHost,
  assertNativeTimeManifest,
  verifyNativeTimeFiles,
  NATIVE_TIME,
  NATIVE_TIME_DISTRIBUTION,
} from "./native-time";
import fs from "node:fs";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const distribution =
  require("../../../scripts/package-phase30-time.cjs").DISTRIBUTION;
describe("pinned local GNU time runtime contract", () => {
  it("requires actual Linux x64 glibc >=2.34, including newer major versions", () => {
    for (const version of ["2.34", "2.36", "3.0"])
      expect(() => assertNativeTimeHost("linux", "x64", version)).not.toThrow();
  });
  it("fails closed for foreign platform/arch, absent libc and malformed or old glibc", () => {
    for (const [platform, arch, version] of [
      ["win32", "x64", "2.36"],
      ["linux", "arm64", "2.36"],
      ["linux", "x64", undefined],
      ["linux", "x64", "2.33"],
      ["linux", "x64", "musl"],
      ["linux", "x64", "2.34-private"],
      ["linux", "x64", "2.3.4"],
    ])
      expect(() => assertNativeTimeHost(platform!, arch!, version)).toThrow(
        "PROCESSING_UNAVAILABLE",
      );
  });
  it("binds manifest to exact approved package, local binary and Linux ABI", () => {
    const manifest = {
      format: 1,
      platform: "linux",
      arch: "x64",
      package: {
        version: "1.9-0.2",
        bytes: 50776,
        sha256: NATIVE_TIME.packageSha256,
      },
      binary: {
        path: "bin/time",
        bytes: 27384,
        sha256: NATIVE_TIME.sha256,
        minimumGlibc: "2.34",
        interpreter: "/lib64/ld-linux-x86-64.so.2",
        needed: ["libc.so.6"],
      },
      distributionBundle: distribution,
    };
    expect(() => assertNativeTimeManifest(manifest)).not.toThrow();
    for (const changed of [
      { ...manifest, platform: "win32" },
      { ...manifest, package: { ...manifest.package, sha256: "wrong" } },
      { ...manifest, binary: { ...manifest.binary, path: "/usr/bin/time" } },
      { ...manifest, binary: { ...manifest.binary, minimumGlibc: "2.33" } },
      { ...manifest, binary: { ...manifest.binary, needed: ["libsecret.so"] } },
      { ...manifest, distributionBundle: [] },
      { ...manifest, distributionBundle: distribution.slice(1) },
      {
        ...manifest,
        distributionBundle: [
          { ...distribution[0], sha256: "wrong" },
          ...distribution.slice(1),
        ],
      },
    ])
      expect(() => assertNativeTimeManifest(changed)).toThrow(
        "PROCESSING_UNAVAILABLE",
      );
  });
});
describe("actual local time artifact/source filesystem rejection", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "phase30-time-files-"));
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "source", "time"), { recursive: true });
    for (const pin of distribution)
      await copyFile(
        resolve(__dirname, "../../../vendor/phase30-time", pin.file),
        join(root, "source", "time", pin.file),
      );
    const packager = require("../../../scripts/package-phase30-time.cjs");
    await writeFile(
      join(root, "time-manifest.json"),
      JSON.stringify({
        format: 1,
        platform: "linux",
        arch: "x64",
        package: packager.TIME_PIN,
        binary: packager.TIME_BINARY,
        distributionBundle: distribution,
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!root.startsWith(join(tmpdir(), "phase30-time-files-")))
      throw Error("TEST_OWNERSHIP");
    await rm(root, { recursive: true, force: true });
  });
  it("keeps build and runtime package, binary and eight distribution pins identical", () => {
    const packager = require("../../../scripts/package-phase30-time.cjs");
    expect(NATIVE_TIME_DISTRIBUTION).toEqual(packager.DISTRIBUTION);
    expect(NATIVE_TIME.sha256).toBe(packager.TIME_BINARY.sha256);
    expect(NATIVE_TIME.packageSha256).toBe(packager.TIME_PIN.sha256);
    expect(NATIVE_TIME.bytes).toBe(packager.TIME_BINARY.bytes);
  });
  it("rejects an actually missing required license before executable use", async () => {
    await unlink(join(root, "source", "time", "COPYING.GPL2"));
    expect(() => verifyNativeTimeFiles(root)).toThrow();
  });
  it("rejects a same-size altered required notice before executable use", async () => {
    const file = join(root, "source", "time", "copyright"),
      bytes = fs.readFileSync(file);
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    expect(() => verifyNativeTimeFiles(root)).toThrow("PROCESSING_UNAVAILABLE");
  });
  it("rejects a same-size corrupt binary after real source bundle verification", async () => {
    const binary = join(root, "bin", "time");
    await writeFile(binary, Buffer.alloc(NATIVE_TIME.bytes));
    const original = fs.lstatSync;
    jest.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      const info = original(file);
      return file === binary ? Object.assign(info, { mode: 0o100500 }) : info;
    }) as typeof fs.lstatSync);
    expect(() => verifyNativeTimeFiles(root)).toThrow("PROCESSING_UNAVAILABLE");
  });
  it("rejects a non-regular source entry including symbolic links", () => {
    const original = fs.lstatSync;
    jest.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      const info = original(file);
      if (file === join(root, "source", "time", "COPYING.GPL2"))
        info.isFile = () => false;
      return info;
    }) as typeof fs.lstatSync);
    expect(() => verifyNativeTimeFiles(root)).toThrow("PROCESSING_UNAVAILABLE");
  });
});
