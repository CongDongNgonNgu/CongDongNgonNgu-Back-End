import {
  validatePinnedLiteral,
  validateEnvelopeValue,
  type ActivationInputs,
  type ActivationEnvelope,
} from "./guard";
import {
  validateFixtureInventory,
  type FixtureInventory,
} from "./fixture-inventory";
import {
  validateOperationDeclarations,
  type OperationDeclaration,
} from "./operation-declarations";
import {
  validateAllocationReferences,
  type AllocationReferences,
} from "./allocation-references";
import {
  validateObjectIdentities,
  type ObjectIdentityTuple,
} from "./object-identities";
import { type RequestCatalogue } from "./request-catalogue";
import { compileConservativeReadCatalogue } from "./read-ceilings";

export interface PinnedDeclarations {
  readonly sourceSha: string;
  readonly deploymentId: string;
  readonly manifestSha256: string;
  readonly envelope: ActivationEnvelope;
  readonly inventory: FixtureInventory;
  readonly operations: readonly OperationDeclaration[];
  readonly allocations: AllocationReferences;
  readonly objectIdentities: readonly ObjectIdentityTuple[];
  readonly catalogue: RequestCatalogue;
}
const fields = [
  "schema",
  "envelope",
  "inventory",
  "operations",
  "allocationSlots",
  "objectIdentities",
] as const;
const fail = (): never => {
  throw Error("TEST_ADMISSION_DECLARATIONS");
};
function root(value: unknown): Record<(typeof fields)[number], unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key as (typeof fields)[number]),
    )
  )
    return fail();
  const result = Object.create(null) as Record<
    (typeof fields)[number],
    unknown
  >;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return fail();
    result[key] = descriptor.value;
  }
  if (result.schema !== 1) return fail();
  return result;
}
/** Pure declarations for complete planned source/derivative identities.
 * All sections come from one identity-checked literal.
 * Read declarations must cover frozen full derivative caps, including HEAD/ranges.
 * No independently supplied snapshots are accepted. This is not a complete
 * executable manifest or proof of actual object/HEAD bytes, role cardinality,
 * attempt/allocation compatibility, internal cleanup, provider/source provenance,
 * boot activation or request authority. No ledger preparation, I/O or runtime
 * wiring. Legacy envelope-only guard behavior remains unchanged. */
export function validatePinnedDeclarations(
  options?: ActivationInputs,
): PinnedDeclarations | null {
  try {
    const pinned = validatePinnedLiteral(options);
    if (pinned === null) return null;
    const raw = root(pinned.value);
    const envelope = validateEnvelopeValue(raw.envelope, pinned.nowMs);
    const inventory = validateFixtureInventory(raw.inventory, envelope);
    const operations = validateOperationDeclarations(
      raw.operations,
      inventory,
      envelope,
    );
    const refs = operations.map((operation) => ({
      operationKey: operation.key,
      attachmentId: operation.attachmentId,
      slotKeys: operation.slotKeys,
    }));
    const allocations = validateAllocationReferences(
      raw.allocationSlots,
      inventory,
      envelope,
      refs,
    );
    const objectIdentities = validateObjectIdentities(
      raw.objectIdentities,
      inventory,
      allocations,
    );
    const byKey = new Map(
      operations.map((operation) => [operation.key, operation]),
    );
    for (const identity of objectIdentities) {
      const operation = byKey.get(identity.operationKey);
      if (
        !operation ||
        operation.attachmentId !== identity.attachmentId ||
        operation.kind !==
          (identity.variant === "source" ? "UPLOAD" : "FINALIZE")
      )
        return fail();
    }
    for (const slot of allocations.slots) {
      if (slot.role !== "ATTACHMENT") continue;
      const operation = byKey.get(slot.operationKey);
      if (
        !operation ||
        operation.kind !== "INITIATE" ||
        operation.attachmentId !== slot.attachmentId
      )
        return fail();
    }
    // Revalidate the same frozen raw records. Parsed INITIATE bodies are not raw DTOs.
    const { catalogue } = compileConservativeReadCatalogue(
      raw.operations,
      inventory,
      envelope,
    );
    return Object.freeze({
      sourceSha: pinned.sourceSha,
      deploymentId: pinned.deploymentId,
      manifestSha256: pinned.manifestSha256,
      envelope,
      inventory,
      operations,
      allocations,
      objectIdentities,
      catalogue,
    });
  } catch {
    return fail();
  }
}
