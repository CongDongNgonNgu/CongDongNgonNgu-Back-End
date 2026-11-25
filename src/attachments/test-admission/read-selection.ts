import type { AttachmentFormat } from "../attachment-policy";
import type { AttachmentStoredObject } from "../storage/attachment-storage.port";
import type { PinnedDeclarations } from "./pinned-declarations";
import { frozenReadOutputCap } from "./read-ceilings";
export type PlannedReadDeclarations = Pick<
  PinnedDeclarations,
  "inventory" | "operations" | "objectIdentities" | "catalogue"
>;
export interface AdmittedReadSelection {
  readonly method: "GET" | "HEAD";
  readonly format: AttachmentFormat;
  readonly object: AttachmentStoredObject;
}
export interface PlannedReadSelection {
  readonly opKey: string;
  readonly method: "GET" | "HEAD";
  readonly format: AttachmentFormat;
  readonly object: {
    readonly locator: Readonly<AttachmentStoredObject["locator"]>;
    readonly sizeBytes: number;
  };
  readonly outputCap: number;
  readonly plannedEgressBytes: number;
}
const fail = (): never => {
  throw Error("TEST_ADMISSION_READ_SELECTION");
};
/** Pure successful-selection consistency check. Declarations must be the same
 * trusted pinned validator output; selected must come from fresh normal ACL
 * admission. Neither precondition is established by this function or its result.
 * Compares full size, never Range length, for both GET and HEAD. Returns only
 * compared facts: hashes/versions are deliberately omitted, not provider-proved.
 * No request reservation, expiry/identity checks, ACL or provider I/O, headers,
 * authority, runtime wiring or refunds. Future controlled integration must prove
 * the matching durable reservation and provider integrity before headers/output.
 * Expected-denial declarations never become successful selection acceptance;
 * ordinary ACL/invalid-Range error precedence remains the service's concern. */
export function validatePlannedReadSelection(
  declarations: PlannedReadDeclarations,
  opKey: string,
  selected: AdmittedReadSelection,
): PlannedReadSelection {
  try {
    const { method, format, object } = selected;
    const { locator, sizeBytes } = object;
    const operation = declarations.operations.find((o) => o.key === opKey);
    if (
      !operation ||
      operation.kind !== "READ" ||
      operation.assertion !== "NORMAL_AUTHORIZATION" ||
      operation.method !== method
    )
      return fail();
    const fixture = declarations.inventory.attachments.find(
      (a) => a.id === operation.attachmentId,
    );
    if (!fixture || fixture.initiation.format !== format) return fail();
    const outputCap = frozenReadOutputCap(format, operation.variant);
    const identity = declarations.objectIdentities.find(
      (o) =>
        o.attachmentId === operation.attachmentId &&
        o.variant === operation.variant,
    );
    // Identity's operationKey belongs to its FINALIZE creator, not this READ.
    const { attachmentId, attemptId, objectId, kind } = locator;
    if (
      !identity ||
      attachmentId !== identity.attachmentId ||
      attemptId !== identity.attemptId ||
      objectId !== identity.objectId ||
      kind !== identity.variant ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > outputCap
    )
      return fail();
    const path =
      "/api/v1/attachments/" +
      operation.attachmentId +
      (operation.variant === "normalized" ? "/content" : "/preview");
    const authClass = operation.principal.kind === "ANON" ? "ANON" : "AUTH";
    const group = declarations.catalogue.groups.find(
      (g) =>
        g.method === operation.method &&
        g.path === path &&
        g.authClass === authClass &&
        g.policies.some((p) => p.operationKey === opKey),
    );
    if (
      !group ||
      !Number.isSafeInteger(group.egressBytes) ||
      group.egressBytes < outputCap
    )
      return fail();
    return Object.freeze({
      opKey,
      method: operation.method,
      format,
      object: Object.freeze({
        locator: Object.freeze({ attachmentId, attemptId, objectId, kind }),
        sizeBytes,
      }),
      outputCap,
      plannedEgressBytes: group.egressBytes,
    });
  } catch {
    return fail();
  }
}
