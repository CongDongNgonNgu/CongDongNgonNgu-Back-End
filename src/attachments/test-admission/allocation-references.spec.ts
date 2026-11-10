import { validateAllocationReferences } from "./allocation-references";
import { validateFixtureInventory } from "./fixture-inventory";
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
const inventory = () =>
  validateFixtureInventory(
    {
      actors: [{ id: id(3), sessionIds: [id(4)] }],
      attachments: [
        {
          id: id(7),
          ownerId: id(3),
          generation: id(9),
          parent: { kind: "STUDY_GROUP", groupId: id(6), textId: id(8) },
          initiation: {
            clientUploadId: id(5),
            scope: { kind: "STUDY_GROUP", groupId: id(6) },
            filename: "a.jpg",
            mime: "image/jpeg",
            bytes: 100,
          },
          sourceSha256: "a".repeat(64),
        },
      ],
    },
    envelope,
  );
const fixture = () => ({
  slots: [
    {
      key: "z",
      operationKey: "attempt-a",
      role: "UPLOAD_OWNER",
      id: id(10),
      attachmentId: id(7),
    },
    {
      key: "a",
      operationKey: "attempt-a",
      role: "ATTACHMENT",
      id: id(7),
      attachmentId: id(7),
    },
  ],
  refs: [
    { operationKey: "attempt-a", attachmentId: id(7), slotKeys: ["z", "a"] },
  ],
});
const reject = (slots: unknown, refs: unknown) =>
  expect(() =>
    validateAllocationReferences(slots, inventory(), envelope, refs),
  ).toThrow("TEST_ADMISSION_ALLOCATION_REFERENCES");
describe("pure allocation reference integrity not completeness", () => {
  it("sorts by binary ASCII and deeply detaches/freeze data", () => {
    const f = fixture();
    const r = validateAllocationReferences(
      f.slots,
      inventory(),
      envelope,
      f.refs,
    );
    expect(r.slots.map((s: { key: string }) => s.key)).toEqual(["a", "z"]);
    expect(r.references[0].slotKeys).toEqual(["a", "z"]);
    expect(Object.isFrozen(r.references[0].slotKeys)).toBe(true);
    expect(Object.isFrozen(r.slots[0])).toBe(true);
    f.slots[0].id = id(99);
    f.refs[0].slotKeys[0] = "other";
    expect(r.slots[1].id).toBe(id(10));
    expect(Object.keys(r).sort()).toEqual(["references", "slots"]);
  });
  it("rejects missing unused shared and mismatched slot edges", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => f.refs[0].slotKeys.pop(),
      (f: ReturnType<typeof fixture>) => f.refs[0].slotKeys.push("missing"),
      (f: ReturnType<typeof fixture>) => f.refs[0].slotKeys.push("a"),
      (f: ReturnType<typeof fixture>) => (f.slots[0].operationKey = "unknown"),
      (f: ReturnType<typeof fixture>) => (f.slots[0].attachmentId = id(99)),
      (f: ReturnType<typeof fixture>) =>
        f.refs.push({ ...f.refs[0], operationKey: "other" }),
    ]) {
      const f = fixture();
      mutate(f);
      reject(f.slots, f.refs);
    }
  });
  it("requires one exact ATTACHMENT slot and forbids all other owned/foreign collisions", () => {
    for (const role of ["UPLOAD_OWNER", "CLEANUP_JOB", "PUT_SUPERVISION"])
      for (const collision of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const f = fixture();
        Object.assign(f.slots[0], { role, id: id(collision) });
        reject(f.slots, f.refs);
      }
    const f = fixture();
    f.slots[1].id = id(11);
    reject(f.slots, f.refs);
    f.slots[1].id = id(7);
    f.slots[0].role = "ATTACHMENT";
    reject(f.slots, f.refs);
  });
  it("rejects duplicate UUIDs keys operations and invalid roles or noncanonical keys", () => {
    for (const change of [
      { id: id(7) },
      { role: "UNKNOWN" },
      { key: "../x" },
      { id: "AAAAAAAA-1111-4111-8111-111111111111" },
    ]) {
      const f = fixture();
      Object.assign(f.slots[0], change);
      reject(f.slots, f.refs);
    }
    const f = fixture();
    f.slots[0].key = "a";
    reject(f.slots, f.refs);
    const g = fixture();
    g.refs.push({ ...g.refs[0], slotKeys: [] });
    reject(g.slots, g.refs);
  });
  it("rejects unknown fields accessors sparse arrays and excessive counts without invoking getters", () => {
    const f = fixture();
    reject([{ ...f.slots[0], secret: "private" }, f.slots[1]], f.refs);
    const accessor = fixture();
    Object.defineProperty(accessor.refs[0], "operationKey", {
      get() {
        throw Error("private");
      },
      enumerable: true,
    });
    reject(accessor.slots, accessor.refs);
    const holes = fixture();
    delete holes.slots[0];
    reject(holes.slots, holes.refs);
    reject(f.slots, Array(257).fill(f.refs[0]));
    reject(Array(257).fill(f.slots[0]), f.refs);
  });
  it("permits empty-slot reference declarations without asserting runtime branch completeness", () => {
    const f = fixture();
    f.refs.push({
      operationKey: "status-only",
      attachmentId: id(7),
      slotKeys: [],
    });
    const r = validateAllocationReferences(
      f.slots,
      inventory(),
      envelope,
      f.refs,
    );
    expect(r.references).toHaveLength(2);
  });
});

it("accepts exact256 distinct slots and references but rejects the257th", () => {
  const slots = Array.from({ length: 256 }, (_, i) => ({
    key: "slot-" + String(i).padStart(3, "0"),
    operationKey: "attempt-" + String(i).padStart(3, "0"),
    role: i === 0 ? "ATTACHMENT" : "CLEANUP_JOB",
    id: i === 0 ? id(7) : id(1000 + i),
    attachmentId: id(7),
  }));
  const refs = slots.map((s) => ({
    operationKey: s.operationKey,
    attachmentId: s.attachmentId,
    slotKeys: [s.key],
  }));
  expect(
    validateAllocationReferences(slots, inventory(), envelope, refs).slots,
  ).toHaveLength(256);
  reject([...slots, { ...slots[1], key: "extra", id: id(2000) }], refs);
  reject(slots, [
    ...refs,
    { operationKey: "extra", attachmentId: id(7), slotKeys: [] },
  ]);
});
it("blocks normalized Community and DM foreign references in addition to group generation", () => {
  for (const kind of ["COMMUNITY", "DIRECT_MESSAGE"]) {
    const base = inventory(),
      a = JSON.parse(JSON.stringify(base.attachments[0]));
    if (kind === "COMMUNITY") {
      a.generation = null;
      a.initiation.intent = {
        kind,
        postType: "DISCUSSION",
        languageId: id(30),
        visibility: "PUBLIC",
      };
      a.parent = { kind, postId: id(31) };
    } else {
      a.initiation.intent = { kind, conversationId: id(30) };
      a.parent = { kind, conversationId: id(30), messageId: id(31) };
    }
    const inv = { actors: base.actors, attachments: [a] };
    for (const n of [30, 31]) {
      const f = fixture();
      f.slots[0].id = id(n);
      expect(() =>
        validateAllocationReferences(f.slots, inv, envelope, f.refs),
      ).toThrow("TEST_ADMISSION_ALLOCATION_REFERENCES");
    }
  }
});
