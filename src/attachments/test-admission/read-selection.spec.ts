import {
  validatePlannedReadSelection,
  type AdmittedReadSelection,
  type PlannedReadDeclarations,
} from "./read-selection";
import { compileConservativeReadCatalogue } from "./read-ceilings";
import { validateFixtureInventory } from "./fixture-inventory";
import { validateOperationDeclarations } from "./operation-declarations";
import type { AttachmentFormat } from "../attachment-policy";
import type { ActivationEnvelope } from "./guard";
jest.mock("pg", () => {
  throw Error("selection checks must not load database runtime");
});
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
function fixture(
  format: AttachmentFormat = "IMAGE",
  variant: "normalized" | "thumbnail" = "normalized",
  method: "GET" | "HEAD" = "GET",
  anon = false,
  range: string | null = null,
) {
  const cap =
    variant === "thumbnail"
      ? 262144
      : format === "IMAGE"
        ? 4194304
        : format === "VIDEO"
          ? 3145728
          : 65536;
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
  const raw = {
    key: "read",
    kind: "READ",
    attachmentId: id(7),
    principal: anon
      ? { kind: "ANON" }
      : { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: ["read-attempt"],
    charges: {
      authenticatedRequests: anon ? 0 : 1,
      anonymousRequests: anon ? 1 : 0,
      ingressBytes: 0,
      authenticatedEgressBytes: anon ? 0 : cap,
      anonymousEgressBytes: anon ? cap : 0,
      processingAttempts: 0,
    },
    slotKeys: [],
    method,
    variant,
    range,
  };
  const operations = validateOperationDeclarations([raw], inventory, envelope);
  const { catalogue } = compileConservativeReadCatalogue(
    [raw],
    inventory,
    envelope,
  );
  const objectIdentities = [
    {
      attachmentId: id(7),
      variant,
      objectId: id(10),
      attemptId: id(11),
      putClaimId: id(12),
      supervisionId: id(13),
      operationKey: "finalize",
    },
  ];
  const declarations: PlannedReadDeclarations = {
    inventory,
    operations,
    catalogue,
    objectIdentities,
  };
  const selected: AdmittedReadSelection = {
    method,
    format,
    object: {
      locator: {
        attachmentId: id(7),
        attemptId: id(11),
        objectId: id(10),
        kind: variant,
      },
      sizeBytes: cap,
      sha256: "b".repeat(64),
      version: "provider-etag",
    },
  };
  return {
    declarations,
    selected,
    cap,
    check: (s = selected, p = declarations, key = "read") =>
      validatePlannedReadSelection(p, key, s),
  };
}
const deny = (f: ReturnType<typeof fixture>) =>
  expect(() => f.check()).toThrow(/^TEST_ADMISSION_READ_SELECTION$/);
describe("planned derivative selection consistency, never reservation or access authority", () => {
  it("compares and returns one selected format observation", () => {
    const f = fixture();
    let reads = 0;
    const selected = {
      ...f.selected,
      get format(): AttachmentFormat {
        return ++reads === 1 ? "IMAGE" : "TEXT";
      },
    };
    const result = f.check(selected);
    expect(result.format).toBe("IMAGE");
    expect(result.outputCap).toBe(f.cap);
    expect(reads).toBe(1);
  });
  it("never combines locator and length from separate selected objects", () => {
    const f = fixture();
    let reads = 0;
    const first = f.selected.object;
    const selected = {
      ...f.selected,
      get object() {
        return ++reads === 1 ? first : { ...first, sizeBytes: 1 };
      },
    };
    const result = f.check(selected);
    expect(result.object.sizeBytes).toBe(f.cap);
    expect(reads).toBe(1);
  });
  it.each<[AttachmentFormat, "normalized" | "thumbnail"]>([
    ["IMAGE", "normalized"],
    ["VIDEO", "normalized"],
    ["TEXT", "normalized"],
    ["IMAGE", "thumbnail"],
    ["VIDEO", "thumbnail"],
  ])("accepts exact full output cap for %s %s", (format, variant) => {
    const f = fixture(format, variant);
    expect(f.check()).toMatchObject({
      opKey: "read",
      outputCap: f.cap,
      plannedEgressBytes: f.cap,
      object: { locator: f.selected.object.locator, sizeBytes: f.cap },
    });
  });
  it.each(["GET", "HEAD"] as const)(
    "ignores a tiny Range when enforcing full %s object size",
    (method) => {
      const f = fixture("IMAGE", "normalized", method, false, "bytes=0-0");
      f.selected.object.sizeBytes = f.cap + 1;
      deny(f);
    },
  );
  it("accepts one-byte actual derivatives even when source length differs", () => {
    const f = fixture();
    f.selected.object.sizeBytes = 1;
    expect(f.check().object.sizeBytes).toBe(1);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or oversize full length %s",
    (size) => {
      const f = fixture();
      f.selected.object.sizeBytes = size;
      deny(f);
    },
  );
  it.each(["attachmentId", "attemptId", "objectId", "kind"] as const)(
    "rejects substituted locator %s",
    (field) => {
      const f = fixture();
      if (field === "kind") f.selected.object.locator.kind = "source";
      else f.selected.object.locator[field] = id(99);
      deny(f);
    },
  );
  it("rejects selected format mismatch", () => {
    const f = fixture();
    deny({ ...f, check: () => f.check({ ...f.selected, format: "VIDEO" }) });
  });
  it("rejects selected method mismatch", () => {
    const f = fixture();
    deny({ ...f, check: () => f.check({ ...f.selected, method: "HEAD" }) });
  });
  it("rejects missing or non-READ policy", () => {
    const f = fixture();
    expect(() => f.check(f.selected, f.declarations, "absent")).toThrow(
      "TEST_ADMISSION_READ_SELECTION",
    );
    const op = { ...f.declarations.operations[0], kind: "DELETE" as const };
    deny({
      ...f,
      check: () => f.check(f.selected, { ...f.declarations, operations: [op] }),
    });
  });
  it("rejects expected denials even if normal ACL selection succeeded", () => {
    const f = fixture();
    const op = {
      ...f.declarations.operations[0],
      assertion: "EXPECTED_DENIAL" as const,
    };
    expect(() =>
      f.check(f.selected, { ...f.declarations, operations: [op] }),
    ).toThrow("TEST_ADMISSION_READ_SELECTION");
  });
  it("rejects missing planned derivative", () => {
    const f = fixture();
    deny({
      ...f,
      check: () =>
        f.check(f.selected, { ...f.declarations, objectIdentities: [] }),
    });
  });
  it("rejects cap undercoverage even if actual selected bytes fit", () => {
    const f = fixture();
    f.selected.object.sizeBytes = 1;
    const group = {
      ...f.declarations.catalogue.groups[0],
      egressBytes: f.cap - 1,
    };
    deny({
      ...f,
      check: () =>
        f.check(f.selected, {
          ...f.declarations,
          catalogue: { ...f.declarations.catalogue, groups: [group] },
        }),
    });
  });
  it.each(["method", "path", "authClass", "policies"] as const)(
    "rejects mismatched catalogue %s",
    (field) => {
      const f = fixture();
      const group = {
        ...f.declarations.catalogue.groups[0],
        [field]:
          field === "method"
            ? "HEAD"
            : field === "path"
              ? "/api/v1/attachments/other/content"
              : field === "authClass"
                ? "ANON"
                : [],
      };
      deny({
        ...f,
        check: () =>
          f.check(f.selected, {
            ...f.declarations,
            catalogue: { ...f.declarations.catalogue, groups: [group] },
          }),
      });
    },
  );
  it("accepts a larger shared group ceiling without rewriting it", () => {
    const f = fixture();
    const group = {
      ...f.declarations.catalogue.groups[0],
      egressBytes: f.cap + 100,
    };
    expect(
      f.check(f.selected, {
        ...f.declarations,
        catalogue: { ...f.declarations.catalogue, groups: [group] },
      }).plannedEgressBytes,
    ).toBe(f.cap + 100);
  });
  it.each([NaN, Infinity, 1.5])(
    "rejects malformed planned group ceiling %s",
    (egressBytes) => {
      const f = fixture();
      const group = { ...f.declarations.catalogue.groups[0], egressBytes };
      expect(() =>
        f.check(f.selected, {
          ...f.declarations,
          catalogue: { ...f.declarations.catalogue, groups: [group] },
        }),
      ).toThrow("TEST_ADMISSION_READ_SELECTION");
    },
  );
  it("keeps authenticated and anonymous planned groups separate", () => {
    const f = fixture("IMAGE", "normalized", "HEAD", true);
    expect(f.check().plannedEgressBytes).toBe(f.cap);
  });
  it("returns detached deeply frozen metadata without mutating input", () => {
    const f = fixture();
    const result = f.check();
    f.selected.object.sizeBytes = 1;
    f.selected.object.locator.objectId = id(99);
    expect(result.object.sizeBytes).toBe(f.cap);
    expect(result.object.locator.objectId).toBe(id(10));
    expect(
      [result, result.object, result.object.locator].every(Object.isFrozen),
    ).toBe(true);
    expect(Object.isFrozen(f.selected.object)).toBe(false);
    expect(result.object).not.toHaveProperty("sha256");
    expect(result.object).not.toHaveProperty("version");
  });
});
