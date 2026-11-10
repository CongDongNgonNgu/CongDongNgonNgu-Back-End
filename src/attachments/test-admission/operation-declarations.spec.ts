import { validateOperationDeclarations } from "./operation-declarations";
import { validateFixtureInventory } from "./fixture-inventory";
import type { ActivationEnvelope } from "./guard";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const env: ActivationEnvelope = {
  schema: 1,
  runId: id(1),
  activationId: id(2),
  notBefore: "2026-11-10T00:00:00.000Z",
  expiresAt: "2026-11-10T00:10:00.000Z",
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
const body = {
  clientUploadId: id(5),
  scope: {
    kind: "COMMUNITY",
    postType: "DISCUSSION",
    languageId: id(6),
    visibility: "PUBLIC",
  },
  filename: " a.jpg ",
  mime: "image/jpeg",
  bytes: 100,
};
const inventory = () =>
  validateFixtureInventory(
    {
      actors: [
        { id: id(3), sessionIds: [id(4)] },
        { id: id(30), sessionIds: [id(31)] },
      ],
      attachments: [
        {
          id: id(7),
          ownerId: id(3),
          generation: null,
          parent: { kind: "COMMUNITY", postId: id(8) },
          initiation: body,
          sourceSha256: "a".repeat(64),
        },
      ],
    },
    env,
  );
const op = () => ({
  key: "read-policy",
  kind: "READ",
  attachmentId: id(7),
  principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
  assertion: "NORMAL_AUTHORIZATION",
  attemptKeys: ["attempt-1"],
  charges: {
    authenticatedRequests: 1,
    anonymousRequests: 0,
    ingressBytes: 0,
    authenticatedEgressBytes: 100,
    anonymousEgressBytes: 0,
    processingAttempts: 0,
  },
  slotKeys: [],
  method: "HEAD",
  variant: "normalized",
  range: null,
});
const reject = (v: unknown, e = env) =>
  expect(() => validateOperationDeclarations(v, inventory(), e)).toThrow(
    "TEST_ADMISSION_OPERATIONS",
  );
describe("pure operation declarations not execution authority", () => {
  it("keeps finite retries in one immutable policy with charges per attempt", () => {
    const o = op();
    o.attemptKeys.push("attempt-2");
    const r = validateOperationDeclarations([o], inventory(), env);
    expect(r[0].attemptKeys).toEqual(["attempt-1", "attempt-2"]);
    expect(Object.isFrozen(r[0].charges)).toBe(true);
    o.attemptKeys[0] = "changed";
    expect(r[0].attemptKeys[0]).toBe("attempt-1");
  });
  it("rejects mismatched session pairs and foreign resource references", () => {
    const o = op();
    o.principal.sessionId = id(31);
    reject([o]);
    o.principal.sessionId = id(4);
    o.attachmentId = id(99);
    reject([o]);
  });
  it("limits anonymous positives to bound public derivatives while allowing denial tests", () => {
    const o = op();
    Object.assign(o, {
      principal: { kind: "ANON" },
      charges: {
        ...o.charges,
        authenticatedRequests: 0,
        authenticatedEgressBytes: 0,
        anonymousRequests: 1,
        anonymousEgressBytes: 100,
      },
    });
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
    Object.assign(o, { kind: "METADATA" });
    delete (o as Partial<typeof o>).method;
    delete (o as Partial<typeof o>).variant;
    delete (o as Partial<typeof o>).range;
    reject([o]);
    const privateInv = inventory();
    const draft = JSON.parse(JSON.stringify(privateInv));
    draft.attachments[0].parent = null;
    const read = op();
    Object.assign(read, {
      principal: { kind: "ANON" },
      charges: { ...o.charges },
    });
    expect(() => validateOperationDeclarations([read], draft, env)).toThrow();
    read.assertion = "EXPECTED_DENIAL";
    expect(validateOperationDeclarations([read], draft, env)).toHaveLength(1);
  });
  it("invalid credentials can only assert denial and cannot select different input policy", () => {
    const o = op();
    Object.assign(o, { principal: { kind: "INVALID_CREDENTIAL_NEGATIVE" } });
    reject([o]);
    o.assertion = "EXPECTED_DENIAL";
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
  });
  it("normalizes initiation and patch body via existing domain parsers", () => {
    const common = op();
    const { method, variant, range, ...o } = common;
    Object.assign(o, {
      kind: "INITIATE",
      body: { ...body },
      charges: { ...common.charges, authenticatedEgressBytes: 0 },
    });
    const r = validateOperationDeclarations([o], inventory(), env);
    expect((r[0] as { body: { filename: string } }).body.filename).toBe(
      "a.jpg",
    );
    Object.assign(o, {
      kind: "PATCH_METADATA",
      body: { expectedMetadataVersion: 0, caption: "  text  ", alt: " alt " },
    });
    expect(
      (
        validateOperationDeclarations([o], inventory(), env)[0] as {
          body: { caption: string };
        }
      ).body.caption,
    ).toBe("text");
  });
  it("validates complete source declarations and bounded interrupted negatives without processing claims", () => {
    const { method, variant, range, ...o } = op();
    Object.assign(o, {
      kind: "UPLOAD",
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "a".repeat(64),
      transmittedBytes: 100,
      case: "COMPLETE",
      charges: { ...o.charges, authenticatedEgressBytes: 0, ingressBytes: 100 },
    });
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
    Object.assign(o, { inputSha256: "b".repeat(64) });
    reject([o]);
    Object.assign(o, {
      case: "INTERRUPTED",
      assertion: "EXPECTED_DENIAL",
      transmittedBytes: 50,
      inputSha256: "a".repeat(64),
    });
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
  });
  it("enforces per-attempt charge axes and aggregate lower envelope ceilings", () => {
    const o = op();
    o.attemptKeys = ["one", "two"];
    reject([o], {
      ...env,
      budgets: { ...env.budgets, authenticatedRequests: 1 },
    });
    o.charges.authenticatedRequests = 0;
    reject([o]);
    o.charges.authenticatedRequests = 1;
    o.charges.processingAttempts = 1;
    reject([o]);
    o.charges.processingAttempts = 0;
    o.charges.ingressBytes = 1;
    reject([o]);
    o.charges.ingressBytes = 0;
    o.charges.authenticatedEgressBytes = 0;
    reject([o]);
  });
  it("rejects duplicate signatures, shared attempt keys, unknown fields and accessor arrays", () => {
    const a = op(),
      b = { ...op(), key: "other", attemptKeys: ["other-attempt"] };
    reject([a, b]);
    const different = { ...b, method: "GET", attemptKeys: ["attempt-1"] };
    reject([a, different]);
    reject([{ ...op(), credentials: "private" }]);
    const getter = op();
    Object.defineProperty(getter, "kind", {
      get() {
        throw Error("private");
      },
      enumerable: true,
    });
    reject([getter]);
    const holes = [op()];
    delete holes[0];
    reject(holes);
    reject([{ ...op(), range: "bytes=0-1\nprivate" }]);
  });
});

it("preserves exact ASCII Range and charges HEAD as a nonzero selected-object ceiling", () => {
  const o = op();
  o.range = "bytes=0-9" as never;
  expect(validateOperationDeclarations([o], inventory(), env)[0]).toMatchObject(
    { method: "HEAD", range: "bytes=0-9" },
  );
  o.range = "bytes=0-9\n" as never;
  reject([o]);
});
it("accepts closed bodyless operations and only FINALIZE may reserve one processing attempt", () => {
  for (const kind of ["FINALIZE", "METADATA", "DELETE"]) {
    const { method, variant, range, ...o } = op();
    Object.assign(o, {
      kind,
      charges: {
        ...o.charges,
        authenticatedEgressBytes: 0,
        processingAttempts: kind === "FINALIZE" ? 1 : 0,
      },
    });
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
    reject([{ ...o, body: {} }]);
  }
});
it("rejects claimed OVERLIMIT below real frozen format ceiling and bounds true negative ingress", () => {
  const { method, variant, range, ...o } = op();
  Object.assign(o, {
    kind: "UPLOAD",
    contentType: "image/jpeg",
    contentLength: 101,
    inputSha256: "a".repeat(64),
    transmittedBytes: 0,
    case: "OVERLIMIT",
    assertion: "EXPECTED_DENIAL",
    charges: { ...o.charges, authenticatedEgressBytes: 0, ingressBytes: 101 },
  });
  reject([o]);
  Object.assign(o, {
    contentLength: 4194305,
    charges: { ...o.charges, ingressBytes: 4194305 },
  });
  expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(1);
});
it("does not allow assertions to weaken signatures, foreign owner positives, RAW_BODY or implicit retry expansion", () => {
  const a = op(),
    b = {
      ...op(),
      key: "changed-policy",
      attemptKeys: ["other"],
      assertion: "EXPECTED_DENIAL",
      charges: { ...op().charges, authenticatedEgressBytes: 200 },
    };
  reject([a, b]);
  const { method, variant, range, ...o } = op();
  Object.assign(o, {
    kind: "INITIATE",
    principal: { kind: "ACTOR", actorId: id(30), sessionId: id(31) },
    body: { ...body },
    charges: { ...o.charges, authenticatedEgressBytes: 0 },
  });
  reject([o]);
  reject([{ ...o, kind: "RAW_BODY" }]);
  const many = op();
  many.attemptKeys = Array.from({ length: 121 }, (_, i) => "try-" + i);
  reject([many]);
});

describe("reviewed observable-policy and processing/read reservations", () => {
  it("rejects upload policies differing only in nonobservable stream outcomes", () => {
    const { method, variant, range, ...base } = op();
    const complete = {
      ...base,
      kind: "UPLOAD",
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "a".repeat(64),
      transmittedBytes: 100,
      case: "COMPLETE",
      charges: {
        ...base.charges,
        authenticatedEgressBytes: 0,
        ingressBytes: 100,
      },
    };
    const interrupted = {
      ...complete,
      key: "interrupted-policy",
      attemptKeys: ["interrupted-attempt"],
      case: "INTERRUPTED",
      transmittedBytes: 50,
      assertion: "EXPECTED_DENIAL",
    };
    reject([complete, interrupted]);
  });
  it("requires an ACTOR finalize processing reservation despite denial expectation", () => {
    const { method, variant, range, ...o } = op();
    Object.assign(o, {
      kind: "FINALIZE",
      assertion: "EXPECTED_DENIAL",
      charges: {
        ...o.charges,
        authenticatedEgressBytes: 0,
        processingAttempts: 0,
      },
    });
    reject([o]);
    o.charges.processingAttempts = 1;
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
    Object.assign(o, {
      principal: { kind: "INVALID_CREDENTIAL_NEGATIVE" },
      charges: { ...o.charges, processingAttempts: 0 },
    });
    expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
      1,
    );
  });
  it("rejects malformed positive ranges and TEXT preview while allowing declared denial probes", () => {
    for (const range of ["not-range", "bytes=9-1", "bytes=0-1,2-3"]) {
      const o = { ...op(), range };
      reject([o]);
      o.assertion = "EXPECTED_DENIAL";
      expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(
        1,
      );
    }
    const input = {
      actors: [{ id: id(3), sessionIds: [id(4)] }],
      attachments: [
        {
          id: id(7),
          ownerId: id(3),
          generation: null,
          parent: { kind: "COMMUNITY", postId: id(8) },
          initiation: { ...body, filename: "file.txt", mime: "text/plain" },
          sourceSha256: "a".repeat(64),
        },
      ],
    };
    const inv = validateFixtureInventory(input, env),
      o = { ...op(), variant: "thumbnail" };
    expect(() => validateOperationDeclarations([o], inv, env)).toThrow(
      "TEST_ADMISSION_OPERATIONS",
    );
    o.assertion = "EXPECTED_DENIAL";
    expect(validateOperationDeclarations([o], inv, env)).toHaveLength(1);
  });
});

it("rejects foreign ACTOR initiation even under expected denial because it can create another draft", () => {
  const { method, variant, range, ...o } = op();
  Object.assign(o, {
    kind: "INITIATE",
    assertion: "EXPECTED_DENIAL",
    principal: { kind: "ACTOR", actorId: id(30), sessionId: id(31) },
    body: { ...body },
    charges: { ...o.charges, authenticatedEgressBytes: 0 },
  });
  reject([o]);
  Object.assign(o, { principal: { kind: "INVALID_CREDENTIAL_NEGATIVE" } });
  expect(validateOperationDeclarations([o], inventory(), env)).toHaveLength(1);
});
