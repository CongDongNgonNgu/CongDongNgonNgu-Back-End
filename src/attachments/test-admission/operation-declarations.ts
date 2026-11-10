import { parseInitiation } from "../initiation/initiation-input";
import { parseDraftMetadata } from "../initiation/attachment-draft-repository";
import { attachmentRange } from "../transport/attachment-range";
import { ATTACHMENT_LIMITS, sourceByteLimit } from "../attachment-policy";
import { RUN_LIMITS } from "./run-ledger-schema";
import type { FixtureInventory } from "./fixture-inventory";
import type { ActivationEnvelope } from "./guard";
type Counter = keyof typeof RUN_LIMITS;
type Principal =
  | { kind: "ACTOR"; actorId: string; sessionId: string }
  | { kind: "ANON" }
  | { kind: "INVALID_CREDENTIAL_NEGATIVE" };
type Common = {
  key: string;
  attachmentId: string;
  principal: Principal;
  assertion: "NORMAL_AUTHORIZATION" | "EXPECTED_DENIAL";
  attemptKeys: string[];
  charges: Record<Counter, number>;
  slotKeys: string[];
};
type Detail =
  | { kind: "INITIATE"; body: ReturnType<typeof parseInitiation> }
  | { kind: "PATCH_METADATA"; body: ReturnType<typeof parseDraftMetadata> }
  | { kind: "FINALIZE" | "METADATA" | "DELETE" }
  | {
      kind: "UPLOAD";
      contentType: string;
      contentLength: number;
      inputSha256: string;
      transmittedBytes: number;
      case: "COMPLETE" | "INTERRUPTED" | "OVERLIMIT";
    }
  | {
      kind: "READ";
      method: "GET" | "HEAD";
      variant: "normalized" | "thumbnail";
      range: string | null;
    };
type Frozen<T> = T extends object
  ? { readonly [K in keyof T]: Frozen<T[K]> }
  : T;
export type OperationDeclaration = Frozen<Common & Detail>;
const fail = (): never => {
  throw Error("TEST_ADMISSION_OPERATIONS");
};
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
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
    keys.some(
      (k) => typeof k !== "string" || ![...required, ...optional].includes(k),
    ) ||
    required.some((k) => !keys.includes(k))
  )
    return fail();
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) return fail();
    out[key] = d.value;
  }
  return out;
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail();
  const n = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < min ||
    n > max ||
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
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value))
    return fail();
  return value;
}
function integer(value: unknown, max: number, min = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return fail();
  return value;
}
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}
const common = [
  "key",
  "kind",
  "attachmentId",
  "principal",
  "assertion",
  "attemptKeys",
  "charges",
  "slotKeys",
];
const fields: Record<string, string[]> = {
  INITIATE: ["body"],
  PATCH_METADATA: ["body"],
  UPLOAD: [
    "contentType",
    "contentLength",
    "inputSha256",
    "transmittedBytes",
    "case",
  ],
  FINALIZE: [],
  METADATA: [],
  DELETE: [],
  READ: ["method", "variant", "range"],
};
/** Inventory/envelope must already be validated. Declarations prove no request,
 * source bytes, ACL, derivative size or allocation graph. No I/O or capability.
 * slotKeys are policy-wide references: a later graph must bind each slot to an
 * individual attemptKey, never reburn all slots for each retry. A later matcher
 * must atomically claim the first unused attempt or fail immediately, not queue.
 * RAW_BODY malformed JSON negatives are deliberately unsupported in this slice. */
