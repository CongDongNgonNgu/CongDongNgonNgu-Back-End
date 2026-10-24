import type { PoolClient } from "pg";
import {
  authorizeDraftScope,
  opaqueAttachmentAuthorizationError,
  type AttachmentDraftIntent,
} from "../authorization/attachment-authorization";
import type { AttachmentFormat, AttachmentState } from "../attachment-policy";
import { normalizeAttachmentMetadata } from "../validation/metadata";
import { AttachmentValidationError } from "../validation/validation-error";
import type {
  CommunityPostType,
  CommunityVisibility,
} from "../../community/community.types";

export class AttachmentDraftConflict extends Error {
  readonly status = 409;
  constructor(
    readonly code:
      | "ATTACHMENT_METADATA_CONFLICT"
      | "ATTACHMENT_INITIATION_CONFLICT" = "ATTACHMENT_METADATA_CONFLICT",
  ) {
    super(code);
    this.name = "AttachmentDraftConflict";
  }
}
export interface DraftRow {
  id: string;
  uploader_id: string;
  scope: AttachmentDraftIntent["kind"];
  scope_id: string;
  scope_generation: string | null;
  community_post_type: CommunityPostType | null;
  community_visibility: CommunityVisibility | null;
  state: AttachmentState;
  format: AttachmentFormat;
  expected_bytes: string;
  display_filename: string;
  caption: string;
  alt: string;
  metadata_version: string;
  expires_at: Date;
  first_bound_at: Date | null;
  init_fingerprint: string;
  client_upload_id: string;
}
export interface AttachmentDraftStatus {
  id: string;
  state: AttachmentState;
  format: AttachmentFormat;
  expectedBytes: number;
  filename: string;
  caption: string;
  alt: string;
  metadataVersion: number;
  expiresAt: string;
}
export function draftIntent(row: DraftRow): AttachmentDraftIntent {
  if (row.scope === "COMMUNITY")
    return {
      kind: "COMMUNITY",
      postType: row.community_post_type!,
      visibility: row.community_visibility!,
      languageId: row.scope_id,
    };
  if (row.scope === "STUDY_GROUP")
    return { kind: "STUDY_GROUP", groupId: row.scope_id };
  return { kind: "DIRECT_MESSAGE", conversationId: row.scope_id };
}
export function projectDraft(row: DraftRow): AttachmentDraftStatus {
  return {
    id: row.id,
    state: row.state,
    format: row.format,
    expectedBytes: Number(row.expected_bytes),
    filename: row.display_filename,
    caption: row.caption,
    alt: row.alt,
    metadataVersion: Number(row.metadata_version),
    expiresAt: row.expires_at.toISOString(),
  };
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const deny = (): never => {
  throw opaqueAttachmentAuthorizationError();
};
/** Caller owns READ COMMITTED transaction. The first unlocked query grants no
 * access; domain locks and fresh generation precede the attachment row lock. */
export async function lockAuthorizedDraft(
  client: PoolClient,
  actor: string,
  id: string,
): Promise<DraftRow> {
  if (!uuid(actor) || !uuid(id)) return deny();
  const candidate = (
    await client.query<DraftRow>(
      "SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2",
      [id, actor],
    )
  ).rows[0];
  if (!candidate) return deny();
  await authorizeDraftScope(
    client,
    actor,
    draftIntent(candidate),
    candidate.scope_generation,
  );
  const row = (
    await client.query<DraftRow>(
      `SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2 AND first_bound_at IS NULL AND state<>'DELETED' AND expires_at>clock_timestamp() FOR UPDATE`,
      [id, actor],
    )
  ).rows[0];
  if (!row) return deny();
  return row;
}
export async function readDraftStatus(
  client: PoolClient,
  actor: string,
  id: string,
): Promise<AttachmentDraftStatus> {
  return projectDraft(await lockAuthorizedDraft(client, actor, id));
}
export function parseDraftMetadata(input: unknown): {
  expectedMetadataVersion: number;
  caption: string;
  alt: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AttachmentValidationError("ATTACHMENT_INVALID_METADATA");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) => !["expectedMetadataVersion", "caption", "alt"].includes(k),
    ) ||
    !Number.isSafeInteger(value.expectedMetadataVersion) ||
    Number(value.expectedMetadataVersion) < 0 ||
    typeof value.caption !== "string" ||
    typeof value.alt !== "string"
  )
    throw new AttachmentValidationError("ATTACHMENT_INVALID_METADATA");
  const normalized = normalizeAttachmentMetadata({
    filename: "metadata.txt",
    caption: value.caption,
    alt: value.alt,
  });
  return {
    expectedMetadataVersion: Number(value.expectedMetadataVersion),
    caption: normalized.caption,
    alt: normalized.alt,
  };
}
export async function patchDraftMetadata(
  client: PoolClient,
  actor: string,
  id: string,
  input: unknown,
): Promise<AttachmentDraftStatus> {
  const patch = parseDraftMetadata(input);
  const row = await lockAuthorizedDraft(client, actor, id);
  if (Number(row.metadata_version) !== patch.expectedMetadataVersion)
    throw new AttachmentDraftConflict();
  const updated = (
    await client.query<DraftRow>(
      "UPDATE attachments SET caption=$2,alt=$3,metadata_version=metadata_version+1 WHERE id=$1 RETURNING *",
      [id, patch.caption, patch.alt],
    )
  ).rows[0];
  return projectDraft(updated);
}
