import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { mkdtemp, lstat, readFile, unlink, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  measuredNativeInvocation,
  parseCompletedNativePeak,
  waitForLinuxGroupExit,
} from "./native-memory";

// Exact Debian bookworm artifact and ABI independently authenticated in the
// Phase30 native-time-236e842a evidence; matching source/notices ship alongside it.
export const NATIVE_TIME = Object.freeze({
  packageSha256:
    "10257c6fe888e6578550b1f20705d282dd630b76f8df0c006aec3031fefe5e23",
  sha256: "efc0d1112e36ec76c14bf7508e287935cf1631d9d0d91fb532802d07aef51cea",
  bytes: 27384,
});
export const NATIVE_TIME_DISTRIBUTION = Object.freeze([
  {
    file: "time_1.9.orig.tar.gz",
    bytes: 596779,
    sha256: "fbacf0c81e62429df3e33bda4cee38756604f18e01d977338e23306a3e3b521e",
  },
  {
    file: "time_1.9-0.2.debian.tar.xz",
    bytes: 14748,
    sha256: "42a9d951055290c5186a1b83808744bd07bf8675f24e99998e46a31825781480",
  },
  {
    file: "time_1.9-0.2.dsc",
    bytes: 1703,
    sha256: "32edee09df14a7e61fe0d02be477e7f2efd3df3f601dff6ecc51f18b99fd0f24",
  },
  {
    file: "copyright",
    bytes: 2943,
    sha256: "9c5fb22ad687c290ca88f4064a2b5f89bb998a5caec2f5eada316d6caf889738",
  },
  {
    file: "COPYING.GPL3",
    bytes: 35147,
    sha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
  },
  {
    file: "COPYING.GPL2",
    bytes: 18092,
    sha256: "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
  },
  {
    file: "README.upstream",
    bytes: 650,
    sha256: "d1665e188a9ceb040c9ae2de22080e098b0bf1b96a298fe0a9764409e7eb378f",
  },
  {
    file: "INSTALL.upstream",
    bytes: 15756,
    sha256: "54be5efe708bd5a7b433ab227130c5548221151698d17eb7eb142f640cf291ec",
  },
]);
const unavailable = (): never => {
  throw Error("PROCESSING_UNAVAILABLE");
};
export function assertNativeTimeHost(
  platform: string,
  arch: string,
  glibc: unknown,
): void {
  if (
    platform !== "linux" ||
    arch !== "x64" ||
    typeof glibc !== "string" ||
    !/^\d+\.\d+$/.test(glibc)
  )
    return unavailable();
  const [major, minor] = glibc.split(".").map(Number);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 2 ||
    (major === 2 && minor < 34)
  )
    return unavailable();
}
export function assertNativeTimeManifest(value: unknown): void {
  const item = value as {
    format?: unknown;
    platform?: unknown;
    arch?: unknown;
    package?: { version?: unknown; bytes?: unknown; sha256?: unknown };
    binary?: {
      path?: unknown;
      bytes?: unknown;
      sha256?: unknown;
      minimumGlibc?: unknown;
      interpreter?: unknown;
      needed?: unknown;
    };
    distributionBundle?: unknown;
  } | null;
  if (
    item?.format !== 1 ||
    item.platform !== "linux" ||
    item.arch !== "x64" ||
    item.package?.version !== "1.9-0.2" ||
    item.package.bytes !== 50776 ||
    item.package.sha256 !== NATIVE_TIME.packageSha256 ||
    item.binary?.path !== "bin/time" ||
    item.binary.bytes !== NATIVE_TIME.bytes ||
    item.binary.sha256 !== NATIVE_TIME.sha256 ||
    item.binary.minimumGlibc !== "2.34" ||
    item.binary.interpreter !== "/lib64/ld-linux-x86-64.so.2" ||
    !Array.isArray(item.binary.needed) ||
    item.binary.needed.length !== 1 ||
    item.binary.needed[0] !== "libc.so.6"
  )
    return unavailable();
  if (
    !Array.isArray(item.distributionBundle) ||
    item.distributionBundle.length !== NATIVE_TIME_DISTRIBUTION.length
  )
    return unavailable();
  for (let index = 0; index < NATIVE_TIME_DISTRIBUTION.length; index++) {
    const actual = item.distributionBundle[index] as {
        file?: unknown;
        bytes?: unknown;
        sha256?: unknown;
      } | null,
      expected = NATIVE_TIME_DISTRIBUTION[index];
    if (
      actual?.file !== expected.file ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      return unavailable();
  }
}
const cleanEnvironment: NodeJS.ProcessEnv = {
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
};
/** Only invoked by the explicit build. Executes fixed trusted Node code, in one
 * owned process group, with a 5s deadline and independent absence verification.
 * This is an observed lifetime peak, never an OS-enforced memory sandbox. */
export async function measureNativeTimeSmoke(
  executable: string,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "phase30-time-smoke-")),
    metric = join(directory, "rss.txt");
  let group: number | undefined,
    closed = false,
    failed = false,
    stdout = Buffer.alloc(0),
    stderrBytes = 0;
  const stop = () => {
    failed = true;
    if (group)
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
  };
  const invocation = measuredNativeInvocation(
    process.execPath,
    ["-e", "process.stdout.write(String(Buffer.alloc(1048576).length))"],
    metric,
    "linux",
    executable,
  );
  try {
    await new Promise<void>((done) => {
      let deadline: NodeJS.Timeout | undefined,
        grace: NodeJS.Timeout | undefined;
      const finish = () => {
        if (deadline) clearTimeout(deadline);
        if (grace) clearTimeout(grace);
        done();
      };
      const abort = () => {
        stop();
        grace ??= setTimeout(finish, 1000);
      };
      try {
        const child = spawn(invocation.executable, invocation.args, {
          cwd: directory,
          env: cleanEnvironment,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        group = child.pid;
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length + chunk.length > 64) abort();
          else stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 8192) abort();
        });
        child.once("error", abort);
        child.once("close", (code, signal) => {
          closed = true;
          if (code !== 0 || signal !== null) failed = true;
          finish();
        });
        deadline = setTimeout(abort, 5000);
      } catch {
        failed = true;
        finish();
      }
    });
    if (group && !(await waitForLinuxGroupExit(group))) {
      stop();
      throw Error("PROCESSING_UNQUIESCED");
    }
    if (
      !closed ||
      failed ||
      stderrBytes !== 0 ||
      stdout.toString("ascii") !== "1048576"
    )
      return unavailable();
    const info = await lstat(metric);
    if (!info.isFile() || info.size < 1 || info.size > 128)
      return unavailable();
    const peak = parseCompletedNativePeak(await readFile(metric));
    if (peak > 192 * 1024 * 1024) return unavailable();
    return peak;
  } finally {
    // Retain scratch if any producer remains uncertain; no cleanup PASS is claimed.
    if (!group || (await waitForLinuxGroupExit(group))) {
      await unlink(metric).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rmdir(directory);
    }
  }
}
export function verifyNativeTimeFiles(directory: string): string {
  directory = resolve(directory);
  const executable = join(directory, "bin", "time"),
    manifest = join(directory, "time-manifest.json");
  const manifestInfo = lstatSync(manifest);
  if (
    !manifestInfo.isFile() ||
    manifestInfo.size < 1 ||
    manifestInfo.size > 8192
  )
    return unavailable();
  assertNativeTimeManifest(JSON.parse(readFileSync(manifest, "utf8")));
  for (const pin of NATIVE_TIME_DISTRIBUTION) {
    const file = join(directory, "source", "time", pin.file),
      sourceInfo = lstatSync(file);
    if (!sourceInfo.isFile() || sourceInfo.size !== pin.bytes)
      return unavailable();
    if (
      createHash("sha256").update(readFileSync(file)).digest("hex") !==
      pin.sha256
    )
      return unavailable();
  }
  const info = lstatSync(executable);
  if (!info.isFile() || info.size !== NATIVE_TIME.bytes || !(info.mode & 0o111))
    return unavailable();
  const binary = readFileSync(executable);
  if (
    createHash("sha256").update(binary).digest("hex") !== NATIVE_TIME.sha256 ||
    binary.subarray(0, 6).toString("hex") !== "7f454c460201" ||
    binary.readUInt16LE(16) !== 3 ||
    binary.readUInt16LE(18) !== 62
  )
    return unavailable();
  return executable;
}
export async function verifyBundledNativeTime(
  directory: string,
  options: { smoke?: boolean } = {},
): Promise<{
  executable: string;
  glibcVersion: string;
  peakRssBytes?: number;
}> {
  const glibc = (
    process.report.getReport() as { header: { glibcVersionRuntime?: unknown } }
  ).header.glibcVersionRuntime;
  assertNativeTimeHost(process.platform, process.arch, glibc);
  const executable = verifyNativeTimeFiles(directory);
  const version = spawnSync(executable, ["--version"], {
    cwd: directory,
    env: cleanEnvironment,
    shell: false,
    windowsHide: true,
    timeout: 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8192,
    encoding: "utf8",
  });
  if (
    version.error ||
    version.status !== 0 ||
    !version.stdout.startsWith("time (GNU Time)")
  )
    return unavailable();
  const peakRssBytes = options.smoke
    ? await measureNativeTimeSmoke(executable)
    : undefined;
  return {
    executable,
    glibcVersion: glibc as string,
    ...(peakRssBytes ? { peakRssBytes } : {}),
  };
}