export function validateOperationDeclarations(
  value: unknown,
  inventory: FixtureInventory,
  envelope: ActivationEnvelope,
): readonly OperationDeclaration[] {
  try {
    const keys = new Set<string>(),
      attempts = new Set<string>(),
      policies = new Map<string, string>(),
      totals = Object.fromEntries(
        Object.keys(RUN_LIMITS).map((k) => [k, 0]),
      ) as Record<Counter, number>;
    const result = array(value, 140, 1).map((raw) => {
      const broad = object(raw, common, Object.values(fields).flat()),
        kind = broad.kind;
      if (typeof kind !== "string" || !Object.hasOwn(fields, kind))
        return fail();
      const o = object(raw, [...common, ...fields[kind]]),
        operationKey = key(o.key);
      if (keys.has(operationKey)) return fail();
      keys.add(operationKey);
      const attachment = inventory.attachments.find(
        (a) => a.id === o.attachmentId,
      );
      if (!attachment) return fail();
      const p = object(o.principal, ["kind"], ["actorId", "sessionId"]);
      let principal: Principal;
      if (p.kind === "ACTOR") {
        const actor = object(o.principal, ["kind", "actorId", "sessionId"]),
          listed = inventory.actors.find((a) => a.id === actor.actorId);
        if (
          !listed ||
          typeof actor.sessionId !== "string" ||
          !listed.sessionIds.includes(actor.sessionId)
        )
          return fail();
        principal = {
          kind: "ACTOR",
          actorId: listed.id,
          sessionId: actor.sessionId,
        };
      } else if (
        p.kind === "ANON" ||
        p.kind === "INVALID_CREDENTIAL_NEGATIVE"
      ) {
        object(o.principal, ["kind"]);
        principal = { kind: p.kind };
      } else return fail();
      if (
        o.assertion !== "NORMAL_AUTHORIZATION" &&
        o.assertion !== "EXPECTED_DENIAL"
      )
        return fail();
      if (
        principal.kind === "INVALID_CREDENTIAL_NEGATIVE" &&
        o.assertion !== "EXPECTED_DENIAL"
      )
        return fail();
      if (principal.kind === "ANON" && kind !== "READ") return fail();
      if (
        principal.kind === "ANON" &&
        o.assertion === "NORMAL_AUTHORIZATION" &&
        (attachment.parent?.kind !== "COMMUNITY" ||
          attachment.initiation.intent.kind !== "COMMUNITY" ||
          attachment.initiation.intent.visibility !== "PUBLIC")
      )
        return fail();
      const attemptKeys = array(o.attemptKeys, 140, 1).map((v) => {
        const k = key(v);
        if (attempts.has(k)) return fail();
        attempts.add(k);
        if (attempts.size > 140) return fail();
        return k;
      });
      const slotKeys = array(o.slotKeys, 256).map(key);
      if (new Set(slotKeys).size !== slotKeys.length) return fail();
      const chargeInput = object(o.charges, Object.keys(RUN_LIMITS)),
        charges = Object.fromEntries(
          Object.entries(RUN_LIMITS).map(([k, max]) => [
            k,
            integer(
              chargeInput[k],
              Math.min(max, envelope.budgets[k as Counter]),
            ),
          ]),
        ) as Record<Counter, number>;
      const anonymous = principal.kind === "ANON";
      if (
        charges.authenticatedRequests !== (anonymous ? 0 : 1) ||
        charges.anonymousRequests !== (anonymous ? 1 : 0) ||
        charges[
          anonymous ? "authenticatedEgressBytes" : "anonymousEgressBytes"
        ] !== 0 ||
        (kind !== "READ" &&
          (charges.authenticatedEgressBytes !== 0 ||
            charges.anonymousEgressBytes !== 0)) ||
        (kind !== "UPLOAD" && charges.ingressBytes !== 0) ||
        (kind !== "FINALIZE" && charges.processingAttempts !== 0) ||
        charges.processingAttempts > 1
      )
        return fail();
      if (
        kind === "FINALIZE" &&
        principal.kind === "ACTOR" &&
        charges.processingAttempts !== 1
      )
        return fail();
      let detail: Detail;
      if (kind === "INITIATE") {
        if (
          principal.kind === "ACTOR" &&
          principal.actorId !== attachment.ownerId
        )
          return fail();
        const dto = object(
            o.body,
            ["clientUploadId", "scope", "filename", "mime", "bytes"],
            ["caption", "alt"],
          ),
          tag = object(
            dto.scope,
            ["kind"],
            [
              "postType",
              "languageId",
              "visibility",
              "groupId",
              "conversationId",
            ],
          );
        const scope =
          tag.kind === "COMMUNITY"
            ? object(dto.scope, [
                "kind",
                "postType",
                "languageId",
                "visibility",
              ])
            : tag.kind === "STUDY_GROUP"
              ? object(dto.scope, ["kind", "groupId"])
              : tag.kind === "DIRECT_MESSAGE"
                ? object(dto.scope, ["kind", "conversationId"])
                : fail();
        const body = parseInitiation({ ...dto, scope });
        if (body.fingerprint !== attachment.initiation.fingerprint)
          return fail();
        detail = { kind, body };
      } else if (kind === "PATCH_METADATA") {
        detail = {
          kind,
          body: parseDraftMetadata(
            object(o.body, ["expectedMetadataVersion", "caption", "alt"]),
          ),
        };
      } else if (kind === "UPLOAD") {
        const contentLength = integer(o.contentLength, 33554432, 1),
          transmittedBytes = integer(o.transmittedBytes, 33554432),
          contentType = o.contentType,
          inputSha256 = o.inputSha256,
          which = o.case;
        if (
          typeof contentType !== "string" ||
          contentType !== attachment.initiation.mime ||
          typeof inputSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(inputSha256) ||
          charges.ingressBytes < Math.max(contentLength, transmittedBytes)
        )
          return fail();
        if (which === "COMPLETE") {
          if (
            contentLength !== attachment.initiation.bytes ||
            transmittedBytes !== contentLength ||
            inputSha256 !== attachment.sourceSha256
          )
            return fail();
        } else if (which === "INTERRUPTED") {
          if (
            o.assertion !== "EXPECTED_DENIAL" ||
            contentLength !== attachment.initiation.bytes ||
            transmittedBytes >= contentLength ||
            inputSha256 !== attachment.sourceSha256
          )
            return fail();
        } else if (which === "OVERLIMIT") {
          if (
            o.assertion !== "EXPECTED_DENIAL" ||
            contentLength <= sourceByteLimit(attachment.initiation.format) ||
            transmittedBytes > contentLength
          )
            return fail();
        } else return fail();
        detail = {
          kind,
          contentType,
          contentLength,
          inputSha256,
          transmittedBytes,
          case: which,
        };
      } else if (kind === "READ") {
        if (
          (o.method !== "GET" && o.method !== "HEAD") ||
          (o.variant !== "normalized" && o.variant !== "thumbnail") ||
          !(
            o.range === null ||
            (typeof o.range === "string" &&
              o.range.length >= 1 &&
              o.range.length <= 64 &&
              /^[\x20-\x7e]+$/.test(o.range))
          ) ||
          charges[
            anonymous ? "anonymousEgressBytes" : "authenticatedEgressBytes"
          ] < 1
        )
          return fail();
        if (o.assertion === "NORMAL_AUTHORIZATION") {
          if (
            o.variant === "thumbnail" &&
            attachment.initiation.format === "TEXT"
          )
            return fail();
          attachmentRange(
            o.range === null ? undefined : (o.range as string),
            o.variant === "thumbnail"
              ? ATTACHMENT_LIMITS.thumbnailBytes
              : sourceByteLimit(attachment.initiation.format),
          );
        }
        detail = {
          kind,
          method: o.method as "GET" | "HEAD",
          variant: o.variant as "normalized" | "thumbnail",
          range: o.range as string | null,
        };
      } else detail = { kind: kind as "FINALIZE" | "METADATA" | "DELETE" };
      if (
        o.assertion === "NORMAL_AUTHORIZATION" &&
        ["INITIATE", "UPLOAD", "FINALIZE", "PATCH_METADATA", "DELETE"].includes(
          kind,
        ) &&
        (principal.kind !== "ACTOR" || principal.actorId !== attachment.ownerId)
      )
        return fail();
      for (const k of Object.keys(RUN_LIMITS) as Counter[]) {
        totals[k] += charges[k] * attemptKeys.length;
        if (
          !Number.isSafeInteger(totals[k]) ||
          totals[k] > Math.min(RUN_LIMITS[k], envelope.budgets[k])
        )
          return fail();
      }
      // Assertion and charges never select an alternate admission policy for the
      // same principal/resource/input. Combine retries in one finite entry instead.
      const observedDetail =
        detail.kind === "UPLOAD"
          ? {
              kind: "UPLOAD",
              method: "PUT",
              contentType: detail.contentType,
              contentLength: detail.contentLength,
            }
          : detail;
      const signature = JSON.stringify({
        principal,
        attachmentId: attachment.id,
        detail: observedDetail,
      });
      if (policies.has(signature)) return fail();
      policies.set(signature, operationKey);
      return {
        key: operationKey,
        attachmentId: attachment.id,
        principal,
        assertion: o.assertion,
        attemptKeys,
        charges,
        slotKeys,
        ...detail,
      };
    });
    return freeze(result) as readonly OperationDeclaration[];
  } catch {
    return fail();
  }
}
