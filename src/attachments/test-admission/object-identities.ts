import type { FixtureInventory } from "./fixture-inventory";
import type {
  AllocationReferences,
  AllocationSlot,
} from "./allocation-references";
export interface ObjectIdentityTuple {
  readonly attachmentId: string;
  readonly variant: "source" | "normalized" | "thumbnail";
  readonly objectId: string;
  readonly attemptId: string;
  readonly putClaimId: string;
  readonly supervisionId: string;
  readonly operationKey: string;
}
const fail = (): never => {
  throw Error("TEST_ADMISSION_OBJECT_IDENTITIES");
};
const names = [
  "attachmentId",
  "variant",
  "objectId",
  "attemptId",
  "putClaimId",
  "supervisionId",
  "operationKey",
];
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((k) => typeof k !== "string" || !names.includes(k))
  )
    return fail();
  const out = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !d.enumerable || !("value" in d)) return fail();
    out[name] = d.value;
  }
  return out;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail();
  const n = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > 12 ||
    Reflect.ownKeys(value).length !== n + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return fail();
    result.push(d.value);
  }
  return result;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    return fail();
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value))
    return fail();
  return value;
}
const relevant = new Set<AllocationSlot["role"]>([
  "SOURCE_OBJECT",
  "SOURCE_ATTEMPT",
  "NORMALIZED_OBJECT",
  "THUMBNAIL_OBJECT",
  "DERIVATIVE_ATTEMPT",
  "PUT_CLAIM",
  "PUT_SUPERVISION",
]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Inventory and allocation references are already validated snapshots.
 * This describes successful COMPLETE planned lifecycle coverage only, not
 * partial/retry/orphan-only scenarios. Tuples declare associations; they are
 * not actual claims, version/lease/content facts, supervision certificates or
 * cleanup authority. A later typed decoder must establish source UPLOAD and
 * derivative FINALIZE contexts; arbitrary graph operation keys do not prove it.
 * Same-operation claims have no preexisting variant binding in generic slots:
 * these tuples declare that binding, not independently verify runtime history. */
export function validateObjectIdentities(
  value: unknown,
  inventory: FixtureInventory,
  graph: AllocationReferences,
): readonly ObjectIdentityTuple[] {
  try {
    const fixtures = new Map(inventory.attachments.map((a) => [a.id, a]));
    const slots = new Map(graph.slots.map((s) => [s.id, s])),
      used = new Set<string>(),
      unique = new Set<string>(),
      byAttachment = new Map<string, Map<string, ObjectIdentityTuple>>();
    const result = array(value).map((raw) => {
      const r = object(raw),
        attachmentId = uuid(r.attachmentId),
        objectId = uuid(r.objectId),
        attemptId = uuid(r.attemptId),
        putClaimId = uuid(r.putClaimId),
        supervisionId = uuid(r.supervisionId),
        operationKey = key(r.operationKey);
      if (
        !fixtures.has(attachmentId) ||
        (r.variant !== "source" &&
          r.variant !== "normalized" &&
          r.variant !== "thumbnail")
      )
        return fail();
      const variant = r.variant,
        fixture = fixtures.get(attachmentId)!;
      if (variant === "thumbnail" && fixture.initiation.format === "TEXT")
        return fail();
      const expected: [string, AllocationSlot["role"]][] = [
        [
          objectId,
          variant === "source"
            ? "SOURCE_OBJECT"
            : variant === "normalized"
              ? "NORMALIZED_OBJECT"
              : "THUMBNAIL_OBJECT",
        ],
        [
          attemptId,
          variant === "source" ? "SOURCE_ATTEMPT" : "DERIVATIVE_ATTEMPT",
        ],
        [putClaimId, "PUT_CLAIM"],
        [supervisionId, "PUT_SUPERVISION"],
      ];
      for (const [id, role] of expected) {
        const s = slots.get(id);
        if (
          !s ||
          s.role !== role ||
          s.attachmentId !== attachmentId ||
          s.operationKey !== operationKey
        )
          return fail();
        used.add(id);
      }
      for (const id of [objectId, putClaimId, supervisionId]) {
        if (unique.has(id)) return fail();
        unique.add(id);
      }
      const variants =
        byAttachment.get(attachmentId) ??
        new Map<string, ObjectIdentityTuple>();
      if (variants.has(variant)) return fail();
      const tuple = Object.freeze({
        attachmentId,
        variant,
        objectId,
        attemptId,
        putClaimId,
        supervisionId,
        operationKey,
      });
      variants.set(variant, tuple);
      byAttachment.set(attachmentId, variants);
      return tuple;
    });
    for (const fixture of inventory.attachments) {
      const variants = byAttachment.get(fixture.id),
        source = variants?.get("source"),
        normalized = variants?.get("normalized"),
        thumbnail = variants?.get("thumbnail");
      if (
        !source ||
        !normalized ||
        variants!.size !== (fixture.initiation.format === "TEXT" ? 2 : 3)
      )
        return fail();
      if (
        fixture.initiation.format !== "TEXT" &&
        (!thumbnail ||
          thumbnail.attemptId !== normalized.attemptId ||
          thumbnail.operationKey !== normalized.operationKey)
      )
        return fail();
    }
    if (graph.slots.some((s) => relevant.has(s.role) && !used.has(s.id)))
      return fail();
    return Object.freeze(
      result.sort(
        (a, b) =>
          compare(a.attachmentId, b.attachmentId) ||
          compare(a.variant, b.variant),
      ),
    );
  } catch {
    return fail();
  }
}
