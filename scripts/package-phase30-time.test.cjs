"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const {
  TIME_PIN,
  TIME_BINARY,
  DISTRIBUTION,
  verifyDistribution,
  packageTime,
  assertTimeElf,
} = require("./package-phase30-time.cjs");
test("CLI rejects excess arguments before artifact or network access", () => {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "package-phase30-time.cjs"),
      "unused",
      "unused",
      "",
      "extra",
    ],
    { encoding: "utf8", timeout: 1000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});
async function owned(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase30-time-test-"));
  try {
    await work(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("pins authenticated Debian package, binary and complete eight-file source/notice bundle", () => {
  assert.equal(
    TIME_PIN.sha256,
    "10257c6fe888e6578550b1f20705d282dd630b76f8df0c006aec3031fefe5e23",
  );
  assert.equal(TIME_PIN.bytes, 50776);
  assert.equal(
    TIME_BINARY.sha256,
    "efc0d1112e36ec76c14bf7508e287935cf1631d9d0d91fb532802d07aef51cea",
  );
  assert.equal(DISTRIBUTION.length, 8);
  assert.equal(
    DISTRIBUTION.reduce((sum, item) => sum + item.bytes, 0),
    685818,
  );
});
test("verifies the repository source and notice bundle without executing it", async () => {
  assert.equal((await verifyDistribution()).length, 8);
});
test("missing source/license bundle fails closed", () =>
  owned(async (root) => {
    await assert.rejects(verifyDistribution(root), /TIME_SOURCE/);
  }));
test("same-size modified source fails checksum validation", () =>
  owned(async (root) => {
    await fs.writeFile(
      path.join(root, DISTRIBUTION[0].file),
      Buffer.alloc(DISTRIBUTION[0].bytes),
    );
    await assert.rejects(verifyDistribution(root), /TIME_SOURCE_CHECKSUM/);
  }));
test("unverified package never creates destination", () =>
  owned(async (root) => {
    const archive = path.join(root, "wrong.deb"),
      destination = path.join(root, "install");
    await fs.writeFile(archive, "unverified");
    await assert.rejects(
      packageTime(archive, destination),
      /TIME_PACKAGE_SIZE/,
    );
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  }));
test("same-size wrong-checksum package never creates destination", () =>
  owned(async (root) => {
    const archive = path.join(root, "wrong.deb"),
      destination = path.join(root, "install");
    await fs.writeFile(archive, Buffer.alloc(TIME_PIN.bytes));
    await assert.rejects(
      packageTime(archive, destination),
      /TIME_PACKAGE_CHECKSUM/,
    );
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  }));
test("ELF validation rejects malformed and foreign architecture headers", () => {
  for (const buffer of [
    Buffer.alloc(64),
    Buffer.from("not an ELF"),
    Buffer.alloc(TIME_BINARY.bytes),
  ])
    assert.throws(() => assertTimeElf(buffer), /TIME_BINARY/);
});
