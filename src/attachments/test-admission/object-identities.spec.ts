import { validateObjectIdentities } from "./object-identities";
import { validateFixtureInventory } from "./fixture-inventory";
import { validateAllocationReferences } from "./allocation-references";
import type { ActivationEnvelope } from "./guard";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const envelope: ActivationEnvelope = {
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
function fixture(count = 1, text = false) {
  const inventory = validateFixtureInventory(
    {
      actors: [{ id: id(3), sessionIds: [id(4)] }],
      attachments: Array.from({ length: count }, (_, i) => ({
        id: id(10 + i),
        ownerId: id(3),
        generation: null,
        parent: null,
        sourceSha256: "a".repeat(64),
        initiation: {
          clientUploadId: id(20 + i),
          scope: {
            kind: "COMMUNITY",
            postType: "DISCUSSION",
            languageId: id(30),
            visibility: "PUBLIC",
          },
          filename: text ? "a.txt" : "a.jpg",
          mime: text ? "text/plain" : "image/jpeg",
          bytes: 100,
        },
      })),
    },
    envelope,
  );
  const slots: {
      key: string;
      operationKey: string;
      role: string;
      id: string;
      attachmentId: string;
    }[] = [],
    refs: { operationKey: string; attachmentId: string; slotKeys: string[] }[] =
      [],
    tuples: {
      attachmentId: string;
      variant: string;
      objectId: string;
      attemptId: string;
      putClaimId: string;
      supervisionId: string;
      operationKey: string;
    }[] = [];
  let next = 100;
  const add = (
    role: string,
    attachmentId: string,
    operationKey: string,
    fixed?: string,
  ) => {
    const identity = fixed ?? id(next++),
      key = "slot-" + identity.slice(0, 8);
    slots.push({ key, role, id: identity, attachmentId, operationKey });
    let ref = refs.find((r) => r.operationKey === operationKey);
    if (!ref) {
      ref = { operationKey, attachmentId, slotKeys: [] };
      refs.push(ref);
    }
    ref.slotKeys.push(key);
    return identity;
  };
  for (const a of inventory.attachments) {
    const source = "source-" + a.id,
      deriv = "deriv-" + a.id;
    add("ATTACHMENT", a.id, "init-" + a.id, a.id);
    const sourceAttempt = add("SOURCE_ATTEMPT", a.id, source),
      derivativeAttempt = add("DERIVATIVE_ATTEMPT", a.id, deriv);
    for (const variant of text
      ? ["source", "normalized"]
      : ["source", "normalized", "thumbnail"]) {
      const op = variant === "source" ? source : deriv;
      tuples.push({
        attachmentId: a.id,
        variant,
        operationKey: op,
        attemptId: variant === "source" ? sourceAttempt : derivativeAttempt,
        objectId: add(
          variant === "source"
            ? "SOURCE_OBJECT"
            : variant === "normalized"
              ? "NORMALIZED_OBJECT"
              : "THUMBNAIL_OBJECT",
          a.id,
          op,
        ),
        putClaimId: add("PUT_CLAIM", a.id, op),
        supervisionId: add("PUT_SUPERVISION", a.id, op),
      });
    }
  }
  return {
    inventory,
    slots,
    refs,
    tuples,
    graph: () => validateAllocationReferences(slots, inventory, envelope, refs),
  };
}
const reject = (f: ReturnType<typeof fixture>) =>
  expect(() =>
    validateObjectIdentities(f.tuples, f.inventory, f.graph()),
  ).toThrow("TEST_ADMISSION_OBJECT_IDENTITIES");
describe("complete planned object identity relationships only", () => {
  it("validates complete IMAGE and TEXT coverage and deeply detaches output", () => {
    const f = fixture();
    const r = validateObjectIdentities(
      [...f.tuples].reverse(),
      f.inventory,
      f.graph(),
    );
    expect(r.map((t: { variant: string }) => t.variant)).toEqual([
      "normalized",
      "source",
      "thumbnail",
    ]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r[0])).toBe(true);
    f.tuples[0].objectId = id(999);
    expect(r[1].objectId).not.toBe(id(999));
    const text = fixture(1, true);
    expect(
      validateObjectIdentities(text.tuples, text.inventory, text.graph()),
    ).toHaveLength(2);
  });
  it("rejects swapped claims cross-operation relations and incorrect slot roles", () => {
    for (const field of [
      "putClaimId",
      "supervisionId",
      "objectId",
      "attemptId",
    ] as const) {
      const f = fixture();
      [f.tuples[0][field], f.tuples[1][field]] = [
        f.tuples[1][field],
        f.tuples[0][field],
      ];
      reject(f);
    }
    const f = fixture();
    f.tuples[0].operationKey = f.tuples[1].operationKey;
    reject(f);
  });
  it("rejects missing tuples duplicate variants and unreferenced graph identities", () => {
    const f = fixture();
    f.tuples.pop();
    reject(f);
    const duplicate = fixture();
    duplicate.tuples[2].variant = "normalized";
    reject(duplicate);
    const unused = fixture();
    const op = unused.refs[0];
    unused.slots.push({
      key: "unused",
      operationKey: op.operationKey,
      attachmentId: op.attachmentId,
      role: "PUT_CLAIM",
      id: id(900),
    });
    op.slotKeys.push("unused");
    reject(unused);
  });
  it("requires normalized and thumbnail to share one derivative attempt and operation", () => {
    const f = fixture();
    const thumb = f.tuples[2],
      ref = f.refs.find((r) => r.operationKey === thumb.operationKey)!;
    f.slots.push({
      key: "another-attempt",
      role: "DERIVATIVE_ATTEMPT",
      id: id(900),
      attachmentId: thumb.attachmentId,
      operationKey: thumb.operationKey,
    });
    ref.slotKeys.push("another-attempt");
    thumb.attemptId = id(900);
    reject(f);
  });
  it("rejects cross-fixture reuse and non-image thumbnail declarations", () => {
    const f = fixture(2);
    f.tuples[3].putClaimId = f.tuples[0].putClaimId;
    reject(f);
    const text = fixture(1, true);
    text.tuples.push({ ...text.tuples[1], variant: "thumbnail" });
    reject(text);
  });
  it("accepts exactly12 tuples for4files and rejects13, holes unknown fields and accessors", () => {
    const f = fixture(4);
    expect(
      validateObjectIdentities(f.tuples, f.inventory, f.graph()),
    ).toHaveLength(12);
    f.tuples.push({ ...f.tuples[0] });
    reject(f);
    const hole = fixture();
    delete hole.tuples[0];
    reject(hole);
    const unknown = fixture();
    Object.assign(unknown.tuples[0], { private: "value" });
    reject(unknown);
    const getter = fixture();
    Object.defineProperty(getter.tuples[0], "objectId", {
      get() {
        throw Error("private");
      },
      enumerable: true,
    });
    reject(getter);
  });
});

