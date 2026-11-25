import { createHash } from "node:crypto";
import {
  validateColdPinnedLiteral,
  validatePinnedLiteral,
  validateActivationEnvelope,
  type ColdActivationInputs,
  type ActivationInputs,
} from "./guard";
jest.mock("pg", () => {
  throw Error("cold identity must not import database runtime");
});
const SHA = "a".repeat(40);
function fixture(
  value: unknown = {
    envelope: { schema: 99 },
    resources: [{ label: "literal only" }],
  },
) {
  const manifest = Buffer.from(JSON.stringify(value));
  return {
    activation: {
      expectedSourceSha: SHA,
      expectedManifestSha256: createHash("sha256")
        .update(manifest)
        .digest("hex"),
    },
    env: {
      NODE_ENV: "test",
      RENDER_GIT_BRANCH: "dev",
      RENDER_GIT_COMMIT: SHA,
      RENDER_SERVICE_ID: "srv-dahnerh594qs73fp3420",
      ATTACHMENTS_ENABLED: "false",
      ATTACHMENTS_IMAGE_ENABLED: "false",
      ATTACHMENTS_VIDEO_ENABLED: "false",
      ATTACHMENTS_TEXT_ENABLED: "false",
    },
    config: {
      environment: "test",
      attachments: { enabled: false, image: false, video: false, text: false },
    },
    platform: "linux",
    arch: "x64",
    execArgv: [] as string[],
    manifest,
    nowMs: Date.parse("2026-11-25T00:02:00.000Z"),
  };
}
const reject = (value: unknown) =>
  expect(() =>
    validateColdPinnedLiteral(value as ColdActivationInputs),
  ).toThrow(/^TEST_ADMISSION_REJECTED$/);
