import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import {
  createPinnedPlanFixture,
  createPinnedPlanRoot,
} from "../../../test/phase30/pinned-plan-fixture";
import { lowerPinnedRequestPlan } from "./request-plan-lowering";
import { InitiationPolicyBinding } from "./initiation-policy-binding";
import type { MatchedBoundOperation } from "./run-ledger";
import type { ControlledInitiationContext } from "../initiation/controlled-initiation.port";
function fixture() {
  const declarations = createPinnedPlanFixture(
      Date.parse("2026-11-25T00:02:00Z"),
    ).declarations,
    lowered = lowerPinnedRequestPlan(declarations),
    policy = lowered.policies.find((p) => p.policyKey === "init")!,
    candidate = lowered.prepared.requests!.candidates.find(
      (c) => c.key === policy.candidateKey,
    )!,
    operation = declarations.operations.find((o) => o.kind === "INITIATE")!,
    principal = operation.principal as { actorId: string; sessionId: string };
  const req = Object.assign(new EventEmitter(), {
      user: {
        user: { id: principal.actorId },
        claims: { sid: principal.sessionId },
      },
      aborted: false,
    }) as AuthenticatedRequest,
    input = createPinnedPlanRoot().operations[0].body,
    receipt = {
      runId: declarations.envelope.runId,
      attemptKey: "coarse-attempt",
      candidateKey: candidate.key,
    },
    handle = {
      ...receipt,
      operationKey: policy.instances[0].instanceKey,
      policyKey: policy.policyKey,
      policyAttemptKey: policy.instances[0].policyAttemptKey,
      attachmentId: operation.attachmentId,
      candidate,
      slots: lowered.prepared.slots.filter(
        (s) => s.operationKey === policy.instances[0].instanceKey,
      ),
    } as MatchedBoundOperation,
    context = Object.freeze({}) as ControlledInitiationContext;
  const accounting = { take: jest.fn(() => receipt) },
    ledger = {
      bindMatchedPolicy: jest.fn(async () => handle),
      requireMatchedBoundOperation: jest.fn(() => handle),
      issueMatchedInitiationContext: jest.fn(
        (
          _h: MatchedBoundOperation,
          _f: { actorId: string; sessionId: string; fingerprint: string },
          _s: AbortSignal,
        ) => context,
      ),
    };
  return {
    req,
    response: new EventEmitter() as Response,
    input,
    handle,
    context,
    receipt,
    accounting,
    ledger,
    binder: new InitiationPolicyBinding(
      declarations,
      lowered,
      accounting,
      ledger,
    ),
  };
}
describe("native exact INITIATE policy correlation only", () => {
  it("matches normalized body+actor/session and issues only from the original committed matched handle", async () => {
    const f = fixture();
    await expect(f.binder.bind(f.req, f.input, f.response)).resolves.toBe(
      f.context,
    );
    expect(f.ledger.issueMatchedInitiationContext).toHaveBeenCalledWith(
      f.handle,
      expect.objectContaining({
        actorId: f.req.user!.user.id,
        sessionId: f.req.user!.claims.sid,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.any(AbortSignal),
    );
    await expect(f.binder.bind(f.req, f.input, f.response)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).toHaveBeenCalledTimes(1);
  });
  it.each(["actor", "session", "body", "receipt", "candidate", "aborted"])(
    "fails closed on changed %s",
    async (mode) => {
      const f = fixture();
      let input = f.input;
      if (mode === "actor") f.req.user!.user.id = "foreign";
      if (mode === "session") f.req.user!.claims.sid = "foreign";
      if (mode === "body")
        input = { ...(f.input as object), filename: "changed.jpg" };
      if (mode === "receipt")
        f.accounting.take.mockReturnValue(undefined as never);
      if (mode === "candidate")
        f.ledger.bindMatchedPolicy.mockResolvedValue({
          ...f.handle,
          candidate: { ...f.handle.candidate, ingressBytes: 1 },
        });
      if (mode === "aborted")
        Object.defineProperty(f.req, "aborted", { value: true });
      await expect(
        f.binder.bind(f.req, input, f.response),
      ).rejects.toMatchObject({ code: "ATTACHMENTS_UNAVAILABLE" });
      expect(f.ledger.issueMatchedInitiationContext).not.toHaveBeenCalled();
    },
  );
});

it("uses only native abort/premature response close and cleans normal completion listeners", async () => {
  for (const kind of ["request-aborted", "response-close", "normal-finish"]) {
    const f = fixture();
    await f.binder.bind(f.req, f.input, f.response);
    const signal = f.ledger.issueMatchedInitiationContext.mock.calls[0][2];
    f.req.emit("close");
    expect(signal.aborted).toBe(false);
    if (kind === "request-aborted") f.req.emit("aborted");
    else if (kind === "response-close") f.response.emit("close");
    else {
      Object.defineProperty(f.response, "writableFinished", { value: true });
      f.response.emit("finish");
      f.response.emit("close");
    }
    expect(signal.aborted).toBe(true);
    if (kind === "request-aborted") f.response.emit("close");
    expect(f.req.listenerCount("aborted")).toBe(0);
    expect(f.response.listenerCount("close")).toBe(0);
    expect(f.response.listenerCount("finish")).toBe(0);
  }
});
it("releases cancellation listeners on early binding failure", async () => {
  const f = fixture();
  f.req.user!.claims.sid = "foreign";
  await expect(f.binder.bind(f.req, f.input, f.response)).rejects.toThrow();
  expect(f.req.listenerCount("aborted")).toBe(0);
  expect(f.response.listenerCount("close")).toBe(0);
  expect(f.response.listenerCount("finish")).toBe(0);
});

it("rejects an already completed response before taking its request receipt", async () => {
  const f = fixture();
  Object.defineProperty(f.response, "writableEnded", { value: true });
  await expect(f.binder.bind(f.req, f.input, f.response)).rejects.toThrow();
  expect(f.accounting.take).not.toHaveBeenCalled();
});
