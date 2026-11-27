import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type { PinnedDeclarations } from "./pinned-declarations";
import type { LoweredRequestPlan } from "./request-plan-lowering";
import type { RequestAccounting } from "./request-accounting";
import type { RunLedger, RequestCandidate } from "./run-ledger";
import type {
  ControlledSourceUploads,
  ControlledSourceUploadContext,
} from "./controlled-source-upload";
import { AttachmentInitiationUnavailable } from "../initiation/attachment-initiation-repository";
const fail = (): never => {
  throw new AttachmentInitiationUnavailable();
};
/** Native header correlation only; source bytes/hash are proved by the actual spool before claim. */
export class SourceUploadPolicyBinding {
  private readonly used = new WeakSet<AuthenticatedRequest>();
  private readonly policies: LoweredRequestPlan["policies"];
  private readonly candidates: readonly Readonly<RequestCandidate>[];
  constructor(
    private readonly declarations: PinnedDeclarations,
    lowered: LoweredRequestPlan,
    private readonly accounting: Pick<RequestAccounting, "take">,
    private readonly ledger: Pick<
      RunLedger,
      "bindMatchedPolicy" | "requireMatchedBoundOperation"
    >,
    private readonly uploads: ControlledSourceUploads,
  ) {
    this.policies = Object.freeze(
      lowered.policies.map((p) =>
        Object.freeze({
          ...p,
          instances: Object.freeze(
            p.instances.map((i) => Object.freeze({ ...i })),
          ),
        }),
      ),
    );
    this.candidates = Object.freeze(
      (lowered.prepared.requests?.candidates ?? []).map((c) =>
        Object.freeze({ ...c }),
      ),
    );
  }
  async bind(
    req: AuthenticatedRequest,
    attachmentId: string,
    res: Response,
  ): Promise<ControlledSourceUploadContext> {
    if (
      res.destroyed ||
      res.writableEnded ||
      req.method !== "PUT" ||
      (req.originalUrl || req.url).split("?", 1)[0] !==
        "/api/v1/attachments/" + attachmentId + "/content"
    )
      return fail();
    const abort = new AbortController(),
      stop = () => abort.abort();
    const release = () => {
      req.removeListener("aborted", stop);
      res.removeListener("finish", finish);
      res.removeListener("close", finish);
    };
    const finish = () => {
      stop();
      release();
    };
    req.once("aborted", stop);
    res.once("finish", finish);
    res.once("close", finish);
    try {
      if (this.used.has(req)) return fail();
      this.used.add(req);
      const receipt = this.accounting.take(req);
      if (
        !receipt ||
        receipt.runId !== this.declarations.envelope.runId ||
        !req.user ||
        req.aborted
      )
        return fail();
      const actorId = req.user.user.id,
        sessionId = req.user.claims.sid,
        type = req.headers["content-type"],
        raw = req.headers["content-length"];
      if (
        typeof type !== "string" ||
        typeof raw !== "string" ||
        !/^[1-9][0-9]*$/.test(raw) ||
        !Number.isSafeInteger(Number(raw))
      )
        return fail();
      for (const name of ["content-type", "content-length"])
        if (
          req.rawHeaders.filter(
            (v, i) => i % 2 === 0 && v.toLowerCase() === name,
          ).length !== 1
        )
          return fail();
      const matches = this.declarations.operations.filter(
        (o) =>
          o.kind === "UPLOAD" &&
          o.case === "COMPLETE" &&
          o.attemptKeys.length === 1 &&
          o.attachmentId === attachmentId &&
          o.principal.kind === "ACTOR" &&
          o.principal.actorId === actorId &&
          o.principal.sessionId === sessionId &&
          o.contentType === type &&
          o.contentLength === Number(raw),
      );
      if (matches.length !== 1) return fail();
      const operation = matches[0];
      if (
        operation.kind !== "UPLOAD" ||
        !(this.declarations.internalCleanup ?? []).some(
          (e) => e.sourceOperationKey === operation.key,
        )
      )
        return fail();
      const policy = this.policies.find((p) => p.policyKey === operation.key),
        expected = this.candidates.find((c) => c.key === policy?.candidateKey);
      if (
        !policy ||
        policy.instances.length !== 1 ||
        policy.instances[0].policyAttemptKey !== operation.attemptKeys[0] ||
        policy.candidateKey !== receipt.candidateKey ||
        !expected ||
        expected.method !== "PUT" ||
        expected.path !== "/api/v1/attachments/" + attachmentId + "/content" ||
        expected.authClass !== "AUTH"
      )
        return fail();
      const h = await this.ledger.bindMatchedPolicy(receipt, {
        policyKey: policy.policyKey,
        instanceKeys: policy.instances.map((i) => i.instanceKey),
      });
      if (
        this.ledger.requireMatchedBoundOperation(h) !== h ||
        req.aborted ||
        res.destroyed ||
        res.writableEnded ||
        h.runId !== receipt.runId ||
        h.attemptKey !== receipt.attemptKey ||
        h.attachmentId !== attachmentId ||
        h.policyKey !== policy.policyKey ||
        h.policyAttemptKey !== policy.instances[0].policyAttemptKey ||
        h.operationKey !== policy.instances[0].instanceKey ||
        h.candidateKey !== expected.key ||
        (
          [
            "key",
            "method",
            "path",
            "authClass",
            "ingressBytes",
            "egressBytes",
          ] as const
        ).some((k) => h.candidate[k] !== expected[k])
      )
        return fail();
      return this.uploads.issue(
        h,
        {
          actorId,
          sessionId,
          contentType: type,
          contentLength: Number(raw),
          inputSha256: operation.inputSha256,
          initiationFingerprint: this.declarations.inventory.attachments.find(
            (a) => a.id === attachmentId,
          )!.initiation.fingerprint,
        },
        abort.signal,
      );
    } catch {
      release();
      return fail();
    }
  }
}
