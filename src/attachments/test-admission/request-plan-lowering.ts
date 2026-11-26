import { DIAGNOSTIC_JSON_INGRESS_CAP } from "./diagnostic-ingress-policy";
import type { PinnedDeclarations } from "./pinned-declarations";
import type {
  PreparedRun,
  BindingOperation,
  BindingEdge,
  RunSlot,
} from "./run-ledger";
import { RUN_LIMITS } from "./run-ledger-schema";
import {
  compileCoarseRequestPlan,
  type CoarseRequestPlan,
} from "./coarse-request-plan";
export interface LoweredPolicy {
  readonly policyKey: string;
  readonly candidateKey: string;
  readonly instances: readonly {
    readonly instanceKey: string;
    readonly policyAttemptKey: string;
  }[];
}
export interface LoweredRequestPlan {
  prepared: PreparedRun;
  coarse: CoarseRequestPlan;
  policies: readonly LoweredPolicy[];
}
const fail = (): never => {
  throw Error("TEST_ADMISSION_REQUEST_LOWERING");
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Consistency lowering from one trusted pinned declaration snapshot only.
 * Preserves literal identity and declared UUIDs. Complete Cartesian compatibility
 * is capped at the existing140edges; allocating retries lack distinct ownership
 * in the current schema and are rejected. No UUID generation, role-cardinality
 * completion, provider ownership, matcher, activation or executable-manifest grant.
 * Original object creator policy keys remain unchanged in pinned declarations. */
export function lowerPinnedRequestPlan(
  declarations: PinnedDeclarations,
): LoweredRequestPlan {
  try {
    const coarse = compileCoarseRequestPlan(
      declarations.catalogue,
      declarations.envelope,
    );
    const operations: BindingOperation[] = [],
      edges: BindingEdge[] = [],
      slots: RunSlot[] = [],
      policies: LoweredPolicy[] = [];
    const transferred = new Set<string>(),
      seenPolicies = new Set<string>();
    const sourceSlots = new Map(
      declarations.allocations.slots.map((s) => [s.key, s]),
    );
    if (
      sourceSlots.size !== declarations.allocations.slots.length ||
      sourceSlots.size < 1 ||
      sourceSlots.size > 256
    )
      return fail();
    for (const policy of [...declarations.operations].sort((a, b) =>
      compare(a.key, b.key),
    )) {
      if (
        (["INITIATE", "PATCH_METADATA"].includes(policy.kind) &&
          policy.charges.ingressBytes < DIAGNOSTIC_JSON_INGRESS_CAP) ||
        seenPolicies.has(policy.key) ||
        policy.attemptKeys.length < 1 ||
        policy.attemptKeys.length > 140 ||
        (policy.slotKeys.length > 0 && policy.attemptKeys.length !== 1)
      )
        return fail();
      if (policy.kind === "INITIATE") {
        const slot =
          policy.slotKeys.length === 1
            ? sourceSlots.get(policy.slotKeys[0])
            : undefined;
        if (
          !slot ||
          slot.role !== "ATTACHMENT" ||
          slot.id !== policy.attachmentId ||
          slot.attachmentId !== policy.attachmentId ||
          slot.operationKey !== policy.key
        )
          return fail();
      }
      seenPolicies.add(policy.key);
      const groups = coarse.candidates.filter((c) =>
        c.policyKeys.includes(policy.key),
      );
      if (groups.length !== 1) return fail();
      const candidateKey = groups[0].candidateKey;
      const instances = [...policy.attemptKeys]
        .sort(compare)
        .map((policyAttemptKey) => {
          if (operations.length >= 140) return fail();
          const instanceKey =
            "policy-i" + String(operations.length).padStart(3, "0");
          const slotKeys = [...policy.slotKeys].sort(compare);
          for (const slotKey of slotKeys) {
            const s = sourceSlots.get(slotKey);
            if (
              !s ||
              transferred.has(slotKey) ||
              s.operationKey !== policy.key ||
              s.attachmentId !== policy.attachmentId
            )
              return fail();
            transferred.add(slotKey);
            slots.push({ ...s, operationKey: instanceKey });
          }
          operations.push({
            key: instanceKey,
            policyKey: policy.key,
            policyAttemptKey,
            attachmentId: policy.attachmentId,
            ingressBytes: policy.charges.ingressBytes,
            egressBytes:
              policy.charges[
                policy.principal.kind === "ANON"
                  ? "anonymousEgressBytes"
                  : "authenticatedEgressBytes"
              ],
            processingAttempts: policy.charges.processingAttempts,
            slotKeys,
          });
          return Object.freeze({ instanceKey, policyAttemptKey });
        });
      policies.push(
        Object.freeze({
          policyKey: policy.key,
          candidateKey,
          instances: Object.freeze(instances),
        }),
      );
    }
    if (
      transferred.size !== sourceSlots.size ||
      coarse.candidates.some((c) =>
        c.policyKeys.some((k) => !seenPolicies.has(k)),
      )
    )
      return fail();
    for (const group of coarse.candidates) {
      const attempts = coarse.requests.attempts.filter(
        (a) => a.candidateKey === group.candidateKey,
      );
      const instances = policies
        .filter((p) => p.candidateKey === group.candidateKey)
        .flatMap((p) => p.instances);
      if (
        attempts.length !== group.attemptCount ||
        instances.length !== group.attemptCount ||
        edges.length + attempts.length * instances.length > 140
      )
        return fail();
      for (const a of attempts)
        for (const i of instances)
          edges.push({ attemptKey: a.key, operationKey: i.instanceKey });
    }
    if (operations.length < 1 || edges.length < 1) return fail();
    const limits = Object.fromEntries(
      Object.keys(RUN_LIMITS).map((k) => {
        const axis = k as keyof typeof RUN_LIMITS,
          value = declarations.envelope.budgets[axis];
        if (
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > RUN_LIMITS[axis]
        )
          return fail();
        return [axis, value];
      }),
    ) as PreparedRun["limits"];
    const prepared: PreparedRun = {
      runId: declarations.envelope.runId,
      activationId: declarations.envelope.activationId,
      sourceSha: declarations.sourceSha,
      manifestSha256: declarations.manifestSha256,
      notBefore: declarations.envelope.notBefore,
      expiresAt: declarations.envelope.expiresAt,
      limits,
      slots: slots.sort((a, b) => compare(a.key, b.key)),
      requests: coarse.requests,
      bindings: {
        operations,
        edges: edges.sort(
          (a, b) =>
            compare(a.attemptKey, b.attemptKey) ||
            compare(a.operationKey, b.operationKey),
        ),
      },
      activationControlRequired: true,
    };
    return { prepared, coarse, policies: Object.freeze(policies) };
  } catch {
    return fail();
  }
}
