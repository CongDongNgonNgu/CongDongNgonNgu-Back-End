import { compileConservativeReadCatalogue } from "./read-ceilings";
import { validateFixtureInventory } from "./fixture-inventory";
import { validateOperationDeclarations } from "./operation-declarations";
import {
  ATTACHMENT_LIMITS as L,
  type AttachmentFormat,
} from "../attachment-policy";
import type { ActivationEnvelope } from "./guard";
jest.mock("pg", () => {
  throw Error("pure ceiling compiler must not import database runtime");
});
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
function fixture(format: AttachmentFormat = "IMAGE") {
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
  const inventory = validateFixtureInventory(
    {
      actors: [{ id: id(3), sessionIds: [id(4)] }],
      attachments: [
        {
          id: id(7),
          ownerId: id(3),
          generation: null,
          parent: { kind: "COMMUNITY", postId: id(8) },
          sourceSha256: "a".repeat(64),
          initiation: {
            clientUploadId: id(5),
            scope: {
              kind: "COMMUNITY",
              postType: "DISCUSSION",
              languageId: id(6),
              visibility: "PUBLIC",
            },
            filename:
              format === "IMAGE"
                ? "a.jpg"
                : format === "VIDEO"
                  ? "a.mp4"
                  : "a.txt",
            mime:
              format === "IMAGE"
                ? "image/jpeg"
                : format === "VIDEO"
                  ? "video/mp4"
                  : "text/plain",
            bytes: 100,
          },
        },
      ],
    },
    envelope,
  );
  const operation = (
    key = "read",
    variant = "normalized",
    egress = 4194304,
  ) => ({
    key,
    kind: "READ",
    attachmentId: id(7),
    principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: [key + "-attempt"],
    charges: {
      authenticatedRequests: 1,
      anonymousRequests: 0,
      ingressBytes: 0,
      authenticatedEgressBytes: egress,
      anonymousEgressBytes: 0,
      processingAttempts: 0,
    },
    slotKeys: [],
    method: "GET",
    variant,
    range: null as string | null,
  });
  return {
    envelope,
    inventory,
    operation,
    compile: (ops: unknown, e = envelope) =>
      compileConservativeReadCatalogue(ops, inventory, e),
  };
}
const cases: [AttachmentFormat, string, number][] = [
  ["IMAGE", "normalized", 4194304],
  ["VIDEO", "normalized", 3145728],
  ["TEXT", "normalized", 65536],
  ["IMAGE", "thumbnail", 262144],
  ["VIDEO", "thumbnail", 262144],
];
const reject = (f: ReturnType<typeof fixture>, ops: unknown) =>
  expect(() => f.compile(ops)).toThrow(/^TEST_ADMISSION_READ_CEILINGS$/);
