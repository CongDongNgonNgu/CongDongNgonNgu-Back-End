"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { stageReviewedBaseline } = require("./stage-reviewed-baseline.cjs");
const baseline = path.resolve(
    __dirname,
    "../vendor/ci/backend-reviewed-baseline-9f.zip",
  ),
  digest = "7dc2bce0d6fa3891dbede35e6928c4ef66ec14a8baf99325ade51fe3f57b7f7f";
function owned(run) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cdnn-retained-baseline-"),
  );
  try {
    return run(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
test("stages the exact retained reviewed archive without fetching or rebuilding", () =>
  owned((temp) => {
    const output = stageReviewedBaseline(temp);
    assert.equal(
      output,
      path.join(temp, "cdnn-pinned-application", "reviewed-baseline.zip"),
    );
    const bytes = fs.readFileSync(output);
    assert.equal(bytes.length, 1550281);
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      digest,
    );
    assert.deepEqual(bytes, fs.readFileSync(baseline));
  }));
test("rejects checksum tampering before creating the staging directory", () =>
  owned((temp) => {
    const file = path.join(temp, "tampered.zip"),
      bytes = fs.readFileSync(baseline);
    bytes[100] ^= 1;
    fs.writeFileSync(file, bytes);
    assert.throws(() => stageReviewedBaseline(temp, file), /PINNED_BASELINE/);
    assert.equal(
      fs.existsSync(path.join(temp, "cdnn-pinned-application")),
      false,
    );
  }));
test("rejects short archives before creating any trusted output", () =>
  owned((temp) => {
    const file = path.join(temp, "short.zip");
    fs.writeFileSync(file, "not the retained archive");
    assert.throws(() => stageReviewedBaseline(temp, file), /PINNED_BASELINE/);
    assert.equal(
      fs.existsSync(path.join(temp, "cdnn-pinned-application")),
      false,
    );
  }));
test("refuses existing staging targets without altering their contents", () =>
  owned((temp) => {
    const target = path.join(temp, "cdnn-pinned-application");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "existing"), "preserve");
    assert.throws(() => stageReviewedBaseline(temp), /PINNED_BASELINE/);
    assert.equal(
      fs.readFileSync(path.join(target, "existing"), "utf8"),
      "preserve",
    );
  }));
test("refuses symlink staging targets and preserves the external destination", () =>
  owned((temp) => {
    const destination = path.join(temp, "outside");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "existing"), "preserve");
    fs.symlinkSync(
      destination,
      path.join(temp, "cdnn-pinned-application"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => stageReviewedBaseline(temp), /PINNED_BASELINE/);
    assert.equal(
      fs.readFileSync(path.join(destination, "existing"), "utf8"),
      "preserve",
    );
  }));
test("rejects absent, relative, production and non-directory runner roots", () =>
  owned((temp) => {
    const file = path.join(temp, "file");
    fs.writeFileSync(file, "preserve");
    for (const root of [
      undefined,
      "relative",
      path.join(temp, "missing"),
      file,
      "/var/www",
    ])
      assert.throws(() => stageReviewedBaseline(root), /PINNED_BASELINE/);
  }));

test("readback mismatch removes only the exact newly created output", () =>
  owned((temp) => {
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      const bytes = original.call(this, file, ...args);
      return String(file) ===
        path.join(temp, "cdnn-pinned-application", "reviewed-baseline.zip")
        ? Buffer.from("corrupt readback")
        : bytes;
    };
    try {
      assert.throws(() => stageReviewedBaseline(temp), /PINNED_BASELINE/);
      assert.equal(
        fs.existsSync(path.join(temp, "cdnn-pinned-application")),
        false,
      );
    } finally {
      fs.readFileSync = original;
    }
  }));

test("partial write failure removes only its own output and empty target", () =>
  owned((temp) => {
    const original = fs.writeFileSync;
    fs.writeFileSync = function (file, bytes, ...args) {
      if (
        typeof file === "number" ||
        String(file) ===
          path.join(temp, "cdnn-pinned-application", "reviewed-baseline.zip")
      ) {
        original.call(this, file, Buffer.from("partial"), ...args);
        throw Error("synthetic ENOSPC");
      }
      return original.call(this, file, bytes, ...args);
    };
    try {
      assert.throws(() => stageReviewedBaseline(temp), /PINNED_BASELINE/);
      assert.equal(
        fs.existsSync(path.join(temp, "cdnn-pinned-application")),
        false,
      );
    } finally {
      fs.writeFileSync = original;
    }
  }));
