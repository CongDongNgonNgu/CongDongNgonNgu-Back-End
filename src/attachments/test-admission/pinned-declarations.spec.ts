import { createHash } from "node:crypto";
import { validatePinnedDeclarations } from "./pinned-declarations";
import { validateActivationEnvelope, type ActivationInputs } from "./guard";

jest.mock("pg", () => {
  throw Error("declarations must not import database runtime");
});
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const SHA = "a".repeat(40),
  DEP = "dep-synthetic-declarations";
const charges = () => ({
  authenticatedRequests: 1,
  anonymousRequests: 0,
  ingressBytes: 0,
  authenticatedEgressBytes: 0,
  anonymousEgressBytes: 0,
  processingAttempts: 0,
});
function root() {
  const envelope = {
    schema: 1,
    runId: id(1),
    activationId: id(2),
    notBefore: "2026-11-25T00:00:00.000Z",
    expiresAt: "2026-11-25T00:10:00.000Z",
    budgets: {
      durationMs: 600000,
      attachments: 4,
      videos: 1,
      declaredBytes: 16777216,
      authenticatedRequests: 120,
      anonymousRequests: 20,
      ingressBytes: 33554432,
      authenticatedEgressBytes: 67108864,
      anonymousEgressBytes: 16777216,
      processingAttempts: 4,
      processingConcurrency: 1,
    },
  };
  const initiation = {
    clientUploadId: id(5),
    scope: {
      kind: "COMMUNITY",
      postType: "DISCUSSION",
      languageId: id(6),
      visibility: "PUBLIC",
    },
    filename: "a.jpg",
    mime: "image/jpeg",
    bytes: 100,
  };
  const inventory = {
    actors: [{ id: id(3), sessionIds: [id(4)] }],
    attachments: [
      {
        id: id(7),
        ownerId: id(3),
        generation: null,
        parent: { kind: "COMMUNITY", postId: id(8) },
        initiation,
        sourceSha256: "b".repeat(64),
      },
    ],
  };
  const principal = { kind: "ACTOR", actorId: id(3), sessionId: id(4) };
  const operation = (kind: string, key: string): Record<string, unknown> => ({
    kind,
    key,
    attachmentId: id(7),
    principal: { ...principal },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: [key + "-attempt"],
    charges: charges(),
    slotKeys: [] as string[],
  });
  const operations = [
    { ...operation("INITIATE", "init"), body: initiation },
    {
      ...operation("UPLOAD", "upload"),
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "b".repeat(64),
      transmittedBytes: 100,
      case: "COMPLETE",
      charges: { ...charges(), ingressBytes: 100 },
    },
    {
      ...operation("FINALIZE", "finalize"),
      charges: { ...charges(), processingAttempts: 1 },
    },
  ] as Record<string, unknown>[];
  const allocationSlots: {
      key: string;
      operationKey: string;
      role: string;
      id: string;
      attachmentId: string;
    }[] = [],
    objectIdentities: {
      attachmentId: string;
      variant: string;
      objectId: string;
      attemptId: string;
      putClaimId: string;
      supervisionId: string;
      operationKey: string;
    }[] = [];
  let next = 100;
  const add = (role: string, operationKey: string, fixed?: string) => {
    const identity = fixed ?? id(next++),
      key = "slot-" + identity.slice(0, 8);
    allocationSlots.push({
      key,
      operationKey,
      role,
      id: identity,
      attachmentId: id(7),
    });
    (operations.find((o) => o.key === operationKey)!.slotKeys as string[]).push(
      key,
    );
    return identity;
  };
  add("ATTACHMENT", "init", id(7));
  const sourceAttempt = add("SOURCE_ATTEMPT", "upload"),
    derivativeAttempt = add("DERIVATIVE_ATTEMPT", "finalize");
  for (const variant of ["source", "normalized", "thumbnail"]) {
    const key = variant === "source" ? "upload" : "finalize";
    objectIdentities.push({
      attachmentId: id(7),
      variant,
      operationKey: key,
      attemptId: variant === "source" ? sourceAttempt : derivativeAttempt,
      objectId: add(
        variant === "source"
          ? "SOURCE_OBJECT"
          : variant === "normalized"
            ? "NORMALIZED_OBJECT"
            : "THUMBNAIL_OBJECT",
        key,
      ),
      putClaimId: add("PUT_CLAIM", key),
      supervisionId: add("PUT_SUPERVISION", key),
    });
  }
  return {
    schema: 1,
    envelope,
    inventory,
    operations,
    allocationSlots,
    objectIdentities,
  };
}
function fixture(value: unknown = root()) {
  const manifest = Buffer.from(JSON.stringify(value));
  return {
    activation: {
      expectedSourceSha: SHA,
      expectedManifestSha256: createHash("sha256")
        .update(manifest)
        .digest("hex"),
      expectedDeploymentId: DEP,
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
    receipt: {
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      sha: SHA,
      deploymentId: DEP,
      observedAt: "2026-11-25T00:01:00.000Z",
    },
    nowMs: Date.parse("2026-11-25T00:02:00.000Z"),
  };
}
const reject = (options: ActivationInputs) =>
  expect(() => validatePinnedDeclarations(options)).toThrow(
    /^TEST_ADMISSION_DECLARATIONS$/,
  );
describe("pinned complete successful declaration composition only", () => {
  it("stays cold without observing any other option or database runtime", () => {
    const options = new Proxy(
      { activation: undefined },
      {
        get(target, key) {
          if (key === "activation") return target.activation;
          throw Error("private option");
        },
      },
    );
    expect(validatePinnedDeclarations()).toBeNull();
    expect(validatePinnedDeclarations(options as ActivationInputs)).toBeNull();
  });
  it("validates all sections from one full literal while preserving the external pin", () => {
    const r = root(),
      f = fixture(r),
      out = validatePinnedDeclarations(f) as {
        manifestSha256: string;
        sourceSha: string;
        deploymentId: string;
        envelope: unknown;
        inventory: unknown;
        operations: readonly unknown[];
        allocations: { slots: readonly unknown[] };
        objectIdentities: readonly unknown[];
        catalogue: { groups: readonly unknown[] };
      };
    expect(out.manifestSha256).toBe(f.activation.expectedManifestSha256);
    expect(out.manifestSha256).not.toBe(
      createHash("sha256").update(JSON.stringify(r.envelope)).digest("hex"),
    );
    expect(out.sourceSha).toBe(SHA);
    expect(out.deploymentId).toBe(DEP);
    expect(out.operations).toHaveLength(3);
    expect(out.allocations.slots).toHaveLength(r.allocationSlots.length);
    expect(out.objectIdentities).toHaveLength(3);
    expect(out.catalogue.groups).toHaveLength(3);
    expect(Object.keys(out).sort()).toEqual([
      "allocations",
      "catalogue",
      "deploymentId",
      "envelope",
      "inventory",
      "manifestSha256",
      "objectIdentities",
      "operations",
      "sourceSha",
    ]);
  });
  it("rejects wrong full hashes and mutated literal bytes", () => {
    const f = fixture();
    f.activation.expectedManifestSha256 = createHash("sha256")
      .update(JSON.stringify(root().envelope))
      .digest("hex");
    reject(f);
    const changed = fixture();
    changed.manifest[0] ^= 1;
    reject(changed);
  });
  it("requires the existing fresh default-off TEST identity prerequisites", () => {
    for (const field of ["platform", "arch"] as const) {
      const f = fixture();
      f[field] = "foreign";
      reject(f);
    }
    for (const patch of [
      { NODE_ENV: "production" },
      { RENDER_GIT_BRANCH: "main" },
      { ATTACHMENTS_IMAGE_ENABLED: "true" },
      { NODE_OPTIONS: "--inspect" },
    ]) {
      const f = fixture();
      Object.assign(f.env, patch);
      reject(f);
    }
    const f = fixture();
    f.receipt.observedAt = "2026-11-24T23:56:00.000Z";
    reject(f);
    const bad = fixture();
    bad.receipt.deploymentId = "dep-other";
    reject(bad);
    const expired = fixture();
    expired.nowMs = Date.parse(root().envelope.expiresAt);
    expired.receipt.observedAt = root().envelope.expiresAt;
    reject(expired);
  });
  it("rejects missing/unknown root sections, versions and envelope-only literals", () => {
    for (const key of Object.keys(root())) {
      const value: Record<string, unknown> = { ...root() };
      delete value[key];
      reject(fixture(value));
    }
    reject(fixture({ ...root(), schema: 2 }));
    for (const key of [
      "requests",
      "bindings",
      "references",
      "sourceSha",
      "manifestSha256",
      "extra",
    ])
      reject(fixture({ ...root(), [key]: [] }));
    reject(fixture(root().envelope));
  });
  it("checks every nested section even with a newly correct external hash", () => {
    const changes: ((r: ReturnType<typeof root>) => void)[] = [
      (r) => {
        r.envelope.budgets.authenticatedRequests = 0;
      },
      (r) => {
        r.inventory.attachments[0].ownerId = id(99);
      },
      (r) => {
        r.operations[0].attachmentId = id(99);
      },
      (r) => {
        r.allocationSlots[0].operationKey = "invented";
      },
      (r) => {
        r.objectIdentities[0].objectId = id(999);
      },
    ];
    for (const change of changes) {
      const r = root();
      change(r);
      reject(fixture(r));
    }
  });
  it("rejects duplicate decoded keys across the full literal before composition", () => {
    for (const manifest of [
      Buffer.from('{"schema":1,"schema":1}'),
      Buffer.from(
        JSON.stringify(root()).replace(
          '"schema":1',
          '"schema":1,"sch\\u0065ma":1',
        ),
      ),
    ]) {
      const f = fixture();
      f.manifest = manifest;
      f.activation.expectedManifestSha256 = createHash("sha256")
        .update(manifest)
        .digest("hex");
      reject(f);
    }
  });
  it("requires object identities and attachment allocations to use the declared operation kinds", () => {
    for (const key of ["upload", "finalize", "init"]) {
      const r = root(),
        op = r.operations.find((o) => o.key === key)!;
      op.kind = "METADATA";
      delete op.body;
      delete op.contentType;
      delete op.contentLength;
      delete op.inputSha256;
      delete op.transmittedBytes;
      delete op.case;
      op.charges = charges();
      reject(fixture(r));
    }
  });
  it("checks same-attachment operation links independently of declared slot names", () => {
    const r = root();
    r.objectIdentities[0].attachmentId = id(99);
    reject(fixture(r));
    const q = root();
    q.allocationSlots[0].attachmentId = id(99);
    reject(fixture(q));
  });
  it("rejects grouped ceiling inflation although individual policy totals fit", () => {
    const r = root(),
      a = {
        kind: "READ",
        key: "read-a",
        attachmentId: id(7),
        principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
        assertion: "NORMAL_AUTHORIZATION",
        attemptKeys: ["read-a-attempt"],
        charges: { ...charges(), authenticatedEgressBytes: 10 },
        slotKeys: [],
        method: "GET",
        variant: "normalized",
        range: "bytes=0-9",
      },
      b = {
        ...a,
        key: "read-b",
        attemptKeys: ["read-b-attempt"],
        range: "bytes=10-19",
        charges: { ...charges(), authenticatedEgressBytes: 20 },
      };
    r.operations.push(a, b);
    r.envelope.budgets.authenticatedEgressBytes = 30;
    reject(fixture(r));
  });
  it("returns deeply frozen detached facts without raw literals or ledger authority", () => {
    const r = root(),
      f = fixture(r),
      out = validatePinnedDeclarations(f)!;
    const check = (value: unknown): void => {
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(check);
      }
    };
    check(out);
    const before = JSON.stringify(out);
    f.manifest.fill(0);
    r.inventory.actors[0].sessionIds[0] = id(999);
    r.operations[0].key = "changed";
    expect(JSON.stringify(out)).toBe(before);
    for (const key of [
      "value",
      "raw",
      "requests",
      "bindings",
      "active",
      "receipt",
      "preparedRun",
    ])
      expect(out).not.toHaveProperty(key);
  });
  it("preserves the legacy envelope-only guard contract", () => {
    const f = fixture(root().envelope);
    expect(validateActivationEnvelope(f)?.envelope).toEqual(root().envelope);
    expect(() => validateActivationEnvelope(fixture())).toThrow(
      "TEST_ADMISSION_REJECTED",
    );
    reject(f);
  });
  it("normalizes all malformed inputs and hostile activation errors", () => {
    reject({ activation: {} as never });
    reject({
      get activation(): never {
        throw Error("private activation");
      },
    });
    reject(fixture(null));
    reject(fixture([]));
    reject(fixture({ ...root(), inventory: null }));
  });
});
