"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path"),
  os = require("node:os");
const crypto = require("node:crypto"),
  zlib = require("node:zlib");
const { stagePinnedArchive } = require("./stage-phase30-archive.cjs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const files = () => [
  {
    path: "bin/ffmpeg",
    data: Buffer.from("synthetic executable"),
    mode: 0o500,
  },
  {
    path: "source/ffmpeg.tar.gz",
    data: Buffer.from("complete source archive"),
    mode: 0o400,
  },
  {
    path: "notices/COPYING.LGPLv2.1+",
    data: Buffer.from("retained license"),
    mode: 0o400,
  },
  {
    path: "manifest.json",
    data: Buffer.from('{"candidate":true}'),
    mode: 0o400,
  },
];
function archiveBytes(entries) {
  const blocks = [];
  for (const item of entries) {
    const header = Buffer.alloc(512),
      data = item.data ?? Buffer.alloc(0);
    const text = (offset, length, value) =>
      header.write(value, offset, length, "ascii");
    const octal = (offset, length, value) =>
      text(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
    text(0, 100, item.path);
    octal(100, 8, item.mode ?? 0o400);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    text(156, 1, item.type ?? "0");
    text(157, 100, item.link ?? "");
    text(257, 6, "ustar\0");
    text(263, 2, "00");
    const checksum = header.reduce((total, value) => total + value, 0);
    text(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function pin(bytes, entries) {
  return {
    bytes: bytes.length,
    sha256: sha(bytes),
    members: entries.map((item) => ({
      path: item.path,
      bytes: (item.data ?? Buffer.alloc(0)).length,
      sha256: sha(item.data ?? Buffer.alloc(0)),
      mode: item.mode ?? 0o400,
    })),
  };
}
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase30-stage-test-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function prepare(root, entries = files()) {
  const archive = path.join(root, "candidate.tar.gz"),
    destination = path.join(root, "staged"),
    bytes = archiveBytes(entries);
  await fs.writeFile(archive, bytes);
  return { archive, destination, bytes, codePin: pin(bytes, entries) };
}
async function absent(file) {
  await assert.rejects(fs.lstat(file), { code: "ENOENT" });
}

test("stages every pinned binary, source, notice and original manifest with verified proof", () =>
  fixture(async (root) => {
    const input = await prepare(root),
      proof = await stagePinnedArchive(
        input.archive,
        input.destination,
        input.codePin,
      );
    assert.deepEqual(proof, input.codePin);
    for (const item of files()) {
      const output = path.join(input.destination, item.path);
      assert.deepEqual(await fs.readFile(output), item.data);
      const info = await fs.lstat(output);
      assert.equal(info.isFile(), true);
      if (process.platform !== "win32")
        assert.equal(info.mode & 0o777, item.mode);
    }
  }));
test("rejects changed archive checksum before tar or destination creation", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    input.codePin.sha256 = "0".repeat(64);
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_CHECKSUM/,
    );
    await absent(input.destination);
  }));
test("rejects archive size drift and oversize code pin bounds before creating destination", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    for (const changed of [
      { ...input.codePin, bytes: input.codePin.bytes + 1 },
      { ...input.codePin, bytes: 64 * 1024 * 1024 + 1 },
      {
        ...input.codePin,
        members: [{ ...input.codePin.members[0], bytes: 20 * 1024 * 1024 + 1 }],
      },
      {
        ...input.codePin,
        members: Array.from({ length: 4 }, (_, i) => ({
          ...input.codePin.members[0],
          path: "source/part" + i,
          bytes: 20 * 1024 * 1024,
        })),
      },
      {
        ...input.codePin,
        members: Array.from({ length: 65 }, (_, i) => ({
          ...input.codePin.members[0],
          path: "source/part" + i,
        })),
      },
    ])
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, changed),
        /PROCESSOR_STAGE_/,
      );
    await absent(input.destination);
  }));
test("rejects unsafe pin paths including traversal, absolute, backslash and control characters", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    for (const unsafe of [
      "../escape",
      "/absolute",
      "bin/../../escape",
      "bin\\escape",
      "bin/a\nb",
      "a//b",
      "a/./b",
      "a".repeat(101),
    ]) {
      const changed = {
        ...input.codePin,
        members: [{ ...input.codePin.members[0], path: unsafe }],
      };
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, changed),
        /PROCESSOR_STAGE_PIN/,
      );
    }
    await absent(input.destination);
    await absent(path.join(root, "escape"));
  }));
test("rejects traversal archive names, missing, duplicate and extra members before extraction", () =>
  fixture(async (root) => {
    const expected = files();
    for (const entries of [
      [...expected, { path: "../escape", data: Buffer.from("x") }],
      expected.slice(1),
      [...expected, expected[0]],
      [...expected, { path: "extra.txt", data: Buffer.from("extra") }],
    ]) {
      const input = await prepare(root, entries);
      input.codePin.members = pin(input.bytes, expected).members;
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, input.codePin),
        /PROCESSOR_STAGE_MEMBERS/,
      );
      await absent(input.destination);
      await absent(path.join(root, "escape"));
    }
  }));
for (const [label, type] of [
  ["hard link", "1"],
  ["symbolic link", "2"],
  ["directory", "5"],
  ["device", "3"],
])
  test("rejects " + label + " members before destination creation", () =>
    fixture(async (root) => {
      const input = await prepare(root, [
        { path: "unsafe", type, link: "elsewhere", mode: 0o400 },
      ]);
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, input.codePin),
        /PROCESSOR_STAGE_(MEMBERS|TYPE)/,
      );
      await absent(input.destination);
    }),
  );