describe("pure frozen output-cap planning, not actual object-size proof", () => {
  it("never re-observes hostile raw descriptors after validating their snapshot", () => {
    const f = fixture(),
      op = f.operation();
    let chargeReads = 0;
    const proxy = new Proxy(op, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "charges")
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: {
              ...target.charges,
              authenticatedEgressBytes: ++chargeReads <= 2 ? L.imageBytes : 1,
            },
          };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const out = f.compile([proxy]);
    expect(out.catalogue.totals.authenticatedEgressBytes).toBe(L.imageBytes);
    expect(chargeReads).toBe(2);
  });

  it.each(cases)(
    "derives %s/%s frozen output cap with exact-cap and cap-minus-one boundaries",
    (format, variant, cap) => {
      const f = fixture(format),
        op = f.operation("read", variant, cap),
        out = f.compile([op]) as {
          reads: readonly unknown[];
          catalogue: { totals: { authenticatedEgressBytes: number } };
        };
      expect(out.reads).toEqual([
        {
          opKey: "read",
          attachmentId: id(7),
          method: "GET",
          variant,
          format,
          outputCap: cap,
        },
      ]);
      expect(out.catalogue.totals.authenticatedEgressBytes).toBe(cap);
      op.charges.authenticatedEgressBytes = cap - 1;
      reject(f, [op]);
    },
  );
  it("uses derivative caps despite tiny declared sources and never rewrites charges", () => {
    const f = fixture(),
      op = f.operation("read", "normalized", L.imageBytes);
    const before = JSON.stringify(op);
    expect(f.inventory.attachments[0].initiation.bytes).toBe(100);
    expect(f.compile([op])).toMatchObject({
      reads: [{ outputCap: L.imageBytes }],
    });
    expect(JSON.stringify(op)).toBe(before);
    op.charges.authenticatedEgressBytes = 100;
    reject(f, [op]);
  });
  it.each(["GET", "HEAD"])(
    "requires full-cap %s reservations even with a one-byte range",
    (method) => {
      const f = fixture(),
        op = { ...f.operation(), method, range: "bytes=0-0" };
      op.charges.authenticatedEgressBytes = 1;
      reject(f, [op]);
      op.charges.authenticatedEgressBytes = L.imageBytes;
      expect(f.compile([op])).toMatchObject({
        reads: [{ method, outputCap: L.imageBytes }],
      });
    },
  );
  it.each([
    "ACTOR",
    "PUBLIC_AUTHENTICATED",
    "INVALID_CREDENTIAL_NEGATIVE",
    "ANON",
  ])(
    "preserves %s budget classification and negative-read full ceilings",
    (kind) => {
      const f = fixture(),
        op = {
          ...f.operation(),
          principal: kind === "ACTOR" ? f.operation().principal : { kind },
          assertion:
            kind === "INVALID_CREDENTIAL_NEGATIVE"
              ? "EXPECTED_DENIAL"
              : "NORMAL_AUTHORIZATION",
        };
      if (kind === "ANON") {
        op.charges.authenticatedRequests = 0;
        op.charges.anonymousRequests = 1;
        op.charges.authenticatedEgressBytes = 0;
        op.charges.anonymousEgressBytes = L.imageBytes;
      }
      expect(f.compile([op])).toMatchObject({
        catalogue: {
          totals: {
            authenticatedEgressBytes: kind === "ANON" ? 0 : L.imageBytes,
            anonymousEgressBytes: kind === "ANON" ? L.imageBytes : 0,
          },
        },
      });
      if (kind === "ANON") op.charges.anonymousEgressBytes--;
      else op.charges.authenticatedEgressBytes--;
      reject(f, [op]);
    },
  );
  it("requires conservative bytes for expected-denial policies and rejects text thumbnails even then", () => {
    const f = fixture(),
      op = { ...f.operation(), assertion: "EXPECTED_DENIAL" };
    op.charges.authenticatedEgressBytes = 1;
    reject(f, [op]);
    const text = fixture("TEXT");
    reject(text, [
      {
        ...text.operation("read", "thumbnail", L.thumbnailBytes),
        assertion: "EXPECTED_DENIAL",
      },
    ]);
  });
  it("enforces lower envelope ceilings with unchanged declared charges", () => {
    const f = fixture(),
      op = f.operation(),
      at = {
        ...f.envelope,
        budgets: {
          ...f.envelope.budgets,
          authenticatedEgressBytes: L.imageBytes,
        },
      },
      below = {
        ...at,
        budgets: { ...at.budgets, authenticatedEgressBytes: L.imageBytes - 1 },
      };
    expect(f.compile([op], at)).toMatchObject({
      reads: [{ outputCap: L.imageBytes }],
    });
    expect(() => f.compile([op], below)).toThrow(
      /^TEST_ADMISSION_READ_CEILINGS$/,
    );
  });
  it("rejects grouped maximum times attempts overflow when separate policy sums fit", () => {
    const f = fixture(),
      a = {
        ...f.operation("a", "normalized", L.imageBytes),
        range: "bytes=0-0",
      },
      b = {
        ...f.operation("b", "normalized", 2 * L.imageBytes),
        range: "bytes=1-1",
      },
      e = {
        ...f.envelope,
        budgets: {
          ...f.envelope.budgets,
          authenticatedEgressBytes: 3 * L.imageBytes,
        },
      };
    expect(validateOperationDeclarations([a, b], f.inventory, e)).toHaveLength(
      2,
    );
    expect(() => f.compile([a, b], e)).toThrow(
      /^TEST_ADMISSION_READ_CEILINGS$/,
    );
  });
  it("revalidates unknown records without exposing hostile errors", () => {
    const f = fixture(),
      getter = Object.defineProperty(f.operation(), "key", {
        get() {
          throw Error("private");
        },
      });
    for (const value of [
      null,
      [],
      [{}],
      [getter],
      [{ ...f.operation(), attachmentId: id(99) }],
      [{ ...f.operation(), outputCap: 1 }],
    ])
      reject(f, value);
  });
  it("returns sorted deeply frozen detached provenance and catalogue without runtime authority", () => {
    const f = fixture(),
      a = { ...f.operation("a"), range: "bytes=0-0" },
      b = { ...f.operation("b"), range: "bytes=1-1" },
      out = f.compile([b, a]) as {
        reads: readonly { opKey: string }[];
        catalogue: unknown;
      };
    expect(out.reads.map((x) => x.opKey)).toEqual(["a", "b"]);
    expect(out).toEqual(f.compile([a, b]));
    const before = JSON.stringify(out);
    a.attemptKeys[0] = "changed";
    a.charges.authenticatedEgressBytes = 999;
    expect(JSON.stringify(out)).toBe(before);
    const frozen = (v: unknown): void => {
      if (v && typeof v === "object") {
        expect(Object.isFrozen(v)).toBe(true);
        Object.values(v).forEach(frozen);
      }
    };
    frozen(out);
    expect(Object.keys(out).sort()).toEqual(["catalogue", "reads"]);
    for (const key of [
      "objects",
      "providerProof",
      "requests",
      "bindings",
      "activeRun",
    ])
      expect(out).not.toHaveProperty(key);
  });
  it("keeps valid non-read catalogue entries without inventing read provenance", () => {
    const f = fixture(),
      op = { ...f.operation(), kind: "METADATA" };
    const raw = {
      key: op.key,
      kind: op.kind,
      attachmentId: op.attachmentId,
      principal: op.principal,
      assertion: op.assertion,
      attemptKeys: op.attemptKeys,
      charges: { ...op.charges, authenticatedEgressBytes: 0 },
      slotKeys: op.slotKeys,
    };
    expect(f.compile([raw])).toMatchObject({
      reads: [],
      catalogue: {
        groups: [{ path: "/api/v1/attachments/" + id(7), egressBytes: 0 }],
      },
    });
  });
});
