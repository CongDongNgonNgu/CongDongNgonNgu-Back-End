import {syntheticSupervisedStorage} from './synthetic-supervised-storage';
import { randomUUID, createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from 'sharp';
import { SqlHarness } from "../phase22/sql-harness";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { AttachmentUploadService } from "../../src/attachments/service/attachment-upload-service";
import {
  AttachmentFinalizeService,
  type AttachmentModerationPolicy,
} from "../../src/attachments/service/attachment-finalize-service";
import {
  AttachmentStorageError,
  type AttachmentStorage,
  type AttachmentStoredObject,
} from "../../src/attachments/storage/attachment-storage.port";

describe("shared finalize orchestration: real SQL and deterministic synthetic storage", () => {
  const db = new SqlHarness(),
    caps = { enabled: true, text: true, image: false, video: false };
  let actor: string, language: string;
  const objects = new Map<
    string,
    { receipt: AttachmentStoredObject; bytes: Buffer }
  >();
  let puts = 0;
  let onNormalized: (() => Promise<void>) | undefined;
  let uncertainPut = false;
  let failNextDerivative = false;
  const storage = {
    ...syntheticSupervisedStorage(async (
      i: Parameters<AttachmentStorage["putTemporary"]>[0],
    ) => {
      const chunks: Buffer[] = [];
      for await (const b of i.body) chunks.push(Buffer.from(b));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(i.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(i.sha256);
      puts++;
      const receipt = {
        locator: i.locator,
        sizeBytes: i.sizeBytes,
        sha256: i.sha256,
        version: '"synthetic-' + puts + '"',
      };
      objects.set(i.locator.objectId, { receipt, bytes });
      if(i.locator.kind!=='source'&&failNextDerivative){failNextDerivative=false;throw new AttachmentStorageError('UNAVAILABLE');}
      if (i.locator.kind === "normalized") {
        await onNormalized?.();
        if (uncertainPut) throw new AttachmentStorageError("UNAVAILABLE");
      }
      return receipt;
    }),
    head: async (locator: AttachmentStoredObject["locator"]) =>
      objects.get(locator.objectId)?.receipt ?? null,
    openRead: async (expected: AttachmentStoredObject) => {
      const value = objects.get(expected.locator.objectId);
      if (!value) throw new AttachmentStorageError("NOT_FOUND");
      return {
        ...value.receipt,
        responseBytes: value.bytes.length,
        body: Readable.from([value.bytes]),
      };
    },
  } as unknown as AttachmentStorage;
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
    await db.pool.query(
      "INSERT INTO attachment_processing_lease(singleton) VALUES(true) ON CONFLICT DO NOTHING",
    );
    objects.clear();
    puts = 0;
    onNormalized = undefined;
    uncertainPut = false;
    failNextDerivative = false;
    actor = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic finalizer actor','ACTIVE',now())",
      [actor, actor + "@phase30.invalid"],
    );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
  });
  async function uploaded(bytes = Buffer.from("abc"),kind:'TEXT'|'IMAGE'='TEXT') {
    const mediaCaps={...caps,image:kind==='IMAGE'};
    const draft = await new AttachmentInitiationRepository(
      db.pool,
      mediaCaps,
    ).initiate(actor, {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PUBLIC",
      },
      filename: kind==='IMAGE'?'synthetic.png':"synthetic.txt",
      mime: kind==='IMAGE'?'image/png':"text/plain",
      bytes: bytes.length,
      caption: "",
      alt: "",
    });
    if (!("id" in draft)) throw Error("fixture invalid");
    await new AttachmentUploadService(db.pool, storage, mediaCaps).upload({
      actorId: actor,
      attachmentId: draft.id,
      contentType: kind==='IMAGE'?'image/png':"text/plain",
      contentLength: bytes.length,
      body: Readable.from([bytes]),
      reauthorize: async () => {},
    });
    return draft.id;
  }
  const request = (id: string, signal?: AbortSignal) => ({
    actorId: actor,
    attachmentId: id,
    reauthorize: async () => {},
    signal,
  });
  const state = async (id: string) =>
    (
      await db.pool.query(
        "SELECT state,pending_slot_held,lease_owner,rejection_code FROM attachments WHERE id=$1",
        [id],
      )
    ).rows[0];
  it('retires an unused second derivative original claim after the first physical write fails, while handing off only the unresolved started producer',async()=>{
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:{r:30,g:60,b:90}}}).png().toBuffer();
    const webp=await sharp(bytes).webp().toBuffer(),id=await uploaded(bytes,'IMAGE');failNextDerivative=true;
    const handoff=jest.fn(),service=new AttachmentFinalizeService(db.pool,storage,{...caps,image:true},{imageProcessor:{process:async()=>({normalized:webp,thumbnail:webp,width:2,height:2,thumbnailWidth:2,thumbnailHeight:2,peakRssBytes:1})},onUncertainPut:handoff});
    await expect(service.finalize(request(id))).rejects.toThrow();
    const derivatives=(await db.pool.query("SELECT id,put_supervision_id,put_abandoned_at,put_uncertain,put_settled_at,etag,status FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source' ORDER BY id",[id])).rows;
    expect(derivatives).toHaveLength(2);expect(derivatives.every(r=>r.put_supervision_id!==null)).toBe(true);
    expect(derivatives.filter(r=>r.put_abandoned_at!==null)).toEqual([expect.objectContaining({put_abandoned_at:expect.any(Date),put_uncertain:false,put_settled_at:null,etag:null,status:'DELETE_PENDING'})]);
    const unresolved=derivatives.filter(r=>r.put_uncertain);expect(unresolved).toHaveLength(1);expect(puts).toBe(2);
    expect(await state(id)).toMatchObject({state:'REJECTED',lease_owner:expect.any(String)});
    expect(handoff).toHaveBeenCalledTimes(1);expect(handoff.mock.calls[0][0].objectId).toBe(unresolved[0].id);expect(handoff.mock.calls[0][1].id).toBe(unresolved[0].put_supervision_id);
    expect(storage.putTemporary).not.toHaveBeenCalled();
  });
  it("publishes inert normalized text only after durable writes and fresh HEAD, and repeats without another object", async () => {
    const id = await uploaded(),
      service = new AttachmentFinalizeService(db.pool, storage, caps);
    const result = await service.finalize(request(id));
    expect(result.state).toBe("READY");
    expect(puts).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(
      /sha256|etag|objectId|bucket|r2/,
    );
    await expect(service.finalize(request(id))).resolves.toHaveProperty(
      "state",
      "READY",
    );
    expect(puts).toBe(2);
    expect(
      (await db.pool.query("SELECT owner FROM attachment_processing_lease"))
        .rows[0].owner,
    ).toBeNull();
    expect(
      (await db.pool.query("SELECT reason FROM attachment_cleanup_jobs"))
        .rows[0].reason,
    ).toBe("ORPHAN");
  });
  it("rejects corrupt/unsafe text and never uploads a derivative or leaves an active native owner", async () => {
    const id = await uploaded(Buffer.from([97, 0, 98]));
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps).finalize(
        request(id),
      ),
    ).resolves.toHaveProperty("state", "REJECTED");
    expect(puts).toBe(1);
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      pending_slot_held: false,
      lease_owner: null,
    });
  });
  it("quarantines a moderation rejection and does not turn it into ready content", async () => {
    const id = await uploaded();
    const moderation: AttachmentModerationPolicy = {
      review: async () => "REJECT",
    };
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps, {
        moderation,
      }).finalize(request(id)),
    ).resolves.toHaveProperty("state", "REJECTED");
    expect(puts).toBe(1);
    expect(await state(id)).toMatchObject({
      rejection_code: "MODERATION_REJECTED",
      lease_owner: null,
    });
  });
  it("records completed derivative writes after revocation but refuses publication and releases only stopped processing", async () => {
    const id = await uploaded();
    onNormalized = async () => {
      await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [
        actor,
      ]);
    };
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps).finalize(
        request(id),
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      lease_owner: null,
    });
    expect(
      (
        await db.pool.query(
          "SELECT put_uncertain,status FROM attachment_objects WHERE attachment_id=$1 AND variant='normalized'",
          [id],
        )
      ).rows[0],
    ).toEqual({ put_uncertain: false, status: "DELETE_PENDING" });
  });
  it("does not publish a positive late write when the caller cancels", async () => {
    const id = await uploaded(),
      abort = new AbortController();
    onNormalized = async () => abort.abort();
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps).finalize(
        request(id, abort.signal),
      ),
    ).rejects.toThrow();
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      lease_owner: null,
    });
    expect(
      (
        await db.pool.query(
          "SELECT put_uncertain FROM attachment_objects WHERE attachment_id=$1 AND variant='normalized'",
          [id],
        )
      ).rows[0].put_uncertain,
    ).toBe(false);
  });
  it("reports durable pending for a concurrent finalize without duplicating processing or writes", async () => {
    const id = await uploaded();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const moderation: AttachmentModerationPolicy = {
      review: async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return "ALLOW";
      },
    };
    const service = new AttachmentFinalizeService(db.pool, storage, caps, {
        moderation,
      }),
      first = service.finalize(request(id));
    await started;
    await expect(service.finalize(request(id))).resolves.toHaveProperty(
      "state",
      "PENDING",
    );
    release();
    await expect(first).resolves.toHaveProperty("state", "READY");
    expect(puts).toBe(2);
  });
  it("fails closed on a missing source object without promoting a phantom ready attachment", async () => {
    const id = await uploaded();
    objects.clear();
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps).finalize(
        request(id),
      ),
    ).rejects.toThrow();
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      lease_owner: null,
    });
    expect(puts).toBe(1);
  });
  it("retains uncertain derivative manifests and the global producer fence after an unknown PUT outcome", async () => {
    const id = await uploaded();
    uncertainPut = true;
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps).finalize(
        request(id),
      ),
    ).rejects.toThrow();
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      pending_slot_held: false,
      lease_owner: expect.any(String),
    });
    expect(
      (await db.pool.query("SELECT owner FROM attachment_processing_lease"))
        .rows[0].owner,
    ).not.toBeNull();
    expect(
      (
        await db.pool.query(
          "SELECT put_uncertain,status FROM attachment_objects WHERE attachment_id=$1 AND variant='normalized'",
          [id],
        )
      ).rows[0],
    ).toEqual({ put_uncertain: true, status: "DELETE_PENDING" });
  });

  it("keeps QUARANTINE unavailable without preparing derivative claims and settles the completed policy callback", async () => {
    const id = await uploaded(),
      moderation: AttachmentModerationPolicy = {
        review: async () => "QUARANTINE",
      };
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps, {
        moderation,
      }).finalize(request(id)),
    ).resolves.toHaveProperty("state", "REJECTED");
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      pending_slot_held: false,
      lease_owner: null,
      rejection_code: "MODERATION_PENDING",
    });
    expect(puts).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await db.pool.query("SELECT owner FROM attachment_processing_lease"))
        .rows[0].owner,
    ).toBeNull();
  });
  it("rejects a policy callback failure without exposing its private error or publishing content", async () => {
    const id = await uploaded(),
      moderation: AttachmentModerationPolicy = {
        review: async () => {
          throw Error(
            "synthetic-private-policy https://private.invalid/?token=synthetic",
          );
        },
      };
    await expect(
      new AttachmentFinalizeService(db.pool, storage, caps, {
        moderation,
      }).finalize(request(id)),
    ).rejects.toMatchObject({ code: "ATTACHMENTS_UNAVAILABLE" });
    expect(await state(id)).toMatchObject({
      state: "REJECTED",
      pending_slot_held: false,
      lease_owner: null,
    });
    expect(puts).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await db.pool.query("SELECT owner FROM attachment_processing_lease"))
        .rows[0].owner,
    ).toBeNull();
  });
  it("times out a deliberately unsettled policy and retains its producer fence without minting artifact claims before ALLOW", async () => {
    const id = await uploaded();
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const moderation: AttachmentModerationPolicy = {
      review: async () => {
        entered();
        return new Promise<"ALLOW">(() => {});
      },
    };
    const service = new AttachmentFinalizeService(db.pool, storage, caps, {
      moderation,
      moderationTimeoutMs: 20,
    });
    const operation = service.finalize(request(id)).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await started;
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await operation).toMatchObject({
      error: { code: "ATTACHMENTS_UNAVAILABLE" },
    });
    const row = await state(id);
    expect(row).toMatchObject({
      state: "REJECTED",
      pending_slot_held: false,
      lease_owner: expect.any(String),
    });
    expect(puts).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT owner,attachment_id FROM attachment_processing_lease",
        )
      ).rows[0],
    ).toEqual({ owner: row.lease_owner, attachment_id: id });
    // This deliberate unsettled synthetic callback is not quiescence evidence.
    // The exact-owned schema teardown removes only this suite's SQL fixtures.
  });
});
