import type { PoolClient } from "pg";
import {
  COMMUNITY_POST_TYPES,
  type CommunityPostType,
  type CommunityVisibility,
} from "../../community/community.types";
import { lockMessagingPair } from "../../messaging/messaging-pair-authorization";
import { MessageFailure } from "../../messaging/message-failure";

export type AttachmentDraftIntent =
  | {
      kind: "COMMUNITY";
      postType: CommunityPostType;
      languageId: string;
      visibility: CommunityVisibility;
    }
  | { kind: "STUDY_GROUP"; groupId: string }
  | { kind: "DIRECT_MESSAGE"; conversationId: string };
export type AttachmentBoundParent =
  | { kind: "COMMUNITY"; postId: string }
  | { kind: "STUDY_GROUP"; groupId: string; textId: string }
  | { kind: "DIRECT_MESSAGE"; conversationId: string; messageId: string };
export interface AuthorizedAttachmentScope {
  readonly intent: AttachmentDraftIntent;
  readonly generation: string | null;
}
export interface AuthorizedAttachmentParent extends AuthorizedAttachmentScope {
  readonly authorId: string;
}
export class AttachmentAuthorizationError extends Error {
  readonly code = "ATTACHMENT_UNAVAILABLE";
  readonly status = 404;
  constructor() {
    super("Attachment is not available");
    this.name = "AttachmentAuthorizationError";
  }
}
export function opaqueAttachmentAuthorizationError(): AttachmentAuthorizationError {
  return new AttachmentAuthorizationError();
}
const deny = (): never => {
  throw opaqueAttachmentAuthorizationError();
};
function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    deny();
}

// The caller MUST own a READ COMMITTED transaction and call these before locking
// attachments/quotas. These functions never connect, commit, release or perform I/O.
// Locks last through the caller's state/binding selection and transaction commit.
async function accounts(
  client: PoolClient,
  ids: string[],
  verifiedIds: string[] = ids,
): Promise<void> {
  const unique = [...new Set(ids)].sort();
  unique.forEach(uuid);
  const result = await client.query<{
    id: string;
    status: string;
    email_verified_at: Date | null;
  }>(
    "SELECT id,status,email_verified_at FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [unique],
  );
  if (
    result.rows.length !== unique.length ||
    result.rows.some(
      (u) =>
        u.status !== "ACTIVE" ||
        (verifiedIds.includes(u.id) && !u.email_verified_at),
    )
  )
    deny();
}
async function activeLanguage(client: PoolClient, id: string): Promise<void> {
  uuid(id);
  const result = await client.query(
    "SELECT id FROM languages WHERE id=$1 AND active FOR SHARE",
    [id],
  );
  if (result.rowCount !== 1) deny();
}
async function groupScope(
  client: PoolClient,
  actor: string,
  groupId: string,
  requireVerifiedAccount = true,
) {
  uuid(groupId);
  await accounts(client, [actor], requireVerifiedAccount ? [actor] : []);
  const group = await client.query(
    "SELECT id FROM study_groups WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
    [groupId],
  );
  if (group.rowCount !== 1) deny();
  const member = (
    await client.query<{ generation: string; role: string }>(
      "SELECT generation,role FROM study_group_memberships WHERE group_id=$1 AND user_id=$2 AND status='ACTIVE'",
      [groupId, actor],
    )
  ).rows[0];
  if (!member) deny();
  return member;
}
async function dmScope(
  client: PoolClient,
  actor: string,
  conversationId: string,
): Promise<string> {
  uuid(conversationId);
  uuid(actor);
  // This unlocked identifier lookup cannot authorize. Recheck exact pair and room
  // after the existing ordered-account/advisory safety locks.
  const candidate = (
    await client.query<{ participant_a_id: string; participant_b_id: string }>(
      "SELECT participant_a_id,participant_b_id FROM direct_conversations WHERE id=$1 AND (participant_a_id=$2 OR participant_b_id=$2)",
      [conversationId, actor],
    )
  ).rows[0];
  if (!candidate) deny();
  const partner =
    candidate.participant_a_id === actor
      ? candidate.participant_b_id
      : candidate.participant_a_id;
  try {
    await lockMessagingPair(client, actor, partner);
  } catch (error) {
    if (
      error instanceof MessageFailure &&
      error.code === "CONVERSATION_UNAVAILABLE"
    )
      deny();
    throw error;
  }
  const room = await client.query(
    "SELECT id FROM direct_conversations WHERE id=$1 AND participant_a_id=LEAST($2::uuid,$3::uuid) AND participant_b_id=GREATEST($2::uuid,$3::uuid) FOR UPDATE",
    [conversationId, actor, partner],
  );
  if (room.rowCount !== 1) deny();
  const connection = (
    await client.query<{ id: string }>(
      "SELECT id FROM language_exchange_connections WHERE participant_a_id=LEAST($1::uuid,$2::uuid) AND participant_b_id=GREATEST($1::uuid,$2::uuid) AND status='CONNECTED'",
      [actor, partner],
    )
  ).rows[0];
  if (!connection) deny();
  return connection.id;
}
export async function authorizeDraftScope(
  client: PoolClient,
  actor: string,
  intent: AttachmentDraftIntent,
  expectedGeneration?: string | null,
): Promise<AuthorizedAttachmentScope> {
  uuid(actor);
  let generation: string | null = null;
  let canonical: AttachmentDraftIntent;
  if (intent.kind === "COMMUNITY") {
    if (
      !COMMUNITY_POST_TYPES.includes(intent.postType) ||
      !["PUBLIC", "PRIVATE"].includes(intent.visibility)
    )
      deny();
    await accounts(client, [actor]);
    await activeLanguage(client, intent.languageId);
    canonical = {
      kind: "COMMUNITY",
      postType: intent.postType,
      languageId: intent.languageId,
      visibility: intent.visibility,
    };
  } else if (intent.kind === "STUDY_GROUP") {
    generation = (await groupScope(client, actor, intent.groupId)).generation;
    canonical = { kind: "STUDY_GROUP", groupId: intent.groupId };
  } else if (intent.kind === "DIRECT_MESSAGE") {
    generation = await dmScope(client, actor, intent.conversationId);
    canonical = {
      kind: "DIRECT_MESSAGE",
      conversationId: intent.conversationId,
    };
  } else return deny();
  if (expectedGeneration !== undefined && expectedGeneration !== generation)
    deny();
  return { intent: canonical, generation };
}

