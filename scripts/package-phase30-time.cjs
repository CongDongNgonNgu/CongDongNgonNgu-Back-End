"use strict";
// Explicit build-time artifact assembly only. No root installation or maintainer scripts.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
// Debian Release/Packages/Sources signature chain independently verified in the
// Phase30 Workspace native-time-236e842a evidence. No moving-latest dependency.
const TIME_PIN = Object.freeze({
  name: "time",
  version: "1.9-0.2",
  architecture: "amd64",
  file: "time_1.9-0.2_amd64.deb",
  bytes: 50776,
  sha256: "10257c6fe888e6578550b1f20705d282dd630b76f8df0c006aec3031fefe5e23",
  url: "https://deb.debian.org/debian/pool/main/t/time/time_1.9-0.2_amd64.deb",
});
const TIME_BINARY = Object.freeze({
  path: "bin/time",
  bytes: 27384,
  sha256: "efc0d1112e36ec76c14bf7508e287935cf1631d9d0d91fb532802d07aef51cea",
  minimumGlibc: "2.34",
  interpreter: "/lib64/ld-linux-x86-64.so.2",
  needed: ["libc.so.6"],
});
const DISTRIBUTION = Object.freeze([
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
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function verifiedFile(file, pin, label) {
  const info = await fs.lstat(file).catch(() => {
    throw Error(label + "_MISSING");
  });
  if (!info.isFile() || info.size !== pin.bytes) throw Error(label + "_SIZE");
  const bytes = await fs.readFile(file);
  if (sha(bytes) !== pin.sha256) throw Error(label + "_CHECKSUM");
  return bytes;
}
async function verifyDistribution(
  directory = path.resolve(__dirname, "../vendor/phase30-time"),
) {
  const files = [];
  for (const pin of DISTRIBUTION)
    files.push({
      pin,
      bytes: await verifiedFile(
        path.join(directory, pin.file),
        pin,
        "TIME_SOURCE",
      ),
    });
  return files;
}
function assertTimeElf(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== TIME_BINARY.bytes ||
    sha(bytes) !== TIME_BINARY.sha256
  )
    throw Error("TIME_BINARY_CHECKSUM");
  if (
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62
  )
    throw Error("TIME_BINARY_ELF");
  const offset = Number(bytes.readBigUInt64LE(32)),
    entryBytes = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(offset) ||
    entryBytes !== 56 ||
    count < 1 ||
    count > 64 ||
    offset + count * entryBytes > bytes.length
  )
    throw Error("TIME_BINARY_ELF");
  const interpreters = [];
  for (let i = 0; i < count; i++) {
    const start = offset + i * entryBytes;
    if (bytes.readUInt32LE(start) !== 3) continue;
    const from = Number(bytes.readBigUInt64LE(start + 8)),
      size = Number(bytes.readBigUInt64LE(start + 32));
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 128 ||
      from + size > bytes.length
    )
      throw Error("TIME_BINARY_ELF");
    interpreters.push(bytes.subarray(from, from + size).toString("ascii"));
  }
  if (
    interpreters.length !== 1 ||
    interpreters[0] !== TIME_BINARY.interpreter + "\0"
  )
    throw Error("TIME_BINARY_ELF");
}
function debData(bytes) {
  if (bytes.subarray(0, 8).toString("ascii") !== "!<arch>\n")
    throw Error("TIME_PACKAGE_AR");
  let offset = 8;
  const members = new Map();
  while (offset < bytes.length) {
    if (offset + 60 > bytes.length) throw Error("TIME_PACKAGE_AR");
    const header = bytes.subarray(offset, offset + 60),
      name = header.subarray(0, 16).toString("ascii").trim().replace(/\/$/, ""),
      rawSize = header.subarray(48, 58).toString("ascii").trim();
    if (
      header.subarray(58).toString("ascii") !== "`\n" ||
      !/^\d+$/.test(rawSize) ||
      !["debian-binary", "control.tar.xz", "data.tar.xz"].includes(name) ||
      members.has(name)
    )
      throw Error("TIME_PACKAGE_AR");
    const size = Number(rawSize);
    offset += 60;
    if (size < 1 || offset + size > bytes.length)
      throw Error("TIME_PACKAGE_AR");
    members.set(name, bytes.subarray(offset, offset + size));
    offset += size;
    if (size % 2) {
      if (bytes[offset] !== 10) throw Error("TIME_PACKAGE_AR");
      offset++;
    }
  }
  if (
    offset !== bytes.length ||
    members.size !== 3 ||
    members.get("debian-binary")?.toString("ascii") !== "2.0\n"
  )
    throw Error("TIME_PACKAGE_AR");
  return members.get("data.tar.xz");
}
function extractTime(bytes) {
  const archive = debData(bytes),
    member = "./usr/bin/time",
    run = (args) => {
      const result = spawnSync("tar", args, {
        input: archive,
        shell: false,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 65536,
      });
      if (result.error || result.status !== 0) throw Error("TIME_PACKAGE_TAR");
      return result.stdout;
    };
  const listing = run(["-tJvf", "-", member]).toString("utf8");
  if (!listing.startsWith("-") || listing.trim().split("\n").length !== 1)
    throw Error("TIME_PACKAGE_MEMBER");
  const binary = run(["-xJOf", "-", member]);
  assertTimeElf(binary);
  return binary;
}
async function packageTime(archive, destination, { vendorDirectory } = {}) {
  const bytes = await verifiedFile(
      path.resolve(archive),
      TIME_PIN,
      "TIME_PACKAGE",
    ),
    binary = extractTime(bytes),
    sources = await verifyDistribution(vendorDirectory);
  destination = path.resolve(destination);
  await fs.mkdir(path.join(destination, "bin"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(destination, "source", "time"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(path.join(destination, TIME_BINARY.path), binary, {
    flag: "wx",
    mode: 0o500,
  });
  for (const item of sources)
    await fs.writeFile(
      path.join(destination, "source", "time", item.pin.file),
      item.bytes,
      { flag: "wx", mode: 0o400 },
    );
  const manifest = {
    format: 1,
    package: TIME_PIN,
    binary: TIME_BINARY,
    platform: "linux",
    arch: "x64",
    licenses: { upstream: "GPL-3.0-or-later", debian: "GPL-2.0-or-later" },
    distributionBundle: DISTRIBUTION,
    provenance:
      "Authenticated Debian bookworm Release -> Packages/Sources -> exact package/source artifacts; original separate executable, no root installation.",
  };
  await fs.writeFile(
    path.join(destination, "time-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o400 },
  );
  return manifest;
}
async function downloadTime(destination) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 30000);
  try {
    const response = await fetch(TIME_PIN.url, {
      redirect: "error",
      signal: abort.signal,
    });
    if (response.status !== 200 || !response.body) throw Error("TIME_DOWNLOAD");
    const file = await fs.open(destination, "wx", 0o600);
    let count = 0;
    try {
      for await (const part of response.body) {
        count += part.length;
        if (count > TIME_PIN.bytes) throw Error("TIME_DOWNLOAD_SIZE");
        await file.writeFile(part);
      }
      if (count !== TIME_PIN.bytes) throw Error("TIME_DOWNLOAD_SIZE");
    } finally {
      await file.close();
    }
  } finally {
    clearTimeout(timer);
  }
}
module.exports = {
  TIME_PIN,
  TIME_BINARY,
  DISTRIBUTION,
  verifyDistribution,
  assertTimeElf,
  packageTime,
  downloadTime,
};
if (require.main === module) {
  const [archive, destination, download] = process.argv.slice(2);
  if (
    process.argv.slice(2).length > 3 ||
    !archive ||
    !destination ||
    (download && download !== "--download")
  ) {
    console.error(
      "Usage: node scripts/package-phase30-time.cjs DEB DESTINATION [--download]",
    );
    process.exitCode = 1;
  } else
    (async () => {
      if (download) await downloadTime(archive);
      await packageTime(archive, destination);
      console.log("PINNED_TIME_PACKAGE=VERIFIED");
    })().catch(() => {
      console.error("PINNED_TIME_PACKAGE=REJECTED");
      process.exitCode = 1;
    });
}
