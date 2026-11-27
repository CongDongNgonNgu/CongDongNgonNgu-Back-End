import type { FixtureInventory } from "./fixture-inventory";
import type { OperationDeclaration } from "./operation-declarations";
export interface SourceCleanupDeclaration {
  readonly key: string;
  readonly sourceOperationKey: string;
  readonly attachmentId: string;
  readonly objectId: string;
  readonly jobSlotKey: string;
}
const fail = (): never => {
  throw Error("TEST_ADMISSION_SOURCE_CLEANUP");
};
/** Declaration links only. No proof, internal allocation, cleanup or provider grant. */
export function validateSourceCleanupDeclarations(
  value: unknown,
  inventory: FixtureInventory,
  operations: readonly OperationDeclaration[],
): readonly SourceCleanupDeclaration[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 4 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return fail();
    const used = new Set<string>(),
      names = [
        "key",
        "sourceOperationKey",
        "attachmentId",
        "objectId",
        "jobSlotKey",
      ],
      out: SourceCleanupDeclaration[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = Object.getOwnPropertyDescriptor(value, String(i));
      if (!item || !item.enumerable || !("value" in item)) return fail();
      const raw = item.value;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
        Reflect.ownKeys(raw).length !== names.length ||
        Reflect.ownKeys(raw).some(
          (k) => typeof k !== "string" || !names.includes(k),
        )
      )
        return fail();
      const r: Record<string, string> = Object.create(null);
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, name);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string"
        )
          return fail();
        r[name] = descriptor.value;
      }
      if (
        ![r.key, r.sourceOperationKey, r.jobSlotKey].every((k) =>
          /^[a-z0-9][a-z0-9._-]{0,79}$/.test(k),
        ) ||
        ![r.attachmentId, r.objectId].every((id) =>
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            id,
          ),
        )
      )
        return fail();
      const operation = operations.find((o) => o.key === r.sourceOperationKey);
      if (
        !operation ||
        operation.kind !== "UPLOAD" ||
        operation.case !== "COMPLETE" ||
        operation.attemptKeys.length !== 1 ||
        operation.attachmentId !== r.attachmentId ||
        !inventory.attachments.some((a) => a.id === r.attachmentId) ||
        operations.some(
          (o) => o.key === r.key || o.slotKeys.includes(r.jobSlotKey),
        )
      )
        return fail();
      for (const id of [
        r.key,
        r.sourceOperationKey,
        r.objectId,
        r.jobSlotKey,
      ]) {
        if (used.has(id)) return fail();
        used.add(id);
      }
      out.push(Object.freeze({ ...r }) as unknown as SourceCleanupDeclaration);
    }
    return Object.freeze(
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    );
  } catch {
    return fail();
  }
}
