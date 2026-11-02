"use strict";
// Build-time only, for code-pinned software artifacts. Never an upload parser.
const fs = require("node:fs/promises"),
  path = require("node:path");
const crypto = require("node:crypto"),
  { gunzipSync } = require("node:zlib");
const LIMIT = 64 * 1024 * 1024,
  MEMBER_LIMIT = 20_000_000;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const reject = (label) => {
  throw Error("PROCESSOR_STAGE_" + label);
};
const validDigest = (value) =>
  typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const safePath = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 100 &&
  !/[^A-Za-z0-9._+/-]/.test(name) &&
  name.split("/").every((part) => part && part !== "." && part !== "..");
function snapshotPin(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > LIMIT ||
    !validDigest(value.sha256) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 64
  )
    reject("PIN");
  const members = [],
    names = new Set();
  let total = 0;
  for (const member of value.members) {
    if (
      !member ||
      !safePath(member.path) ||
      names.has(member.path) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes < 0 ||
      member.bytes > MEMBER_LIMIT ||
      !validDigest(member.sha256) ||
      ![0o400, 0o500].includes(member.mode)
    )
      reject("PIN");
    names.add(member.path);
    total += member.bytes;
    if (total > LIMIT) reject("PIN");
    members.push({
      path: member.path,
      bytes: member.bytes,
      sha256: member.sha256,
      mode: member.mode,
    });
  }
  // A regular file cannot simultaneously be another member's parent directory.
  for (const name of names)
    for (const other of names) if (other.startsWith(name + "/")) reject("PIN");
  return { bytes: value.bytes, sha256: value.sha256, members };
}
async function authenticatedArchive(file, pin) {
  const handle = await fs.open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== pin.bytes) reject("SIZE");
    // A concurrently enlarged file cannot turn a bounded stat into an unbounded read.
    const bytes = Buffer.alloc(pin.bytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        count,
        bytes.length - count,
        null,
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== pin.bytes) reject("SIZE");
    const authenticated = bytes.subarray(0, count);
    if (sha(authenticated) !== pin.sha256) reject("CHECKSUM");
    return authenticated;
  } finally {
    await handle.close();
  }
}
function octal(field) {
  const raw = field.toString("latin1");
  if (/[^0-7 \0]/.test(raw)) reject("HEADER");
  const digits = raw.replace(/[ \0]+$/, " ").trim();
  if (!digits || /[^0-7]/.test(digits)) reject("HEADER");
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) reject("HEADER");
  return value;
}
function verifiedMembers(archive, pin) {
  let bytes;
  try {
    bytes = gunzipSync(archive, { maxOutputLength: LIMIT });
  } catch {
    reject("ARCHIVE");
  }
  if (bytes.length < 1024 || bytes.length % 512) reject("HEADER");
  const expected = new Map(pin.members.map((member) => [member.path, member])),
    found = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (
        bytes.length - offset < 1024 ||
        !bytes.subarray(offset).every((value) => value === 0) ||
        found.size !== expected.size
      )
        reject("MEMBERS");
      return found;
    }
    const checksum = octal(header.subarray(148, 156));
    let actual = 0;
    for (let i = 0; i < 512; i++)
      actual += i >= 148 && i < 156 ? 32 : header[i];
    if (
      checksum !== actual ||
      header.subarray(257, 265).toString("latin1") !== "ustar\0" + "00"
    )
      reject("HEADER");
    if (
      header[156] !== 48 ||
      !header.subarray(157, 257).every((value) => value === 0) ||
      !header.subarray(345).every((value) => value === 0)
    )
      reject("TYPE");
    const rawName = header.subarray(0, 100),
      end = rawName.indexOf(0);
    if (end >= 0 && !rawName.subarray(end).every((value) => value === 0))
      reject("MEMBERS");
    const name = rawName.subarray(0, end < 0 ? 100 : end).toString("latin1"),
      member = expected.get(name);
    if (!safePath(name) || !member || found.has(name)) reject("MEMBERS");
    const size = octal(header.subarray(124, 136)),
      mode = octal(header.subarray(100, 108));
    if (size > MEMBER_LIMIT || size !== member.bytes || mode !== member.mode)
      reject("MEMBER");
    const start = offset + 512,
      next = start + Math.ceil(size / 512) * 512;
    if (next > bytes.length) reject("HEADER");
    const payload = bytes.subarray(start, start + size);
    if (
      sha(payload) !== member.sha256 ||
      !bytes.subarray(start + size, next).every((value) => value === 0)
    )
      reject("MEMBER");
    found.set(name, payload);
    offset = next;
  }
  reject("HEADER");
}
async function stagePinnedArchive(archive, destination, codePin) {
  const pin = snapshotPin(codePin),
    authenticated = await authenticatedArchive(archive, pin);
  // Strict USTAR avoids parser disagreement between native listing and extraction.
  // All payload sizes, hashes, types, padding and trailing blocks pass before writes.
  const members = verifiedMembers(authenticated, pin);
  destination = path.resolve(destination);
  try {
    await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  } catch {
    reject("DESTINATION");
  }
  for (const member of pin.members) {
    const file = path.join(destination, member.path);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, members.get(member.path), {
      flag: "wx",
      mode: 0o600,
    });
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.size !== member.bytes ||
      sha(await fs.readFile(file)) !== member.sha256
    )
      reject("MEMBER");
    await fs.chmod(file, member.mode);
  }
  return pin;
}
module.exports = { stagePinnedArchive };
