import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
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
/** Owned-schema diagnostic coverage only. Synthetic control receipts grant no
 * deployment/provider authority; cleanup identity is distinct from HTTP roles. */
describe("separate prepared internal source-cleanup ownership", () => {
  const db = new SqlHarness();
  let ledger: RunLedger, controls: ActivationControlRepository;
  const table = (name: string) => '"' + db.schema + '".' + name;
  beforeAll(async () => {
    await db.open();
    if (!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))
      throw Error("unsafe proof schema");
    await db.pool.query(
      RUN_LEDGER_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    await db.pool.query(
      ACTIVATION_CONTROL_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    const pool = {
      connect: async () => {
        const c = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            c.query(sql.replace(/phase30_test_execution/g, db.schema), values),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    ledger = new RunLedger(pool);
    controls = new ActivationControlRepository(pool);
  }, 30000);
  afterAll(async () => db.close());
  async function plan() {
    const now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime(),
      attachmentId = randomUUID(),
      roles = [
        "UPLOAD_OWNER",
        "SOURCE_OBJECT",
        "SOURCE_ATTEMPT",
        "PUT_CLAIM",
        "PUT_SUPERVISION",
      ] as const;
    const slots = roles.map((role) => ({
      key: role.toLowerCase(),
      operationKey: "upload.instance",
      role,
      id: randomUUID(),
      attachmentId,
    }));
    const job = {
      key: "source.cleanup.job",
      operationKey: "source.cleanup",
      role: "CLEANUP_JOB" as const,
      id: randomUUID(),
      attachmentId,
    };
    const id = (role: string) => slots.find((s) => s.role === role)!.id;
    return {
      runId: randomUUID(),
      activationId: randomUUID(),
      manifestSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      sourceSha: "b".repeat(40),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      limits: { ...RUN_LIMITS },
      activationControlRequired: true,
      slots: [...slots, job],
      requests: {
        candidates: [
          {
            key: "upload",
            method: "PUT" as const,
            path: "/api/v1/attachments/" + attachmentId + "/content",
            authClass: "AUTH" as const,
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
          objectId: id("SOURCE_OBJECT"),
          attemptId: id("SOURCE_ATTEMPT"),
          claimId: id("PUT_CLAIM"),
          supervisionId: id("PUT_SUPERVISION"),
          sha256: createHash("sha256").update("abc").digest("hex"),
          byteCount: 3,
          jobSlotKey: job.key,
        },
      ],
    } as PreparedRun & {
      internalCleanup: Array<{
        key: string;
        sourceOperationKey: string;
        attachmentId: string;
        objectId: string;
        attemptId: string;
        claimId: string;
        supervisionId: string;
        sha256: string;
        byteCount: number;
        jobSlotKey: string;
      }>;
    };
  }
  it("seals exact HTTP5 plus INTERNAL1 coverage without dummy request edges", async () => {
    const p = await plan();
    await ledger.prepare(p);
    const run = (
      await db.pool.query(
        "SELECT slot_count,operation_slot_count,internal_cleanup_count,internal_slot_count,preparation_sealed FROM " +
          table("runs") +
          " WHERE run_id=$1",
        [p.runId],
      )
    ).rows[0];
    expect(run).toEqual({
      slot_count: 6,
      operation_slot_count: 5,
      internal_cleanup_count: 1,
      internal_slot_count: 1,
      preparation_sealed: true,
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int n FROM " +
            table("request_attempts") +
            " WHERE run_id=$1",
          [p.runId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT object_id,job_slot_key FROM " +
            table("internal_cleanup_entries") +
            " WHERE run_id=$1",
          [p.runId],
        )
      ).rows,
    ).toEqual([
      {
        object_id: p.internalCleanup[0].objectId,
        job_slot_key: "source.cleanup.job",
      },
    ]);
  });
  it("rejects missing, overlapping and foreign internal coverage without leaving a partial run", async () => {
    for (const change of ["missing", "overlap", "foreign", "duplicate"]) {
      const p = await plan();
      if (change === "missing") p.internalCleanup = [];
      if (change === "overlap")
        p.internalCleanup[0].jobSlotKey = "source_object";
      if (change === "foreign") p.internalCleanup[0].objectId = randomUUID();
      if (change === "duplicate")
        p.internalCleanup.push({ ...p.internalCleanup[0], key: "other" });
      await expect(ledger.prepare(p)).rejects.toThrow("TEST_ADMISSION_LEDGER");
      expect(
        (
          await db.pool.query(
            "SELECT 1 FROM " + table("runs") + " WHERE run_id=$1",
            [p.runId],
          )
        ).rowCount,
      ).toBe(0);
    }
  });
  it("preserves immutable internal source tuples and forbids post-seal insertion/deletion/truncation", async () => {
    const p = await plan();
    await ledger.prepare(p);
    for (const sql of [
      "UPDATE " +
        table("internal_cleanup_entries") +
        " SET object_id=$2 WHERE run_id=$1",
      "DELETE FROM " + table("internal_cleanup_entries") + " WHERE run_id=$1",
    ])
      await expect(
        db.pool.query(
          sql,
          sql.startsWith("UPDATE") ? [p.runId, randomUUID()] : [p.runId],
        ),
      ).rejects.toThrow();
    await expect(
      db.pool.query("TRUNCATE " + table("internal_cleanup_entries")),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT object_id FROM " +
            table("internal_cleanup_entries") +
            " WHERE run_id=$1",
          [p.runId],
        )
      ).rows[0].object_id,
    ).toBe(p.internalCleanup[0].objectId);
  });
  it("burns only five HTTP roles when binding and leaves the separate cleanup entry unavailable", async () => {
    const p = await plan();
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
      deploymentId: "dep-synthetic-source-cleanup",
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
      receipt = await ledger.reserveRequest(active, "upload"),
      handle = await ledger.bindMatchedPolicy(receipt, {
        policyKey: "upload.policy",
        instanceKeys: ["upload.instance"],
      });
    expect(handle.slots).toHaveLength(5);
    expect(handle.slots.some((s) => s.role === "CLEANUP_JOB")).toBe(false);
    const slots = (
      await db.pool.query(
        "SELECT role,state FROM " + table("slots") + " WHERE run_id=$1",
        [p.runId],
      )
    ).rows;
    expect(slots.filter((s) => s.state === "BURNED")).toHaveLength(5);
    expect(slots.find((s) => s.role === "CLEANUP_JOB").state).toBe("AVAILABLE");
    expect(
      (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [p.runId],
        )
      ).rows[0].counters,
    ).toMatchObject({ authenticatedRequests: 1, ingressBytes: 3 });
  });
  it("rejects null cleanup versions at the SQL CHECK boundary even below the row guard", async () => {
    const p = await plan();
    await ledger.prepare(p);
    for (const nullable of ["attachment_version", "object_version"]) {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        // Exact owned random-schema adversarial constraint proof; rollback also
        // restores the guard. No shared schema or permanent trigger mutation.
        await c.query(
          "ALTER TABLE " +
            table("internal_cleanup_entries") +
            " DISABLE TRIGGER guard_internal_cleanup",
        );
        const attachmentVersion =
            nullable === "attachment_version" ? "NULL" : "0",
          objectVersion = nullable === "object_version" ? "NULL" : "1";
        await expect(
          c.query(
            "UPDATE " +
              table("internal_cleanup_entries") +
              " SET state='BOUND',proof_kind='SETTLED',lease_owner=$2,attachment_version=" +
              attachmentVersion +
              ",object_version=" +
              objectVersion +
              ",allocated_at=clock_timestamp() WHERE run_id=$1",
            [p.runId, randomUUID()],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " +
            table("internal_cleanup_entries") +
            " WHERE run_id=$1",
          [p.runId],
        )
      ).rows[0].state,
    ).toBe("AVAILABLE");
  });
});
