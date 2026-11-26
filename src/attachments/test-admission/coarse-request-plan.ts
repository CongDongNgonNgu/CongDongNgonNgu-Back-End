import type {
  RequestCatalogue,
  RequestCatalogueGroup,
} from "./request-catalogue";
import type { ActivationEnvelope } from "./guard";
import type { RequestPreparation } from "./run-ledger";
import { RUN_LIMITS } from "./run-ledger-schema";
export interface CoarseCandidateProvenance {
  readonly candidateKey: string;
  readonly method: RequestCatalogueGroup["method"];
  readonly path: string;
  readonly authClass: "AUTH" | "ANON";
  readonly policyKeys: readonly string[];
  readonly attemptCount: number;
}
export interface CoarseRequestPlan {
  requests: RequestPreparation;
  candidates: readonly CoarseCandidateProvenance[];
}
const axes = [
  "authenticatedRequests",
  "anonymousRequests",
  "ingressBytes",
  "authenticatedEgressBytes",
  "anonymousEgressBytes",
] as const;
const fail = (): never => {
  throw Error("TEST_ADMISSION_COARSE_PLAN");
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function route(method: string, path: string): boolean {
  const base = "/api/v1/attachments";
  if (path === base) return method === "POST";
  const match =
    /^\/api\/v1\/attachments\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\/(content|preview|metadata|finalize))?$/.exec(
      path,
    );
  if (!match) return false;
  return match[1] === undefined
    ? ["GET", "DELETE"].includes(method)
    : match[1] === "metadata"
      ? method === "PATCH"
      : match[1] === "finalize"
        ? method === "POST"
        : match[1] === "preview"
          ? ["GET", "HEAD"].includes(method)
          : ["GET", "HEAD", "PUT"].includes(method);
}
/** Pure coarse inventory from trusted validated catalogue/envelope snapshots.
 * Recompute conservative maxima times counts. New slot names identify only
 * pre-parser accounting attempts, never actor policies, allocations or grants.
 * No bindings, ledger preparation, activation or I/O. */
export function compileCoarseRequestPlan(
  catalogue: RequestCatalogue,
  envelope: ActivationEnvelope,
): CoarseRequestPlan {
  try {
    if (
      !Array.isArray(catalogue.groups) ||
      catalogue.groups.length < 1 ||
      catalogue.groups.length > 140
    )
      return fail();
    const signatures = new Set<string>(),
      policies = new Set<string>();
    const groups = catalogue.groups
      .map((g: RequestCatalogueGroup) => {
        if (
          typeof g.method !== "string" ||
          typeof g.path !== "string" ||
          !route(g.method, g.path) ||
          (g.authClass !== "AUTH" && g.authClass !== "ANON") ||
          !Number.isSafeInteger(g.attemptCount) ||
          g.attemptCount < 1 ||
          g.attemptCount > 140 ||
          !Number.isSafeInteger(g.ingressBytes) ||
          g.ingressBytes < 0 ||
          !Number.isSafeInteger(g.egressBytes) ||
          g.egressBytes < 0 ||
          !Array.isArray(g.policies) ||
          g.policies.length < 1 ||
          g.policies.length > 140
        )
          return fail();
        if (
          g.authClass === "ANON" &&
          (g.ingressBytes !== 0 ||
            !["GET", "HEAD"].includes(g.method) ||
            !/(content|preview)$/.test(g.path))
        )
          return fail();
        const signature = JSON.stringify([g.method, g.path, g.authClass]);
        if (signatures.has(signature)) return fail();
        signatures.add(signature);
        let count = 0;
        const policyKeys = g.policies
          .map((p: RequestCatalogueGroup["policies"][number]) => {
            if (
              typeof p.operationKey !== "string" ||
              !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(p.operationKey) ||
              policies.has(p.operationKey) ||
              !Array.isArray(p.attemptKeys) ||
              p.attemptKeys.length < 1 ||
              p.attemptKeys.length > 140
            )
              return fail();
            policies.add(p.operationKey);
            count += p.attemptKeys.length;
            return p.operationKey;
          })
          .sort(compare);
        if (count !== g.attemptCount) return fail();
        return {
          method: g.method,
          path: g.path,
          authClass: g.authClass,
          ingressBytes: g.ingressBytes,
          egressBytes: g.egressBytes,
          attemptCount: count,
          policyKeys,
        };
      })
      .sort(
        (a, b) =>
          compare(a.method, b.method) ||
          compare(a.path, b.path) ||
          compare(a.authClass, b.authClass),
      );
    const totals = {
        authenticatedRequests: 0,
        anonymousRequests: 0,
        ingressBytes: 0,
        authenticatedEgressBytes: 0,
        anonymousEgressBytes: 0,
      },
      requests: RequestPreparation = { candidates: [], attempts: [] },
      candidates: CoarseCandidateProvenance[] = [];
    for (const [i, g] of groups.entries()) {
      totals[
        g.authClass === "AUTH" ? "authenticatedRequests" : "anonymousRequests"
      ] += g.attemptCount;
      totals.ingressBytes += g.ingressBytes * g.attemptCount;
      totals[
        g.authClass === "AUTH"
          ? "authenticatedEgressBytes"
          : "anonymousEgressBytes"
      ] += g.egressBytes * g.attemptCount;
      if (
        axes.some(
          (k) =>
            !Number.isSafeInteger(totals[k]) ||
            !Number.isSafeInteger(envelope.budgets[k]) ||
            envelope.budgets[k] < 1 ||
            totals[k] > Math.min(RUN_LIMITS[k], envelope.budgets[k]),
        ) ||
        requests.attempts.length + g.attemptCount > 140
      )
        return fail();
      const key = "coarse-c" + String(i).padStart(3, "0");
      requests.candidates.push({
        key,
        method: g.method,
        path: g.path,
        authClass: g.authClass,
        ingressBytes: g.ingressBytes,
        egressBytes: g.egressBytes,
      });
      for (let n = 0; n < g.attemptCount; n++)
        requests.attempts.push({
          key: "coarse-r" + String(requests.attempts.length).padStart(3, "0"),
          candidateKey: key,
        });
      candidates.push(
        Object.freeze({
          candidateKey: key,
          method: g.method,
          path: g.path,
          authClass: g.authClass,
          policyKeys: Object.freeze(g.policyKeys),
          attemptCount: g.attemptCount,
        }),
      );
    }
    return { requests, candidates: Object.freeze(candidates) };
  } catch {
    return fail();
  }
}