it("accepts VIDEO thumbnail coverage and rejects each unused relevant allocation role", () => {
  const video = fixture();
  const inv = JSON.parse(JSON.stringify(video.inventory));
  inv.attachments[0].initiation.format = "VIDEO";
  expect(
    validateObjectIdentities(video.tuples, inv, video.graph()),
  ).toHaveLength(3);
  for (const role of [
    "SOURCE_OBJECT",
    "SOURCE_ATTEMPT",
    "NORMALIZED_OBJECT",
    "THUMBNAIL_OBJECT",
    "DERIVATIVE_ATTEMPT",
    "PUT_CLAIM",
    "PUT_SUPERVISION",
  ]) {
    const f = fixture();
    const ref = f.refs[0];
    f.slots.push({
      key: "unused-role",
      operationKey: ref.operationKey,
      attachmentId: ref.attachmentId,
      role,
      id: id(901),
    });
    ref.slotKeys.push("unused-role");
    reject(f);
  }
  const other = fixture();
  const ref = other.refs[0];
  other.slots.push({
    key: "cleanup-candidate",
    operationKey: ref.operationKey,
    attachmentId: ref.attachmentId,
    role: "CLEANUP_JOB",
    id: id(902),
  });
  ref.slotKeys.push("cleanup-candidate");
  expect(
    validateObjectIdentities(other.tuples, other.inventory, other.graph()),
  ).toHaveLength(3);
});
it("rejects wrong variant roles, unlisted fixtures, noncanonical IDs and extended arrays", () => {
  for (const change of [
    { variant: "other" },
    { attachmentId: id(999) },
    { putClaimId: "AAAAAAAA-1111-4111-8111-111111111111" },
    { operationKey: "../private" },
  ]) {
    const f = fixture();
    Object.assign(f.tuples[0], change);
    reject(f);
  }
  const wrong = fixture();
  wrong.tuples[0].variant = "normalized";
  reject(wrong);
  const extra = fixture();
  Object.assign(extra.tuples, { unreviewed: true });
  reject(extra);
});
