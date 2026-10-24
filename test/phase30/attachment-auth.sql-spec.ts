import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SqlHarness } from "../phase22/sql-harness";
import { transaction } from "../../src/study-groups/study-group.store";
import {
  authorizeDraftScope,
  authorizeBoundParent,
  authorizeAttachmentRemoval,
} from "../../src/attachments/authorization/attachment-authorization";
describe("Phase30 fresh domain attachment authorization", () => {
  const db = new SqlHarness();
  let a: string,
    b: string,
    c: string,
    language: string,
    group: string,
    otherGroup: string,
    text: string,
    post: string,
    room: string,
    message: string;
  beforeAll(async () => {
    await db.open();
    await db.migration("0027_phase22_study_groups.down.sql");
    const files = (
      await readdir(path.resolve(__dirname, "../../database/migrations"))
    )
      .filter(
        (f) =>
          /^\d{4}_[\w-]+\.sql$/.test(f) &&
          Number(f.slice(0, 4)) >= 2 &&
          Number(f.slice(0, 4)) <= 38,
      )
      .sort();
    for (const f of files) await db.migration(f);
  }, 180000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [a, b, c])
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic authorization actor','ACTIVE',now())",
        [id, id + "@phase30.invalid"],
      );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    for (const id of [a, b, c]) {
      await db.pool.query(
        "INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission) VALUES($1,true,true,'RELATIONSHIP_GATED')",
        [id],
      );
      const ul = (
        await db.pool.query(
          "INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency) VALUES($1,$2,true,true,'B1') RETURNING id",
          [id, language],
        )
      ).rows[0].id;
      await db.pool.query(
        "INSERT INTO language_exchange_languages(user_id,user_language_id,direction) VALUES($1,$2,'OFFER'),($1,$2,'WANT')",
        [id, ul],
      );
    }
    await db.pool.query(
      "INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$1,'CONNECTED')",
      [a, b],
    );
    room = (
      await db.pool.query(
        "INSERT INTO direct_conversations(participant_a_id,participant_b_id) VALUES($1,$2) RETURNING id",
        [a, b],
      )
    ).rows[0].id;
    message = (
      await db.pool.query(
        "INSERT INTO direct_messages(conversation_id,sender_user_id,client_message_id,text,sequence,participant_a_id,participant_b_id) VALUES($1,$2,$3,'Synthetic',1,$2,$4) RETURNING id",
        [room, a, randomUUID(), b],
      )
    ).rows[0].id;
    group = await makeGroup(a, [b]);
    otherGroup = await makeGroup(c, []);
    text = (
      await db.pool.query(
        "INSERT INTO study_group_texts(group_id,author_user_id,body) VALUES($1,$2,'Synthetic') RETURNING id",
        [group, b],
      )
    ).rows[0].id;
    post = (
      await db.pool.query(
        "INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,'DISCUSSION','Synthetic','PRIVATE') RETURNING id",
        [a, language],
      )
    ).rows[0].id;
  });
  async function makeGroup(owner: string, members: string[]) {
    return transaction(db.pool, async (client) => {
      const id = (
        await client.query(
          "INSERT INTO study_groups(name,owner_user_id) VALUES('Synthetic authorization group',$1) RETURNING id",
          [owner],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'OWNER')",
        [id, owner],
      );
      for (const member of members)
        await client.query(
          "INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'MEMBER')",
          [id, member],
        );
      return id;
    });
  }
  const unavailable = { code: "ATTACHMENT_UNAVAILABLE" };
  it("preserves unverified ACTIVE group-member and public-viewer reads while denying new uploads", async () => {
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      b,
    ]);
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, b, {
          kind: "STUDY_GROUP",
          groupId: group,
          textId: text,
        }),
      ),
    ).resolves.toMatchObject({ authorId: b });
    await expect(
      transaction(db.pool, (client) =>
        authorizeAttachmentRemoval(client, b, b, {
          kind: "STUDY_GROUP",
          groupId: group,
          textId: text,
        }),
      ),
    ).resolves.toMatchObject({ authorId: b });
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, b, { kind: "STUDY_GROUP", groupId: group }),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query(
      "UPDATE community_posts SET visibility='PUBLIC' WHERE id=$1",
      [post],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, b, { kind: "COMMUNITY", postId: post }),
      ),
    ).resolves.toMatchObject({ authorId: a });
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, b, {
          kind: "COMMUNITY",
          postType: "DISCUSSION",
          languageId: language,
          visibility: "PUBLIC",
        }),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      a,
    ]);
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, b, { kind: "COMMUNITY", postId: post }),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("fences private group drafts across leave/rejoin generations", async () => {
    const first = await transaction(db.pool, (client) =>
      authorizeDraftScope(client, b, { kind: "STUDY_GROUP", groupId: group }),
    );
    await db.pool.query(
      "UPDATE study_group_memberships SET status='LEFT' WHERE group_id=$1 AND user_id=$2",
      [group, b],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(
          client,
          b,
          { kind: "STUDY_GROUP", groupId: group },
          first.generation,
        ),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query(
      "UPDATE study_group_memberships SET status='ACTIVE' WHERE group_id=$1 AND user_id=$2",
      [group, b],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(
          client,
          b,
          { kind: "STUDY_GROUP", groupId: group },
          first.generation,
        ),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("fences DM drafts across disconnect/reconnect but permits eligible bound history", async () => {
    const first = await transaction(db.pool, (client) =>
      authorizeDraftScope(client, a, {
        kind: "DIRECT_MESSAGE",
        conversationId: room,
      }),
    );
    await db.pool.query(
      "DELETE FROM language_exchange_connections WHERE participant_a_id=$1 AND participant_b_id=$2",
      [a, b],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, a, {
          kind: "DIRECT_MESSAGE",
          conversationId: room,
          messageId: message,
        }),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query(
      "INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$1,'CONNECTED')",
      [a, b],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(
          client,
          a,
          { kind: "DIRECT_MESSAGE", conversationId: room },
          first.generation,
        ),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, b, {
          kind: "DIRECT_MESSAGE",
          conversationId: room,
          messageId: message,
        }),
      ),
    ).resolves.toMatchObject({ authorId: a });
  });
  it("never turns group membership into DM rights or a connection into private-group rights", async () => {
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, c, { kind: "STUDY_GROUP", groupId: group }),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, c, {
          kind: "DIRECT_MESSAGE",
          conversationId: room,
        }),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, b, {
          kind: "STUDY_GROUP",
          groupId: otherGroup,
        }),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("enforces exact group/text binding and hidden-role policy even for uploader removal", async () => {
    const parent = {
      kind: "STUDY_GROUP" as const,
      groupId: group,
      textId: text,
    };
    await expect(
      transaction(db.pool, (client) =>
        authorizeAttachmentRemoval(client, b, b, parent),
      ),
    ).resolves.toMatchObject({ authorId: b });
    await db.pool.query(
      "UPDATE study_group_texts SET hidden_at=now(),hidden_by_user_id=$2 WHERE id=$1",
      [text, a],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, b, parent)),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) =>
        authorizeAttachmentRemoval(client, b, b, parent),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).resolves.toMatchObject({ authorId: b });
    await expect(
      transaction(db.pool, (client) =>
        authorizeAttachmentRemoval(client, a, b, parent),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, c, { ...parent, groupId: otherGroup }),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("rejects archived groups and revoked members on fresh bound reads", async () => {
    const parent = {
      kind: "STUDY_GROUP" as const,
      groupId: group,
      textId: text,
    };
    await db.pool.query(
      "UPDATE study_group_memberships SET status='REMOVED' WHERE group_id=$1 AND user_id=$2",
      [group, b],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, b, parent)),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query(
      "UPDATE study_groups SET status='ARCHIVED' WHERE id=$1",
      [group],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).rejects.toMatchObject(unavailable);
  });
  it("uses current Community visibility, author eligibility, language and moderation", async () => {
    const parent = { kind: "COMMUNITY" as const, postId: post };
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, null, parent),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, b, parent)),
    ).rejects.toMatchObject(unavailable);
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).resolves.toMatchObject({ authorId: a });
    await db.pool.query(
      "UPDATE community_posts SET visibility='PUBLIC' WHERE id=$1",
      [post],
    );
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, null, parent),
      ),
    ).resolves.toMatchObject({ authorId: a });
    await db.pool.query("UPDATE languages SET active=false WHERE id=$1", [
      language,
    ]);
    await expect(
      transaction(db.pool, (client) =>
        authorizeBoundParent(client, null, parent),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query("UPDATE languages SET active=true WHERE id=$1", [
      language,
    ]);
    await db.pool.query(
      "UPDATE community_posts SET moderation_state='HIDDEN' WHERE id=$1",
      [post],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).rejects.toMatchObject(unavailable);
  });
  it("denies blocked, contact-disabled, disabled and unverified participants", async () => {
    const parent = {
      kind: "DIRECT_MESSAGE" as const,
      conversationId: room,
      messageId: message,
    };
    await db.pool.query(
      "UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1",
      [b],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query(
      "UPDATE language_exchange_preferences SET contact_permission='RELATIONSHIP_GATED' WHERE user_id=$1",
      [b],
    );
    await db.pool.query(
      "INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)",
      [b, a],
    );
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query("DELETE FROM language_exchange_blocks");
    await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [b]);
    await expect(
      transaction(db.pool, (client) => authorizeBoundParent(client, a, parent)),
    ).rejects.toMatchObject(unavailable);
    await db.pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [b]);
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      a,
    ]);
    await expect(
      transaction(db.pool, (client) =>
        authorizeDraftScope(client, a, {
          kind: "COMMUNITY",
          postType: "DISCUSSION",
          languageId: language,
          visibility: "PUBLIC",
        }),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("waits for committed domain revoke before authorizing instead of trusting candidate IDs", async () => {
    const writer = await db.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [b]);
      await writer.query("SELECT id FROM study_groups WHERE id=$1 FOR UPDATE", [
        group,
      ]);
      await writer.query(
        "UPDATE study_group_memberships SET status='LEFT' WHERE group_id=$1 AND user_id=$2",
        [group, b],
      );
      const pending = transaction(db.pool, (client) =>
        authorizeBoundParent(client, b, {
          kind: "STUDY_GROUP",
          groupId: group,
          textId: text,
        }),
      );
      await writer.query("COMMIT");
      await expect(pending).rejects.toMatchObject(unavailable);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });
});
