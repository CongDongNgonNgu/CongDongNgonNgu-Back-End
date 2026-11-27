import { randomUUID, createHash } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { SqlHarness } from "../phase22/sql-harness";
import {
  RunLedger,
  RUN_LIMITS,
  type PreparedRun,
} from "../../src/attachments/test-admission/run-ledger";
import { RUN_LEDGER_DDL } from "../../src/attachments/test-admission/run-ledger-schema";
import { ACTIVATION_CONTROL_DDL } from "../../src/attachments/test-admission/activation-control-schema";
import {
  ActivationControlRepository,
  type ControlTuple,
} from "../../src/attachments/test-admission/activation-control";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { AttachmentUploadService } from "../../src/attachments/service/attachment-upload-service";
import {
  createPutSupervisionAuthority,
  supervisionIdentity,
  originalPutState,
  type PlannedPutSupervisionIdentity,
} from "../../src/attachments/storage/put-supervision-proof";
import type {
  AttachmentStorage,
  AttachmentStoredObject,
  AttachmentPutSupervision,
  AttachmentObjectLocator,
} from "../../src/attachments/storage/attachment-storage.port";
/** Actual TEST SQL with supervised fake transport only. No real provider or deployment authority. */
describe("controlled source upload exact identities and request-local cleanup", () => {
  const db = new SqlHarness();
  let actor: string, language: string, temporaryRoot: string;
  const capabilities = {
    enabled: true,
    text: true,
    image: false,
    video: false,
  };
  const table = (n: string) => '"' + db.schema + '".' + n;
  beforeAll(async () => {
    await db.open();
    await db.migration("0027_phase22_study_groups.down.sql");
    const files = (
      await readdir(path.resolve(__dirname, "../../database/migrations"))
    )
      .filter(
        (f) =>
          f.endsWith(".sql") &&
          !f.endsWith(".down.sql") &&
          Number(f.slice(0, 4)) >= 2 &&
          Number(f.slice(0, 4)) <= 39,
      )
      .sort();
    for (const file of files) await db.migration(file);
    await db.pool.query(
      RUN_LEDGER_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    await db.pool.query(
      ACTIVATION_CONTROL_DDL.replace(/phase30_test_execution/g, db.schema),
    );
  }, 180000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    actor = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic controlled upload','ACTIVE',clock_timestamp())",
      [actor, actor + "@phase30.invalid"],
    );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "phase30-controlled-upload-"),
    );
  });
  afterEach(async () => {
    if (
      !temporaryRoot.startsWith(
        path.join(tmpdir(), "phase30-controlled-upload-"),
      )
    )
      throw Error("unsafe owned temp");
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  type Send = (c: PoolClient, sql: string, values?: unknown[]) => Promise<any>;
  async function ready(
    options: { send?: Send; expiresInMs?: number; fingerprint?: string } = {},
  ) {
    const draft = await new AttachmentInitiationRepository(
      db.pool,
      capabilities,
    ).initiate(actor, {
      clientUploadId: randomUUID(),
      scope: {
        kind: "COMMUNITY",
        postType: "DISCUSSION",
        languageId: language,
        visibility: "PRIVATE",
      },
      filename: "source.txt",
      mime: "text/plain",
      bytes: 3,
    });
    if (!("id" in draft)) throw Error("unexpected bound fixture");
    const attachmentId = draft.id;
    const initiationFingerprint =
      options.fingerprint ??
      (
        await db.pool.query(
          "SELECT init_fingerprint FROM attachments WHERE id=$1",
          [attachmentId],
        )
      ).rows[0].init_fingerprint;
    const pool = {
      connect: async () => {
        const c = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            options.send
              ? options.send(
                  c,
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                )
              : c.query(
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                ),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const ledger = new RunLedger(pool),
      controls = new ActivationControlRepository(pool),
      now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime();
    const roles = [
        "UPLOAD_OWNER",
        "SOURCE_OBJECT",
        "SOURCE_ATTEMPT",
        "PUT_CLAIM",
        "PUT_SUPERVISION",
      ] as const,
      slots = roles.map((role) => ({
        key: role.toLowerCase(),
        operationKey: "upload.instance",
        role,
        id: randomUUID(),
        attachmentId,
      })),
      ids = Object.fromEntries(slots.map((s) => [s.role, s.id])) as Record<
        (typeof roles)[number],
        string
      >,
      jobId = randomUUID(),
      sha256 = createHash("sha256").update("abc").digest("hex");
    const p: PreparedRun = {
      runId: randomUUID(),
      activationId: randomUUID(),
      manifestSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      sourceSha: "b".repeat(40),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + (options.expiresInMs ?? 60000)).toISOString(),
      limits: { ...RUN_LIMITS },
      activationControlRequired: true,
      slots: [
        ...slots,
        {
          key: "source.cleanup.job",
          operationKey: "source.cleanup",
          role: "CLEANUP_JOB",
          id: jobId,
          attachmentId,
        },
      ],
      requests: {
        candidates: [
          {
            key: "upload",
            method: "PUT",
            path: "/api/v1/attachments/" + attachmentId + "/content",
            authClass: "AUTH",
            ingressBytes: 3,
            egressBytes: 0,
          },
        ],
        attempts: [{ key: "coarse", candidateKey: "upload" }],
      },
      bindings: {
        operations: [
          {
            key: "upload.instance",
            policyKey: "upload.policy",
            policyAttemptKey: "one",
            attachmentId,
            ingressBytes: 3,
            egressBytes: 0,
            processingAttempts: 0,
            slotKeys: slots.map((s) => s.key),
          },
        ],
        edges: [{ attemptKey: "coarse", operationKey: "upload.instance" }],
      },
      internalCleanup: [
        {
          key: "source.cleanup",
          sourceOperationKey: "upload.instance",
          attachmentId,
          objectId: ids.SOURCE_OBJECT,
          attemptId: ids.SOURCE_ATTEMPT,
          claimId: ids.PUT_CLAIM,
          supervisionId: ids.PUT_SUPERVISION,
          sha256,
          byteCount: 3,
          jobSlotKey: "source.cleanup.job",
        },
      ],
    };
    await ledger.prepare(p);
    const t: ControlTuple = {
      runId: p.runId,
      activationId: p.activationId,
      sourceSha: p.sourceSha,
      manifestSha256: p.manifestSha256,
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      deploymentId: "dep-synthetic-controlled-source",
      bootId: randomUUID(),
    };
    await controls.arm(t);
    await controls.storeReceipt(t, {
      service: t.service,
      branch: t.branch,
      sha: t.sourceSha,
      manifestSha256: t.manifestSha256,
      deploymentId: t.deploymentId,
      bootId: t.bootId,
      observedAt: (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).toISOString(),
      liveObserved: true,
      originalDisabledCommandObserved: true,
      allFourFlagsFalseObserved: true,
    });
    const active = await ledger.activateControlled(t),
      handle = await ledger.bindMatchedPolicy(
        await ledger.reserveRequest(active, "upload"),
        { policyKey: "upload.policy", instanceKeys: ["upload.instance"] },
      ),
      abort = new AbortController(),
      executor = ledger.controlledSourceUploads(),
      context = executor.issue(
        handle,
        {
          actorId: actor,
          sessionId: randomUUID(),
          contentType: "text/plain",
          contentLength: 3,
          inputSha256: sha256,
          initiationFingerprint,
        },
        abort.signal,
      );
    return {
      p,
      ids,
      jobId,
      sha256,
      attachmentId,
      ledger,
      executor,
      context,
      abort,
    };
  }
  function storage(
    put: (
      input: Parameters<AttachmentStorage["putTemporary"]>[0],
    ) => Promise<AttachmentStoredObject>,
  ) {
    const entries = new Map<
      AttachmentPutSupervision,
      ReturnType<typeof createPutSupervisionAuthority>
    >();
    return {
      putTemporary: jest.fn(async () => {
        throw Error("UNSUPERVISED_WRITE_FORBIDDEN");
      }),
      supervisePut: jest.fn(
        (
          locator: AttachmentObjectLocator,
          planned?: PlannedPutSupervisionIdentity,
        ) => {
          const authority = createPutSupervisionAuthority(
            locator,
            () => {},
            planned,
          );
          entries.set(authority.handle, authority);
          return authority.handle;
        },
      ),
      putSupervised: jest.fn(
        async (
          handle: AttachmentPutSupervision,
          input: Parameters<AttachmentStorage["putTemporary"]>[0],
        ) => {
          const authority = entries.get(handle);
          if (
            !authority ||
            supervisionIdentity(handle, input.locator) !== handle.id
          )
            throw Error("INVALID_ORIGINAL_SUPERVISION");
          authority.start();
          try {
            return await put(input);
          } finally {
            authority.settle();
          }
        },
      ),
    } as unknown as AttachmentStorage & {
      supervisePut: jest.Mock;
      putSupervised: jest.Mock;
    };
  }
  async function consume(
    input: Parameters<AttachmentStorage["putTemporary"]>[0],
  ) {
    const chunks: Buffer[] = [];
    for await (const part of input.body) chunks.push(Buffer.from(part));
    expect(Buffer.concat(chunks).toString()).toBe("abc");
    return {
      locator: input.locator,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      version: '"synthetic-controlled-source"',
    };
  }
  function input(f: Awaited<ReturnType<typeof ready>>, body = "abc") {
    return {
      actorId: actor,
      attachmentId: f.attachmentId,
      contentType: "text/plain",
      contentLength: 3,
      body: Readable.from([Buffer.from(body)]),
      signal: f.abort.signal,
      reauthorize: async () => {},
    };
  }
  it("uses the exact five HTTP identities and original supervisor for one PUT then PENDING without a cleanup allocation", async () => {
    const f = await ready(),
      s = storage(async (i) => {
        const row = (
          await db.pool.query(
            "SELECT id,attempt_id,put_claim,put_supervision_id FROM attachment_objects WHERE attachment_id=$1",
            [f.attachmentId],
          )
        ).rows[0];
        expect(row).toMatchObject({
          id: f.ids.SOURCE_OBJECT,
          attempt_id: f.ids.SOURCE_ATTEMPT,
          put_claim: f.ids.PUT_CLAIM,
          put_supervision_id: f.ids.PUT_SUPERVISION,
        });
        expect(
          (
            await db.pool.query(
              "SELECT lease_owner FROM attachments WHERE id=$1",
              [f.attachmentId],
            )
          ).rows[0].lease_owner,
        ).toBe(f.ids.UPLOAD_OWNER);
        return consume(i);
      }),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
        controlled: f.executor,
      });
    await expect(service.upload(input(f), f.context)).resolves.toEqual({
      state: "PENDING",
    });
    expect(s.putSupervised).toHaveBeenCalledTimes(1);
    expect(s.supervisePut.mock.results[0].value.id).toBe(f.ids.PUT_SUPERVISION);
    expect(
      (
        await db.pool.query(
          "SELECT state,source_object_id FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "PENDING",
      source_object_id: f.ids.SOURCE_OBJECT,
    });
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " +
            table("slots") +
            " WHERE run_id=$1 AND role='CLEANUP_JOB'",
          [f.p.runId],
        )
      ).rows[0].state,
    ).toBe("AVAILABLE");
  });
  it("rejects actual spooled hash mismatch before preparing any object or dispatching PUT", async () => {
    const f = await ready(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
        controlled: f.executor,
      });
    await expect(service.upload(input(f, "abd"), f.context)).rejects.toThrow();
    expect(s.putSupervised).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM attachment_objects WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({ state: "DELETED", upload_slot_held: false });
  });
  it("rejects copied or missing contexts without physical PUT or ordinary random-ID fallback", async () => {
    const f = await ready(),
      s = storage(consume),
      service = new AttachmentUploadService(db.pool, s, capabilities, {
        temporaryRoot,
        controlled: f.executor,
      });
    await expect(service.upload(input(f), { ...f.context })).rejects.toThrow();
    await expect(service.upload(input(f))).rejects.toThrow();
    const ordinary = new AttachmentUploadService(db.pool, s, capabilities, {
      temporaryRoot,
    });
    await expect(ordinary.upload(input(f), f.context)).rejects.toThrow();
    expect(s.putSupervised).not.toHaveBeenCalled();
  });

  it.each(["ABORT", "LOST_ACK", "CLOSED"] as const)(
    "retains original claim and uses only planned cleanup after claim COMMIT %s",
    async (mode) => {
      let enabled = false,
        claimTransaction = false,
        f: Awaited<ReturnType<typeof ready>>;
      f = await ready({
        send: async (c, sql, values) => {
          if (
            enabled &&
            sql.includes("UPDATE attachment_objects SET put_claim=")
          )
            claimTransaction = true;
          const result = await c.query(sql, values);
          if (enabled && claimTransaction && sql === "COMMIT") {
            enabled = false;
            if (mode === "ABORT") f.abort.abort();
            else if (mode === "LOST_ACK")
              throw Error("SYNTHETIC_LOST_CLAIM_COMMIT_ACK");
            else
              await c.query(
                "UPDATE " +
                  table("runs") +
                  " SET state='CLOSED' WHERE run_id=$1",
                [f.p.runId],
              );
          }
          return result;
        },
      });
      const st = storage(consume),
        service = new AttachmentUploadService(db.pool, st, capabilities, {
          temporaryRoot,
          controlled: f.executor,
        });
      enabled = true;
      let failure: unknown;
      try {
        await service.upload(input(f), f.context);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      if (!claimTransaction)
        throw new AggregateError(
          [failure],
          "EXPECTED_CLAIM_TRANSACTION_NOT_REACHED",
        );
      expect(claimTransaction).toBe(true);
      expect(st.putSupervised).not.toHaveBeenCalled();
      const jobs = (
        await db.pool.query(
          "SELECT id,object_id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows;
      expect(jobs).toEqual([{ id: f.jobId, object_id: f.ids.SOURCE_OBJECT }]);
      expect(
        (
          await db.pool.query(
            "SELECT state,upload_slot_held,lease_owner FROM attachments WHERE id=$1",
            [f.attachmentId],
          )
        ).rows[0],
      ).toMatchObject({
        state: "DELETED",
        upload_slot_held: false,
        lease_owner: null,
      });
      expect(
        (
          await db.pool.query(
            "SELECT put_uncertain,put_abandoned_at FROM attachment_objects WHERE id=$1",
            [f.ids.SOURCE_OBJECT],
          )
        ).rows[0],
      ).toMatchObject({
        put_uncertain: false,
        put_abandoned_at: expect.any(Date),
      });
      expect(
        (
          await db.pool.query(
            "SELECT state,proof_kind FROM " +
              table("internal_cleanup_entries") +
              " WHERE run_id=$1",
            [f.p.runId],
          )
        ).rows[0],
      ).toMatchObject({ state: "BOUND", proof_kind: "UNSENT" });
      expect(
        (
          await db.pool.query(
            "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
            [f.p.runId],
          )
        ).rows[0].counters,
      ).toMatchObject({ authenticatedRequests: 1, ingressBytes: 3 });
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM " +
              table("slots") +
              " WHERE run_id=$1 AND state='BURNED'",
            [f.p.runId],
          )
        ).rows[0].n,
      ).toBe(6);
    },
  );

  it("records an authentic late positive after natural run expiry using one planned job without PENDING", async () => {
    const f = await ready({ expiresInMs: 25000 });
    const st = storage(async (i) => {
      const result = await consume(i);
      const remaining = Number(
        (
          await db.pool.query(
            "SELECT EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))*1000 AS ms FROM " +
              table("runs") +
              " WHERE run_id=$1",
            [f.p.runId],
          )
        ).rows[0].ms,
      );
      expect(remaining).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, remaining + 50));
      return result;
    });
    const service = new AttachmentUploadService(db.pool, st, capabilities, {
      temporaryRoot,
      controlled: f.executor,
    });
    await expect(service.upload(input(f), f.context)).rejects.toThrow();
    expect(st.putSupervised).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held,source_object_id FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "DELETED",
      upload_slot_held: false,
      source_object_id: null,
    });
    expect(
      (
        await db.pool.query(
          "SELECT id,object_id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([{ id: f.jobId, object_id: f.ids.SOURCE_OBJECT }]);
    expect(
      (
        await db.pool.query(
          "SELECT etag,put_uncertain,status FROM attachment_objects WHERE id=$1",
          [f.ids.SOURCE_OBJECT],
        )
      ).rows[0],
    ).toMatchObject({
      etag: '"synthetic-controlled-source"',
      put_uncertain: false,
      status: "DELETE_PENDING",
    });
    expect(
      (
        await db.pool.query(
          "SELECT state,proof_kind FROM " +
            table("internal_cleanup_entries") +
            " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0],
    ).toMatchObject({ state: "BOUND", proof_kind: "SETTLED" });
  }, 65000);

  it("settles original negative transport completion with one job while retaining unknown object debt", async () => {
    const f = await ready(),
      st = storage(async (i) => {
        await consume(i);
        throw Error("SYNTHETIC_SETTLED_UNKNOWN_PUT");
      });
    const service = new AttachmentUploadService(db.pool, st, capabilities, {
      temporaryRoot,
      controlled: f.executor,
    });
    await expect(service.upload(input(f), f.context)).rejects.toThrow();
    expect(st.putSupervised).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({ state: "DELETED", upload_slot_held: false });
    expect(
      (
        await db.pool.query(
          "SELECT id,object_id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([{ id: f.jobId, object_id: f.ids.SOURCE_OBJECT }]);
    expect(
      (
        await db.pool.query(
          "SELECT etag,put_uncertain,put_abandoned_at,byte_count FROM attachment_objects WHERE id=$1",
          [f.ids.SOURCE_OBJECT],
        )
      ).rows[0],
    ).toMatchObject({
      etag: null,
      put_uncertain: true,
      put_abandoned_at: null,
      byte_count: "3",
    });
    expect(
      (
        await db.pool.query(
          "SELECT state,proof_kind FROM " +
            table("internal_cleanup_entries") +
            " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0],
    ).toMatchObject({ state: "BOUND", proof_kind: "SETTLED" });
  });

  it.each([false, true])(
    "retains original cleanup proof after lost COMMIT acknowledgement; completed job=%s",
    async (completed) => {
      let enabled = false,
        claimTx = false,
        cleanupTx = false,
        lost = false,
        f: Awaited<ReturnType<typeof ready>>;
      f = await ready({
        send: async (c, sql, values) => {
          if (
            enabled &&
            sql.includes("UPDATE attachment_objects SET put_claim=")
          )
            claimTx = true;
          if (enabled && sql.includes("internal_cleanup_entries SET state="))
            cleanupTx = true;
          const result = await c.query(sql, values);
          if (enabled && claimTx && !cleanupTx && sql === "COMMIT") {
            claimTx = false;
            f.abort.abort();
          }
          if (enabled && cleanupTx && sql === "COMMIT") {
            enabled = false;
            lost = true;
            throw Error("SYNTHETIC_LOST_CLEANUP_COMMIT_ACK");
          }
          return result;
        },
      });
      const st = storage(consume),
        service = new AttachmentUploadService(db.pool, st, capabilities, {
          temporaryRoot,
          controlled: f.executor,
        });
      enabled = true;
      await expect(service.upload(input(f), f.context)).rejects.toThrow();
      expect(lost).toBe(true);
      expect(st.putSupervised).not.toHaveBeenCalled();
      const handle = st.supervisePut.mock.results[0].value;
      expect(originalPutState(handle)).toBe("RETIRED");
      if (completed)
        await db.pool.query(
          "UPDATE attachment_cleanup_jobs SET completed_at=clock_timestamp() WHERE id=$1",
          [f.jobId],
        );
      await expect(service.retryControlledRetirements()).resolves.toEqual({
        remaining: completed ? 1 : 0,
      });
      if (completed) expect(originalPutState(handle)).toBe("RETIRED");
      else expect(() => originalPutState(handle)).toThrow();
      expect(
        (
          await db.pool.query(
            "SELECT id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
            [f.attachmentId],
          )
        ).rows,
      ).toEqual([{ id: f.jobId }]);
      expect(st.putSupervised).not.toHaveBeenCalled();
      await expect(service.retryControlledRetirements()).resolves.toEqual({
        remaining: completed ? 1 : 0,
      });
    },
  );

  it("terminalizes exact owner after lost upload-admission COMMIT acknowledgement without preparing an object or allocating a job", async () => {
    let enabled = false,
      admission = false,
      lost = false;
    const f = await ready({
      send: async (c, sql, values) => {
        if (enabled && sql.includes("UPDATE attachments SET state='UPLOADING'"))
          admission = true;
        const result = await c.query(sql, values);
        if (enabled && admission && sql === "COMMIT") {
          enabled = false;
          lost = true;
          throw Error("SYNTHETIC_LOST_UPLOAD_OWNER_COMMIT_ACK");
        }
        return result;
      },
    });
    const st = storage(consume),
      service = new AttachmentUploadService(db.pool, st, capabilities, {
        temporaryRoot,
        controlled: f.executor,
      });
    enabled = true;
    await expect(service.upload(input(f), f.context)).rejects.toThrow();
    expect(lost).toBe(true);
    expect(st.supervisePut).not.toHaveBeenCalled();
    expect(st.putSupervised).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held,lease_owner FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "DELETED",
      upload_slot_held: false,
      lease_owner: null,
    });
    expect(
      (
        await db.pool.query(
          "SELECT id FROM attachment_objects WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([]);
  });

  it("rejects a different pinned initiation fingerprint for the same draft ID before upload ownership", async () => {
    const f = await ready({ fingerprint: "a".repeat(64) }),
      st = storage(consume),
      service = new AttachmentUploadService(db.pool, st, capabilities, {
        temporaryRoot,
        controlled: f.executor,
      });
    await expect(service.upload(input(f), f.context)).rejects.toThrow();
    expect(st.supervisePut).not.toHaveBeenCalled();
    expect(st.putSupervised).not.toHaveBeenCalled();
    expect(
      (
        await db.pool.query(
          "SELECT state,upload_slot_held FROM attachments WHERE id=$1",
          [f.attachmentId],
        )
      ).rows[0],
    ).toMatchObject({ state: "TEMPORARY", upload_slot_held: false });
    expect(
      (
        await db.pool.query(
          "SELECT id FROM attachment_objects WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
          [f.attachmentId],
        )
      ).rows,
    ).toEqual([]);
  });
});
