import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { SqlHarness } from "../phase22/sql-harness";
import { transaction } from "../../src/study-groups/study-group.store";
import { bindNewParent } from "../../src/attachments/binding/attachment-binding";
describe("Phase30 internal atomic initial binding", () => {
  const db = new SqlHarness();
  let actor: string, other: string, language: string, group: string;
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
          Number(f.slice(0, 4)) <= 39,
      )
      .sort();
    for (const f of files) await db.migration(f);
  }, 180000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    actor = randomUUID();
    other = randomUUID();
    for (const id of [actor, other])
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic binding actor','ACTIVE',now())",
        [id, id + "@phase30.invalid"],
      );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    group = await transaction(db.pool, async (c) => {
      const id = (
        await c.query(
          "INSERT INTO study_groups(name,owner_user_id) VALUES('Synthetic binding group',$1) RETURNING id",
          [actor],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'OWNER')",
        [id, actor],
      );
      return id;
    });
  });
  async function ready(
    options: {
      owner?: string;
      scope?: "COMMUNITY" | "STUDY_GROUP";
      expired?: boolean;
      format?: "TEXT" | "VIDEO";
      postType?: string;
      visibility?: string;
    } = {},
  ) {
    const id = randomUUID(),
      scope = options.scope ?? "COMMUNITY",
      format = options.format ?? "TEXT";
    const generation =
      scope === "STUDY_GROUP"
        ? (
            await db.pool.query(
              "SELECT generation FROM study_group_memberships WHERE group_id=$1 AND user_id=$2",
              [group, actor],
            )
          ).rows[0].generation
        : null;
    // Synthetic SQL READY fixture only, not a storage/processor acceptance claim.
    await db.pool.query(
      `INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,group_id,scope_generation,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,5,$14,65541,'READY',clock_timestamp()-interval '2 hours',CASE WHEN $15 THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1 hour' END)`,
      [
        id,
        options.owner ?? actor,
        scope,
        scope === "COMMUNITY" ? language : group,
        scope === "COMMUNITY" ? language : null,
        scope === "STUDY_GROUP" ? group : null,
        generation,
        scope === "COMMUNITY" ? (options.postType ?? "DISCUSSION") : null,
        scope === "COMMUNITY" ? (options.visibility ?? "PRIVATE") : null,
        randomUUID(),
        "a".repeat(64),
        format,
        format === "TEXT" ? "text/plain" : "video/mp4",
        format === "TEXT" ? "synthetic.txt" : "synthetic.mp4",
        Boolean(options.expired),
      ],
    );
    return id;
  }
  async function post(
    c: PoolClient,
    id: string,
    options: { author?: string; postType?: string; visibility?: string } = {},
  ) {
    await c.query(
      "INSERT INTO community_posts(id,author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,$3,$4,'Synthetic binding post',$5)",
      [
        id,
        options.author ?? actor,
        language,
        options.postType ?? "DISCUSSION",
        options.visibility ?? "PRIVATE",
      ],
    );
  }
  it("binds caller order atomically while preventing later rebind even after removal", async () => {
    const ids = [await ready(), await ready()].sort().reverse(),
      parent = randomUUID();
    await transaction(db.pool, async (c) => {
      await bindNewParent(c, actor, ids, async (tx) => {
        await post(tx, parent);
        return {
          parent: { kind: "COMMUNITY", postId: parent },
          result: undefined,
        };
      });
    });
    expect(
      (
        await db.pool.query(
          "SELECT attachment_id,position FROM attachment_bindings WHERE community_post_id=$1 ORDER BY position",
          [parent],
        )
      ).rows,
    ).toEqual(
      ids.map((attachment_id, position) => ({ attachment_id, position })),
    );
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE id=ANY($1::uuid[]) AND first_bound_at IS NOT NULL",
          [ids],
        )
      ).rows[0].n,
    ).toBe(2);
    await db.pool.query(
      "UPDATE attachment_bindings SET removed_at=clock_timestamp() WHERE attachment_id=$1",
      [ids[0]],
    );
    const next = randomUUID();
    await expect(
      transaction(db.pool, async (c) => {
        await bindNewParent(c, actor, [ids[0]], async (tx) => {
          await post(tx, next);
          return {
            parent: { kind: "COMMUNITY", postId: next },
            result: undefined,
          };
        });
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM community_posts WHERE id=$1",
          [next],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it.each([
    "owner",
    "scope",
    "expired",
    "postType",
    "visibility",
    "state",
    "duplicates",
    "count",
    "videos",
  ] as const)(
    "rolls back the new parent and all bindings for invalid %s",
    async (reason) => {
      let ids = [
        await ready(
          reason === "owner"
            ? { owner: other }
            : reason === "scope"
              ? { scope: "STUDY_GROUP" }
              : reason === "expired"
                ? { expired: true }
                : reason === "postType"
                  ? { postType: "QUESTION" }
                  : reason === "visibility"
                    ? { visibility: "PUBLIC" }
                    : {},
        ),
      ];
      if (reason === "state")
        await db.pool.query(
          "UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",
          [ids[0]],
        );
      if (reason === "duplicates") ids = [ids[0], ids[0]];
      if (reason === "count")
        ids = await Promise.all(Array.from({ length: 5 }, () => ready()));
      if (reason === "videos")
        ids = [
          await ready({ format: "VIDEO" }),
          await ready({ format: "VIDEO" }),
        ];
      const parent = randomUUID();
      await expect(
        transaction(db.pool, async (c) => {
          await bindNewParent(c, actor, ids, async (tx) => {
            await post(tx, parent);
            return {
              parent: { kind: "COMMUNITY", postId: parent },
              result: undefined,
            };
          });
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM community_posts WHERE id=$1",
            [parent],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM attachment_bindings WHERE attachment_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );
  it("requires original parent authorship and a currently verified uploader", async () => {
    const id = await ready(),
      parent = randomUUID();
    await expect(
      transaction(db.pool, async (c) => {
        await bindNewParent(c, actor, [id], async (tx) => {
          await post(tx, parent, { author: other, visibility: "PUBLIC" });
          return {
            parent: { kind: "COMMUNITY", postId: parent },
            result: undefined,
          };
        });
      }),
    ).rejects.toThrow();
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      actor,
    ]);
    await expect(
      transaction(db.pool, async (c) => {
        await bindNewParent(c, actor, [id], async (tx) => {
          await post(tx, parent);
          return {
            parent: { kind: "COMMUNITY", postId: parent },
            result: undefined,
          };
        });
      }),
    ).rejects.toThrow();
  });
  it("rejects a READY group draft from a former membership generation and rolls back its new text", async () => {
    const id = await ready({ scope: "STUDY_GROUP" }),
      text = randomUUID();
    await db.pool.query(
      "UPDATE study_group_memberships SET generation=$3 WHERE group_id=$1 AND user_id=$2",
      [group, actor, randomUUID()],
    );
    await expect(
      transaction(db.pool, async (c) => {
        await bindNewParent(c, actor, [id], async (tx) => {
          await tx.query(
            "INSERT INTO study_group_texts(id,group_id,author_user_id,body) VALUES($1,$2,$3,'Synthetic binding text')",
            [text, group, actor],
          );
          return {
            parent: { kind: "STUDY_GROUP", groupId: group, textId: text },
            result: undefined,
          };
        });
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM study_group_texts WHERE id=$1",
          [text],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("preserves caller-owned existing parent authorization for an unverified group author with no attachments", async () => {
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      actor,
    ]);
    const text = randomUUID();
    const result = await transaction(db.pool, (c) =>
      bindNewParent(c, actor, [], async (tx) => {
        await tx.query(
          "INSERT INTO study_group_texts(id,group_id,author_user_id,body) VALUES($1,$2,$3,'Synthetic legacy text')",
          [text, group, actor],
        );
        const { authorizeBoundParent } =
          await import("../../src/attachments/authorization/attachment-authorization");
        await authorizeBoundParent(tx, actor, {
          kind: "STUDY_GROUP",
          groupId: group,
          textId: text,
        });
        return {
          parent: { kind: "STUDY_GROUP", groupId: group, textId: text },
          result: { textId: text },
        };
      }),
    );
    expect(result.result).toEqual({ textId: text });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_bindings WHERE group_text_id=$1",
          [text],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("binds a valid group attachment to its exact new text under the current membership generation", async () => {
    const id = await ready({ scope: "STUDY_GROUP" }),
      text = randomUUID();
    await transaction(db.pool, (c) =>
      bindNewParent(c, actor, [id], async (tx) => {
        await tx.query(
          "INSERT INTO study_group_texts(id,group_id,author_user_id,body) VALUES($1,$2,$3,'Synthetic attachment text')",
          [text, group, actor],
        );
        return {
          parent: { kind: "STUDY_GROUP", groupId: group, textId: text },
          result: { textId: text },
        };
      }),
    );
    expect(
      (
        await db.pool.query(
          "SELECT attachment_id,group_text_id,position FROM attachment_bindings WHERE attachment_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ attachment_id: id, group_text_id: text, position: 0 }]);
  });
});
