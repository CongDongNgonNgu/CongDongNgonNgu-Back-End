import {
  validateOperationDeclarations,
  type OperationDeclaration,
} from "./operation-declarations";
import { RUN_LIMITS } from "./run-ledger-schema";
import type { FixtureInventory } from "./fixture-inventory";
import type { ActivationEnvelope } from "./guard";

const axes = [
  "authenticatedRequests",
  "anonymousRequests",
  "ingressBytes",
  "authenticatedEgressBytes",
  "anonymousEgressBytes",
] as const;
export type RequestCatalogueTotals = Readonly<
  Record<(typeof axes)[number], number>
>;
export interface RequestCataloguePolicy {
  readonly operationKey: string;
  readonly attemptKeys: readonly string[];
}
export interface RequestCatalogueGroup {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly authClass: "AUTH" | "ANON";
  readonly ingressBytes: number;
  readonly egressBytes: number;
  readonly attemptCount: number;
  readonly policies: readonly RequestCataloguePolicy[];
}
export interface RequestCatalogue {
  readonly groups: readonly RequestCatalogueGroup[];
  readonly totals: RequestCatalogueTotals;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function route(
  operation: OperationDeclaration,
): readonly [RequestCatalogueGroup["method"], string] {
  const base = "/api/v1/attachments",
    item = base + "/" + operation.attachmentId;
  switch (operation.kind) {
    case "INITIATE":
      return ["POST", base];
    case "METADATA":
      return ["GET", item];
    case "PATCH_METADATA":
      return ["PATCH", item + "/metadata"];
    case "DELETE":
      return ["DELETE", item];
    case "UPLOAD":
      return ["PUT", item + "/content"];
    case "FINALIZE":
      return ["POST", item + "/finalize"];
    case "READ":
      return [
        operation.method,
        item + (operation.variant === "normalized" ? "/content" : "/preview"),
      ];
  }
}
/** Pure declaration catalogue only. Operations/envelope must be trusted validator-output
 * snapshots; this helper does not accept raw operation records. No full-manifest, source
 * or actual-object-size proof, request matcher, identity/ACL or runtime grant.
 * Ceilings are maxima of declared policy charges, including HEAD declarations;
 * later provenance/selection must prove the full chosen object fits, even HEAD.
 * Policy attempt names are provenance, NOT coarse request-slot/operation edges.
 * No ledger preparation, allocation expansion, I/O, activation or cleanup. */
export function catalogueFromValidatedOperations(
  operations: readonly OperationDeclaration[],
  envelope: ActivationEnvelope,
): RequestCatalogue {
  try {
    const groups = new Map<
      string,
      {
        method: RequestCatalogueGroup["method"];
        path: string;
        authClass: "AUTH" | "ANON";
        ingressBytes: number;
        egressBytes: number;
        attemptCount: number;
        policies: RequestCataloguePolicy[];
      }
    >();
    for (const operation of operations) {
      const [method, path] = route(operation);
      const authClass = operation.principal.kind === "ANON" ? "ANON" : "AUTH";
      const signature = JSON.stringify([method, path, authClass]);
      const group = groups.get(signature) ?? {
        method,
        path,
        authClass,
        ingressBytes: 0,
        egressBytes: 0,
        attemptCount: 0,
        policies: [],
      };
      group.ingressBytes = Math.max(
        group.ingressBytes,
        operation.charges.ingressBytes,
      );
      group.egressBytes = Math.max(
        group.egressBytes,
        operation.charges[
          authClass === "ANON"
            ? "anonymousEgressBytes"
            : "authenticatedEgressBytes"
        ],
      );
      group.attemptCount += operation.attemptKeys.length;
      group.policies.push(
        Object.freeze({
          operationKey: operation.key,
          attemptKeys: Object.freeze([...operation.attemptKeys].sort(compare)),
        }),
      );
      groups.set(signature, group);
    }
    const totals = {
      authenticatedRequests: 0,
      anonymousRequests: 0,
      ingressBytes: 0,
      authenticatedEgressBytes: 0,
      anonymousEgressBytes: 0,
    };
    const ordered = [...groups.values()].sort(
      (a, b) =>
        compare(a.method, b.method) ||
        compare(a.path, b.path) ||
        compare(a.authClass, b.authClass),
    );
    for (const group of ordered) {
      totals[
        group.authClass === "ANON"
          ? "anonymousRequests"
          : "authenticatedRequests"
      ] += group.attemptCount;
      totals.ingressBytes += group.ingressBytes * group.attemptCount;
      totals[
        group.authClass === "ANON"
          ? "anonymousEgressBytes"
          : "authenticatedEgressBytes"
      ] += group.egressBytes * group.attemptCount;
      if (
        axes.some(
          (axis) =>
            !Number.isSafeInteger(totals[axis]) ||
            totals[axis] > Math.min(RUN_LIMITS[axis], envelope.budgets[axis]),
        )
      ) {
        throw Error("TEST_ADMISSION_CATALOGUE");
      }
    }
    return Object.freeze({
      groups: Object.freeze(
        ordered.map((group) =>
          Object.freeze({
            ...group,
            policies: Object.freeze(
              group.policies.sort((a, b) =>
                compare(a.operationKey, b.operationKey),
              ),
            ),
          }),
        ),
      ),
      totals: Object.freeze(totals),
    });
  } catch {
    throw Error("TEST_ADMISSION_CATALOGUE");
  }
}

/** Raw-record compatibility API: validate once, then group the detached snapshot.
 * The internal grouping helper requires trusted validator output, not authority. */
export function compileRequestCatalogue(
  value: unknown,
  inventory: FixtureInventory,
  envelope: ActivationEnvelope,
): RequestCatalogue {
  try {
    return catalogueFromValidatedOperations(
      validateOperationDeclarations(value, inventory, envelope),
      envelope,
    );
  } catch {
    throw Error("TEST_ADMISSION_CATALOGUE");
  }
}
