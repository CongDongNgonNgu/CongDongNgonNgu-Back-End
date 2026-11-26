import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type {
  AttachmentRequestPolicy,
  AttachmentPolicyAction,
} from "../http/attachment-request-policy.port";
import { AttachmentInitiationUnavailable } from "../initiation/attachment-initiation-repository";
import type { PinnedDeclarations } from "./pinned-declarations";
import type { LoweredRequestPlan } from "./request-plan-lowering";
import type { RequestAccounting } from "./request-accounting";
import type {
  RunLedger,
  MatchedBoundOperation,
  RequestCandidate,
} from "./run-ledger";
const fail = (): never => {
  throw new AttachmentInitiationUnavailable();
};
/** Explicit post-native-guard diagnostic binding only. Pinned declarations and
 * lowering must belong to the same trusted composition. Native principal is not
 * refreshed/replaced here; normal service identity refresh and exact parent ACL
 * remain mandatory. No expected-denial assertion grants access. No provider I/O,
 * selected artifact proof, product allocation or runtime activation. */
export class ReadPolicyBinding implements AttachmentRequestPolicy {
  private readonly policies: LoweredRequestPlan["policies"];
  private readonly candidates: readonly Readonly<RequestCandidate>[];
  private readonly bound = new WeakMap<
    AuthenticatedRequest,
    MatchedBoundOperation
  >();
  private readonly used = new WeakSet<AuthenticatedRequest>();
  constructor(
    private readonly declarations: PinnedDeclarations,
    lowered: LoweredRequestPlan,
    private readonly accounting: Pick<RequestAccounting, "take">,
    private readonly ledger: Pick<
      RunLedger,
      "bindMatchedPolicy" | "requireMatchedBoundOperation"
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
    req: AuthenticatedRequest,
    action: AttachmentPolicyAction,
  ): Promise<{
    constraint?: "CURRENT_PARENT" | "AUTHENTICATED_PUBLIC_COMMUNITY";
  }> {
    try {
      if (this.used.has(req)) return fail();
      this.used.add(req);
      const receipt = this.accounting.take(req);
      if (!receipt || receipt.runId !== this.declarations.envelope.runId)
        return fail();
      const { kind, attachmentId } = action;
      const method = kind === "READ" ? action.method : "GET",
        variant = kind === "READ" ? action.variant : undefined,
        range = kind === "READ" ? (action.range ?? null) : null;
      const principal = req.user,
        actorId = principal?.user.id,
        sessionId = principal?.claims.sid;
      const supplied =
        Object.prototype.hasOwnProperty.call(req.headers, "authorization") ||
        req.rawHeaders.some(
          (v, i) => i % 2 === 0 && v.toLowerCase() === "authorization",
        );
      const matches = this.declarations.operations.filter((o) => {
        if (o.kind !== kind || o.attachmentId !== attachmentId) return false;
        if (
          o.kind === "READ" &&
          (o.method !== method || o.variant !== variant || o.range !== range)
        )
          return false;
        const p = o.principal;
        return p.kind === "ACTOR"
          ? !!principal && p.actorId === actorId && p.sessionId === sessionId
          : p.kind === "ANON"
            ? !principal && !supplied
            : p.kind === "PUBLIC_AUTHENTICATED"
              ? !!principal
              : false;
      });
      if (matches.length !== 1) return fail();
      const operation = matches[0];
      const policy = this.policies.find((p) => p.policyKey === operation.key);
      if (!policy || policy.candidateKey !== receipt.candidateKey)
        return fail();
      const expected = this.candidates.find(
        (c) => c.key === policy.candidateKey,
      );
      if (!expected) return fail();
      const path =
        "/api/v1/attachments/" +
        attachmentId +
        (kind === "READ"
          ? variant === "normalized"
            ? "/content"
            : "/preview"
          : "");
      if (
        expected.method !== method ||
        expected.path !== path ||
        expected.authClass !==
          (supplied || kind === "METADATA" ? "AUTH" : "ANON")
      )
        return fail();
      const handle = await this.ledger.bindMatchedPolicy(receipt, {
        policyKey: policy.policyKey,
        instanceKeys: policy.instances.map((i) => i.instanceKey),
      });
      this.ledger.requireMatchedBoundOperation(handle);
      if (
        handle.runId !== receipt.runId ||
        handle.attemptKey !== receipt.attemptKey ||
        handle.attachmentId !== attachmentId ||
        handle.policyKey !== policy.policyKey ||
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
        ).some((k) => expected[k] !== handle.candidate[k])
      )
        return fail();
      if (req.aborted) return fail();
      this.bound.set(req, handle);
      return {
        constraint:
          operation.principal.kind === "PUBLIC_AUTHENTICATED"
            ? "AUTHENTICATED_PUBLIC_COMMUNITY"
            : "CURRENT_PARENT",
      };
    } catch {
      return fail();
    }
  }
  /** Original local correlation only, not current ACL/expiry/provider authority. */
  take(req: AuthenticatedRequest): MatchedBoundOperation | undefined {
    const h = this.bound.get(req);
    this.bound.delete(req);
    if (!h || req.aborted) return undefined;
    return this.ledger.requireMatchedBoundOperation(h);
  }
}
