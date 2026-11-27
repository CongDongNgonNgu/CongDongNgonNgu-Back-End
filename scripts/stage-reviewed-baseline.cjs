"use strict";
// Retention repair of original public artifact12735767418, never a provenance rebuild.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const ARCHIVE = path.join(
  __dirname,
  "../vendor/ci/backend-reviewed-baseline-9f.zip",
);
const DIGEST =
    "7dc2bce0d6fa3891dbede35e6928c4ef66ec14a8baf99325ade51fe3f57b7f7f",
  BYTES = 1550281;
const fail = () => {
  throw Error("PINNED_BASELINE_STAGING_FAILED");
};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function stageReviewedBaseline(runnerTemp, archive = ARCHIVE) {
  let root,
    output,
    created = false,
    written = false;
  try {
    if (typeof runnerTemp !== "string" || !path.isAbsolute(runnerTemp))
      return fail();
    const input = fs.lstatSync(runnerTemp);
    if (!input.isDirectory() || input.isSymbolicLink()) return fail();
    const temp = fs.realpathSync(runnerTemp),
      normalized = temp.split(path.sep).join("/");
    if (
      normalized === "/var/www" ||
      normalized.startsWith("/var/www/") ||
      (typeof process.getuid === "function" &&
        fs.statSync(temp).uid !== process.getuid())
    )
      return fail();
    const info = fs.lstatSync(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== BYTES)
      return fail();
    const bytes = fs.readFileSync(archive);
    if (bytes.length !== BYTES || hash(bytes) !== DIGEST) return fail();
    root = path.join(temp, "cdnn-pinned-application");
    output = path.join(root, "reviewed-baseline.zip");
    fs.mkdirSync(root, { mode: 0o700 });
    created = true;
    const descriptor = fs.openSync(output, "wx", 0o600);
    written = true;
    try {
      fs.writeFileSync(descriptor, bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const readback = fs.readFileSync(output);
    if (readback.length !== BYTES || hash(readback) !== DIGEST) return fail();
    return output;
  } catch {
    if (written)
      try {
        fs.unlinkSync(output);
      } catch {
        /* Retain failure; never recurse or remove another path. */
      }
    if (created)
      try {
        fs.rmdirSync(root);
      } catch {
        /* Only an empty exact newly-created directory may be removed. */
      }
    return fail();
  }
}
module.exports = { stageReviewedBaseline };
if (require.main === module) {
  try {
    stageReviewedBaseline(process.env.RUNNER_TEMP);
    console.log(
      "Reviewed pinned9f retained archive digest verified; no fetch or provenance rebuild",
    );
  } catch {
    console.error("PINNED_BASELINE_STAGING_FAILED");
    process.exitCode = 1;
  }
}
