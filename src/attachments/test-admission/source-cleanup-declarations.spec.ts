import {
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "../../../test/phase30/pinned-plan-fixture";
import { validatePinnedDeclarations } from "./pinned-declarations";
import { lowerPinnedRequestPlan } from "./request-plan-lowering";
function raw() {
  const r = createPinnedPlanRoot(),
    op = r.operations.find((o) => o.kind === "UPLOAD")!,
    id = "eeeeeeee-1111-4111-8111-111111111111",
    owner = "dddddddd-1111-4111-8111-111111111111",
    source = r.objectIdentities.find((o) => o.variant === "source")!;
  r.allocationSlots.push(
    {
      key: "upload-owner",
      operationKey: "upload",
      role: "UPLOAD_OWNER",
      id: owner,
      attachmentId: source.attachmentId,
    },
    {
      key: "source-cleanup-job",
      operationKey: "cleanup-source",
      role: "CLEANUP_JOB",
      id,
      attachmentId: source.attachmentId,
    },
  );
  (op.slotKeys as string[]).push("upload-owner");
  return {
    ...r,
    internalCleanup: [
      {
        key: "cleanup-source",
        sourceOperationKey: "upload",
        attachmentId: source.attachmentId,
        objectId: source.objectId,
        jobSlotKey: "source-cleanup-job",
      },
    ],
  };
}
it("composes one exact separate internal source cleanup entry and lowers complete disjoint coverage", () => {
  const r = raw(),
    d = validatePinnedDeclarations(createPinnedPlanOptions(r))!,
    p = lowerPinnedRequestPlan(d),
    entry = (
      p.prepared as typeof p.prepared & {
        internalCleanup?: readonly Record<string, unknown>[];
      }
    ).internalCleanup?.[0];
  expect(entry).toMatchObject({
    ...r.internalCleanup[0],
    sourceOperationKey: p.policies.find((p) => p.policyKey === "upload")!
      .instances[0].instanceKey,
    claimId: r.objectIdentities[0].putClaimId,
    supervisionId: r.objectIdentities[0].supervisionId,
    attemptId: r.objectIdentities[0].attemptId,
    sha256: "b".repeat(64),
    byteCount: 100,
  });
  expect(
    p.prepared.bindings!.operations.find((o) => o.policyKey === "upload")!
      .slotKeys,
  ).toHaveLength(5);
  expect(
    p.prepared.bindings!.operations.flatMap((o) => o.slotKeys),
  ).not.toContain("source-cleanup-job");
  expect(
    p.prepared.slots.find((s) => s.key === "source-cleanup-job"),
  ).toMatchObject({ operationKey: "cleanup-source", role: "CLEANUP_JOB" });
  expect(JSON.stringify(r)).toContain("internalCleanup");
});
it.each(["object", "creator", "role", "duplicate", "extra", "accessor"])(
  "rejects malformed source cleanup %s",
  (mode) => {
    const r = raw();
    if (mode === "object")
      r.internalCleanup[0].objectId = "ffffffff-1111-4111-8111-111111111111";
    if (mode === "creator")
      r.internalCleanup[0].sourceOperationKey = "finalize";
    if (mode === "role")
      r.allocationSlots.find((s) => s.key === "source-cleanup-job")!.role =
        "CLEANUP_OWNER";
    if (mode === "duplicate")
      r.internalCleanup.push({ ...r.internalCleanup[0], key: "other" });
    if (mode === "extra")
      Object.assign(r.internalCleanup[0], { authority: true });
    if (mode === "accessor")
      Object.defineProperty(r.internalCleanup[0], "objectId", {
        enumerable: true,
        get() {
          throw Error("getter executed");
        },
      });
    expect(() =>
      validatePinnedDeclarations(createPinnedPlanOptions(r)),
    ).toThrow();
  },
);

it("defaults internal cleanup only when absent and rejects explicit null", () => {
  expect(() =>
    validatePinnedDeclarations(
      createPinnedPlanOptions({
        ...createPinnedPlanRoot(),
        internalCleanup: null,
      }),
    ),
  ).toThrow("TEST_ADMISSION_DECLARATIONS");
});
