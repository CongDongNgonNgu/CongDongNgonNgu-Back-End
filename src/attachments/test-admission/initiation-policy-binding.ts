import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type { PinnedDeclarations } from "./pinned-declarations";
import type { LoweredRequestPlan } from "./request-plan-lowering";
import type { RequestAccounting } from "./request-accounting";
import type { RunLedger, RequestCandidate } from "./run-ledger";
import type { ControlledInitiationContext } from "../initiation/controlled-initiation.port";
import type { AttachmentInitiationPolicy } from "../http/attachment-initiation-policy.port";
import { parseInitiation } from "../initiation/initiation-input";
import { AttachmentInitiationUnavailable } from "../initiation/attachment-initiation-repository";
const fail = (): never => {
  throw new AttachmentInitiationUnavailable();
};
/** Native principal/body correlation only. Normal session refresh and repository
 * current ACL remain mandatory. Expected denial never grants authorization. */
export class InitiationPolicyBinding implements AttachmentInitiationPolicy {
  private readonly used = new WeakSet<AuthenticatedRequest>();
  private readonly policies: LoweredRequestPlan["policies"];
  private readonly candidates: readonly Readonly<RequestCandidate>[];
  constructor(
    private readonly declarations: PinnedDeclarations,
    lowered: LoweredRequestPlan,
    private readonly accounting: Pick<RequestAccounting, "take">,
    private readonly ledger: Pick<
      RunLedger,
      | "bindMatchedPolicy"
      | "requireMatchedBoundOperation"
      | "issueMatchedInitiationContext"
    >,
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
    request: AuthenticatedRequest,
    input: unknown,
    response: Response,
  ): Promise<ControlledInitiationContext> {
    if (response.destroyed || response.writableEnded) return fail();
    const cancellation = new AbortController();
    const aborted = () => cancellation.abort();
    const release = () => {
      request.removeListener("aborted", aborted);
      response.removeListener("close", closed);
      response.removeListener("finish", finished);
    };
    const finished = () => {
      aborted();
      release();
    };
    const closed = () => {
      aborted();
      release();
    };
    request.once("aborted", aborted);
    response.once("close", closed);
    response.once("finish", finished);
    if (request.aborted) aborted();
    try {
      if (this.used.has(request)) return fail();
      this.used.add(request);
      const receipt = this.accounting.take(request);
      if (
        !receipt ||
        receipt.runId !== this.declarations.envelope.runId ||
        request.aborted ||
        !request.user
      )
        return fail();
      const actorId = request.user.user.id,
        sessionId = request.user.claims.sid,
        parsed = parseInitiation(input);
      const matches = this.declarations.operations.filter(
        (o) =>
          o.kind === "INITIATE" &&
          o.principal.kind === "ACTOR" &&
          o.principal.actorId === actorId &&
          o.principal.sessionId === sessionId &&
          o.body.fingerprint === parsed.fingerprint,
      );
      if (matches.length !== 1) return fail();
      const operation = matches[0],
        policy = this.policies.find((p) => p.policyKey === operation.key),
        expected = this.candidates.find((c) => c.key === policy?.candidateKey);
      if (
        !policy ||
        !expected ||
        policy.candidateKey !== receipt.candidateKey ||
        expected.method !== "POST" ||
        expected.path !== "/api/v1/attachments" ||
        expected.authClass !== "AUTH"
      )
        return fail();
      if (operation.kind !== "INITIATE") return fail();
      const creator =
        operation.creatorAttemptKey ??
        (operation.attemptKeys.length === 1
          ? operation.attemptKeys[0]
          : undefined);
      if (
        !creator ||
        !operation.attemptKeys.includes(creator) ||
        policy.instances.length !== operation.attemptKeys.length ||
        new Set(policy.instances.map((i) => i.policyAttemptKey)).size !==
          policy.instances.length ||
        policy.instances[0]?.policyAttemptKey !== creator ||
        policy.instances.some(
          (i) =>
            !operation.attemptKeys.includes(i.policyAttemptKey) ||
            i.initiationMode !==
              (i.policyAttemptKey === creator
                ? "CREATE_ALLOWED"
                : "REPLAY_ONLY"),
        )
      )
        return fail();
      const handle = await this.ledger.bindMatchedPolicy(receipt, {
        policyKey: policy.policyKey,
        instanceKeys: policy.instances.map((i) => i.instanceKey),
      });
      if (
        this.ledger.requireMatchedBoundOperation(handle) !== handle ||
        request.aborted ||
        response.destroyed ||
        response.writableEnded ||
        handle.runId !== receipt.runId ||
        handle.attemptKey !== receipt.attemptKey ||
        handle.policyKey !== policy.policyKey ||
        handle.attachmentId !== operation.attachmentId ||
        handle.candidateKey !== expected.key ||
        !policy.instances.some(
          (i) =>
            i.instanceKey === handle.operationKey &&
            i.policyAttemptKey === handle.policyAttemptKey,
        ) ||
        (
          [
            "key",
            "method",
            "path",
            "authClass",
            "ingressBytes",
            "egressBytes",
          ] as const
        ).some((k) => handle.candidate[k] !== expected[k])
      )
        return fail();
      return this.ledger.issueMatchedInitiationContext(
        handle,
        { actorId, sessionId, fingerprint: parsed.fingerprint },
        cancellation.signal,
        {
          policyKey: policy.policyKey,
          policyAttemptKey: handle.policyAttemptKey,
          creatorAttemptKey: creator,
          mode:
            handle.policyAttemptKey === creator
              ? "CREATE_ALLOWED"
              : "REPLAY_ONLY",
        },
      );
    } catch {
      release();
      return fail();
    }
  }
}
