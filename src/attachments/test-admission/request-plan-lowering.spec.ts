import { createHash } from "node:crypto";
import { ATTACHMENT_LIMITS } from "../attachment-policy";
import { validatePinnedDeclarations } from "./pinned-declarations";
import { lowerPinnedRequestPlan } from "./request-plan-lowering";
jest.mock("pg", () => {
  throw Error("lowering must not import runtime database");
});
import {
  createPinnedPlanRoot as root,
  createPinnedPlanOptions as fixture,
} from "../../../test/phase30/pinned-plan-fixture";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const charges = () => ({
  authenticatedRequests: 1,
  anonymousRequests: 0,
  ingressBytes: 0,
  authenticatedEgressBytes: 0,
  anonymousEgressBytes: 0,
  processingAttempts: 0,
});
const declarations = (r: ReturnType<typeof root> = root()) =>
  validatePinnedDeclarations(fixture(r))!;
function read(
  r: ReturnType<typeof root>,
  key: string,
  method: "GET" | "HEAD",
  variant: "normalized" | "thumbnail",
  count: number,
) {
  r.operations.push({
    kind: "READ",
    key,
    attachmentId: id(7),
    principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: Array.from({ length: count }, (_, i) => key + "-attempt-" + i),
    charges: {
      ...charges(),
      authenticatedEgressBytes:
        variant === "thumbnail"
          ? ATTACHMENT_LIMITS.thumbnailBytes
          : ATTACHMENT_LIMITS.imageBytes,
    },
    slotKeys: [],
    method,
    variant,
    range: null,
  });
}
describe("lower pinned declarations into controlled coarse/instance ledger inventory", () => {
  it("preserves pinned source/hash/window and forces controlled preparation with lower budgets", () => {
    const r = root();
    r.envelope.budgets.authenticatedRequests = 20;
    const d = declarations(r),
      p = lowerPinnedRequestPlan(d);
    expect(p.prepared).toMatchObject({
      runId: d.envelope.runId,
      activationId: d.envelope.activationId,
      sourceSha: d.sourceSha,
      manifestSha256: d.manifestSha256,
      notBefore: d.envelope.notBefore,
      expiresAt: d.envelope.expiresAt,
      activationControlRequired: true,
    });
    expect(p.prepared.limits.authenticatedRequests).toBe(20);
    expect(p.prepared.requests).toEqual(p.coarse.requests);
    expect(p.prepared.bindings!.operations).toHaveLength(3);
  });
  it("rewrites only single-instance slot creator keys while retaining exact IDs and policy attempt provenance", () => {
    const d = declarations(),
      before = JSON.stringify(d),
      p = lowerPinnedRequestPlan(d);
    expect(p.prepared.slots.map((s) => s.id).sort()).toEqual(
      d.allocations.slots.map((s) => s.id).sort(),
    );
    for (const policy of p.policies) {
      expect(policy.instances).toHaveLength(1);
      const op = p.prepared.bindings!.operations.find(
        (o) => o.key === policy.instances[0].instanceKey,
      )!;
      expect(op).toMatchObject({
        policyKey: policy.policyKey,
        policyAttemptKey: policy.instances[0].policyAttemptKey,
      });
      for (const s of p.prepared.slots.filter(
        (s) => s.operationKey === op.key,
      )) {
        const original = d.allocations.slots.find((x) => x.key === s.key)!;
        expect(s).toEqual({ ...original, operationKey: op.key });
        expect(original.operationKey).toBe(policy.policyKey);
      }
    }
    expect(JSON.stringify(d)).toBe(before);
    expect(
      d.objectIdentities.find((x) => x.variant === "source")!.operationKey,
    ).toBe("upload");
  });
  it("expands slot-free retries and connects every coarse attempt to every compatible group instance", () => {
    const r = root();
    read(r, "read", "GET", "normalized", 3);
    const p = lowerPinnedRequestPlan(declarations(r)),
      policy = p.policies.find((x) => x.policyKey === "read")!;
    expect(policy.instances).toHaveLength(3);
    const attempts = p.coarse.requests.attempts.filter(
      (a) => a.candidateKey === policy.candidateKey,
    );
    expect(attempts).toHaveLength(3);
    for (const a of attempts)
      expect(
        p.prepared
          .bindings!.edges.filter((e) => e.attemptKey === a.key)
          .map((e) => e.operationKey)
          .sort(),
      ).toEqual(policy.instances.map((i) => i.instanceKey).sort());
    expect(p.prepared.bindings!.edges).toHaveLength(12);
  });
  it("rejects allocating retries without cloning or inventing identities", () => {
    const r = root(),
      upload = r.operations.find((o) => o.key === "upload")!;
    upload.attemptKeys = ["upload-a", "upload-b"];
    const d = declarations(r);
    expect(() => lowerPinnedRequestPlan(d)).toThrow(
      /^TEST_ADMISSION_REQUEST_LOWERING$/,
    );
  });
  it("accepts exactly140 Cartesian edges and rejects141 without truncation", () => {
    const r = root();
    read(r, "normal-get", "GET", "normalized", 10);
    read(r, "thumb-get", "GET", "thumbnail", 6);
    read(r, "normal-head", "HEAD", "normalized", 1);
    expect(
      lowerPinnedRequestPlan(declarations(r)).prepared.bindings!.edges,
    ).toHaveLength(140);
    read(r, "thumb-head", "HEAD", "thumbnail", 1);
    expect(() => lowerPinnedRequestPlan(declarations(r))).toThrow(
      /^TEST_ADMISSION_REQUEST_LOWERING$/,
    );
  });
  it("retains compatibility for different actor/range policies in the same coarse group", () => {
    const r = root();
    read(r, "read-a", "GET", "normalized", 1);
    read(r, "read-b", "GET", "normalized", 1);
    r.operations.find((o) => o.key === "read-a")!.range = "bytes=0-0";
    r.operations.find((o) => o.key === "read-b")!.range = "bytes=1-1";
    const p = lowerPinnedRequestPlan(declarations(r)),
      policies = p.policies.filter((x) => x.policyKey.startsWith("read-"));
    expect(policies[0].candidateKey).toBe(policies[1].candidateKey);
    for (const a of p.coarse.requests.attempts.filter(
      (x) => x.candidateKey === policies[0].candidateKey,
    ))
      expect(
        p.prepared.bindings!.edges.filter((e) => e.attemptKey === a.key),
      ).toHaveLength(2);
  });
  it("produces detached deterministic outputs without changing creator policy tuples", () => {
    const r = root();
    read(r, "read", "GET", "normalized", 2);
    const d = declarations(r),
      before = JSON.stringify(d),
      p = lowerPinnedRequestPlan(d);
    expect(p).toEqual(lowerPinnedRequestPlan(d));
    p.prepared.slots[0].id = id(999);
    p.prepared.requests!.candidates[0].key = "changed";
    expect(JSON.stringify(d)).toBe(before);
    expect(lowerPinnedRequestPlan(d).prepared.slots[0].id).not.toBe(id(999));
    expect(Object.keys(p).sort()).toEqual(["coarse", "policies", "prepared"]);
    expect(p).not.toHaveProperty("active");
    expect(p).not.toHaveProperty("runtime");
  });
});

