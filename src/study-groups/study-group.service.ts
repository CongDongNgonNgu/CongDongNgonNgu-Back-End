import { randomBytes as randomCursorBytes } from 'node:crypto';
import { GroupSyncCursor } from './group-sync-cursor';
import {
  normalizeGroupText,
  normalizeGroupSync,
  type GroupTextInput,
  type GroupSyncInput,
} from './group-collaboration.validation';
import { MessageContextResolver } from '../communication/learning-context-resolver';
import { parseSequence } from '../messaging/message-validation';
import { StudyGroupFailure } from './study-group.validation';
import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockMessagingPair } from '../messaging/messaging-pair-authorization';
import { MessageFailure } from '../messaging/message-failure';
import type {
  GroupResponse,
  GroupRow,
  GroupRole,
  PageQuery,
  MembershipRow,
  MemberResponse,
  TextResponse,
  ReportResponse,
  InvitationResponse,
} from "./study-group.types";
import {
  authorize,
  consumeRate,
  groupResponse,
  lockAccounts,
  lockGroup,
  membership,
  transaction,
  type RateAction,
} from "./study-group.store";
import {
  bounded,
  invalid,
  limitReached,
  pagination,
  paginate,
  unavailable,
  uuid,
} from "./study-group.validation";

@Injectable()
export class StudyGroupService {
  private readonly syncCursors: GroupSyncCursor;
  constructor(
    readonly pool: Pool,
    private readonly contexts?: MessageContextResolver,
    cursors?: GroupSyncCursor,
  ) {
    this.syncCursors =
      cursors ?? new GroupSyncCursor(randomCursorBytes(32).toString('hex'));
  }

  async createGroup(
    actorId: string,
    input: { name: string; description?: string },
  ): Promise<GroupResponse> {
    uuid(actorId);
    const name = bounded(input.name, 120),
      description = bounded(input.description ?? "", 500, true);
    await consumeRate(this.pool, actorId, "CREATE");
    return transaction(this.pool, async (client) => {
      await lockAccounts(client, [actorId], true);
      await this.checkUserCaps(client, actorId, true);
      const result = await client.query<GroupRow>(
        "INSERT INTO study_groups(name,description,owner_user_id) VALUES($1,$2,$3) RETURNING *",
        [name, description, actorId],
      );
      const group = result.rows[0];
      await client.query(
        "INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'OWNER')",
        [group.id, actorId],
      );
      return groupResponse(group, "OWNER");
    });
  }

  async listGroups(actorId: string, query: PageQuery = {}) {
    uuid(actorId);
    const page = pagination(query);
    return transaction(this.pool, async (client) => {
      await lockAccounts(client, [actorId], false);
      // Lock in UUID order before rendering creation-order results. Membership changes lock actor first.
      const result = await client.query<GroupRow>(
        `SELECT g.* FROM study_groups g JOIN study_group_memberships m ON m.group_id=g.id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND g.status='ACTIVE' ORDER BY g.id FOR SHARE OF g`,
        [actorId],
      );
      const groups: GroupResponse[] = [];
      for (const group of result.rows) {
        if (group.status !== "ACTIVE") continue;
        const current = await authorize(client, group.id, actorId);
        groups.push(groupResponse(group, current.role));
      }
      groups.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      return paginate(groups, page);
    });
  }

