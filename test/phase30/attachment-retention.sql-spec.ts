import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SqlHarness } from "../phase22/sql-harness";
import { transaction } from "../../src/study-groups/study-group.store";
import { AttachmentRetentionLedger } from "../../src/attachments/retention/attachment-retention-ledger";
describe("bounded closed-window and unlinked-admission retention in owned schemas only", () => {
  const db = new SqlHarness(),
    retention = new AttachmentRetentionLedger();
  let actor: string, subjects: string[];
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
    subjects = [];
    actor = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic retention actor','ACTIVE',now())",
      [actor, actor + "@phase30.invalid"],
    );
  });
  afterEach(async () => {
    if (subjects.length)
      await db.pool.query(
        "DELETE FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
        [subjects],
      );
  });
  async function counter(
    kind: "ACTOR" | "IP" | "DEPLOYMENT",
    action: string,
    windowHours = 72,
    updatedHours = 72,
    subject = randomUUID(),
  ) {
    subjects.push(subject);
    await db.pool.query(
      `INSERT INTO attachment_quota_counters(kind,subject,action,window_start,updated_at,used,ceiling) VALUES($1,$2,$3,CASE WHEN $4=-1 THEN to_timestamp(0) ELSE clock_timestamp()-($4::int*interval '1 hour') END,clock_timestamp()-($5::int*interval '1 hour'),1,10)`,
      [kind, subject, action, windowHours, updatedHours],
    );
    return subject;
  }
  async function admission(
    options: { status?: "ADMITTED" | "REJECTED"; expired?: boolean } = {},
  ) {
    const id = randomUUID(),
      status = options.status ?? "ADMITTED";
    await db.pool.query(
      `INSERT INTO attachment_initiation_admissions(uploader_id,client_upload_id,fingerprint,source_bytes,format,status,failure_code,created_at,expires_at) VALUES($1,$2,$3,1,'TEXT',$4,$5,clock_timestamp()-interval '25 hours',clock_timestamp()+CASE WHEN $6 THEN -interval '1 hour' ELSE interval '1 hour' END)`,
      [
        actor,
        id,
        "a".repeat(64),
        status,
        status === "REJECTED" ? "POLICY_REJECTED" : null,
        options.expired !== false,
      ],
    );
    return id;
  }
  it("deletes only the five allowlisted old rate actions, never epoch capacity or recently touched/current windows", async () => {
    for (const action of [
      "initiate",
      "source",
      "read",
      "upload_attempt",
      "ingress",
    ])
      await counter("ACTOR", action);
    for (const action of ["bytes", "metadata", "upload", "pending"])
      await counter("DEPLOYMENT", action, -1);
    await counter("ACTOR", "read", 72, 1);
    await counter("IP", "read", 1, 72);
    await counter("ACTOR", "read", 47, 72);
    await counter("ACTOR", "read", 72, 47);
    expect(await transaction(db.pool, (c) => retention.purge(c, 20))).toEqual({
      admissionsPurged: 0,
      rateCountersPurged: 5,
      used: 5,
      remaining: 15,
    });
    const rows = (
      await db.pool.query(
        "SELECT action,window_start,updated_at FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
        [subjects],
      )
    ).rows;
    expect(rows).toHaveLength(8);
    expect(
      rows
        .filter((r) => new Date(r.window_start).getTime() === 0)
        .map((r) => r.action)
        .sort(),
    ).toEqual(["bytes", "metadata", "pending", "upload"]);
  });
  it("shares one bounded budget across old unlinked admissions first and rate rows second", async () => {
    const a = await admission(),
      b = await admission({ status: "REJECTED" }),
      notExpired = await admission({ expired: false });
    for (let n = 0; n < 5; n++) await counter("ACTOR", "read");
    expect(await transaction(db.pool, (c) => retention.purge(c, 3))).toEqual({
      admissionsPurged: 2,
      rateCountersPurged: 1,
      used: 3,
      remaining: 0,
    });
    expect(
      (
        await db.pool.query(
          "SELECT client_upload_id FROM attachment_initiation_admissions WHERE uploader_id=$1",
          [actor],
        )
      ).rows.map((r) => r.client_upload_id),
    ).toEqual([notExpired]);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
          [subjects],
        )
      ).rows[0].n,
    ).toBe(4);
    expect(a).not.toBe(b);
  });
  it("never removes a linked CREATED admission even after its retention expiry", async () => {
    const language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    const id = randomUUID(),
      client = randomUUID();
    await db.pool.query(
      `INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,created_at,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PRIVATE',$4,$5,'TEXT','text/plain',1,'synthetic.txt',65537,clock_timestamp()-interval '26 hours',clock_timestamp()-interval '25 hours')`,
      [id, actor, language, client, "a".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO attachment_initiation_admissions(uploader_id,client_upload_id,fingerprint,source_bytes,format,status,attachment_id,created_at,expires_at) VALUES($1,$2,$3,1,'TEXT','CREATED',$4,clock_timestamp()-interval '26 hours',clock_timestamp()-interval '1 hour')`,
      [actor, client, "a".repeat(64), id],
    );
    expect(
      await transaction(db.pool, (c) => retention.purge(c, 20)),
    ).toMatchObject({ used: 0 });
    expect(
      (
        await db.pool.query(
          "SELECT attachment_id FROM attachment_initiation_admissions WHERE uploader_id=$1",
          [actor],
        )
      ).rows[0].attachment_id,
    ).toBe(id);
  });
  it("skips a real locked rate counter and preserves a concurrent refresh of its last-use time", async () => {
    const heldSubject = await counter("ACTOR", "read"),
      freeSubject = await counter("IP", "read"),
      writer = await db.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT 1 FROM attachment_quota_counters WHERE subject=$1 FOR UPDATE",
        [heldSubject],
      );
      await writer.query(
        "UPDATE attachment_quota_counters SET updated_at=clock_timestamp() WHERE subject=$1",
        [heldSubject],
      );
      const result = await transaction(db.pool, async (c) => {
        await c.query("SET LOCAL lock_timeout='500ms'");
        return retention.purge(c, 20);
      });
      expect(result.rateCountersPurged).toBe(1);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    expect(
      (
        await db.pool.query(
          "SELECT subject FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
          [[heldSubject, freeSubject]],
        )
      ).rows.map((r) => r.subject),
    ).toEqual([heldSubject]);
    expect(
      await transaction(db.pool, (c) => retention.purge(c, 20)),
    ).toMatchObject({ used: 0 });
  });
  it("skips a locked admission rather than waiting behind an initiation transaction", async () => {
    const held = await admission(),
      free = await admission(),
      writer = await db.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT 1 FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2 FOR UPDATE",
        [actor, held],
      );
      expect(
        await transaction(db.pool, async (c) => {
          await c.query("SET LOCAL lock_timeout='500ms'");
          return retention.purge(c, 20);
        }),
      ).toMatchObject({ admissionsPurged: 1 });
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    expect(
      (
        await db.pool.query(
          "SELECT client_upload_id FROM attachment_initiation_admissions WHERE uploader_id=$1",
          [actor],
        )
      ).rows.map((r) => r.client_upload_id),
    ).toEqual([held]);
    expect(free).not.toBe(held);
  });

  it("locks eligible counter kinds in ACTOR then IP then DEPLOYMENT order within a partial batch", async () => {
    const deployment = await counter("DEPLOYMENT", "read"),
      ip = await counter("IP", "read"),
      actorCounter = await counter("ACTOR", "read");
    expect(
      await transaction(db.pool, (c) => retention.purge(c, 2)),
    ).toMatchObject({ rateCountersPurged: 2, used: 2, remaining: 0 });
    expect(
      (
        await db.pool.query(
          "SELECT subject FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
          [[deployment, ip, actorCounter]],
        )
      ).rows.map((r) => r.subject),
    ).toEqual([deployment]);
  });
  it("caps a backlog at twenty rows and reports the exact shared budget for its next batch", async () => {
    const batch = Array.from({ length: 25 }, () => randomUUID());
    subjects.push(...batch);
    await db.pool.query(
      "INSERT INTO attachment_quota_counters(kind,subject,action,window_start,updated_at,used,ceiling) SELECT 'ACTOR',subject,'read',clock_timestamp()-interval '72 hours',clock_timestamp()-interval '72 hours',1,10 FROM unnest($1::text[]) AS fixture(subject)",
      [batch],
    );
    expect(await transaction(db.pool, (c) => retention.purge(c))).toEqual({
      admissionsPurged: 0,
      rateCountersPurged: 20,
      used: 20,
      remaining: 0,
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_quota_counters WHERE subject=ANY($1::text[])",
          [batch],
        )
      ).rows[0].n,
    ).toBe(5);
    expect(await transaction(db.pool, (c) => retention.purge(c))).toEqual({
      admissionsPurged: 0,
      rateCountersPurged: 5,
      used: 5,
      remaining: 15,
    });
  });
});
