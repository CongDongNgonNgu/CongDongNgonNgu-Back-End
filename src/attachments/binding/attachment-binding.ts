import type { PoolClient } from "pg";
import {
  authorizeBoundParent,
  opaqueAttachmentAuthorizationError,
  type AttachmentBoundParent,
  type AttachmentDraftIntent,
} from "../authorization/attachment-authorization";
import {
  assertParentBudget,
  type AttachmentFormat,
} from "../attachment-policy";
import type {
  CommunityPostType,
  CommunityVisibility,
} from "../../community/community.types";
interface BindingRow {
  id: string;
  uploader_id: string;
  scope: AttachmentDraftIntent["kind"];
  scope_id: string;
  scope_generation: string | null;
  community_post_type: CommunityPostType | null;
  community_visibility: CommunityVisibility | null;
  state: string;
  first_bound_at: Date | null;
  valid: boolean;
  format: AttachmentFormat;
  expected_bytes: string;
}
export class AttachmentBindingError extends Error {
  readonly code = "ATTACHMENT_BINDING_CONFLICT";
  readonly status = 409;
  constructor() {
    super("Attachment binding conflict");
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const deny = (): never => {
  throw opaqueAttachmentAuthorizationError();
};
/** INTERNAL create orchestration only. Caller owns READ COMMITTED and MUST roll
 * back its whole transaction on error. insertParent is trusted server code that
 * MUST INSERT a new parent using this exact client, preserving existing body,
 * context, write policy and send idempotency. It must acquire normal ordered
 * domain locks before insertion. Never pass a client-provided callback/proof or
 * look up/update a pre-existing group text/message here. No standalone bind API
 * is exported. Concrete004/005 create callsites must prove this requirement;
 * accepting this callback is not database-level proof that INSERT occurred.
 * Empty IDs return only the callback result under its existing parent policy;
 * this is not an unauthenticated parent-create surface. Community retain/reorder/
 * edit is intentionally a different future operation.
 */
export async function bindNewParent<T>(
  client: PoolClient,
  actor: string,
  attachmentIds: readonly string[],
  insertParent: (
    client: PoolClient,
  ) => Promise<{ parent: AttachmentBoundParent; result: T }>,
): Promise<{ parent: AttachmentBoundParent; result: T }> {
  if (
    !uuid(actor) ||
    !Array.isArray(attachmentIds) ||
    attachmentIds.some((id) => !uuid(id))
  )
    return deny();
  if (
    attachmentIds.length > 4 ||
    new Set(attachmentIds).size !== attachmentIds.length
  )
    throw new AttachmentBindingError();
  const created = await insertParent(client);
  // No file operation exists for an empty set. Preserve existing parent policy,
  // including unverified active group authors; this port never replaces it.
  if (attachmentIds.length === 0) return created;
  const authorized = await authorizeBoundParent(client, actor, created.parent);
  if (authorized.authorId !== actor) return deny();
  // authorizeBoundParent already holds all correctly ordered account locks. This
  // verifies the uploader without pre-locking one DM participant out of order.
  if (
    (
      await client.query(
        "SELECT id FROM users WHERE id=$1 AND status='ACTIVE' AND email_verified_at IS NOT NULL",
        [actor],
      )
    ).rowCount !== 1
  )
    return deny();
  const scope = authorized.intent,
    scopeId =
      scope.kind === "COMMUNITY"
        ? scope.languageId
        : scope.kind === "STUDY_GROUP"
          ? scope.groupId
          : scope.conversationId;
  // New-parent create only: no existing binding can be retained or appended.
  const prior =
    created.parent.kind === "COMMUNITY"
      ? await client.query(
          "SELECT 1 FROM attachment_bindings WHERE community_post_id=$1",
          [created.parent.postId],
        )
      : created.parent.kind === "STUDY_GROUP"
        ? await client.query(
            "SELECT 1 FROM attachment_bindings WHERE scope_id=$1 AND group_text_id=$2",
            [created.parent.groupId, created.parent.textId],
          )
        : await client.query(
            "SELECT 1 FROM attachment_bindings WHERE scope_id=$1 AND direct_message_id=$2",
            [created.parent.conversationId, created.parent.messageId],
          );
  if (prior.rowCount) throw new AttachmentBindingError();
  const rows = (
    await client.query<BindingRow>(
      `SELECT *,expires_at>clock_timestamp() AS valid FROM attachments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[...attachmentIds].sort()],
    )
  ).rows;
  if (rows.length !== attachmentIds.length) return deny();
  for (const row of rows) {
    if (
      row.uploader_id !== actor ||
      row.state !== "READY" ||
      !row.valid ||
      row.first_bound_at ||
      row.scope !== scope.kind ||
      row.scope_id !== scopeId ||
      row.scope_generation !== authorized.generation
    )
      return deny();
    if (
      scope.kind === "COMMUNITY" &&
      (row.community_post_type !== scope.postType ||
        row.community_visibility !== scope.visibility)
    )
      return deny();
  }
  if (
    (
      await client.query(
        "SELECT 1 FROM attachment_bindings WHERE attachment_id=ANY($1::uuid[])",
        [attachmentIds],
      )
    ).rowCount
  )
    throw new AttachmentBindingError();
  assertParentBudget(
    scope.kind,
    scope.kind === "COMMUNITY" ? scope.postType : null,
    rows.map((row) => ({
      format: row.format,
      sourceBytes: Number(row.expected_bytes),
    })),
  );
  for (let position = 0; position < attachmentIds.length; position++)
    await client.query(
      `INSERT INTO attachment_bindings(attachment_id,uploader_id,scope,scope_id,community_post_id,group_text_id,direct_message_id,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        attachmentIds[position],
        actor,
        scope.kind,
        scopeId,
        created.parent.kind === "COMMUNITY" ? created.parent.postId : null,
        created.parent.kind === "STUDY_GROUP" ? created.parent.textId : null,
        created.parent.kind === "DIRECT_MESSAGE"
          ? created.parent.messageId
          : null,
        position,
      ],
    );
  return created;
}
