import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import {
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "../../../test/phase30/pinned-plan-fixture";
import { validatePinnedDeclarations } from "./pinned-declarations";
import { lowerPinnedRequestPlan } from "./request-plan-lowering";
import { SourceUploadPolicyBinding } from "./source-upload-policy-binding";
import type {
  ControlledSourceUploads,
  ControlledSourceUploadContext,
} from "./controlled-source-upload";
import type { MatchedBoundOperation } from "./run-ledger";
function fixture() {
  const root = createPinnedPlanRoot(),
    source = root.objectIdentities.find((o) => o.variant === "source")!,
    upload = root.operations.find((o) => o.kind === "UPLOAD")!;
  (upload.slotKeys as string[]).push("upload-owner");
  root.allocationSlots.push(
    {
      key: "upload-owner",
      operationKey: "upload",
      role: "UPLOAD_OWNER",
      id: "dddddddd-1111-4111-8111-111111111111",
      attachmentId: source.attachmentId,
    },
    {
      key: "cleanup-job",
      operationKey: "source-cleanup",
      role: "CLEANUP_JOB",
      id: "eeeeeeee-1111-4111-8111-111111111111",
      attachmentId: source.attachmentId,
    },
  );
  const declarations = validatePinnedDeclarations(
      createPinnedPlanOptions({
        ...root,
        internalCleanup: [
          {
            key: "source-cleanup",
            sourceOperationKey: "upload",
            attachmentId: source.attachmentId,
            objectId: source.objectId,
            jobSlotKey: "cleanup-job",
          },
        ],
      }),
    )!,
    lowered = lowerPinnedRequestPlan(declarations),
    policy = lowered.policies.find((p) => p.policyKey === "upload")!,
    candidate = lowered.prepared.requests!.candidates.find(
      (c) => c.key === policy.candidateKey,
    )!;
  const req = Object.assign(new EventEmitter(), {
    method: "PUT",
    originalUrl: candidate.path,
    url: candidate.path,
    user: {
      user: { id: root.inventory.actors[0].id },
      claims: { sid: root.inventory.actors[0].sessionIds[0] },
    },
    headers: { "content-type": "image/jpeg", "content-length": "100" },
    rawHeaders: ["Content-Type", "image/jpeg", "Content-Length", "100"],
    aborted: false,
  }) as AuthenticatedRequest;
  Object.defineProperty(req, "body", {
    get() {
      throw Error("must not inspect body");
    },
  });
  const res = new EventEmitter() as Response,
    receipt = {
      runId: declarations.envelope.runId,
      candidateKey: candidate.key,
      attemptKey: "coarse",
    },
    handle = {
      ...receipt,
      attachmentId: source.attachmentId,
      operationKey: policy.instances[0].instanceKey,
      policyKey: "upload",
      policyAttemptKey: policy.instances[0].policyAttemptKey,
      candidate,
      slots: lowered.prepared.slots.filter(
        (s) => s.operationKey === policy.instances[0].instanceKey,
      ),
    } as MatchedBoundOperation,
    context = {} as ControlledSourceUploadContext,
    accounting = { take: jest.fn(() => receipt) },
    ledger = {
      bindMatchedPolicy: jest.fn(async () => handle),
      requireMatchedBoundOperation: jest.fn(() => handle),
    },
    issue = jest.fn(() => context),
    binder = new SourceUploadPolicyBinding(
      declarations,
      lowered,
      accounting,
      ledger,
      { issue } as unknown as ControlledSourceUploads,
    );
  return {
    declarations,
    req,
    res,
    handle,
    context,
    accounting,
    ledger,
    issue,
    binder,
    attachmentId: source.attachmentId,
  };
}
it("binds only exact native headers/principal into the original five-role context without reading body", async () => {
  const f = fixture();
  await expect(f.binder.bind(f.req, f.attachmentId, f.res)).resolves.toBe(
    f.context,
  );
  expect(f.issue).toHaveBeenCalledWith(
    f.handle,
    {
      actorId: f.req.user!.user.id,
      sessionId: f.req.user!.claims.sid,
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "b".repeat(64),
      initiationFingerprint:
        f.declarations.inventory.attachments[0].initiation.fingerprint,
    },
    expect.any(AbortSignal),
  );
  await expect(f.binder.bind(f.req, f.attachmentId, f.res)).rejects.toThrow();
});
it.each(["method", "alias", "length", "duplicate", "actor"])(
  "denies changed %s before original operation binding",
  async (mode) => {
    const f = fixture();
    if (mode === "method") f.req.method = "POST";
    if (mode === "alias") f.req.originalUrl = f.req.originalUrl.toUpperCase();
    if (mode === "length") f.req.headers["content-length"] = "99";
    if (mode === "duplicate") f.req.rawHeaders.push("Content-Length", "100");
    if (mode === "actor") f.req.user!.user.id = "foreign";
    await expect(f.binder.bind(f.req, f.attachmentId, f.res)).rejects.toThrow();
    expect(f.ledger.bindMatchedPolicy).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
  },
);