it("requires every JSON policy to reserve the parser cap without rewriting charges", () => {
  const r = root();
  r.operations.find((o) => o.kind === "INITIATE")!.charges = {
    ...charges(),
    ingressBytes: 102399,
  };
  const d = declarations(r);
  expect(() => lowerPinnedRequestPlan(d)).toThrow(
    "TEST_ADMISSION_REQUEST_LOWERING",
  );
});

it("requires PATCH ingress even when INITIATE has its full cap, preserving exact reserved amounts", () => {
  const r = root();
  const original = r.operations.find((o) => o.kind === "INITIATE")!;
  const { body: unused, ...common } = original as typeof original & {
    body: unknown;
  };
  r.operations.push({
    ...common,
    key: "patch",
    kind: "PATCH_METADATA",
    attemptKeys: ["patch-attempt"],
    slotKeys: [],
    body: { expectedMetadataVersion: 0, caption: "", alt: "" },
    charges: { ...charges(), ingressBytes: 102399 },
  } as typeof original);
  const d = declarations(r);
  expect(() => lowerPinnedRequestPlan(d)).toThrow(
    "TEST_ADMISSION_REQUEST_LOWERING",
  );
  r.operations[r.operations.length - 1].charges = {
    ...charges(),
    ingressBytes: 102400,
  };
  const p = lowerPinnedRequestPlan(declarations(r));
  expect(
    p.prepared
      .requests!.candidates.filter(
        (c) =>
          c.method === "PATCH" ||
          (c.method === "POST" && c.path === "/api/v1/attachments"),
      )
      .map((c) => c.ingressBytes),
  ).toEqual([102400, 102400]);
});
