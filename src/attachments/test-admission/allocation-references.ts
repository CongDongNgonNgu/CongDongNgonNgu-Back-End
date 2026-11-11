import { SLOT_ROLES } from "./run-ledger-schema";
import type { FixtureInventory } from "./fixture-inventory";
import type { ActivationEnvelope } from "./guard";
type Role = (typeof SLOT_ROLES)[number];
export interface AllocationReference {
  readonly operationKey: string;
  readonly attachmentId: string;
  readonly slotKeys: readonly string[];
}
export interface AllocationSlot {
  readonly key: string;
  readonly operationKey: string;
  readonly role: Role;
  readonly id: string;
  readonly attachmentId: string;
}
export interface AllocationReferences {
  readonly slots: readonly AllocationSlot[];
  readonly references: readonly AllocationReference[];
}
const fail = (): never => {
  throw Error("TEST_ADMISSION_ALLOCATION_REFERENCES");
};
function object(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
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
    n < 0 ||
    n > 256 ||
    Reflect.ownKeys(value).length !== n + 1
  )
    return fail();
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return fail();
    out.push(d.value);
  }
  return out;
}
function key(v: unknown): string {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v))
    return fail();
  return v;
}
function uuid(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      v,
    )
  )
    return fail();
  return v;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Pure reference integrity only. Inventory/envelope are validated snapshots.
 * trustedRefs must come from future reviewed HTTP-attempt/internal decoders;
 * accepting their shape proves neither authority nor role cardinality/completeness.
 * Later wiring must expand finite attempts, require context-specific allocations,
 * fail without random fallback/reused burned IDs, and define durable cleanup-only
 * behavior after expiry. It must not create fake HTTP requests for internal work. */
export function validateAllocationReferences(
  slotsUnknown: unknown,
  inventory: FixtureInventory,
  envelope: ActivationEnvelope,
  trustedRefs: unknown,
): AllocationReferences {
  try {
    const fixtures = new Map(inventory.attachments.map((a) => [a.id, a])),
      blocked = new Set<string>([envelope.runId, envelope.activationId]);
    for (const a of inventory.actors) {
      blocked.add(a.id);
      a.sessionIds.forEach((id) => blocked.add(id));
    }
    for (const a of inventory.attachments) {
      blocked.add(a.id);
      blocked.add(a.initiation.clientUploadId);
      if (a.generation !== null) blocked.add(a.generation);
      const intent = a.initiation.intent;
      if (intent.kind === "COMMUNITY") blocked.add(intent.languageId);
      else if (intent.kind === "STUDY_GROUP") blocked.add(intent.groupId);
      else blocked.add(intent.conversationId);
      const p = a.parent;
      if (p?.kind === "COMMUNITY") blocked.add(p.postId);
      else if (p?.kind === "STUDY_GROUP") {
        blocked.add(p.groupId);
        blocked.add(p.textId);
      } else if (p?.kind === "DIRECT_MESSAGE") {
        blocked.add(p.conversationId);
        blocked.add(p.messageId);
      }
    }
    const refs = new Map<string, AllocationReference>(),
      claimed = new Map<string, AllocationReference>();
    for (const value of array(trustedRefs)) {
      const r = object(value, ["operationKey", "attachmentId", "slotKeys"]),
        operationKey = key(r.operationKey),
        attachmentId = uuid(r.attachmentId);
      if (refs.has(operationKey) || !fixtures.has(attachmentId)) return fail();
      const slotKeys = array(r.slotKeys).map(key).sort(compare);
      if (new Set(slotKeys).size !== slotKeys.length) return fail();
      const ref = Object.freeze({
        operationKey,
        attachmentId,
        slotKeys: Object.freeze(slotKeys),
      });
      refs.set(operationKey, ref);
      for (const slotKey of slotKeys) {
        if (claimed.has(slotKey)) return fail();
        claimed.set(slotKey, ref);
        if (claimed.size > 256) return fail();
      }
    }
    const ids = new Set<string>(),
      keys = new Set<string>(),
      attachmentCounts = new Map<string, number>();
    const slots = array(slotsUnknown)
      .map((value) => {
        const s = object(value, [
            "key",
            "operationKey",
            "role",
            "id",
            "attachmentId",
          ]),
          slotKey = key(s.key),
          operationKey = key(s.operationKey),
          id = uuid(s.id),
          attachmentId = uuid(s.attachmentId);
        if (
          keys.has(slotKey) ||
          ids.has(id) ||
          !fixtures.has(attachmentId) ||
          typeof s.role !== "string" ||
          !SLOT_ROLES.includes(s.role as Role)
        )
          return fail();
        const role = s.role as Role,
          ref = claimed.get(slotKey);
        if (
          !ref ||
          ref.operationKey !== operationKey ||
          ref.attachmentId !== attachmentId
        )
          return fail();
        if (role === "ATTACHMENT") {
          if (id !== attachmentId) return fail();
          attachmentCounts.set(
            attachmentId,
            (attachmentCounts.get(attachmentId) ?? 0) + 1,
          );
        } else if (blocked.has(id)) return fail();
        ids.add(id);
        keys.add(slotKey);
        return Object.freeze({
          key: slotKey,
          operationKey,
          role,
          id,
          attachmentId,
        });
      })
      .sort((a, b) => compare(a.key, b.key));
    if (
      keys.size !== claimed.size ||
      inventory.attachments.some((a) => attachmentCounts.get(a.id) !== 1)
    )
      return fail();
    return Object.freeze({
      slots: Object.freeze(slots),
      references: Object.freeze(
        [...refs.values()].sort((a, b) =>
          compare(a.operationKey, b.operationKey),
        ),
      ),
    });
  } catch {
    return fail();
  }
}
