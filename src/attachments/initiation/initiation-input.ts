import { createHash } from "node:crypto";
import {
  COMMUNITY_POST_TYPES,
  type CommunityPostType,
  type CommunityVisibility,
} from "../../community/community.types";
import { normalizeAttachmentMetadata } from "../validation/metadata";
import {
  attachmentReservationBytes,
  assertParentBudget,
  formatForDeclaration,
  type AttachmentFormat,
} from "../attachment-policy";
import type { AttachmentDraftIntent } from "../authorization/attachment-authorization";
export class AttachmentInitiationInputError extends Error {
  readonly code = "ATTACHMENT_INVALID_INITIATION";
  readonly status = 400;
  constructor() {
    super("Invalid attachment initiation");
  }
}
const invalid = (): never => {
  throw new AttachmentInitiationInputError();
};
export function initiationUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    return invalid();
  return value.toLowerCase();
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) return invalid();
  return object;
}
export interface ParsedInitiation {
  clientUploadId: string;
  intent: AttachmentDraftIntent;
  filename: string;
  mime: string;
  bytes: number;
  caption: string;
  alt: string;
  format: AttachmentFormat;
  reservedBytes: number;
  fingerprint: string;
}
export function parseInitiation(input: unknown): ParsedInitiation {
  const value = exact(input, [
    "clientUploadId",
    "scope",
    "filename",
    "mime",
    "bytes",
    "caption",
    "alt",
  ]);
  const clientUploadId = initiationUuid(value.clientUploadId);
  const raw = exact(value.scope, [
    "kind",
    "postType",
    "languageId",
    "visibility",
    "groupId",
    "conversationId",
  ]);
  let intent: AttachmentDraftIntent;
  if (raw.kind === "COMMUNITY") {
    exact(raw, ["kind", "postType", "languageId", "visibility"]);
    if (
      !COMMUNITY_POST_TYPES.includes(raw.postType as CommunityPostType) ||
      !["PUBLIC", "PRIVATE"].includes(String(raw.visibility))
    )
      return invalid();
    intent = {
      kind: "COMMUNITY",
      postType: raw.postType as CommunityPostType,
      languageId: initiationUuid(raw.languageId),
      visibility: raw.visibility as CommunityVisibility,
    };
  } else if (raw.kind === "STUDY_GROUP") {
    exact(raw, ["kind", "groupId"]);
    intent = { kind: "STUDY_GROUP", groupId: initiationUuid(raw.groupId) };
  } else if (raw.kind === "DIRECT_MESSAGE") {
    exact(raw, ["kind", "conversationId"]);
    intent = {
      kind: "DIRECT_MESSAGE",
      conversationId: initiationUuid(raw.conversationId),
    };
  } else return invalid();
  if (typeof value.mime !== "string" || !Number.isSafeInteger(value.bytes))
    return invalid();
  const metadata = normalizeAttachmentMetadata({
    filename: value.filename,
    caption: value.caption,
    alt: value.alt,
  });
  const bytes = Number(value.bytes),
    mime = value.mime,
    format = formatForDeclaration(metadata.filename, mime, bytes);
  assertParentBudget(
    intent.kind,
    intent.kind === "COMMUNITY" ? intent.postType : null,
    [{ format, sourceBytes: bytes }],
  );
  const immutable = {
    clientUploadId,
    intent,
    filename: metadata.filename,
    mime,
    bytes,
    caption: metadata.caption,
    alt: metadata.alt,
  };
  return {
    ...immutable,
    format,
    reservedBytes: attachmentReservationBytes(format, bytes),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(immutable))
      .digest("hex"),
  };
}
