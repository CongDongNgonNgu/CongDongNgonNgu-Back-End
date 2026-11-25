import { compileRequestCatalogue } from "./request-catalogue";
import { validateFixtureInventory } from "./fixture-inventory";
import { validateOperationDeclarations } from "./operation-declarations";
import type { ActivationEnvelope } from "./guard";

jest.mock("pg", () => {
  throw Error("catalogue must not import database runtime");
});
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const envelope: ActivationEnvelope = {
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
const body = {
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
    envelope,
  );
const charges = () => ({
  authenticatedRequests: 1,
  anonymousRequests: 0,
  ingressBytes: 0,
  authenticatedEgressBytes: 0,
  anonymousEgressBytes: 0,
  processingAttempts: 0,
});
function operation(kind = "READ", key = "policy"): Record<string, unknown> {
  const base = {
    key,
    kind,
    attachmentId: id(7),
    principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: [key + "-attempt"],
    charges: charges(),
    slotKeys: [],
  };
  if (kind === "READ")
    return {
      ...base,
      method: "GET",
      variant: "normalized",
      range: null,
      charges: { ...base.charges, authenticatedEgressBytes: 100 },
    };
  if (kind === "INITIATE") return { ...base, body };
  if (kind === "PATCH_METADATA")
    return {
      ...base,
      body: { expectedMetadataVersion: 0, caption: "hello", alt: "image" },
    };
  if (kind === "UPLOAD")
    return {
      ...base,
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "a".repeat(64),
      transmittedBytes: 100,
      case: "COMPLETE",
      charges: { ...base.charges, ingressBytes: 100 },
    };
  if (kind === "FINALIZE")
    return { ...base, charges: { ...base.charges, processingAttempts: 1 } };
  return base;
}
const compile = (value: unknown, e = envelope) =>
  compileRequestCatalogue(value, inventory(), e);

describe("pure non-authoritative request catalogue", () => {
  it.each([
    ["INITIATE", "POST", ""],
    ["METADATA", "GET", "/" + id(7)],
    ["PATCH_METADATA", "PATCH", "/" + id(7) + "/metadata"],
    ["DELETE", "DELETE", "/" + id(7)],
    ["UPLOAD", "PUT", "/" + id(7) + "/content"],
    ["FINALIZE", "POST", "/" + id(7) + "/finalize"],
  ])("derives the existing %s route", (kind, method, suffix) => {
    const result = compile([operation(kind)]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      method,
      path: "/api/v1/attachments" + suffix,
      authClass: "AUTH",
      attemptCount: 1,
    });
  });
  it.each([
    ["GET", "normalized", "content"],
    ["HEAD", "normalized", "content"],
    ["GET", "thumbnail", "preview"],
    ["HEAD", "thumbnail", "preview"],
  ])("derives %s %s reads", (method, variant, suffix) => {
    expect(
      compile([{ ...operation(), method, variant }]).groups[0],
    ).toMatchObject({
      method,
      path: "/api/v1/attachments/" + id(7) + "/" + suffix,
    });
  });
  it.each([
    "ACTOR",
    "PUBLIC_AUTHENTICATED",
    "INVALID_CREDENTIAL_NEGATIVE",
    "ANON",
  ])("maps %s to observable class without granting identity", (kind) => {
    const op = operation();
    if (kind !== "ACTOR") op.principal = { kind };
    if (kind === "INVALID_CREDENTIAL_NEGATIVE")
      op.assertion = "EXPECTED_DENIAL";
    if (kind === "ANON")
      op.charges = {
        ...charges(),
        authenticatedRequests: 0,
        anonymousRequests: 1,
        anonymousEgressBytes: 100,
      };
    const result = compile([op]);
    expect(result.groups[0].authClass).toBe(kind === "ANON" ? "ANON" : "AUTH");
    expect(result.totals).toEqual({
      authenticatedRequests: kind === "ANON" ? 0 : 1,
      anonymousRequests: kind === "ANON" ? 1 : 0,
      ingressBytes: 0,
      authenticatedEgressBytes: kind === "ANON" ? 0 : 100,
      anonymousEgressBytes: kind === "ANON" ? 100 : 0,
    });
    expect(Object.keys(result)).toEqual(["groups", "totals"]);
  });
  it("groups actors and ranges, charging every attempt at the group maximum", () => {
    const a = {
      ...operation("READ", "a"),
      range: "bytes=0-9",
      attemptKeys: ["z", "a"],
      charges: { ...charges(), authenticatedEgressBytes: 10 },
    };
    const b = {
      ...operation("READ", "b"),
      principal: { kind: "ACTOR", actorId: id(30), sessionId: id(31) },
      range: "bytes=10-19",
      charges: { ...charges(), authenticatedEgressBytes: 20 },
    };
    const result = compile([b, a]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      ingressBytes: 0,
      egressBytes: 20,
      attemptCount: 3,
      policies: [
        { operationKey: "a", attemptKeys: ["a", "z"] },
        { operationKey: "b", attemptKeys: ["b-attempt"] },
      ],
    });
    expect(result.totals.authenticatedEgressBytes).toBe(60);
  });
  it("does not split by JSON body or assertion", () => {
    const a = operation("PATCH_METADATA", "a"),
      b = {
        ...operation("PATCH_METADATA", "b"),
        assertion: "EXPECTED_DENIAL",
        body: { expectedMetadataVersion: 1, caption: "other", alt: "other" },
      };
    expect(compile([a, b]).groups[0].attemptCount).toBe(2);
  });
  it("rejects grouped maxima overflow even when per-policy totals fit", () => {
    const low = {
        ...operation("READ", "low"),
        range: "bytes=0-9",
        charges: { ...charges(), authenticatedEgressBytes: 10 },
      },
      high = {
        ...operation("READ", "high"),
        range: "bytes=10-19",
        charges: { ...charges(), authenticatedEgressBytes: 20 },
      };
    const e = {
      ...envelope,
      budgets: { ...envelope.budgets, authenticatedEgressBytes: 30 },
    };
    expect(
      validateOperationDeclarations([low, high], inventory(), e),
    ).toHaveLength(2);
    expect(() => compile([low, high], e)).toThrow("TEST_ADMISSION_CATALOGUE");
  });
  it("enforces lower request and byte ceilings", () => {
    for (const axis of [
      "authenticatedRequests",
      "authenticatedEgressBytes",
    ] as const) {
      const op = { ...operation(), attemptKeys: ["first", "second"] },
        at = {
          ...envelope,
          budgets: {
            ...envelope.budgets,
            [axis]: axis === "authenticatedRequests" ? 2 : 200,
          },
        },
        below = {
          ...at,
          budgets: { ...at.budgets, [axis]: at.budgets[axis] - 1 },
        };
      expect(compile([op], at).groups[0].attemptCount).toBe(2);
      expect(() => compile([op], below)).toThrow("TEST_ADMISSION_CATALOGUE");
    }
  });
  it("keeps auth/anonymous totals separate and excludes processing charges", () => {
    const auth = operation("READ", "auth"),
      anon = {
        ...operation("READ", "anon"),
        principal: { kind: "ANON" },
        charges: {
          ...charges(),
          authenticatedRequests: 0,
          anonymousRequests: 1,
          anonymousEgressBytes: 200,
        },
      },
      result = compile([auth, anon]);
    expect(result.groups).toHaveLength(2);
    expect(result.totals).toEqual({
      authenticatedRequests: 1,
      anonymousRequests: 1,
      ingressBytes: 0,
      authenticatedEgressBytes: 100,
      anonymousEgressBytes: 200,
    });
    expect(compile([operation("FINALIZE")]).totals).not.toHaveProperty(
      "processingAttempts",
    );
    expect(compile([operation("UPLOAD")]).totals.ingressBytes).toBe(100);
  });
  it("revalidates records and sanitizes hostile accessors", () => {
    const getter = operation();
    Object.defineProperty(getter, "key", {
      enumerable: true,
      get() {
        throw Error("private");
      },
    });
    for (const value of [
      [],
      [{}],
      [{ ...operation(), attachmentId: id(99) }],
      [{ ...operation(), path: "/api/v1/attachments" }],
      [getter],
    ])
      expect(() => compile(value)).toThrow(/^TEST_ADMISSION_CATALOGUE$/);
  });
  it("sorts groups, policies and attempts independently of input order", () => {
    const read = { ...operation("READ", "z"), attemptKeys: ["z_", "z-", "z."] },
      other = { ...operation("READ", "a"), range: "bytes=1-9" },
      upload = operation("UPLOAD", "upload"),
      metadata = operation("METADATA", "metadata");
    const first = compile([upload, read, metadata, other]),
      second = compile([
        other,
        metadata,
        { ...read, attemptKeys: ["z.", "z_", "z-"] },
        upload,
      ]);
    expect(first).toEqual(second);
    const names = first.groups.map(
      (g) => g.method + " " + g.path + " " + g.authClass,
    );
    expect(names).toEqual([...names].sort());
    expect(
      first.groups.find(
        (g) => g.path.endsWith("/content") && g.method === "GET",
      )!.policies,
    ).toEqual([
      { operationKey: "a", attemptKeys: ["a-attempt"] },
      { operationKey: "z", attemptKeys: ["z-", "z.", "z_"] },
    ]);
  });
  it("returns deeply frozen detached facts without ledger authority or database imports", () => {
    const op = operation(),
      result = compile([op]);
    (op.attemptKeys as string[])[0] = "changed";
    (op.charges as ReturnType<typeof charges>).authenticatedEgressBytes = 999;
    expect(result.groups[0].policies[0].attemptKeys).toEqual([
      "policy-attempt",
    ]);
    expect(result.totals.authenticatedEgressBytes).toBe(100);
    for (const value of [
      result,
      result.groups,
      result.groups[0],
      result.groups[0].policies,
      result.groups[0].policies[0],
      result.groups[0].policies[0].attemptKeys,
      result.totals,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(result).not.toHaveProperty("bindings");
    expect(result).not.toHaveProperty("requests");
  });
});