export async function authorizeBoundParent(
  client: PoolClient,
  actor: string | null,
  parent: AttachmentBoundParent,
): Promise<AuthorizedAttachmentParent> {
  if (actor !== null) uuid(actor);
  if (parent.kind === "COMMUNITY") {
    uuid(parent.postId);
    const candidate = (
      await client.query<{
        author_user_id: string;
        target_language_id: string;
      }>(
        "SELECT author_user_id,target_language_id FROM community_posts WHERE id=$1",
        [parent.postId],
      )
    ).rows[0];
    if (!candidate) deny();
    await accounts(
      client,
      actor ? [actor, candidate.author_user_id] : [candidate.author_user_id],
      [candidate.author_user_id],
    );
    await activeLanguage(client, candidate.target_language_id);
    const post = (
      await client.query<{
        author_user_id: string;
        target_language_id: string;
        post_type: CommunityPostType;
        visibility: CommunityVisibility;
        moderation_state: string;
      }>(
        "SELECT author_user_id,target_language_id,post_type,visibility,moderation_state FROM community_posts WHERE id=$1 FOR UPDATE",
        [parent.postId],
      )
    ).rows[0];
    if (
      !post ||
      post.author_user_id !== candidate.author_user_id ||
      post.target_language_id !== candidate.target_language_id ||
      post.moderation_state !== "ACTIVE" ||
      (post.visibility !== "PUBLIC" && post.author_user_id !== actor)
    )
      deny();
    return {
      intent: {
        kind: "COMMUNITY",
        postType: post.post_type,
        languageId: post.target_language_id,
        visibility: post.visibility,
      },
      generation: null,
      authorId: post.author_user_id,
    };
  }
  if (parent.kind === "STUDY_GROUP") {
    if (!actor) return deny();
    uuid(parent.textId);
    // Existing Phase22 reads/writes require ACTIVE membership, not a newly
    // imposed email-verification gate. Draft upload authorization remains strict.
    const member = await groupScope(client, actor, parent.groupId, false);
    const text = (
      await client.query<{ author_user_id: string; hidden_at: Date | null }>(
        "SELECT author_user_id,hidden_at FROM study_group_texts WHERE group_id=$1 AND id=$2 FOR SHARE",
        [parent.groupId, parent.textId],
      )
    ).rows[0];
    if (!text || (text.hidden_at && member.role === "MEMBER")) deny();
    return {
      intent: { kind: "STUDY_GROUP", groupId: parent.groupId },
      generation: member.generation,
      authorId: text.author_user_id,
    };
  }
  if (parent.kind === "DIRECT_MESSAGE") {
    if (!actor) return deny();
    uuid(parent.messageId);
    const generation = await dmScope(client, actor, parent.conversationId);
    const message = (
      await client.query<{ sender_user_id: string }>(
        "SELECT sender_user_id FROM direct_messages WHERE conversation_id=$1 AND id=$2 FOR SHARE",
        [parent.conversationId, parent.messageId],
      )
    ).rows[0];
    if (!message) deny();
    return {
      intent: { kind: "DIRECT_MESSAGE", conversationId: parent.conversationId },
      generation,
      authorId: message.sender_user_id,
    };
  }
  return deny();
}
// Removal retains the strict live read boundary, including hidden text roles.
// Group/DM read eligibility is their existing current write eligibility; Community
// adds exact original-author ownership. Moderators receive no file-owner bypass.
export async function authorizeAttachmentRemoval(
  client: PoolClient,
  actor: string,
  uploader: string,
  parent: AttachmentBoundParent,
): Promise<AuthorizedAttachmentParent> {
  uuid(actor);
  uuid(uploader);
  if (actor !== uploader) deny();
  const scope = await authorizeBoundParent(client, actor, parent);
  if (scope.authorId !== actor) deny();
  return scope;
}
