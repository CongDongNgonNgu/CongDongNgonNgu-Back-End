import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SqlHarness } from "../phase22/sql-harness";
import {
  transaction,
  lockAccounts,
} from "../../src/study-groups/study-group.store";
import { AttachmentCleanupLedger } from "../../src/attachments/attachment-cleanup-ledger";

describe("Phase30 fenced terminal object cleanup", () => {
  const db = new SqlHarness(),
    ledger = new AttachmentCleanupLedger();
  let actor: string, language: string;
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
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    actor = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic cleanup actor','ACTIVE',now())",
      [actor, actor + "@phase30.invalid"],
    );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
  });
  async function fixture(uncertain = false, neverStarted = false, ready = false) {
    const attachmentId = randomUUID(),
      objectId = randomUUID(),
      jobId = randomUUID();
    await db.pool.query(
      `INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at,state,deleted_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PUBLIC',$4,$5,'IMAGE','image/png',20,'synthetic.png',4456468,clock_timestamp()+interval '1 hour',$6,CASE WHEN $6='DELETED' THEN clock_timestamp() ELSE NULL END)`,
      [attachmentId, actor, language, randomUUID(), "a".repeat(64),ready?"READY":"DELETED"],
    );
    await db.pool.query(
      `INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,status,put_claim,put_claimed_at,put_settled_at,put_uncertain,etag) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream',$5,$6,$7,$8,$9,$10)`,
      [
        objectId,
        attachmentId,
        randomUUID(),
        "b".repeat(64),
        uncertain || neverStarted ? "RESERVED" : "WRITTEN",
        neverStarted ? null : randomUUID(),
        neverStarted ? null : new Date(),
        uncertain || neverStarted ? null : new Date(),
        uncertain,
        uncertain || neverStarted ? null : '"synthetic-etag"',
      ],
    );
    await db.pool.query(
      "INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,'REMOVED')",
      [jobId, attachmentId, objectId],
    );
    return { attachmentId, objectId, jobId };
  }
  const tx = <T>(f: (c: import("pg").PoolClient) => Promise<T>) =>
    transaction(db.pool, async (c) => {
      await lockAccounts(c, [actor], false);
      return f(c);
    });
  const claim = (f: {
    attachmentId: string;
    objectId: string;
    jobId: string;
  }) => tx((c) => ledger.claim(c, f, randomUUID()));
  const observation = async (claim: {
    manifest: {
      locator: import("../../src/attachments/storage/attachment-storage.port").AttachmentObjectLocator;
    };
  }) => ({
    confirmedLocator: { ...claim.manifest.locator },
    headMissing: true as const,
    ownedListingResidual: 0,
    observedAt: (await db.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,
  });
  async function readySource() {
    const f=await fixture(false,false,true), normalized=randomUUID(), thumbnail=randomUUID();
    for(const [id,kind,type] of [[normalized,'normalized','image/webp'],[thumbnail,'thumbnail','image/webp']]) await db.pool.query("INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,status,etag,put_claim,put_claimed_at,put_settled_at) VALUES($1,$2,$3,$4,$5,20,$6,'WRITTEN','\"ready-etag\"',$7,clock_timestamp(),clock_timestamp())",[id,f.attachmentId,randomUUID(),kind,'c'.repeat(64),type,randomUUID()]);
    await db.pool.query('UPDATE attachments SET source_object_id=$2,normalized_object_id=$3,thumbnail_object_id=$4,version=version+1 WHERE id=$1',[f.attachmentId,f.objectId,normalized,thumbnail]);return {...f,normalized,thumbnail};
  }
  it('cleans quarantined originals only after exact selected ready derivatives exist',async()=>{const f=await readySource(), c=await claim(f);await tx(async x=>ledger.finish(x,c,await observation(c)));expect((await db.pool.query('SELECT state,physical_cleanup_at FROM attachments WHERE id=$1',[f.attachmentId])).rows[0]).toEqual({state:'READY',physical_cleanup_at:null});expect((await db.pool.query('SELECT status FROM attachment_objects WHERE id=$1',[f.normalized])).rows[0].status).toBe('WRITTEN');});
  it('never deletes selected live derivatives or originals with unavailable ready derivatives',async()=>{const f=await readySource(),jobId=randomUUID();await db.pool.query("INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,'ORPHAN')",[jobId,f.attachmentId,f.normalized]);await expect(claim({...f,objectId:f.normalized,jobId})).rejects.toThrow('ATTACHMENT_CLEANUP_CLAIM_CONFLICT');await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[f.thumbnail]);await expect(claim(f)).rejects.toThrow('ATTACHMENT_CLEANUP_CLAIM_CONFLICT');});
  it("grants one of two competing workers a durable full-snapshot claim", async () => {
    const f = await fixture();
    const r = await Promise.allSettled([claim(f), claim(f)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const c = (
      r.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof claim>>
      >
    ).value;
    expect(c.expected).toMatchObject({
      sizeBytes: 20,
      sha256: "b".repeat(64),
      version: '"synthetic-etag"',
    });
    expect(
      (
        await db.pool.query(
          "SELECT attempts FROM attachment_cleanup_jobs WHERE id=$1",
          [f.jobId],
        )
      ).rows[0].attempts,
    ).toBe(1);
  });
  it("blocks uncertain writes without consuming a cleanup attempt", async () => {
    const f = await fixture(true);
    await expect(claim(f)).rejects.toThrow("ATTACHMENT_CLEANUP_CLAIM_CONFLICT");
    expect(
      (
        await db.pool.query(
          "SELECT attempts FROM attachment_cleanup_jobs WHERE id=$1",
          [f.jobId],
        )
      ).rows[0].attempts,
    ).toBe(0);
  });
  it("fences a stale worker after expired-lease takeover", async () => {
    const f = await fixture(),
      old = await claim(f);
    await db.pool.query(
      "UPDATE attachment_cleanup_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.jobId],
    );
    const current = await claim(f);
    await expect(
      tx(async (c) => ledger.finish(c, old, await observation(old))),
    ).rejects.toThrow("ATTACHMENT_CLEANUP_CLAIM_CONFLICT");
    await tx(async (c) => ledger.finish(c, current, await observation(current)));
  });
  it("rejects finish after expiry without takeover", async () => {
    const f = await fixture(),
      c = await claim(f);
    await db.pool.query(
      "UPDATE attachment_cleanup_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.jobId],
    );
    await expect(
      tx(async (x) => ledger.finish(x, c, await observation(c))),
    ).rejects.toThrow("ATTACHMENT_CLEANUP_CLAIM_CONFLICT");
  });
  it("requires independent fresh HEAD and listing absence", async () => {
    const f = await fixture(),
      c = await claim(f);
    for (const o of [
      { ...await observation(c), headMissing: false },
      { ...await observation(c), ownedListingResidual: 1 },
      { ...await observation(c), observedAt: new Date(0) },
    ])
      await expect(tx(async (x) => ledger.finish(x, c, o))).rejects.toThrow(
        "ATTACHMENT_CLEANUP_INTEGRITY",
      );
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_objects WHERE id=$1",
          [f.objectId],
        )
      ).rows[0].status,
    ).toBe("DELETE_PENDING");
  });
  it("rejects another object absence receipt without releasing deletion debt", async () => {
    const f = await fixture(),
      c = await claim(f);
    const receipt = {
      ...await observation(c),
      confirmedLocator: { ...c.manifest.locator, objectId: randomUUID() },
    };
    await expect(tx(async (x) => ledger.finish(x, c, receipt))).rejects.toThrow(
      "ATTACHMENT_CLEANUP_INTEGRITY",
    );
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_objects WHERE id=$1",
          [f.objectId],
        )
      ).rows[0].status,
    ).toBe("DELETE_PENDING");
    expect(
      (
        await db.pool.query(
          "SELECT completed_at FROM attachment_cleanup_jobs WHERE id=$1",
          [f.jobId],
        )
      ).rows[0].completed_at,
    ).toBeNull();
  });
  it("finishes idempotently without releasing parent reservations", async () => {
    const f = await fixture(),
      c = await claim(f);
    await tx(async (x) => ledger.finish(x, c, await observation(c)));
    await tx(async (x) => ledger.finish(x, c, await observation(c)));
    expect(
      (
        await db.pool.query(
          "SELECT status,put_uncertain FROM attachment_objects WHERE id=$1",
          [f.objectId],
        )
      ).rows[0],
    ).toEqual({ status: "DELETED", put_uncertain: false });
    expect(
      (
        await db.pool.query(
          "SELECT reserved_bytes,physical_cleanup_at FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toEqual({ reserved_bytes: "4456468", physical_cleanup_at: null });
  });
  it("backs off failed deletion and retains all ownership/debt", async () => {
    const f = await fixture(),
      c = await claim(f);
    await tx((x) => ledger.fail(x, c, "STORAGE_UNAVAILABLE"));
    await expect(claim(f)).rejects.toThrow("ATTACHMENT_CLEANUP_CLAIM_CONFLICT");
    const j = (
      await db.pool.query(
        "SELECT lease_owner,last_error_code,next_attempt_at>clock_timestamp() AS delayed FROM attachment_cleanup_jobs WHERE id=$1",
        [f.jobId],
      )
    ).rows[0];
    expect(j).toEqual({
      lease_owner: null,
      last_error_code: "STORAGE_UNAVAILABLE",
      delayed: true,
    });
    await expect(
      tx((x) => ledger.fail(x, c, "secret token example" as never)),
    ).rejects.toThrow("ATTACHMENT_CLEANUP_INTEGRITY");
  });
  it("allows absence-only cleanup for a never-started physical key", async () => {
    const f = await fixture(false, true),
      c = await claim(f);
    expect(c.expected).toBeNull();
    await tx(async (x) => ledger.finish(x, c, await observation(c)));
  });
  it("stops after ten acquired attempts, preserving deletion debt", async () => {
    const f = await fixture();
    await db.pool.query(
      "UPDATE attachment_cleanup_jobs SET attempts=9 WHERE id=$1",
      [f.jobId],
    );
    const c = await claim(f);
    await tx((x) => ledger.fail(x, c, "STORAGE_UNAVAILABLE"));
    await db.pool.query(
      "UPDATE attachment_cleanup_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.jobId],
    );
    await expect(claim(f)).rejects.toThrow("ATTACHMENT_CLEANUP_CLAIM_CONFLICT");
  });
});
