import {syntheticSupervisedStorage} from './synthetic-supervised-storage';
import * as store from '../../src/study-groups/study-group.store';
import {AttachmentLifecycleLedger} from '../../src/attachments/lifecycle/attachment-lifecycle-ledger';
﻿import { randomUUID } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SqlHarness } from "../phase22/sql-harness";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { AttachmentUploadService } from "../../src/attachments/service/attachment-upload-service";
import type {
  AttachmentStorage,
  AttachmentStoredObject,
} from "../../src/attachments/storage/attachment-storage.port";

describe("actual raw upload SQL orchestration with synthetic storage", () => {
  const db = new SqlHarness();
  let actor: string, language: string, temporaryRoot: string;
  const capabilities = {
    enabled: true,
    text: true,
    image: false,
    video: false,
  };
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
    await db.pool.query("TRUNCATE attachment_quota_counters");
    actor = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic service actor','ACTIVE',now())",
      [actor, actor + "@phase30.invalid"],
    );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "phase30-service-proof-"),
    );
  });
  afterEach(async () => rm(temporaryRoot, { recursive: true, force: true }));
  async function draft() {
    const r = await new AttachmentInitiationRepository(
      db.pool,
      capabilities,
    ).initiate(actor, {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PUBLIC",
      },
      filename: "synthetic.txt",
      mime: "text/plain",
      bytes: 3,
      caption: "",
      alt: "",
    });
    if (!("id" in r)) throw Error("fixture invalid");
    return r.id;
  }
  function storage(
    put: (
      i: Parameters<AttachmentStorage["putTemporary"]>[0],
    ) => Promise<AttachmentStoredObject>,
  ) {
    return syntheticSupervisedStorage(put);
  }
  const consume = async (
    i: Parameters<AttachmentStorage["putTemporary"]>[0],
  ) => {
    const chunks: Buffer[] = [];
    for await (const b of i.body) chunks.push(Buffer.from(b));
    expect(Buffer.concat(chunks).toString()).toBe("abc");
    return {
      locator: i.locator,
      sha256: i.sha256,
      sizeBytes: i.sizeBytes,
      version: '"synthetic-etag"',
    };
  };
  const input = (id: string, refresh = async () => {}) => ({
    actorId: actor,
    attachmentId: id,
    contentType: "text/plain",
    contentLength: 3,
    body: Readable.from([Buffer.from("abc")]),
    reauthorize: refresh,
  });
  it("holds an upload slot before reading and commits immutable manifest before one physical PUT", async () => {
    const id = await draft(),
      s = storage(async (i) => {
        const row = (
          await db.pool.query(
            "SELECT put_claim,put_uncertain,put_supervision_id FROM attachment_objects WHERE id=$1",
            [i.locator.objectId],
          )
        ).rows[0];
        expect(row.put_claim).not.toBeNull();
        expect(row.put_uncertain).toBe(true);
        expect(row.put_supervision_id).toBe(s.supervisePut.mock.results[0].value.id);
        expect(
          Number(
            (
              await db.pool.query(
                "SELECT sum(used) n FROM attachment_quota_counters WHERE action='upload'",
              )
            ).rows[0].n,
          ),
        ).toBe(2);
        return consume(i);
      });
    const refresh = jest.fn(async () => {});
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload({
        ...input(id, refresh),
        body: Readable.from(
          (async function* () {
            expect(
              (
                await db.pool.query(
                  "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
                  [id],
                )
              ).rows[0],
            ).toEqual({ state: "UPLOADING", upload_slot_held: true });
            yield Buffer.from("abc");
          })(),
        ),
      }),
    ).resolves.toEqual({ state: "PENDING" });
    expect(s.putSupervised).toHaveBeenCalledTimes(1);
    expect(s.putTemporary).not.toHaveBeenCalled();
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it('certifies an exact original source claim cancelled after commit but before dispatch without fabricating a positive write',async()=>{
    const id=await draft(),abort=new AbortController(),s=storage(consume);let issued=false,cancelled=false;
    const issue=s.supervisePut.getMockImplementation()!;s.supervisePut.mockImplementation(locator=>{issued=true;return issue(locator);});
    const original=store.transaction;
    const wrapped:typeof store.transaction=async(pool,operation)=>{const result=await original(pool,operation);if(issued&&!cancelled){cancelled=true;abort.abort();}return result;};
    const spy=jest.spyOn(store,'transaction').mockImplementation(wrapped);
    try{await expect(new AttachmentUploadService(db.pool,s,capabilities,{temporaryRoot}).upload({...input(id),signal:abort.signal})).rejects.toThrow('ATTACHMENT_UPLOAD_CANCELLED');}finally{spy.mockRestore();}
    expect(cancelled).toBe(true);expect(s.putSupervised).not.toHaveBeenCalled();expect(s.putTemporary).not.toHaveBeenCalled();
    const object=(await db.pool.query('SELECT put_supervision_id,put_abandoned_at,put_settled_at,etag,put_uncertain,status FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0];
    expect(object).toEqual({put_supervision_id:s.supervisePut.mock.results[0].value.id,put_abandoned_at:expect.any(Date),put_settled_at:null,etag:null,put_uncertain:false,status:'DELETE_PENDING'});
    expect((await db.pool.query('SELECT state,upload_slot_held,lease_owner FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({state:'DELETED',upload_slot_held:false,lease_owner:null});
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it('retains a completed provider handle for recovery when the positive DB acknowledgement fails',async()=>{
    const id=await draft(),s=storage(consume),handoff=jest.fn();
    const ack=jest.spyOn(AttachmentLifecycleLedger.prototype,'recordPutResult').mockRejectedValueOnce(Error('synthetic-ack-transaction-failure'));
    try{await expect(new AttachmentUploadService(db.pool,s,capabilities,{temporaryRoot,onUncertainPut:handoff}).upload(input(id))).rejects.toThrow('synthetic-ack-transaction-failure');}finally{ack.mockRestore();}
    expect(handoff).toHaveBeenCalledTimes(1);expect(s.putTemporary).not.toHaveBeenCalled();
    expect((await db.pool.query('SELECT state,upload_slot_held,lease_owner FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({state:'DELETED',upload_slot_held:true,lease_owner:expect.any(String)});
    expect((await db.pool.query('SELECT put_uncertain,put_settled_at,etag FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0]).toEqual({put_uncertain:true,put_settled_at:null,etag:null});
    await expect(handoff.mock.calls[0][1].waitForActualSendSettlement()).resolves.toBeUndefined();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("rejects mismatched MIME/length and disabled formats before consuming raw bytes", async () => {
    const id = await draft(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      });
    for (const changed of [
      { contentType: "text/plain; charset=utf-8" },
      { contentLength: 2 },
    ]) {
      const body = new Readable({
        read() {
          throw Error("must not consume");
        },
      });
      await expect(
        service.upload({ ...input(id), body, ...changed }),
      ).rejects.toThrow();
      expect(body.destroyed).toBe(true);
    }
    const body = Readable.from([Buffer.from("abc")]);
    await expect(
      new AttachmentUploadService(
        db.pool,
        s,
        { enabled: false, text: false, image: false, video: false },
        { temporaryRoot },
      ).upload({ ...input(id), body }),
    ).rejects.toThrow();
    expect(s.putSupervised).not.toHaveBeenCalled();
    expect(
      (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
        .rows[0].state,
    ).toBe("TEMPORARY");
  });
  it("tombstones and settles a stopped raw producer after exact-length intake failure without provider PUT", async () => {
    const id = await draft(),
      s = storage(consume);
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload({ ...input(id), body: Readable.from([Buffer.from("ab")]) }),
    ).rejects.toThrow("ATTACHMENT_UPLOAD_INTEGRITY");
    expect(s.putSupervised).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "DELETED", upload_slot_held: false });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("records an actual provider completion after revocation then denies pending promotion and settles only known stopped producer", async () => {
    const id = await draft(),
      s = storage(async (i) => {
        const result = await consume(i);
        await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [
          actor,
        ]);
        return result;
      });
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload(input(id)),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "DELETED", upload_slot_held: false });
    const o = (
      await db.pool.query(
        "SELECT put_uncertain,put_settled_at,status FROM attachment_objects WHERE attachment_id=$1",
        [id],
      )
    ).rows[0];
    expect(o.put_uncertain).toBe(false);
    expect(o.put_settled_at).not.toBeNull();
    expect(o.status).toBe("DELETE_PENDING");
  });
  it("retains uncertain producer ownership and manifest debt on storage rejection", async () => {
    const id = await draft(),
      s = storage(async (i) => {
        for await (const _b of i.body) {
        }
        throw Error("synthetic-unknown-provider-outcome");
      });
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload(input(id)),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held,lease_owner FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({ state: "DELETED", upload_slot_held: true });
    expect(
      (
        await db.pool.query(
          "SELECT put_uncertain FROM attachment_objects WHERE attachment_id=$1",
          [id],
        )
      ).rows[0].put_uncertain,
    ).toBe(true);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("rechecks the normal session after spooling and stops before a physical claim when session is revoked", async () => {
    const id = await draft(),
      s = storage(consume);
    let stages = 0;
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload(
        input(id, async () => {
          if (++stages === 3) throw Error("synthetic-session-revoked");
        }),
      ),
    ).rejects.toThrow("synthetic-session-revoked");
    expect(s.putSupervised).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "DELETED", upload_slot_held: false });
  });
  it("does not return persisted success when a late completed PUT follows caller cancellation", async () => {
    const id = await draft(),
      controller = new AbortController(),
      s = storage(async (i) => {
        const result = await consume(i);
        controller.abort();
        return result;
      });
    await expect(
      new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      }).upload({ ...input(id), signal: controller.signal }),
    ).rejects.toThrow("ATTACHMENT_UPLOAD_CANCELLED");
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "DELETED", upload_slot_held: false });
    expect(
      (
        await db.pool.query(
          "SELECT put_uncertain FROM attachment_objects WHERE attachment_id=$1",
          [id],
        )
      ).rows[0].put_uncertain,
    ).toBe(false);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("rejects conflicting replay bytes without mutating selected content or retaining stopped intake slots", async () => {
    const id = await draft(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      });
    await service.upload(input(id));
    await expect(
      service.upload({
        ...input(id),
        body: Readable.from([Buffer.from("xyz")]),
      }),
    ).rejects.toThrow("ATTACHMENT_UPLOAD_INTEGRITY");
    expect(s.putSupervised).toHaveBeenCalledTimes(1);
    expect(
      (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
        .rows[0].state,
    ).toBe("PENDING");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_upload_replay_leases",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      Number(
        (
          await db.pool.query(
            "SELECT sum(used) n FROM attachment_quota_counters WHERE action='upload'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });
  it("settles replay capacity after actor revocation without deleting the already persisted attachment", async () => {
    const id = await draft(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      });
    await service.upload(input(id));
    const body = Readable.from(
      (async function* () {
        expect(
          Number(
            (
              await db.pool.query(
                "SELECT sum(used) n FROM attachment_quota_counters WHERE action='upload'",
              )
            ).rows[0].n,
          ),
        ).toBe(2);
        await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [
          actor,
        ]);
        yield Buffer.from("abc");
      })(),
    );
    await expect(service.upload({ ...input(id), body })).rejects.toThrow();
    expect(
      (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
        .rows[0].state,
    ).toBe("PENDING");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_upload_replay_leases",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("denies rate-exhausted replay before consuming its body and preserves successful content", async () => {
    const id = await draft(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      });
    await service.upload(input(id));
    await db.pool.query(
      `INSERT INTO attachment_quota_counters(kind,subject,action,window_start,used,ceiling) VALUES('ACTOR',$1,'upload_attempt',date_trunc('hour',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',10,10) ON CONFLICT(kind,subject,action,window_start) DO UPDATE SET used=10`,
      [actor],
    );
    let read = false;
    const body = new Readable({
      read() {
        read = true;
        this.push(Buffer.from("abc"));
        this.push(null);
      },
    });
    await expect(service.upload({ ...input(id), body })).rejects.toThrow(
      "ATTACHMENT_RATE_LIMITED",
    );
    expect(read).toBe(false);
    expect(body.destroyed).toBe(true);
    expect(s.putSupervised).toHaveBeenCalledTimes(1);
    expect(
      (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
        .rows[0].state,
    ).toBe("PENDING");
  });
  it("replays identical bytes under bounded admission without another physical PUT", async () => {
    const id = await draft(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
      });
    await service.upload(input(id));
    await expect(service.upload(input(id))).resolves.toEqual({
      state: "PENDING",
    });
    expect(s.putSupervised).toHaveBeenCalledTimes(1);
    expect(
      (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
        .rows[0].state,
    ).toBe("PENDING");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachment_upload_replay_leases",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it.each([
    [{ contentType: "application/pdf" }, "ATTACHMENT_TYPE_MISMATCH"],
    [{ contentLength: 65537 }, "ATTACHMENT_LIMIT_EXCEEDED"],
    [{ contentLength: 2 }, "INTEGRITY"],
  ] as const)(
    "classifies upload header boundary %p before raw intake",
    async (changed, code) => {
      const id = await draft(),
        s = storage(consume);
      let read = false;
      const body = new Readable({
        read() {
          read = true;
          this.push(Buffer.from("abc"));
          this.push(null);
        },
      });
      await expect(
        new AttachmentUploadService(db.pool, s, capabilities, {
          temporaryRoot,
        }).upload({ ...input(id), body, ...changed }),
      ).rejects.toMatchObject({ code });
      expect(read).toBe(false);
      expect(body.destroyed).toBe(true);
      expect(s.putSupervised).not.toHaveBeenCalled();
      expect(
        (await db.pool.query("SELECT state FROM attachments WHERE id=$1", [id]))
          .rows[0].state,
      ).toBe("TEMPORARY");
    },
  );
});
