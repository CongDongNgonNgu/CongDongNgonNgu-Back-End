import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { SqlHarness } from "../phase22/sql-harness";
import { PostgresCorrectionsRepository } from "../../src/corrections/postgres-corrections.repository";
import { CorrectionsRepositoryConflictError } from "../../src/corrections/corrections.repository";
import { PostgresNotificationRepository } from "../../src/notifications/postgres-notification.repository";
import { PostgresConnectionNotificationAccess } from "../../src/notifications/postgres-connection-notification-access";
import { createNotificationIntent } from "../../src/notifications/notification.contracts";
import { createNotificationDomainEvent } from "../../src/notifications/notification-event-integration";
import { projectCurrentNotification } from "../../src/notifications/connection-notification-access";

describe("Phase27 structured security PostgreSQL proof", () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    await db.migration("0027_phase22_study_groups.down.sql");
    const files = (
      await readdir(path.resolve(__dirname, "../../database/migrations"))
    )
      .filter(
        (file) =>
          /^\d{4}_[\w-]+\.sql$/.test(file) &&
          Number(file.slice(0, 4)) >= 2 &&
          Number(file.slice(0, 4)) <= 36,
      )
      .sort();
    for (const file of files) await db.migration(file);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname=current_schema() AND c.relname IN ('community_posts','community_comments',
        'community_structured_responses','community_structured_response_acceptances')`)).rows[0].n).toBe(4);
  }, 180000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
  });
  async function fixture() {
    const [owner, author, outsider] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const id of [owner, author, outsider])
      await db.pool.query(
        `INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Current synthetic name','ACTIVE',now())`,
        [id, id + "@phase27.invalid"],
      );
    const language = (
      await db.pool.query(
        `INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`,
      )
    ).rows[0].id;
    const parent = (
      await db.pool.query(
        `INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,'QUESTION','Synthetic question','PUBLIC') RETURNING id`,
        [owner, language],
      )
    ).rows[0].id;
    const response = (
      await db.pool.query(
        `INSERT INTO community_structured_responses(parent_post_id,author_user_id,response_kind,answer_text) VALUES($1,$2,'QA_ANSWER','Synthetic answer') RETURNING id`,
        [parent, author],
      )
    ).rows[0].id;
    return { owner, author, outsider, parent, response, language };
  }
  async function waitBlocked(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (
          await db.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
            [pid],
          )
        ).rowCount
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Acceptance did not reach the expected database lock");
  }
  it.each([
    "RESPONSE_HIDE",
    "AUTHOR_DISABLE",
    "PARENT_HIDE",
    "LANGUAGE_DISABLE",
  ] as const)(
    "rejects a committed %s race after its service precheck",
    async (kind) => {
      const f = await fixture();
      const blocker = await db.pool.connect();
      const acceptor = await db.pool.connect();
      const pid = Number(
        (await acceptor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );
      try {
        await blocker.query("BEGIN");
        if (kind === "RESPONSE_HIDE")
          await blocker.query(
            `UPDATE community_structured_responses SET moderation_state='HIDDEN' WHERE id=$1`,
            [f.response],
          );
        if (kind === "AUTHOR_DISABLE")
          await blocker.query(
            `UPDATE users SET status='DISABLED' WHERE id=$1`,
            [f.author],
          );
        if (kind === "PARENT_HIDE")
          await blocker.query(
            `UPDATE community_posts SET moderation_state='HIDDEN' WHERE id=$1`,
            [f.parent],
          );
        if (kind === "LANGUAGE_DISABLE")
          await blocker.query("UPDATE languages SET active=false WHERE id=$1", [
            f.language,
          ]);
        const repo = new PostgresCorrectionsRepository({
          connect: async () => ({
            ...acceptor,
            query: acceptor.query.bind(acceptor),
            release: () => undefined,
          }),
        } as unknown as Pool);
        const result = repo
          .setStructuredResponseAcceptance({
            parentPostId: f.parent,
            responseId: f.response,
            acceptedByUserId: f.owner,
            acceptedAt: new Date(),
          })
          .catch((error) => error);
        await waitBlocked(pid);
        await blocker.query("COMMIT");
        expect(await result).toBeInstanceOf(CorrectionsRepositoryConflictError);
        expect(
          (
            await db.pool.query(
              "SELECT count(*)::int AS n FROM community_structured_response_acceptances",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        acceptor.release();
      }
    },
  );
  it("keeps same-response retries idempotent and rejects forged requester or cross-parent responses", async () => {
    const f = await fixture();
    const repo = new PostgresCorrectionsRepository(db.pool);
    const input = {
      parentPostId: f.parent,
      responseId: f.response,
      acceptedByUserId: f.owner,
      acceptedAt: new Date(),
    };
    const first = await repo.setStructuredResponseAcceptance(input);
    expect((await repo.setStructuredResponseAcceptance(input)).id).toBe(
      first.id,
    );
    await expect(
      repo.setStructuredResponseAcceptance({
        ...input,
        acceptedByUserId: f.outsider,
      }),
    ).rejects.toBeInstanceOf(CorrectionsRepositoryConflictError);
    await expect(
      repo.setStructuredResponseAcceptance({
        ...input,
        parentPostId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CorrectionsRepositoryConflictError);
  });
  async function acceptanceNotice() {
    const f = await fixture();
    const corrections = new PostgresCorrectionsRepository(db.pool);
    const accepted = await corrections.setStructuredResponseAcceptance({
      parentPostId: f.parent,
      responseId: f.response,
      acceptedByUserId: f.owner,
      acceptedAt: new Date(),
    });
    const event = createNotificationDomainEvent({
      eventId: accepted.id,
      eventType: "community.response.accepted",
      aggregateType: "CORRECTION_RESPONSE",
      aggregateId: f.response,
      actor: { kind: "USER", userId: f.owner },
      recipientUserId: f.author,
      occurredAt: accepted.acceptedAt,
      idempotencyKey: "phase27:" + accepted.id,
      target: {
        kind: "CORRECTION_RESPONSE",
        id: f.response,
        path: "/private/stale",
      },
      variables: { responseKind: "QA_ANSWER", title: "Stale private snapshot" },
    });
    const repository = new PostgresNotificationRepository(db.pool);
    const claim = await repository.claimIntent(
      createNotificationIntent({
        event,
        notificationType: "ANSWER_ACCEPTED",
        category: "CORRECTIONS",
        priority: "HIGH",
        actor: {
          kind: "USER",
          displayName: "Stale private actor",
          profilePath: "/profiles/stale",
        },
        retention: { mode: "DAYS", days: 365 },
      }),
    );
    if (claim.outcome !== "CREATED")
      throw new Error("Notification fixture conflict");
    return {
      ...f,
      accepted,
      record: claim.record,
      repository,
      access: new PostgresConnectionNotificationAccess(db.pool),
    };
  }
  it.each([
    "PRIVATE_PARENT",
    "HIDDEN_RESPONSE",
    "REVOKED_ACCEPTANCE",
    "DISABLED_ACTOR",
    "DISABLED_RECIPIENT",
    "INACTIVE_LANGUAGE",
  ] as const)(
    "redacts legacy snapshots and unread count on %s",
    async (kind) => {
      const f = await acceptanceNotice();
      expect(await f.access.countUnread(f.author, f.repository)).toBe(1);
      expect(
        await projectCurrentNotification(f.record, false, null, f.access),
      ).toMatchObject({
        available: true,
        response: {
          actor: { displayName: "Current synthetic name" },
          target: { path: "/community/posts/" + f.parent },
          variables: {},
        },
      });
      if (kind === "PRIVATE_PARENT")
        await db.pool.query(
          `UPDATE community_posts SET visibility='PRIVATE' WHERE id=$1`,
          [f.parent],
        );
      if (kind === "HIDDEN_RESPONSE")
        await db.pool.query(
          `UPDATE community_structured_responses SET moderation_state='HIDDEN' WHERE id=$1`,
          [f.response],
        );
      if (kind === "REVOKED_ACCEPTANCE")
        await db.pool.query(
          "UPDATE community_structured_response_acceptances SET revoked_at=now() WHERE id=$1",
          [f.accepted.id],
        );
      if (kind === "DISABLED_ACTOR")
        await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [
          f.owner,
        ]);
      if (kind === "DISABLED_RECIPIENT")
        await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [
          f.author,
        ]);
      if (kind === "INACTIVE_LANGUAGE")
        await db.pool.query("UPDATE languages SET active=false WHERE id=$1", [
          f.language,
        ]);
      expect(
        await projectCurrentNotification(
          f.record,
          false,
          null,
          f.access,
          "SSE",
        ),
      ).toMatchObject({
        available: false,
        response: { actor: { kind: "DELETED" }, target: null, variables: {} },
      });
      expect(await f.access.countUnread(f.author, f.repository)).toBe(0);
    },
  );
  it.each([
    "PRIVATE_PARENT",
    "HIDDEN_PARENT_COMMENT",
    "DISABLED_REPLY_AUTHOR",
  ] as const)("rechecks a general comment reply source on %s", async (kind) => {
    const f = await fixture();
    const root = (
      await db.pool.query(
        `INSERT INTO community_comments(post_id,author_user_id,content,depth) VALUES($1,$2,'Root synthetic comment',0) RETURNING id`,
        [f.parent, f.author],
      )
    ).rows[0].id;
    const reply = (
      await db.pool.query(
        `INSERT INTO community_comments(post_id,author_user_id,parent_comment_id,content,depth) VALUES($1,$2,$3,'Synthetic reply',1) RETURNING id,created_at`,
        [f.parent, f.outsider, root],
      )
    ).rows[0];
    const event = createNotificationDomainEvent({
      eventId: reply.id,
      eventType: "community.comment.created",
      aggregateType: "COMMUNITY_COMMENT",
      aggregateId: reply.id,
      actor: { kind: "USER", userId: f.outsider },
      recipientUserId: f.author,
      occurredAt: new Date(reply.created_at),
      idempotencyKey: "phase27-comment:" + reply.id,
      target: { kind: "COMMUNITY_POST", id: f.parent, path: "/private/stale" },
      variables: { commentKind: "REPLY", title: "Stale private snapshot" },
    });
    const repository = new PostgresNotificationRepository(db.pool);
    const claim = await repository.claimIntent(
      createNotificationIntent({
        event,
        notificationType: "COMMENT_REPLY",
        category: "COMMUNITY",
        priority: "NORMAL",
        actor: {
          kind: "USER",
          displayName: "Stale actor",
          profilePath: "/profiles/stale",
        },
        retention: { mode: "DAYS", days: 180 },
      }),
    );
    if (claim.outcome !== "CREATED")
      throw new Error("Comment notice fixture conflict");
    const access = new PostgresConnectionNotificationAccess(db.pool);
    expect(await access.countUnread(f.author, repository)).toBe(1);
    expect(
      (await projectCurrentNotification(claim.record, false, null, access))
        .available,
    ).toBe(true);
    if (kind === "PRIVATE_PARENT")
      await db.pool.query(
        `UPDATE community_posts SET visibility='PRIVATE' WHERE id=$1`,
        [f.parent],
      );
    if (kind === "HIDDEN_PARENT_COMMENT")
      await db.pool.query(
        `UPDATE community_comments SET moderation_state='HIDDEN' WHERE id=$1`,
        [root],
      );
    if (kind === "DISABLED_REPLY_AUTHOR")
      await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [
        f.outsider,
      ]);
    expect(
      await projectCurrentNotification(
        claim.record,
        false,
        null,
        access,
        "SSE",
      ),
    ).toMatchObject({
      available: false,
      response: { actor: { kind: "DELETED" }, target: null, variables: {} },
    });
    expect(await access.countUnread(f.author, repository)).toBe(0);
  });
});