test("never overwrites an existing destination", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    await fs.mkdir(input.destination);
    const marker = path.join(input.destination, "keep.txt");
    await fs.writeFile(marker, "existing");
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_DESTINATION/,
    );
    assert.equal(await fs.readFile(marker, "utf8"), "existing");
    await absent(path.join(input.destination, "bin"));
  }));
test("invalid gzip cannot return a successful proof or create the destination", () =>
  fixture(async (root) => {
    const input = await prepare(root),
      invalid = Buffer.from("authenticated but invalid gzip");
    await fs.writeFile(input.archive, invalid);
    input.codePin.bytes = invalid.length;
    input.codePin.sha256 = sha(invalid);
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_ARCHIVE/,
    );
    await absent(input.destination);
  }));
test("member hash mismatch fails before destination creation", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    input.codePin.members[0].sha256 = "0".repeat(64);
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_MEMBER/,
    );
    await absent(input.destination);
  }));
test("writes verified memory bytes even after the source archive path is replaced", () =>
  fixture(async (root) => {
    const input = await prepare(root),
      original = fs.mkdir;
    let replaced = false;
    const context = {};
    try {
      fs.mkdir = async (directory, options) => {
        if (directory === input.destination && !replaced) {
          await fs.writeFile(input.archive, Buffer.from("replacement archive"));
          replaced = true;
        }
        return original(directory, options);
      };
      context.proof = await stagePinnedArchive(
        input.archive,
        input.destination,
        input.codePin,
      );
    } finally {
      fs.mkdir = original;
    }
    assert.equal(replaced, true);
    assert.deepEqual(context.proof, input.codePin);
    assert.deepEqual(
      await fs.readFile(path.join(input.destination, "bin/ffmpeg")),
      files()[0].data,
    );
  }));

function checksumHeader(bytes) {
  bytes.fill(32, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((total, value) => total + value, 0);
  bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}
async function rewriteArchive(input, mutate) {
  const expanded = zlib.gunzipSync(input.bytes),
    changed = mutate(expanded) ?? expanded;
  const compressed = zlib.gzipSync(changed);
  input.codePin.bytes = compressed.length;
  input.codePin.sha256 = sha(compressed);
  await fs.writeFile(input.archive, compressed);
}
test("rejects malformed header checksum, octal, USTAR magic, prefix and file mode before writes", () =>
  fixture(async (root) => {
    for (const mutate of [
      (bytes) => {
        bytes[100] ^= 1;
      },
      (bytes) => {
        bytes.write("0000000000x\0", 124, 12, "ascii");
        checksumHeader(bytes);
      },
      (bytes) => {
        bytes[257] = 0;
        checksumHeader(bytes);
      },
      (bytes) => {
        bytes[345] = 97;
        checksumHeader(bytes);
      },
      (bytes) => {
        bytes.write("0000700\0", 100, 8, "ascii");
        checksumHeader(bytes);
      },
    ]) {
      const input = await prepare(root);
      await rewriteArchive(input, mutate);
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, input.codePin),
        /PROCESSOR_STAGE_(HEADER|TYPE|MEMBER)/,
      );
      await absent(input.destination);
    }
  }));
test("rejects oversize header payload lengths before any destination exists", () =>
  fixture(async (root) => {
    const input = await prepare(root);
    await rewriteArchive(input, (bytes) => {
      bytes.write(
        (20 * 1024 * 1024 + 1).toString(8).padStart(11, "0") + "\0",
        124,
        12,
        "ascii",
      );
      checksumHeader(bytes);
    });
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_MEMBER/,
    );
    await absent(input.destination);
  }));
test("rejects nonzero payload padding, hidden second archive, missing footer and truncated blocks", () =>
  fixture(async (root) => {
    for (const mutate of [
      (bytes) => {
        bytes[512 + files()[0].data.length] = 1;
      },
      (bytes) =>
        Buffer.concat([
          bytes,
          zlib.gunzipSync(
            archiveBytes([{ path: "hidden", data: Buffer.from("x") }]),
          ),
        ]),
      (bytes) => bytes.subarray(0, bytes.length - 1024),
      (bytes) => bytes.subarray(0, bytes.length - 1),
    ]) {
      const input = await prepare(root);
      await rewriteArchive(input, mutate);
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, input.codePin),
        /PROCESSOR_STAGE_(HEADER|MEMBER)/,
      );
      await absent(input.destination);
    }
  }));
test("bounds expanded gzip size independently of the small compressed archive", () =>
  fixture(async (root) => {
    const input = await prepare(root),
      bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024 + 512));
    await fs.writeFile(input.archive, bomb);
    input.codePin.bytes = bomb.length;
    input.codePin.sha256 = sha(bomb);
    await assert.rejects(
      stagePinnedArchive(input.archive, input.destination, input.codePin),
      /PROCESSOR_STAGE_ARCHIVE/,
    );
    await absent(input.destination);
  }));
test("post-write readback mismatch fails and leaves only the owned fresh destination", () =>
  fixture(async (root) => {
    const input = await prepare(root),
      original = fs.readFile,
      output = path.join(input.destination, "bin/ffmpeg");
    try {
      fs.readFile = async (file, ...args) =>
        file === output
          ? Buffer.from("unexpected replacement")
          : original(file, ...args);
      await assert.rejects(
        stagePinnedArchive(input.archive, input.destination, input.codePin),
        /PROCESSOR_STAGE_MEMBER/,
      );
    } finally {
      fs.readFile = original;
    }
    assert.equal((await fs.lstat(input.destination)).isDirectory(), true);
    assert.deepEqual(await fs.readFile(output), files()[0].data);
    await absent(path.join(input.destination, "source"));
  }));
