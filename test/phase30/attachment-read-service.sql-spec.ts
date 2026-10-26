import { Readable } from "node:stream";
import { AttachmentReadService } from "../../src/attachments/service/attachment-read-service";
import type {
  AttachmentStorage,
  AttachmentStoredObject,
} from "../../src/attachments/storage/attachment-storage.port";
import { randomUUID, createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SqlHarness } from "../phase22/sql-harness";
import { transaction } from "../../src/study-groups/study-group.store";
import {
  admitAttachmentRead,
  selectAttachmentMetadata,
} from "../../src/attachments/access/attachment-access";
describe("shared fresh-session attachment read service", () => {
  const db = new SqlHarness();
  let owner: string, other: string, language: string;
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
    ip = createHash("sha256").update(randomUUID()).digest("hex");
    owner = randomUUID();
    other = randomUUID();
    for (const id of [owner, other])
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic private media reader','ACTIVE',now())",
        [id, id + "@phase30.invalid"],
      );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
  });
  async function fixture() {
    const id = randomUUID(),
      object = randomUUID();
    const post = (
      await db.pool.query(
        "INSERT INTO community_posts(author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,'DISCUSSION','Synthetic attachment context','PUBLIC') RETURNING id",
        [owner, language],
      )
    ).rows[0].id;
    await db.pool.query(
      `INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PUBLIC',$4,$5,'IMAGE','image/png',20,'synthetic.png',4456468,clock_timestamp()+interval '1 hour')`,
      [id, owner, language, randomUUID(), "a".repeat(64)],
    );
    await db.pool.query(
      "UPDATE attachments SET state='UPLOADING',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '1 minute',version=version+1 WHERE id=$1",
      [id, randomUUID()],
    );
    await db.pool.query(
      "UPDATE attachments SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1",
      [id],
    );
    await db.pool.query(
      "INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,etag,status,put_claim,put_claimed_at,put_settled_at) VALUES($1,$2,$3,'normalized',$4,20,'application/octet-stream',$5,'WRITTEN',$6,clock_timestamp(),clock_timestamp())",
      [
        object,
        id,
        randomUUID(),
        "b".repeat(64),
        '"synthetic-etag"',
        randomUUID(),
      ],
    );
    await db.pool.query(
      "UPDATE attachments SET state='READY',normalized_object_id=$2,version=version+1 WHERE id=$1",
      [id, object],
    );
    await db.pool.query(
      "INSERT INTO attachment_bindings(attachment_id,uploader_id,scope,scope_id,community_post_id,position) VALUES($1,$2,'COMMUNITY',$3,$4,0)",
      [id, owner, language, post],
    );
    return { id, object, post };
  }
  const anonymous = async () => null;
  let ip: string;
  function storage(): AttachmentStorage {
    return {
      head: jest.fn(),
      openRead: jest.fn(),
      putTemporary: jest.fn(),
      deleteOwned: jest.fn(),
      confirmAbsent: jest.fn(),
      listOwnedPrefix: jest.fn(),
      close: jest.fn(),
    };
  }
  async function selected(id: string): Promise<AttachmentStoredObject> {
    return (
      await transaction(db.pool, (c) =>
        admitAttachmentRead(c, owner, id, "normalized"),
      )
    ).object;
  }
  it("refreshes identity on every full/range/HEAD request and rechecks changed parent visibility", async () => {
    const f = await fixture(),
      object = await selected(f.id),
      provider = storage();
    (provider.head as jest.Mock).mockResolvedValue(object);
    (provider.openRead as jest.Mock).mockImplementation(
      async (_expected, range) => ({
        ...object,
        responseBytes: range ? range.end - range.start + 1 : 20,
        body: Readable.from(
          Buffer.alloc(range ? range.end - range.start + 1 : 20),
        ),
      }),
    );
    const service = new AttachmentReadService(db.pool, provider),
      refresh = jest.fn(anonymous);
    const head = await service.read(refresh, f.id, "HEAD", {
      trustedIpHash: ip,
    });
    expect(head).toMatchObject({
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": "20",
        "Cache-Control": "private, no-store",
      },
    });
    expect(head.body).toBeUndefined();
    const read = await service.read(refresh, f.id, "GET", {
      trustedIpHash: ip,
      range: "bytes=2-4",
    });
    expect(read).toMatchObject({
      status: 206,
      headers: { "Content-Length": "3", "Content-Range": "bytes 2-4/20" },
    });
    let size = 0;
    for await (const chunk of read.body!) size += chunk.length;
    expect(size).toBe(3);
    await db.pool.query(
      "UPDATE community_posts SET visibility='PRIVATE' WHERE id=$1",
      [f.post],
    );
    await expect(
      service.read(refresh, f.id, "HEAD", { trustedIpHash: ip }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(provider.head).toHaveBeenCalledTimes(1);
    expect(provider.openRead).toHaveBeenCalledTimes(1);
  });
  it("holds no SQL domain locks during provider I/O and denies the next admission after committed revoke", async () => {
    const f = await fixture(),
      object = await selected(f.id),
      provider = storage();
    (provider.head as jest.Mock).mockImplementation(async () => {
      await transaction(db.pool, async (c) => {
        await c.query("SET LOCAL lock_timeout='500ms'");
        await c.query(
          "UPDATE community_posts SET visibility='PRIVATE' WHERE id=$1",
          [f.post],
        );
      });
      return object;
    });
    const service = new AttachmentReadService(db.pool, provider);
    expect(
      await service.read(anonymous, f.id, "HEAD", { trustedIpHash: ip }),
    ).toHaveProperty("status", 200);
    await expect(
      service.read(anonymous, f.id, "GET", { trustedIpHash: ip }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(provider.openRead).not.toHaveBeenCalled();
  });
  it("does not return provider keys through metadata and leaves failed public lookups durably rate charged", async () => {
    const f = await fixture(),
      service = new AttachmentReadService(db.pool, storage());
    const metadata = await service.metadata(anonymous, f.id, ip);
    expect(JSON.stringify(metadata)).not.toMatch(
      /sha256|etag|attemptId|object_key|r2|bucket/,
    );
    await expect(
      service.metadata(anonymous, randomUUID(), ip),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='IP' AND subject=$1 AND action='read'",
          [ip],
        )
      ).rows[0].used,
    ).toBe("2");
  });
  it("fails closed on missing or changed provider objects and destroys a mismatched returned stream", async () => {
    const f = await fixture(),
      object = await selected(f.id),
      provider = storage(),
      service = new AttachmentReadService(db.pool, provider);
    (provider.head as jest.Mock).mockResolvedValue(null);
    await expect(
      service.read(async () => owner, f.id, "HEAD"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    (provider.head as jest.Mock).mockResolvedValue({
      ...object,
      sha256: "c".repeat(64),
    });
    await expect(
      service.read(async () => owner, f.id, "HEAD"),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
    const body = Readable.from(Buffer.alloc(20));
    (provider.openRead as jest.Mock).mockResolvedValue({
      ...object,
      responseBytes: 21,
      body,
    });
    await expect(
      service.read(async () => owner, f.id, "GET"),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
    expect(body.destroyed).toBe(true);
  });
  it("commits authorized deletion before cleanup and denies every subsequent read", async () => {
    const f = await fixture(),
      provider = storage(),
      service = new AttachmentReadService(db.pool, provider);
    expect(await service.delete(async () => owner, f.id)).toEqual({
      state: "DELETED",
    });
    await expect(
      service.read(async () => owner, f.id, "HEAD"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(provider.head).not.toHaveBeenCalled();
    expect(provider.deleteOwned).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT removed_at FROM attachment_bindings WHERE attachment_id=$1",
          [f.id],
        )
      ).rows[0].removed_at,
    ).not.toBeNull();
  });

  it("initiates and projects current draft metadata, then replays after a metadata CAS edit without another reservation", async () => {
    const { AttachmentInitiationRepository } =
      await import("../../src/attachments/initiation/attachment-initiation-repository");
    const repo = new AttachmentInitiationRepository(db.pool, {
        enabled: true,
        image: false,
        video: false,
        text: true,
      }),
      service = new AttachmentReadService(db.pool, storage());
    const input = {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PUBLIC",
      },
      filename: "synthetic.txt",
      mime: "text/plain",
      bytes: 5,
      caption: "initial",
    };
    const first = await service.initiate(async () => owner, repo, input);
    expect(first).toMatchObject({ state: "TEMPORARY", caption: "initial" });
    expect(
      await service.patchMetadata(async () => owner, first.id, {
        expectedMetadataVersion: 0,
        caption: "edited",
        alt: "safe",
      }),
    ).toMatchObject({ metadataVersion: 1, caption: "edited" });
    expect(
      await service.initiate(async () => owner, repo, input),
    ).toMatchObject({ id: first.id, caption: "edited", metadataVersion: 1 });
    await expect(
      service.patchMetadata(async () => owner, first.id, {
        expectedMetadataVersion: 0,
        caption: "stale",
        alt: "",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_METADATA_CONFLICT" });
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
          [owner],
        )
      ).rows[0].used,
    ).toBe("1");
  });
});
