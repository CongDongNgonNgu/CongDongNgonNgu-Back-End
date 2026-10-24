import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SqlHarness } from "../phase22/sql-harness";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { transaction } from "../../src/study-groups/study-group.store";
import {
  readDraftStatus,
  patchDraftMetadata,
} from "../../src/attachments/initiation/attachment-draft-repository";

describe("Phase30 draft status and optimistic metadata under live scope authorization", () => {
  const db = new SqlHarness();
  let actor: string,
    foreign: string,
    language: string,
    id: string,
    group: string;
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
    for (const file of files) await db.migration(file);
  }, 180000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    actor = randomUUID();
    foreign = randomUUID();
    id = randomUUID();
    for (const user of [actor, foreign])
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic draft actor','ACTIVE',now())",
        [user, user + "@phase30.invalid"],
      );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    group = await transaction(db.pool, async (c) => {
      const created = (
        await c.query(
          "INSERT INTO study_groups(owner_user_id,name) VALUES($1,'Synthetic') RETURNING id",
          [actor],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO study_group_memberships(group_id,user_id,role,status) VALUES($1,$2,'OWNER','ACTIVE')",
        [created, actor],
      );
      return created;
    });
    await db.pool.query(
      "INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PRIVATE',$4,$5,'TEXT','text/plain',5,'synthetic.txt',65541,clock_timestamp()+interval '1 hour')",
      [id, actor, language, randomUUID(), "a".repeat(64)],
    );
  });
  it("projects safe draft fields without provider, immutable replay or lease internals", async () => {
    const value = await transaction(db.pool, (c) =>
      readDraftStatus(c, actor, id),
    );
    expect(value).toMatchObject({
      id,
      state: "TEMPORARY",
      filename: "synthetic.txt",
      metadataVersion: 0,
      caption: "",
      alt: "",
      expectedBytes: 5,
    });
    expect(Object.keys(value).sort()).toEqual(
      [
        "alt",
        "caption",
        "expectedBytes",
        "expiresAt",
        "filename",
        "format",
        "id",
        "metadataVersion",
        "state",
      ].sort(),
    );
  });
  it("returns identical opaque absence for foreign owner, unknown and deleted drafts", async () => {
    for (const [user, attachment] of [
      [foreign, id],
      [actor, randomUUID()],
    ])
      await expect(
        transaction(db.pool, (c) => readDraftStatus(c, user, attachment)),
      ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
    await db.pool.query(
      "UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",
      [id],
    );
    await expect(
      transaction(db.pool, (c) => readDraftStatus(c, actor, id)),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
  });
  it("allows one metadata writer and does not mutate the immutable initiation fingerprint", async () => {
    const results = await Promise.allSettled(
      ["first", "second"].map((caption) =>
        transaction(db.pool, (c) =>
          patchDraftMetadata(c, actor, id, {
            expectedMetadataVersion: 0,
            caption,
            alt: "safe",
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason),
    ).toEqual([
      expect.objectContaining({
        code: "ATTACHMENT_METADATA_CONFLICT",
        status: 409,
      }),
    ]);
    const row = (
      await db.pool.query(
        "SELECT caption,metadata_version,version,init_fingerprint FROM attachments WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(["first", "second"]).toContain(row.caption);
    expect(Number(row.metadata_version)).toBe(1);
    expect(row.init_fingerprint).toBe("a".repeat(64));
  });
  it("rejects membership-generation changes even when membership is active again", async () => {
    const generation = (
      await db.pool.query(
        "SELECT generation FROM study_group_memberships WHERE group_id=$1 AND user_id=$2",
        [group, actor],
      )
    ).rows[0].generation;
    const groupDraft = randomUUID();
    await db.pool.query(
      "INSERT INTO attachments(id,uploader_id,scope,scope_id,group_id,scope_generation,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'STUDY_GROUP',$3,$3,$4,$5,$6,'TEXT','text/plain',5,'synthetic.txt',65541,clock_timestamp()+interval '1 hour')",
      [groupDraft, actor, group, generation, randomUUID(), "b".repeat(64)],
    );
    await db.pool.query(
      "UPDATE study_group_memberships SET generation=$3 WHERE group_id=$1 AND user_id=$2",
      [group, actor, randomUUID()],
    );
    await expect(
      transaction(db.pool, (c) => readDraftStatus(c, actor, groupDraft)),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    await expect(
      transaction(db.pool, (c) =>
        patchDraftMetadata(c, actor, groupDraft, {
          expectedMetadataVersion: 0,
          caption: "never",
          alt: "",
        }),
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  });
  it("rejects unknown metadata fields and unsafe text without changing metadata", async () => {
    for (const patch of [
      { expectedMetadataVersion: 0, caption: "bad\u202e", alt: "" },
      {
        expectedMetadataVersion: 0,
        caption: "safe",
        alt: "",
        filename: "changed.txt",
      },
    ])
      await expect(
        transaction(db.pool, (c) => patchDraftMetadata(c, actor, id, patch)),
      ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT metadata_version FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0].metadata_version,
    ).toBe("0");
  });
  it("creates exactly one reservation and rate charge across concurrent identical retries, returning edited metadata", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PRIVATE",
      },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
      caption: "original",
      alt: "",
    };
    const [a, b] = await Promise.all([
      repo.initiate(actor, input),
      repo.initiate(actor, input),
    ]);
    expect(a).toEqual(b);
    expect(a).toHaveProperty("id");
    const created = (a as { id: string }).id;
    await transaction(db.pool, (c) =>
      patchDraftMetadata(c, actor, created, {
        expectedMetadataVersion: 0,
        caption: "edited",
        alt: "",
      }),
    );
    expect(await repo.initiate(actor, input)).toMatchObject({
      id: created,
      caption: "edited",
      metadataVersion: 1,
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE client_upload_id=$1",
          [input.clientUploadId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='initiate'",
          [actor],
        )
      ).rows[0].used,
    ).toBe("1");
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='bytes'",
          [actor],
        )
      ).rows[0].used,
    ).toBe("65541");
    await expect(
      repo.initiate(actor, { ...input, caption: "conflicting" }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_INITIATION_CONFLICT",
      status: 409,
    });
  });
  it("keeps a failed fresh-domain attempt charged once while allowing later current authorization", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: { kind: "STUDY_GROUP", groupId: group },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    await db.pool.query(
      "UPDATE study_groups SET status='ARCHIVED' WHERE id=$1",
      [group],
    );
    await expect(repo.initiate(actor, input)).rejects.toMatchObject({
      code: "ATTACHMENT_UNAVAILABLE",
    });
    await expect(repo.initiate(actor, input)).rejects.toMatchObject({
      code: "ATTACHMENT_UNAVAILABLE",
    });
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, input.clientUploadId],
        )
      ).rows[0].status,
    ).toBe("ADMITTED");
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='initiate'",
          [actor],
        )
      ).rows[0].used,
    ).toBe("1");
    await db.pool.query("UPDATE study_groups SET status='ACTIVE' WHERE id=$1", [
      group,
    ]);
    expect(await repo.initiate(actor, input)).toMatchObject({
      state: "TEMPORARY",
    });
  });
  it("fails closed without active format capability and consumes no quota", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: false,
      image: false,
      video: false,
      text: false,
    });
    await expect(
      repo.initiate(actor, {
        clientUploadId: randomUUID(),
        scope: { kind: "STUDY_GROUP", groupId: group },
        filename: "safe.txt",
        mime: "text/plain",
        bytes: 5,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENTS_UNAVAILABLE", status: 503 });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_initiation_admissions",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("does not recreate an expired durable admission or charge its counters again", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: { kind: "STUDY_GROUP", groupId: group },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    const { parseInitiation } =
      await import("../../src/attachments/initiation/initiation-input");
    const parsed = parseInitiation(input);
    await db.pool.query(
      "INSERT INTO attachment_initiation_admissions(uploader_id,client_upload_id,fingerprint,source_bytes,format,created_at,expires_at) SELECT $1,$2,$3,5,'TEXT',t-interval '25 hours',t-interval '1 hour' FROM (SELECT clock_timestamp() t) s",
      [actor, input.clientUploadId, parsed.fingerprint],
    );
    await expect(repo.initiate(actor, input)).rejects.toMatchObject({
      code: "ATTACHMENT_INITIATION_CONFLICT",
      status: 409,
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE client_upload_id=$1",
          [input.clientUploadId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1",
          [actor],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("retains the replay reference after binding without exposing bound metadata through the draft helper", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PRIVATE",
      },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    const created = (await repo.initiate(actor, input)) as { id: string };
    await transaction(db.pool, async (c) => {
      const post = (
        await c.query(
          "INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,'DISCUSSION','Synthetic bound post','PRIVATE') RETURNING id",
          [actor, language],
        )
      ).rows[0].id;
      await c.query(
        "UPDATE attachments SET state='UPLOADING',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '1 minute',version=version+1 WHERE id=$1",
        [created.id, randomUUID()],
      );
      await c.query(
        "UPDATE attachments SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1",
        [created.id],
      );
      await c.query(
        "UPDATE attachments SET state='READY',version=version+1 WHERE id=$1",
        [created.id],
      );
      await c.query(
        "INSERT INTO attachment_bindings(attachment_id,uploader_id,scope,scope_id,community_post_id,position) VALUES($1,$2,'COMMUNITY',$3,$4,0)",
        [created.id, actor, language, post],
      );
    });
    expect(await repo.initiate(actor, input)).toEqual({
      attachmentId: created.id,
      requiresBoundProjection: true,
    });
    await expect(
      transaction(db.pool, (c) => readDraftStatus(c, actor, created.id)),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
    await expect(
      transaction(db.pool, (c) =>
        patchDraftMetadata(c, actor, created.id, {
          expectedMetadataVersion: 0,
          caption: "changed",
          alt: "",
        }),
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", status: 404 });
  });
  it("does not revive an unbound group draft after membership generation changes", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: { kind: "STUDY_GROUP", groupId: group },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    const before = await repo.initiate(actor, input);
    await db.pool.query(
      "UPDATE study_group_memberships SET generation=$3 WHERE group_id=$1 AND user_id=$2",
      [group, actor, randomUUID()],
    );
    await expect(repo.initiate(actor, input)).rejects.toMatchObject({
      code: "ATTACHMENT_UNAVAILABLE",
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE client_upload_id=$1",
          [input.clientUploadId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(before).toHaveProperty("id");
  });
  it("retains failed quota admission once and can reserve after capacity is genuinely released", async () => {
    const { AttachmentQuotaLedger } =
      await import("../../src/attachments/attachment-quota-ledger");
    const quota = new AttachmentQuotaLedger();
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: { kind: "STUDY_GROUP", groupId: group },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    await transaction(db.pool, (c) =>
      quota.changeReservation(c, actor, 64 * 1048576, 0),
    );
    await expect(repo.initiate(actor, input)).rejects.toMatchObject({
      code: "ATTACHMENT_QUOTA_EXCEEDED",
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE client_upload_id=$1",
          [input.clientUploadId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, input.clientUploadId],
        )
      ).rows[0].status,
    ).toBe("ADMITTED");
    await transaction(db.pool, (c) =>
      quota.changeReservation(c, actor, -64 * 1048576, 0),
    );
    expect(await repo.initiate(actor, input)).toMatchObject({
      state: "TEMPORARY",
    });
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='initiate'",
          [actor],
        )
      ).rows[0].used,
    ).toBe("1");
  });
  it.each(["other actor", "other client"] as const)(
    "rejects durable admission link to %s attachment",
    async (attack) => {
      const uploader = attack === "other actor" ? foreign : actor;
      const client = randomUUID();
      await db.pool.query(
        "INSERT INTO attachment_initiation_admissions(uploader_id,client_upload_id,fingerprint,source_bytes,format,created_at,expires_at) SELECT $1,$2,$3,5,'TEXT',t,t+interval '24 hours' FROM (SELECT clock_timestamp() t) s",
        [uploader, client, "a".repeat(64)],
      );
      const before = (
        await db.pool.query(
          "SELECT sum(used)::text n FROM attachment_quota_counters",
        )
      ).rows[0].n;
      await db.invalidCommit(
        "UPDATE attachment_initiation_admissions SET status='CREATED',attachment_id=$3 WHERE uploader_id=$1 AND client_upload_id=$2",
        [uploader, client, id],
        "23503",
      );
      expect(
        (
          await db.pool.query(
            "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
            [uploader, client],
          )
        ).rows[0].status,
      ).toBe("ADMITTED");
      expect(
        (
          await db.pool.query(
            "SELECT sum(used)::text n FROM attachment_quota_counters",
          )
        ).rows[0].n,
      ).toBe(before);
    },
  );
  it("waits for a real actor-account writer and denies after its revocation commits without a lock cycle", async () => {
    const repo = new AttachmentInitiationRepository(db.pool, {
      enabled: true,
      image: false,
      video: false,
      text: true,
    });
    const input = {
      clientUploadId: randomUUID(),
      scope: { kind: "STUDY_GROUP", groupId: group },
      filename: "safe.txt",
      mime: "text/plain",
      bytes: 5,
    };
    const writer = await db.pool.connect();
    let committed = false;
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await writer.query("BEGIN");
      const holder = Number(
        (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid,
      );
      await writer.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        actor,
      ]);
      await writer.query("UPDATE users SET status='DISABLED' WHERE id=$1", [
        actor,
      ]);
      pending = repo.initiate(actor, input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const waits = await db.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO attachment_initiation_admissions%'",
          [holder],
        );
        if (waits.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(blocked).toBe(true);
      await writer.query("COMMIT");
      committed = true;
      expect(await pending).toMatchObject({
        error: { code: "ATTACHMENT_UNAVAILABLE", status: 404 },
      });
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM attachments WHERE client_upload_id=$1",
            [input.clientUploadId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.pool.query(
            "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
            [actor, input.clientUploadId],
          )
        ).rows[0].status,
      ).toBe("ADMITTED");
    } finally {
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
      if (pending) await pending;
    }
  });
});