  async getGroup(actorId: string, groupId: string) {
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (_client, group, current) => groupResponse(group, current.role),
    );
  }

  async listMembers(actorId: string, groupId: string, query: PageQuery = {}) {
    const page = pagination(query);
    return this.scoped(actorId, groupId, false, undefined, async (client) => {
      const result = await client.query<MembershipRow>(
        `SELECT m.*,u.display_name FROM study_group_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.group_id=$1 AND m.status='ACTIVE' ORDER BY m.joined_at,m.user_id`,
        [groupId],
      );
      return paginate(
        result.rows.map((row) => this.memberResponse(row)),
        page,
      );
    });
  }

  async issueInvitation(actorId: string, groupId: string) {
    return this.scoped(
      actorId,
      groupId,
      true,
      "INVITE",
      async (client, _group, current) => {
        this.requireOwner(current);
        return this.insertInvitation(client, actorId, groupId);
      },
    );
  }
  async issueConnectedPartnerInvitation(actorId: string, groupId: string, partnerUserId: string) {
    [actorId, groupId, partnerUserId].forEach(uuid);
    await consumeRate(this.pool, actorId, "INVITE");
    return transaction(this.pool, async client => {
      try { await lockMessagingPair(client, actorId, partnerUserId); }
      catch (error) {
        if (error instanceof MessageFailure && error.code === 'CONVERSATION_UNAVAILABLE') unavailable();
        throw error;
      }
      const group = await lockGroup(client, groupId, true);
      const current = await authorize(client, groupId, actorId);
      this.requireOwner(current);
      if (group.owner_user_id !== actorId) unavailable();
      // A convenience check only: retain the native unbound one-use bearer,
      // with no membership grant, message, notification or recipient binding.
      return this.insertInvitation(client, actorId, groupId);
    });
  }

  private async insertInvitation(client: PoolClient, actorId: string, groupId: string) {
    await this.checkGroupCap(client, groupId, "study_group_invitations");
    const token = randomBytes(32).toString("base64url");
    const result = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO study_group_invitations(group_id,issuer_user_id,token_digest,expires_at)
       VALUES($1,$2,$3,clock_timestamp()+interval '24 hours') RETURNING id,expires_at`,
      [groupId, actorId, this.digest(token)],
    );
    return { id: result.rows[0].id, token, expiresAt: result.rows[0].expires_at.toISOString() };
  }
  async listInvitations(
    actorId: string,
    groupId: string,
    query: PageQuery = {},
  ) {
    const page = pagination(query);
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (client, _group, current) => {
        this.requireOwner(current);
        const result = await client.query<{
          id: string;
          created_at: Date;
          expires_at: Date;
          state: InvitationResponse["state"];
        }>(
          `SELECT id,created_at,expires_at,
        CASE WHEN accepted_at IS NOT NULL THEN 'ACCEPTED' WHEN revoked_at IS NOT NULL THEN 'REVOKED'
          WHEN expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE 'UNUSED' END AS state
        FROM study_group_invitations WHERE group_id=$1 ORDER BY created_at,id`,
          [groupId],
        );
        return paginate(
          result.rows.map((row) => ({
            id: row.id,
            createdAt: row.created_at.toISOString(),
            expiresAt: row.expires_at.toISOString(),
            state: row.state,
          })),
          page,
        );
      },
    );
  }
  async revokeInvitation(actorId: string, groupId: string, inviteId: string) {
    uuid(inviteId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "INVITE",
      async (client, _group, current) => {
        this.requireOwner(current);
        const result = await client.query(
          `UPDATE study_group_invitations SET revoked_at=clock_timestamp()
        WHERE id=$1 AND group_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
          [inviteId, groupId],
        );
        if (!result.rowCount) unavailable();
        return { revoked: true as const };
      },
    );
  }
  async acceptInvitation(
    actorId: string,
    input: { groupId: string; token: string },
  ) {
    uuid(actorId);
    uuid(input.groupId);
    if (
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token)
    )
      invalid();
    await consumeRate(this.pool, actorId, "ACCEPT");
    return transaction(this.pool, async (client) => {
      await lockAccounts(client, [actorId], true);
      const group = await lockGroup(client, input.groupId, true);
      const existing = await membership(client, group.id, actorId);
      if (existing && existing.status !== "LEFT") unavailable();
      // Validate capability before quota errors; unavailable invitations reveal no group capacity.
      const invite = await client.query<{ id: string }>(
        `SELECT id FROM study_group_invitations WHERE group_id=$1 AND token_digest=$2
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [group.id, this.digest(input.token)],
      );
      if (!invite.rowCount) unavailable();
      await this.checkUserCaps(client, actorId, false);
      await this.checkGroupCap(client, group.id, "study_group_memberships");
      await client.query(
        `INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'MEMBER')
        ON CONFLICT(group_id,user_id) DO UPDATE SET role='MEMBER',status='ACTIVE',joined_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE study_group_memberships.status='LEFT'`,
        [group.id, actorId],
      );
      const consumed = await client.query(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
        UPDATE study_group_invitations SET accepted_at=instant.now,accepted_by_user_id=$3 FROM instant
        WHERE id=$1 AND group_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>instant.now RETURNING id`,
        [invite.rows[0].id, group.id, actorId],
      );
      if (!consumed.rowCount) unavailable();
      return groupResponse(group, "MEMBER");
    });
  }
  async leaveGroup(actorId: string, groupId: string) {
    return this.scoped(
      actorId,
      groupId,
      true,
      "MEMBERSHIP",
      async (client, _group, current) => {
        if (current.role === "OWNER") unavailable();
        await client.query(
          "UPDATE study_group_memberships SET status='LEFT',role='MEMBER',updated_at=clock_timestamp() WHERE group_id=$1 AND user_id=$2",
          [groupId, actorId],
        );
        return { left: true as const };
      },
    );
  }
  async removeMember(actorId: string, groupId: string, userId: string) {
    uuid(userId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "MEMBERSHIP",
      async (client, _group, current) => {
        const target = await authorize(client, groupId, userId);
        if (
          actorId === userId ||
          target.role === "OWNER" ||
          current.role === "MEMBER" ||
          (current.role === "MODERATOR" && target.role !== "MEMBER")
        )
          unavailable();
        await client.query(
          "UPDATE study_group_memberships SET status='REMOVED',role='MEMBER',updated_at=clock_timestamp() WHERE group_id=$1 AND user_id=$2",
          [groupId, userId],
        );
        return { removed: true as const };
      },
      [userId],
    );
  }
  async setRole(
    actorId: string,
    groupId: string,
    userId: string,
    input: { role: "MEMBER" | "MODERATOR" },
  ) {
    if (input.role !== "MEMBER" && input.role !== "MODERATOR") invalid();
    uuid(userId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "MEMBERSHIP",
      async (client, _group, current) => {
        this.requireOwner(current);
        const target = await authorize(client, groupId, userId);
        if (target.role === "OWNER" || userId === actorId) unavailable();
        await client.query(
          "UPDATE study_group_memberships SET role=$3,updated_at=clock_timestamp() WHERE group_id=$1 AND user_id=$2",
          [groupId, userId, input.role],
        );
        return this.memberResponse({ ...target, role: input.role });
      },
      [userId],
    );
  }
  async transferOwnership(
    actorId: string,
    groupId: string,
    input: { userId: string },
  ) {
    uuid(input.userId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "MEMBERSHIP",
      async (client, group, current) => {
        this.requireOwner(current);
        if (actorId === input.userId) unavailable();
        await authorize(client, groupId, input.userId);
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM study_groups WHERE owner_user_id=$1",
          [input.userId],
        );
        if (count.rows[0].count >= 2) limitReached();
        // Demote first for immediate unique-index enforcement; owner reference is checked at commit.
        await client.query(
          "UPDATE study_group_memberships SET role='MEMBER',updated_at=clock_timestamp() WHERE group_id=$1 AND user_id=$2",
          [groupId, actorId],
        );
        await client.query(
          "UPDATE study_group_memberships SET role='OWNER',updated_at=clock_timestamp() WHERE group_id=$1 AND user_id=$2",
          [groupId, input.userId],
        );
        const result = await client.query<GroupRow>(
          "UPDATE study_groups SET owner_user_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [groupId, input.userId],
        );
        return groupResponse(result.rows[0], "MEMBER");
      },
      [input.userId],
    );
  }
  async archiveGroup(actorId: string, groupId: string) {
    return this.scoped(
      actorId,
      groupId,
      true,
      "MEMBERSHIP",
      async (client, _group, current) => {
        this.requireOwner(current);
        await client.query(
          "UPDATE study_groups SET status='ARCHIVED',updated_at=clock_timestamp() WHERE id=$1",
          [groupId],
        );
        return { archived: true as const };
      },
    );
  }
  async listTexts(actorId: string, groupId: string, query: PageQuery = {}) {
    const page = pagination(query);
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (client, _group, current) => {
        const result = await client.query<TextRow>(
          `SELECT t.*,u.display_name FROM study_group_texts t JOIN users u ON u.id=t.author_user_id
        WHERE t.group_id=$1 AND ($2::boolean OR t.hidden_at IS NULL) ORDER BY t.created_at,t.id`,
          [groupId, current.role !== 'MEMBER'],
        );
        return paginate(
          await this.projectTexts(actorId, result.rows),
          page,
        );
      },
    );
  }
  async createText(actorId: string, groupId: string, input: GroupTextInput) {
    const payload = normalizeGroupText(input);
    return this.scoped(
      actorId,
      groupId,
      true,
      'TEXT',
      async (client, _group, current) => {
        if (payload.clientMessageId) {
          const existing = (
            await client.query<TextRow>(
              'SELECT t.*,u.display_name FROM study_group_texts t JOIN users u ON u.id=t.author_user_id WHERE t.group_id=$1 AND t.author_user_id=$2 AND t.client_message_id=$3',
              [groupId, actorId, payload.clientMessageId],
            )
          ).rows[0];
          if (existing) {
            if (
              existing.body !== payload.body ||
              (existing.context_type ?? null) !==
                (payload.context?.type ?? null) ||
              (existing.context_id ?? null) !== (payload.context?.id ?? null)
            )
              throw new StudyGroupFailure(
                'GROUP_SEND_CONFLICT',
                409,
                'Client message ID was already used',
              );
            if (existing.hidden_at && current.role === 'MEMBER') unavailable();
            return this.projectText(actorId, existing);
          }
        }
        const context = payload.context
          ? await this.contexts?.resolve(actorId, payload.context)
          : null;
        if (payload.context && context?.availability !== 'AVAILABLE')
          throw new StudyGroupFailure(
            'GROUP_CONTEXT_UNAVAILABLE',
            404,
            'Learning context is unavailable',
          );
        await this.checkGroupCap(client, groupId, 'study_group_texts');
        const inserted = (
          await client.query<TextRow>(
            'INSERT INTO study_group_texts(group_id,author_user_id,body,client_message_id,context_type,context_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              groupId,
              actorId,
              payload.body,
              payload.clientMessageId,
              payload.context?.type ?? null,
              payload.context?.id ?? null,
            ],
          )
        ).rows[0];
        return this.projectText(actorId, {
          ...inserted,
          display_name: current.display_name,
        });
      },
    );
  }

  async syncTexts(
    actorId: string,
    groupId: string,
    input: GroupSyncInput = {},
  ) {
    const query = normalizeGroupSync(input);
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (client, group, current) => {
        const before = query.cursor
          ? this.syncCursors.decode(
              query.cursor,
              groupId,
              actorId,
              current.generation,
              query.limit,
            )
          : '0';
        if (parseSequence(before) > parseSequence(group.text_sequence))
          throw new StudyGroupFailure(
            'GROUP_INVALID_CURSOR',
            400,
            'Group cursor is invalid',
          );
        if (query.renderedIds.length) {
          const owned = await client.query(
            'SELECT id FROM study_group_texts WHERE group_id=$1 AND id=ANY($2::uuid[])',
            [groupId, query.renderedIds],
          );
          if (owned.rowCount !== query.renderedIds.length) unavailable();
        }
        const privileged = current.role !== 'MEMBER';
        const rows = (
          await client.query<TextRow>(
            'SELECT t.*,u.display_name FROM study_group_texts t JOIN users u ON u.id=t.author_user_id WHERE t.group_id=$1 AND t.sequence>$2::bigint AND ($3::boolean OR t.hidden_at IS NULL) ORDER BY t.sequence LIMIT $4',
            [groupId, before, privileged, query.limit + 1],
          )
        ).rows;
        const hasMore = rows.length > query.limit;
        const selected = rows.slice(0, query.limit);
        const position = hasMore
          ? String(selected.at(-1)!.sequence)
          : String(group.text_sequence);
        const rendered = (
          await client.query<{ id: string; hidden: boolean }>(
            'SELECT id,hidden_at IS NOT NULL AS hidden FROM study_group_texts WHERE group_id=$1 AND id=ANY($2::uuid[]) AND ($3::boolean OR hidden_at IS NULL)',
            [groupId, query.renderedIds, privileged],
          )
        ).rows;
        const stillVisibleIds = rendered.map((row) => row.id);
        const hiddenIds = rendered.filter((row) => row.hidden).map((row) => row.id);
        const unreadCount = (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM study_group_texts WHERE group_id=$1 AND sequence>$2::bigint AND author_user_id<>$3 AND hidden_at IS NULL',
            [groupId, current.read_sequence, actorId],
          )
        ).rows[0].count;
        const cursor = this.syncCursors.encode(
          groupId,
          actorId,
          current.generation,
          position,
          query.limit,
        );
        return {
          items: await this.projectTexts(actorId, selected),
          stillVisibleIds,
          hiddenIds,
          cursor,
          nextCursor: hasMore ? cursor : null,
          hasMore,
          version: String(group.change_version),
          unreadCount,
          lastReadSequence: String(current.read_sequence),
          groupRole: current.role,
          groupStatus: 'ACTIVE' as const,
        };
      },
    );
  }

  async markRead(actorId: string, groupId: string, textId: string) {
    uuid(textId);
    return this.scoped(
      actorId,
      groupId,
      true,
      undefined,
      async (client, _group, current) => {
        const text = (
          await client.query<{ sequence: string }>(
            'SELECT sequence FROM study_group_texts WHERE id=$1 AND group_id=$2 AND ($3::boolean OR hidden_at IS NULL)',
            [textId, groupId, current.role !== 'MEMBER'],
          )
        ).rows[0];
        if (!text) unavailable();
        const state = (
          await client.query<{ read_sequence: string }>(
            'UPDATE study_group_memberships SET read_sequence=GREATEST(read_sequence,$3::bigint) WHERE group_id=$1 AND user_id=$2 RETURNING read_sequence',
            [groupId, actorId, text.sequence],
          )
        ).rows[0];
        const unread = (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM study_group_texts WHERE group_id=$1 AND sequence>$2::bigint AND author_user_id<>$3 AND hidden_at IS NULL',
            [groupId, state.read_sequence, actorId],
          )
        ).rows[0].count;
        return {
          lastReadSequence: String(state.read_sequence),
          unreadCount: unread,
        };
      },
    );
  }

  async getTextContext(actorId: string, groupId: string, textId: string) {
    uuid(textId);
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (client, _group, current) => {
        const row = (
          await client.query<TextRow>(
            'SELECT t.*,u.display_name FROM study_group_texts t JOIN users u ON u.id=t.author_user_id WHERE t.group_id=$1 AND t.id=$2 AND ($3::boolean OR t.hidden_at IS NULL)',
            [groupId, textId, current.role !== 'MEMBER'],
          )
        ).rows[0];
        if (!row) unavailable();
        return {textId:row.id,context:(await this.projectText(actorId, row)).context};
      },
    );
  }

  async hideText(actorId: string, groupId: string, textId: string) {
    uuid(textId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "MODERATION",
      async (client, _group, current) => {
        this.requireModerator(current);
        const result = await client.query(
          `UPDATE study_group_texts SET hidden_at=COALESCE(hidden_at,clock_timestamp()),hidden_by_user_id=COALESCE(hidden_by_user_id,$3)
        WHERE id=$1 AND group_id=$2 RETURNING id`,
          [textId, groupId, actorId],
        );
        if (!result.rowCount) unavailable();
        return { hidden: true as const };
      },
    );
  }
  async reportText(
    actorId: string,
    groupId: string,
    textId: string,
    input: { reason: string },
  ) {
    uuid(textId);
    const reason = bounded(input.reason, 500);
    return this.scoped(
      actorId,
      groupId,
      true,
      "REPORT",
      async (client, _group, current) => {
        const text = await client.query<{ id: string }>(
          `SELECT id FROM study_group_texts WHERE id=$1 AND group_id=$2 AND ($3::boolean OR hidden_at IS NULL)`,
          [textId, groupId, current.role !== "MEMBER"],
        );
        if (!text.rowCount) unavailable();
        const existing = await client.query(
          "SELECT id FROM study_group_reports WHERE group_id=$1 AND text_id=$2 AND reporter_user_id=$3",
          [groupId, textId, actorId],
        );
        if (!existing.rowCount) {
          await this.checkGroupCap(client, groupId, "study_group_reports");
          await client.query(
            "INSERT INTO study_group_reports(group_id,text_id,reporter_user_id,reason) VALUES($1,$2,$3,$4)",
            [groupId, textId, actorId, reason],
          );
        }
        return { acknowledged: true as const };
      },
    );
  }
  async listReports(actorId: string, groupId: string, query: PageQuery = {}) {
    const page = pagination(query);
    return this.scoped(
      actorId,
      groupId,
      false,
      undefined,
      async (client, _group, current) => {
        this.requireModerator(current);
        const result = await client.query<{
          id: string;
          text_id: string;
          reason: string;
          status: "OPEN" | "RESOLVED";
          created_at: Date;
        }>(
          "SELECT id,text_id,reason,status,created_at FROM study_group_reports WHERE group_id=$1 ORDER BY created_at,id",
          [groupId],
        );
        return paginate(
          result.rows.map((row): ReportResponse => ({
            id: row.id,
            textId: row.text_id,
            reason: row.reason,
            status: row.status,
            createdAt: row.created_at.toISOString(),
          })),
          page,
        );
      },
    );
  }
  async resolveReport(actorId: string, groupId: string, reportId: string) {
    uuid(reportId);
    return this.scoped(
      actorId,
      groupId,
      true,
      "MODERATION",
      async (client, _group, current) => {
        this.requireModerator(current);
        const result = await client.query(
          `UPDATE study_group_reports SET status='RESOLVED',resolved_at=COALESCE(resolved_at,clock_timestamp()),resolved_by_user_id=COALESCE(resolved_by_user_id,$3)
        WHERE id=$1 AND group_id=$2 RETURNING id`,
          [reportId, groupId, actorId],
        );
        if (!result.rowCount) unavailable();
        return { resolved: true as const };
      },
    );
  }
  private async projectTexts(
    actorId: string,
    rows: TextRow[],
  ): Promise<TextResponse[]> {
    const references = rows.map((row) =>
      row.context_type && row.context_id
        ? { type: row.context_type, id: row.context_id }
        : null,
    );
    const cards = this.contexts
      ? await this.contexts.resolvePage(actorId, references)
      : references.map((reference) =>
          reference ? { availability: 'UNAVAILABLE' as const } : null,
        );
    return rows.map((row, index) => ({
      ...this.textResponse(row),
      context: cards[index],
    }));
  }
  private async projectText(
    actorId: string,
    row: TextRow,
  ): Promise<TextResponse> {
    const context =
      row.context_type && row.context_id
        ? await this.contexts?.resolve(actorId, {
            type: row.context_type,
            id: row.context_id,
          })
        : null;
    return {
      ...this.textResponse(row),
      context:
        context ?? (row.context_id ? { availability: 'UNAVAILABLE' } : null),
    };
  }
  private textResponse(row: TextRow): TextResponse {
    return {
      id: row.id,
      sequence: String(row.sequence),
      context: null,
      body: row.body,
      author: { userId: row.author_user_id, displayName: row.display_name },
      hidden: row.hidden_at !== null,
      createdAt: row.created_at.toISOString(),
    };
  }

  private requireOwner(current: MembershipRow) {
    if (current.role !== "OWNER") unavailable();
  }
  private requireModerator(current: MembershipRow) {
    if (current.role === "MEMBER") unavailable();
  }
  private digest(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private async scoped<T>(
    actorId: string,
    groupId: string,
    write: boolean,
    rate: RateAction | undefined,
    operation: (
      client: PoolClient,
      group: GroupRow,
      current: MembershipRow,
    ) => Promise<T>,
    targets: string[] = [],
  ) {
    uuid(actorId);
    uuid(groupId);
    targets.forEach(uuid);
    if (rate) await consumeRate(this.pool, actorId, rate);
    return transaction(this.pool, async (client) => {
      await lockAccounts(client, [actorId, ...targets], write);
      const group = await lockGroup(client, groupId, write);
      const current = await authorize(client, groupId, actorId);
      return operation(client, group, current);
    });
  }

  private async checkUserCaps(
    client: PoolClient,
    userId: string,
    ownership: boolean,
  ) {
    const result = await client.query<{ memberships: number; owned: number }>(
      `SELECT
      (SELECT count(*)::int FROM study_group_memberships WHERE user_id=$1 AND status='ACTIVE') AS memberships,
      (SELECT count(*)::int FROM study_groups WHERE owner_user_id=$1) AS owned`,
      [userId],
    );
    if (
      result.rows[0].memberships >= 20 ||
      (ownership && result.rows[0].owned >= 2)
    )
      limitReached();
  }
  private async checkGroupCap(
    client: PoolClient,
    groupId: string,
    table:
      | "study_group_memberships"
      | "study_group_invitations"
      | "study_group_texts"
      | "study_group_reports",
  ) {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM " +
        table +
        " WHERE group_id=$1" +
        (table === "study_group_memberships" ? " AND status='ACTIVE'" : ""),
      [groupId],
    );
    if (result.rows[0].count >= 20) limitReached();
  }
  private memberResponse(row: MembershipRow): MemberResponse {
    return {
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at.toISOString(),
    };
  }
}

interface TextRow {
  sequence:string;
  context_type:'LIBRARY_RESOURCE'|'COMMUNITY_POST'|null;
  context_id:string|null;
  id: string;
  body: string;
  author_user_id: string;
  display_name: string;
  hidden_at: Date | null;
  created_at: Date;
}
