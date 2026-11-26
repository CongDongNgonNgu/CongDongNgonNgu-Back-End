import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import { ReadPolicyBinding } from "./read-policy-binding";
import { lowerPinnedRequestPlan } from "./request-plan-lowering";
import type { MatchedBoundOperation } from "./run-ledger";
import {
  createPinnedPlanFixture,
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "../../../test/phase30/pinned-plan-fixture";
import {
  validatePinnedDeclarations,
  type PinnedDeclarations,
} from "./pinned-declarations";
const now = Date.parse("2026-11-25T00:02:00.000Z");
function fixture(declarations = createPinnedPlanFixture(now).declarations) {
  const lowered = lowerPinnedRequestPlan(declarations),
    op = declarations.operations.find((o) => o.key === "read")!;
  const actor = declarations.inventory.actors[0];
  const principal = { actorId: actor.id, sessionId: actor.sessionIds[0] };
  const req = {
    headers: { authorization: "Bearer native" },
    rawHeaders: ["Authorization", "Bearer native"],
    user: {
      user: { id: principal.actorId },
      claims: { sid: principal.sessionId },
    },
  } as unknown as AuthenticatedRequest;
  const policy = lowered.policies.find((p) => p.policyKey === "read")!;
  const candidate = lowered.prepared.requests!.candidates.find(
    (c) => c.key === policy.candidateKey,
  )!;
  const handle = {
    runId: declarations.envelope.runId,
    attemptKey: "coarse-r0",
    operationKey: policy.instances[0].instanceKey,
    attachmentId: op.attachmentId,
    slots: [],
    policyKey: "read",
    policyAttemptKey: policy.instances[0].policyAttemptKey,
    candidateKey: candidate.key,
    candidate,
  } as MatchedBoundOperation;
  const receipt = {
    runId: handle.runId,
    candidateKey: candidate.key,
    attemptKey: "coarse-r0",
  };
  const accounting = { take: jest.fn(() => receipt) };
  const ledger = {
    bindMatchedPolicy: jest.fn(async () => handle),
    requireMatchedBoundOperation: jest.fn((h: unknown) => {
      if (h !== handle) throw Error("foreign");
      return handle;
    }),
  };
  const binder = new ReadPolicyBinding(
    declarations,
    lowered,
    accounting,
    ledger,
  );
  const action = {
    kind: "READ" as const,
    attachmentId: op.attachmentId,
    method: "GET" as const,
    variant: "normalized" as const,
    range: undefined,
  };
  return {
    declarations,
    lowered,
    req,
    policy,
    handle,
    accounting,
    ledger,
    binder,
    action,
  };
}
describe("native-principal READ policy to original controlled reservation binding", () => {
  it("binds unique exact actor/session policy and keeps the original handle one-use", async () => {
    const f = fixture();
    await expect(f.binder.bind(f.req, f.action)).resolves.toEqual({
      constraint: "CURRENT_PARENT",
    });
    expect(f.ledger.bindMatchedPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ candidateKey: f.policy.candidateKey }),
      {
        policyKey: "read",
        instanceKeys: f.policy.instances.map((i) => i.instanceKey),
      },
    );
    expect(f.binder.take(f.req)).toBe(f.handle);
    expect(f.binder.take(f.req)).toBeUndefined();
  });
  it.each([
    "actor",
    "session",
    "range",
    "variant",
    "method",
    "attachment",
  ] as const)("rejects changed %s without binding", async (field) => {
    const f = fixture();
    const action = { ...f.action };
    if (field === "actor") f.req.user!.user.id = "foreign";
    if (field === "session") f.req.user!.claims.sid = "foreign";
    if (field === "range") action.range = "bytes=0-0" as never;
    if (field === "variant") action.variant = "thumbnail" as never;
    if (field === "method") action.method = "HEAD" as never;
    if (field === "attachment") action.attachmentId = "foreign";
    await expect(f.binder.bind(f.req, action)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).not.toHaveBeenCalled();
    expect(f.accounting.take).toHaveBeenCalledTimes(1);
  });
  it("rejects missing original receipts and does not infer authority from routing strings", async () => {
    const f = fixture();
    f.accounting.take.mockReturnValue(undefined as never);
    await expect(f.binder.bind(f.req, f.action)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).not.toHaveBeenCalled();
  });
  it("rejects duplicate binding on one request even after the local bound handle is taken", async () => {
    const f = fixture();
    await f.binder.bind(f.req, f.action);
    f.binder.take(f.req);
    await expect(f.binder.bind(f.req, f.action)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatch between committed candidate and matched policy before publishing a handle", async () => {
    const f = fixture();
    const changed = {
      ...f.handle,
      candidate: { ...f.handle.candidate, egressBytes: 1 },
    };
    f.ledger.bindMatchedPolicy.mockResolvedValue(changed);
    f.ledger.requireMatchedBoundOperation.mockImplementation(() => changed);
    await expect(f.binder.bind(f.req, f.action)).rejects.toThrow();
    expect(f.binder.take(f.req)).toBeUndefined();
  });
  it("owns immutable routing snapshots across asynchronous ledger binding", async () => {
    const f = fixture();
    const changed = {
      ...f.handle,
      candidate: { ...f.handle.candidate, egressBytes: 1 },
    };
    f.ledger.requireMatchedBoundOperation.mockImplementation(() => changed);
    let complete!: (h: MatchedBoundOperation) => void;
    f.ledger.bindMatchedPolicy.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.binder.bind(f.req, f.action);
    f.lowered.prepared.requests!.candidates.find(
      (c) => c.key === f.policy.candidateKey,
    )!.egressBytes = 1;
    complete(changed);
    await expect(pending).rejects.toThrow();
    expect(f.binder.take(f.req)).toBeUndefined();
  });
  it("requires current public constraint for PUBLIC_AUTHENTICATED without pinning caller actor", async () => {
    const root = createPinnedPlanRoot();
    root.operations.push({
      key: "read",
      kind: "READ",
      attachmentId: root.operations[0].attachmentId,
      principal: { kind: "PUBLIC_AUTHENTICATED" },
      assertion: "NORMAL_AUTHORIZATION",
      attemptKeys: ["public-read"],
      charges: {
        ...(root.operations[0].charges as Record<string, number>),
        authenticatedEgressBytes: 4194304,
      },
      slotKeys: [],
      method: "GET",
      variant: "normalized",
      range: null,
    } as never);
    const d = validatePinnedDeclarations(createPinnedPlanOptions(root))!;
    const base = fixture();
    const lowered = lowerPinnedRequestPlan(d);
    const p = lowered.policies.find((p) => p.policyKey === "read")!;
    const c = lowered.prepared.requests!.candidates.find(
      (c) => c.key === p.candidateKey,
    )!;
    const h = {
      ...base.handle,
      policyAttemptKey: p.instances[0].policyAttemptKey,
      operationKey: p.instances[0].instanceKey,
      candidateKey: c.key,
      candidate: c,
    };
    const ledger = {
      bindMatchedPolicy: jest.fn(async () => h),
      requireMatchedBoundOperation: jest.fn(() => h),
    };
    const binder = new ReadPolicyBinding(d, lowered, base.accounting, ledger);
    base.accounting.take.mockReturnValue({
      ...base.accounting.take(),
      candidateKey: c.key,
    } as never);
    await expect(binder.bind(base.req, base.action)).resolves.toEqual({
      constraint: "AUTHENTICATED_PUBLIC_COMMUNITY",
    });
  });
  it("preserves normal negative anonymous policy matching without granting ACL access", async () => {
    const raw = createPinnedPlanRoot();
    raw.operations.push({
      key: "read",
      kind: "READ",
      attachmentId: raw.inventory.attachments[0].id,
      principal: { kind: "ANON" },
      assertion: "EXPECTED_DENIAL",
      attemptKeys: ["anon-read"],
      charges: {
        authenticatedRequests: 0,
        anonymousRequests: 1,
        ingressBytes: 0,
        authenticatedEgressBytes: 0,
        anonymousEgressBytes: 4194304,
        processingAttempts: 0,
      },
      slotKeys: [],
      method: "GET",
      variant: "normalized",
      range: null,
    } as never);
    const f = fixture(
      validatePinnedDeclarations(createPinnedPlanOptions(raw))!,
    );
    delete f.req.user;
    f.req.headers = {};
    f.req.rawHeaders = [];
    await expect(f.binder.bind(f.req, f.action)).resolves.toEqual({
      constraint: "CURRENT_PARENT",
    });
    expect(f.binder.take(f.req)).toBe(f.handle);
  });
  it("never treats empty supplied authorization as genuinely anonymous", async () => {
    const raw = createPinnedPlanRoot();
    raw.operations.push({
      key: "read",
      kind: "READ",
      attachmentId: raw.inventory.attachments[0].id,
      principal: { kind: "ANON" },
      assertion: "NORMAL_AUTHORIZATION",
      attemptKeys: ["anon-read"],
      charges: {
        authenticatedRequests: 0,
        anonymousRequests: 1,
        ingressBytes: 0,
        authenticatedEgressBytes: 0,
        anonymousEgressBytes: 4194304,
        processingAttempts: 0,
      },
      slotKeys: [],
      method: "GET",
      variant: "normalized",
      range: null,
    } as never);
    const f = fixture(
      validatePinnedDeclarations(createPinnedPlanOptions(raw))!,
    );
    delete f.req.user;
    f.req.headers = { authorization: "" };
    f.req.rawHeaders = ["Authorization", ""];
    await expect(f.binder.bind(f.req, f.action)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).not.toHaveBeenCalled();
  });
  it("binds authenticated metadata without requiring a READ route", async () => {
    const raw = createPinnedPlanRoot();
    raw.operations.push({
      key: "read",
      kind: "METADATA",
      attachmentId: raw.inventory.attachments[0].id,
      principal: raw.operations[0].principal,
      assertion: "NORMAL_AUTHORIZATION",
      attemptKeys: ["metadata-read"],
      charges: raw.operations[0].charges,
      slotKeys: [],
    } as never);
    const f = fixture(
      validatePinnedDeclarations(createPinnedPlanOptions(raw))!,
    );
    await expect(
      f.binder.bind(f.req, {
        kind: "METADATA",
        attachmentId: f.action.attachmentId,
      }),
    ).resolves.toEqual({ constraint: "CURRENT_PARENT" });
    expect(f.binder.take(f.req)).toBe(f.handle);
  });
  it("rejects a lost ledger commit without publishing a local handle", async () => {
    const f = fixture();
    f.ledger.bindMatchedPolicy.mockRejectedValue(Error("private proof"));
    await expect(f.binder.bind(f.req, f.action)).rejects.toThrow();
    expect(f.binder.take(f.req)).toBeUndefined();
  });
});
