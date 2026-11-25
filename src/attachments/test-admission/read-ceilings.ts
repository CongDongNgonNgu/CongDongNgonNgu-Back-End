import {
  ATTACHMENT_LIMITS as L,
  type AttachmentFormat,
} from "../attachment-policy";
import { validateOperationDeclarations } from "./operation-declarations";
import {
  catalogueFromValidatedOperations,
  type RequestCatalogue,
} from "./request-catalogue";
import type { FixtureInventory } from "./fixture-inventory";
import type { ActivationEnvelope } from "./guard";
export interface ConservativeReadCeiling {
  readonly opKey: string;
  readonly attachmentId: string;
  readonly method: "GET" | "HEAD";
  readonly variant: "normalized" | "thumbnail";
  readonly format: AttachmentFormat;
  readonly outputCap: number;
}
export interface ReadCeilingCatalogue {
  readonly catalogue: RequestCatalogue;
  readonly reads: readonly ConservativeReadCeiling[];
}
/** Frozen derivative-output policy bound, never an actual artifact measurement. */
export function frozenReadOutputCap(
  format: AttachmentFormat,
  variant: "normalized" | "thumbnail",
): number {
  if (!["IMAGE", "VIDEO", "TEXT"].includes(format))
    throw Error("TEST_ADMISSION_READ_CEILINGS");
  if (variant === "thumbnail" && format !== "TEXT") return L.thumbnailBytes;
  if (variant !== "normalized") throw Error("TEST_ADMISSION_READ_CEILINGS");
  return format === "IMAGE"
    ? L.imageBytes
    : format === "VIDEO"
      ? L.videoBytes
      : L.textBytes;
}
/** Pure planning against frozen processor-output policy caps only. Inventory and
 * envelope are trusted validated snapshots. Source lengths, ranges and expected
 * denials never reduce the full derivative ceiling, including HEAD.
 * This neither measures artifacts nor proves selected-object/provider identity.
 * Future wiring must freshly check the exact planned derivative locator, current
 * ACL and provider integrity, and require 1<=full selected size<=outputCap<=the
 * reserved group ceiling before headers/output. No refunds, I/O or authority. */
export function compileConservativeReadCatalogue(
  rawOps: unknown,
  inventory: FixtureInventory,
  envelope: ActivationEnvelope,
): ReadCeilingCatalogue {
  try {
    const operations = validateOperationDeclarations(
      rawOps,
      inventory,
      envelope,
    );
    const fixtures = new Map(inventory.attachments.map((a) => [a.id, a]));
    const reads: ConservativeReadCeiling[] = [];
    for (const operation of operations) {
      if (operation.kind !== "READ") continue;
      const fixture = fixtures.get(operation.attachmentId);
      if (!fixture) throw Error("TEST_ADMISSION_READ_CEILINGS");
      const format = fixture.initiation.format;
      const outputCap = frozenReadOutputCap(format, operation.variant);
      const charge =
        operation.charges[
          operation.principal.kind === "ANON"
            ? "anonymousEgressBytes"
            : "authenticatedEgressBytes"
        ];
      if (charge < outputCap) throw Error("TEST_ADMISSION_READ_CEILINGS");
      reads.push(
        Object.freeze({
          opKey: operation.key,
          attachmentId: operation.attachmentId,
          method: operation.method,
          variant: operation.variant,
          format,
          outputCap,
        }),
      );
    }
    reads.sort((a, b) => (a.opKey < b.opKey ? -1 : a.opKey > b.opKey ? 1 : 0));
    // Use the same detached validated snapshot; never re-observe hostile raw records.
    const catalogue = catalogueFromValidatedOperations(operations, envelope);
    return Object.freeze({ catalogue, reads: Object.freeze(reads) });
  } catch {
    throw Error("TEST_ADMISSION_READ_CEILINGS");
  }
}