describe("cold identity and literal only, without deployment receipt", () => {
  it("returns null before observing any other option when activation is absent", () => {
    const options = new Proxy(
      { activation: undefined },
      {
        get(target, key) {
          if (key === "activation") return target.activation;
          throw Error("private option");
        },
      },
    );
    expect(validateColdPinnedLiteral()).toBeNull();
    expect(
      validateColdPinnedLiteral(options as ColdActivationInputs),
    ).toBeNull();
  });
  it("validates exactly source and full literal pins before a deployment exists", () => {
    const f = fixture(),
      out = validateColdPinnedLiteral(f)!;
    expect(out).toEqual({
      sourceSha: SHA,
      manifestSha256: f.activation.expectedManifestSha256,
      nowMs: f.nowMs,
      value: {
        envelope: { schema: 99 },
        resources: [{ label: "literal only" }],
      },
    });
    expect(Object.keys(out).sort()).toEqual([
      "manifestSha256",
      "nowMs",
      "sourceSha",
      "value",
    ]);
    expect(out).not.toHaveProperty("deploymentId");
    expect(out).not.toHaveProperty("envelope");
  });
  it("never observes receipt or deployment options, even hostile accessors", () => {
    const f = fixture();
    for (const key of ["receipt", "deploymentId", "expectedDeploymentId"])
      Object.defineProperty(f, key, {
        get() {
          throw Error("private " + key);
        },
      });
    expect(validateColdPinnedLiteral(f)).not.toBeNull();
  });
  it("requires exactly the two external pins, without accessors or self-derived substitutes", () => {
    for (const activation of [
      {},
      { expectedSourceSha: SHA },
      { ...fixture().activation, expectedDeploymentId: "dep-not-cold" },
      { ...fixture().activation, expectedSourceSha: "A".repeat(40) },
      { ...fixture().activation, expectedManifestSha256: "bad" },
    ])
      reject({ ...fixture(), activation });
    const f = fixture();
    Object.defineProperty(f.activation, "expectedSourceSha", {
      get() {
        throw Error("private");
      },
    });
    reject(f);
    reject({
      get activation() {
        throw Error("private");
      },
    });
  });
  it("requires exact default-off TEST identity and clean loader settings", () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: "production",
      RENDER_GIT_BRANCH: "main",
      RENDER_GIT_COMMIT: "b".repeat(40),
      RENDER_SERVICE_ID: "other",
      ATTACHMENTS_ENABLED: "true",
      ATTACHMENTS_IMAGE_ENABLED: "False",
      ATTACHMENTS_VIDEO_ENABLED: "",
      ATTACHMENTS_TEXT_ENABLED: "0",
      NODE_OPTIONS: "--inspect",
      NODE_PATH: "private",
      LD_PRELOAD: "private",
      LD_LIBRARY_PATH: "private",
    })) {
      const f = fixture();
      Object.assign(f.env, { [key]: value });
      reject(f);
    }
    const effective = fixture();
    effective.config.attachments.video = true;
    reject(effective);
    reject({
      ...fixture(),
      config: {
        environment: "production",
        attachments: {
          enabled: false,
          image: false,
          video: false,
          text: false,
        },
      },
    });
    for (const patch of [
      { platform: "win32" },
      { arch: "arm64" },
      { execArgv: ["--inspect"] },
    ])
      reject({ ...fixture(), ...patch });
  });
  it("reads supplied observation time once and grants no database-clock or lifetime proof", () => {
    const f = fixture();
    let reads = 0;
    const now = f.nowMs;
    Object.defineProperty(f, "nowMs", {
      get() {
        reads++;
        if (reads > 1) throw Error("second read");
        return now;
      },
    });
    expect(validateColdPinnedLiteral(f)!.nowMs).toBe(now);
    expect(reads).toBe(1);
    for (const nowMs of [
      undefined,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      reject({ ...fixture(), nowMs });
  });
  it("hashes the complete copied bytes and rejects drift without accepting child hashes", () => {
    const f = fixture(),
      childHash = createHash("sha256")
        .update(JSON.stringify({ schema: 99 }))
        .digest("hex");
    f.activation.expectedManifestSha256 = childHash;
    reject(f);
    const changed = fixture();
    changed.manifest[0] ^= 1;
    reject(changed);
  });
  it("enforces the existing bounded literal and strict JSON rules", () => {
    for (const raw of [
      Buffer.alloc(0),
      Buffer.alloc(65537, 32),
      Buffer.from([255]),
      Buffer.from([239, 187, 191, 123, 125]),
      Buffer.from('{"a":1,"a":2}'),
      Buffer.from('{"a":1,"\\u0061":2}'),
      Buffer.from("[".repeat(40) + "0" + "]".repeat(40)),
    ]) {
      const f = fixture();
      f.manifest = raw;
      f.activation.expectedManifestSha256 = createHash("sha256")
        .update(raw)
        .digest("hex");
      reject(f);
    }
    const exact = fixture();
    exact.manifest = Buffer.from("0" + " ".repeat(65535));
    exact.activation.expectedManifestSha256 = createHash("sha256")
      .update(exact.manifest)
      .digest("hex");
    expect(validateColdPinnedLiteral(exact)!.value).toBe(0);
  });
  it("copies and deeply freezes parsed data before exposing identity facts", () => {
    const f = fixture(),
      out = validateColdPinnedLiteral(f)!;
    const before = JSON.stringify(out);
    f.manifest.fill(0);
    f.config.attachments.enabled = true;
    const check = (v: unknown): void => {
      if (v && typeof v === "object") {
        expect(Object.isFrozen(v)).toBe(true);
        Object.values(v).forEach(check);
      }
    };
    check(out);
    expect(JSON.stringify(out)).toBe(before);
  });
  it("does not weaken either legacy receipt-dependent API", () => {
    const f = fixture(),
      legacy = {
        ...f,
        activation: { ...f.activation, expectedDeploymentId: "dep-later" },
      };
    for (const api of [validatePinnedLiteral, validateActivationEnvelope]) {
      expect(() => api(f as unknown as ActivationInputs)).toThrow(
        /^TEST_ADMISSION_REJECTED$/,
      );
      expect(() => api(legacy)).toThrow(/^TEST_ADMISSION_REJECTED$/);
      expect(() =>
        api({
          ...legacy,
          receipt: {
            service: "srv-dahnerh594qs73fp3420",
            branch: "dev",
            sha: SHA,
            deploymentId: "dep-other",
            observedAt: "2026-11-25T00:01:00.000Z",
          },
        }),
      ).toThrow(/^TEST_ADMISSION_REJECTED$/);
    }
  });
});
