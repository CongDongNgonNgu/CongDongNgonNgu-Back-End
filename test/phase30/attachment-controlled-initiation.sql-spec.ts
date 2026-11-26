import { randomUUID, createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
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
import { parseInitiation } from "../../src/attachments/initiation/initiation-input";
/** Actual ledger/domain transactions in owned random TEST schema. Control receipts
 * and principal metadata are synthetic: not native auth, boot, provider or deployment proof. */
describe("controlled INITIATE exact identity and fresh SQL continuation", () => {
  const db = new SqlHarness();
  let actor: string, foreign: string, language: string;
  const capabilities = {
    enabled: true,
    image: false,
    video: false,
    text: true,
  };
  const table = (name: string) => '"' + db.schema + '".' + name;
  type Send = (
    client: PoolClient,
    sql: string,
    values?: unknown[],
  ) => Promise<any>;
  function scoped(send?: Send): Pool {
    return {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            send
              ? send(
                  client,
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                )
              : client.query(
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                ),
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
  }
  beforeAll(async () => {
    await db.open();
    if (!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))
      throw Error("unsafe proof schema");
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
    foreign = randomUUID();
    for (const id of [actor, foreign])
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic controlled INITIATE actor','ACTIVE',clock_timestamp())",
        [id, id + "@phase30.invalid"],
      );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
  });
  function input() {
    return {
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
      caption: "synthetic",
      alt: "",
    };
  }
  async function ready(
    value: unknown,
    options: {
      attachmentId?: string;
      expiresInMs?: number;
      send?: Send;
      retry?: boolean;
    } = {},
  ) {
    const pool = scoped(options.send),
      ledger = new RunLedger(pool),
      controls = new ActivationControlRepository(pool),
      attachmentId = options.attachmentId ?? randomUUID();
    const now = (
      (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
    ).getTime();
    const p: PreparedRun = {
      runId: randomUUID(),
      activationId: randomUUID(),
      manifestSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      sourceSha: "b".repeat(40),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + (options.expiresInMs ?? 60000)).toISOString(),
      limits: { ...RUN_LIMITS, authenticatedRequests: 1, ingressBytes: 102400 },
      activationControlRequired: true,
      slots: [
        {
          key: "attachment",
          operationKey: "create.instance",
          role: "ATTACHMENT",
          id: attachmentId,
          attachmentId,
        },
      ],
      requests: {
        candidates: [
          {
            key: "json",
            method: "POST",
            path: "/api/v1/attachments",
            authClass: "AUTH",
            ingressBytes: 102400,
            egressBytes: 0,
          },
        ],
        attempts: [{ key: "coarse", candidateKey: "json" }],
      },
      bindings: {
        operations: [
          {
            key: "create.instance",
            policyKey: "create.policy",
            policyAttemptKey: "one",
            attachmentId,
            ingressBytes: 102400,
            egressBytes: 0,
            processingAttempts: 0,
            slotKeys: ["attachment"],
          },
        ],
        edges: [{ attemptKey: "coarse", operationKey: "create.instance" }],
      },
    };
    if (options.retry) {
      p.limits.authenticatedRequests = 2;
      p.limits.ingressBytes = 204800;
      p.requests!.attempts.push({ key: "coarse-replay", candidateKey: "json" });
      p.bindings!.operations.push({
        ...p.bindings!.operations[0],
        key: "replay.instance",
        policyAttemptKey: "two",
        slotKeys: [],
      });
      p.bindings!.edges = ["coarse", "coarse-replay"].flatMap((attemptKey) =>
        ["create.instance", "replay.instance"].map((operationKey) => ({
          attemptKey,
          operationKey,
        })),
      );
    }
    await ledger.prepare(p);
    const tuple: ControlTuple = {
      runId: p.runId,
      activationId: p.activationId,
      sourceSha: p.sourceSha,
      manifestSha256: p.manifestSha256,
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      deploymentId: "dep-synthetic-controlled-initiation",
      bootId: randomUUID(),
    };
    await controls.arm(tuple);
    await controls.storeReceipt(tuple, {
      service: tuple.service,
      branch: tuple.branch,
      sha: tuple.sourceSha,
      manifestSha256: tuple.manifestSha256,
      deploymentId: tuple.deploymentId,
      bootId: tuple.bootId,
      observedAt: (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).toISOString(),
      liveObserved: true,
      originalDisabledCommandObserved: true,
      allFourFlagsFalseObserved: true,
    });
    const active = await ledger.activateControlled(tuple),
      receipt = await ledger.reserveRequest(active, "json"),
      handle = await ledger.bindMatchedPolicy(receipt, {
        policyKey: "create.policy",
        instanceKeys: ["create.instance"],
      });
    const abort = new AbortController(),
      context = ledger.issueMatchedInitiationContext(
        handle,
        {
          actorId: actor,
          sessionId: randomUUID(),
          fingerprint: parseInitiation(value).fingerprint,
        },
        abort.signal,
      );
    return {
      p,
      ledger,
      handle,
      context,
      replay: async () => {
        const request = await ledger.reserveRequest(active, "json"),
          bound = await ledger.bindMatchedPolicy(request, {
            policyKey: "create.policy",
            instanceKeys: ["create.instance", "replay.instance"],
          });
        return ledger.issueMatchedInitiationContext(
          bound,
          {
            actorId: actor,
            sessionId: randomUUID(),
            fingerprint: parseInitiation(value).fingerprint,
          },
          new AbortController().signal,
          {
            policyKey: "create.policy",
            policyAttemptKey: "two",
            creatorAttemptKey: "one",
            mode: "REPLAY_ONLY",
          },
        );
      },
      abort,
      attachmentId,
      repo: new AttachmentInitiationRepository(
        db.pool,
        capabilities,
        undefined,
        ledger,
      ),
    };
  }
  async function count(clientUploadId: string) {
    return Number(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM attachments WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, clientUploadId],
        )
      ).rows[0].n,
    );
  }
  async function retained(
    f: Awaited<ReturnType<typeof ready>>,
    clientUploadId: string,
  ) {
    expect(
      (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].counters,
    ).toMatchObject({ authenticatedRequests: 1, ingressBytes: 102400 });
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " + table("slots") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].state,
    ).toBe("BURNED");
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, clientUploadId],
        )
      ).rows[0]?.status,
    ).toBe("ADMITTED");
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='initiate'",
          [actor],
        )
      ).rows[0].used,
    ).toBe("1");
  }
  it("requires the original context and inserts the exact planned attachment UUID once", async () => {
    const value = input(),
      f = await ready(value),
      ordinary = new AttachmentInitiationRepository(db.pool, capabilities);
    await expect(ordinary.initiate(actor, value, f.context)).rejects.toThrow();
    await expect(
      f.repo.initiate(actor, value, { ...f.context }),
    ).rejects.toThrow();
    const result = await f.repo.initiate(actor, value, f.context);
    expect(result).toMatchObject({ id: f.attachmentId, state: "TEMPORARY" });
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(1);
  });
  it("replays only the same planned identity without a local allocation and rejects identity adoption", async () => {
    const value = input(),
      ordinary = new AttachmentInitiationRepository(db.pool, capabilities),
      existing = await ordinary.initiate(actor, value);
    if (!("id" in existing)) throw Error("unexpected bound fixture");
    // One fresh ledger reference to a preexisting owned draft. This does not prove
    // controlled-created retry compatibility: globally unique burned IDs cannot be redeclared.
    const same = await ready(value, { attachmentId: existing.id });
    expect(await same.repo.initiate(actor, value, same.context)).toMatchObject({
      id: existing.id,
    });
    expect(same.ledger.takeMatchedAttachment(same.handle)).toBe(existing.id);
    const other = await ready(value);
    await expect(
      other.repo.initiate(actor, value, other.context),
    ).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(1);
  });
  it("denies expiry before rate admission while retaining coarse charges and burned slots", async () => {
    const value = input(),
      f = await ready(value, { expiresInMs: 8000 });
    await db.pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)",
      [f.p.expiresAt],
    );
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].counters,
    ).toMatchObject({ authenticatedRequests: 1, ingressBytes: 102400 });
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " + table("slots") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].state,
    ).toBe("BURNED");
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, value.clientUploadId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='initiate'",
          [actor],
        )
      ).rowCount,
    ).toBe(0);
  }, 30000);
  it("cancels after the actual rate COMMIT without entering domain creation", async () => {
    const value = input();
    let armed = false,
      abort!: AbortController;
    const f = await ready(value, {
      send: async (c, sql, values) => {
        const result = await c.query(sql, values);
        if (armed && sql === "COMMIT") abort.abort();
        return result;
      },
    });
    abort = f.abort;
    armed = true;
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(0);
    await retained(f, value.clientUploadId);
  });
  it("keeps immutable burns and rate admission when the exact planned UUID collides", async () => {
    const value = input(),
      f = await ready(value);
    await db.pool.query(
      "INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PRIVATE',$4,$5,'TEXT','text/plain',5,'synthetic.txt',65541,clock_timestamp()+interval '1 hour')",
      [f.attachmentId, foreign, language, randomUUID(), "a".repeat(64)],
    );
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(0);
    await retained(f, value.clientUploadId);
    expect(
      (
        await db.pool.query("SELECT uploader_id FROM attachments WHERE id=$1", [
          f.attachmentId,
        ])
      ).rows[0].uploader_id,
    ).toBe(foreign);
    expect(() => f.ledger.takeMatchedAttachment(f.handle)).toThrow();
  });
  it("returns no success after an actual domain COMMIT with lost acknowledgement", async () => {
    const value = input();
    let armed = false,
      commits = 0;
    const f = await ready(value, {
      send: async (c, sql, values) => {
        const result = await c.query(sql, values);
        if (armed && sql === "COMMIT" && ++commits === 2)
          throw Error("synthetic lost domain commit acknowledgement");
        return result;
      },
    });
    armed = true;
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    expect(commits).toBe(2);
    expect(await count(value.clientUploadId)).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM attachments WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, value.clientUploadId],
        )
      ).rows[0].id,
    ).toBe(f.attachmentId);
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
  });
  it("honors current account authorization after matching without refunding admission", async () => {
    const value = input(),
      f = await ready(value);
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      actor,
    ]);
    await expect(
      f.repo.initiate(actor, value, f.context),
    ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
    expect(await count(value.clientUploadId)).toBe(0);
    await retained(f, value.clientUploadId);
  });
  it("does not adopt a concurrent creator using a different planned identity", async () => {
    const value = input(),
      a = await ready(value),
      b = await ready(value);
    const results = await Promise.allSettled([
      a.repo.initiate(actor, value, a.context),
      b.repo.initiate(actor, value, b.context),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await count(value.clientUploadId)).toBe(1);
    const actual = (
      await db.pool.query(
        "SELECT id FROM attachments WHERE uploader_id=$1 AND client_upload_id=$2",
        [actor, value.clientUploadId],
      )
    ).rows[0].id;
    expect([a.attachmentId, b.attachmentId]).toContain(actual);
  });
  it("rechecks original expiry after waiting for a real scope writer without a lock cycle", async () => {
    const creator = await db.pool.connect();
    let group: string;
    try {
      await creator.query("BEGIN");
      group = (
        await creator.query(
          "INSERT INTO study_groups(owner_user_id,name) VALUES($1,'Synthetic controlled scope') RETURNING id",
          [actor],
        )
      ).rows[0].id;
      await creator.query(
        "INSERT INTO study_group_memberships(group_id,user_id,role,status) VALUES($1,$2,'OWNER','ACTIVE')",
        [group, actor],
      );
      await creator.query("COMMIT");
    } catch (error) {
      await creator.query("ROLLBACK");
      throw error;
    } finally {
      creator.release();
    }
    let expiry: string;
    let scopeStarted!: () => void;
    const scopeReached = new Promise<void>((r) => (scopeStarted = r));
    const value = {
        ...input(),
        scope: { kind: "STUDY_GROUP", groupId: group },
      },
      f = await ready(value, {
        expiresInMs: 20000,
        send: async (c, sql, values) => {
          if (
            sql.includes(
              "SELECT id FROM study_groups WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
            )
          )
            scopeStarted();
          const result = await c.query(sql, values);
          if (
            sql.includes(
              "SELECT id FROM study_groups WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
            )
          ) {
            // The real scope lock was acquired after an observed writer wait. Delay
            // delivery of its result across natural expiry, independent of network RTT.
            const remaining = Number(
              (
                await c.query(
                  "SELECT EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())*1000 remaining",
                  [expiry],
                )
              ).rows[0].remaining,
            );
            await new Promise((r) =>
              setTimeout(r, Math.max(0, remaining) + 25),
            );
          }
          return result;
        },
      });
    expiry = f.p.expiresAt;
    const holder = await db.pool.connect();
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined,
      done = false,
      blocked = false;
    try {
      await holder.query("BEGIN");
      const pid = Number(
        (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid,
      );
      await holder.query("SELECT id FROM study_groups WHERE id=$1 FOR UPDATE", [
        group,
      ]);
      pending = f.repo
        .initiate(actor, value, f.context)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .then((result) => {
          done = true;
          return result;
        });
      await Promise.race([scopeReached, pending.then(() => {})]);
      for (let i = 0; i < 15 && !done; i++) {
        blocked = Boolean(
          (
            await db.pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='phase22-sql-proof' AND $1::int=ANY(pg_blocking_pids(pid))) blocked",
              [pid],
            )
          ).rows[0].blocked,
        );
        if (blocked) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const result = await pending!;
    expect(result.error).toBeDefined();
    expect(await count(value.clientUploadId)).toBe(0);
    await retained(f, value.clientUploadId);
  }, 30000);
  it("replays a committed controlled creator in the same run without allocating or charging rate/capacity twice", async () => {
    const writes: string[] = [];
    let replaying = false;
    const value = input(),
      f = await ready(value, {
        retry: true,
        send: async (c, sql, values) => {
          if (
            replaying &&
            /INSERT INTO (attachments|attachment_initiation_admissions)/.test(
              sql,
            )
          )
            writes.push(sql);
          return c.query(sql, values);
        },
      });
    const created = await f.repo.initiate(actor, value, f.context);
    expect(created).toMatchObject({ id: f.attachmentId });
    const before = (
      await db.pool.query(
        "SELECT used FROM attachment_quota_counters WHERE kind=$1 AND subject=$2 AND action=$3",
        ["ACTOR", actor, "initiate"],
      )
    ).rows[0].used;
    const capacities = (
      await db.pool.query(
        "SELECT kind,subject,action,used FROM attachment_quota_counters WHERE action IN ('bytes','metadata') AND (subject=$1 OR kind='DEPLOYMENT') ORDER BY kind,subject,action",
        [actor],
      )
    ).rows;
    expect(capacities).toHaveLength(3);
    replaying = true;
    const replay = await f.replay();
    expect(await f.repo.initiate(actor, value, replay)).toMatchObject({
      id: f.attachmentId,
    });
    expect(await count(value.clientUploadId)).toBe(1);
    expect(writes).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind=$1 AND subject=$2 AND action=$3",
          ["ACTOR", actor, "initiate"],
        )
      ).rows[0].used,
    ).toBe(before);
    expect(
      (
        await db.pool.query(
          "SELECT kind,subject,action,used FROM attachment_quota_counters WHERE action IN ('bytes','metadata') AND (subject=$1 OR kind='DEPLOYMENT') ORDER BY kind,subject,action",
          [actor],
        )
      ).rows,
    ).toEqual(capacities);
    expect(
      (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].counters,
    ).toMatchObject({ authenticatedRequests: 2, ingressBytes: 204800 });
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " + table("slots") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows,
    ).toEqual([{ state: "BURNED" }]);
  });
  it("recovers the same committed identity through a new replay attempt after lost creator acknowledgement", async () => {
    const value = input();
    let armed = false,
      commits = 0;
    const f = await ready(value, {
      retry: true,
      send: async (c, sql, values) => {
        const result = await c.query(sql, values);
        if (armed && sql === "COMMIT" && ++commits === 2)
          throw Error("synthetic lost creator acknowledgement");
        return result;
      },
    });
    armed = true;
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    armed = false;
    const replay = await f.replay();
    expect(await f.repo.initiate(actor, value, replay)).toMatchObject({
      id: f.attachmentId,
    });
    expect(await count(value.clientUploadId)).toBe(1);
  });
  it("rejects replay after creator rollback without reusing its burned identity or inserting again", async () => {
    const value = input(),
      f = await ready(value, { retry: true });
    await db.pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [
      actor,
    ]);
    await expect(f.repo.initiate(actor, value, f.context)).rejects.toThrow();
    await db.pool.query(
      "UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1",
      [actor],
    );
    const replay = await f.replay();
    await expect(f.repo.initiate(actor, value, replay)).rejects.toThrow();
    expect(await count(value.clientUploadId)).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT status FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, value.clientUploadId],
        )
      ).rows[0].status,
    ).toBe("ADMITTED");
    expect(
      (
        await db.pool.query(
          "SELECT used FROM attachment_quota_counters WHERE kind=$1 AND subject=$2 AND action=$3",
          ["ACTOR", actor, "initiate"],
        )
      ).rows[0].used,
    ).toBe("1");
    expect(
      (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows[0].counters,
    ).toMatchObject({ authenticatedRequests: 2, ingressBytes: 204800 });
  });
});
