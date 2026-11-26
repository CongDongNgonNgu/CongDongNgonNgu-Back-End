import { randomUUID, createHash } from "node:crypto";
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
/** Actual transaction/provenance proof in disposable schema only. Policies,
 * control receipts and candidate200-byte ceilings are synthetic accounting
 * fixtures, not full manifest/READ cap/actor/ACL/provider/deployment acceptance. */
describe("controlled matched policy instances in owned PostgreSQL schema", () => {
  const db = new SqlHarness();
  let ledger: RunLedger;
  let controls: ActivationControlRepository;
  type Send = (c: PoolClient, sql: string, values?: unknown[]) => Promise<any>;
  function scoped(send?: Send): Pool {
    return {
      connect: async () => {
        const c = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            send
              ? send(
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
  }
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
    ledger = new RunLedger(scoped());
    controls = new ActivationControlRepository(scoped());
  }, 30000);
  afterAll(async () => db.close());
  async function plan(expiresInMs = 60000): Promise<PreparedRun> {
    const now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime(),
      attachmentId = randomUUID();
    return {
      runId: randomUUID(),
      activationId: randomUUID(),
      manifestSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      sourceSha: "b".repeat(40),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      limits: {
        ...RUN_LIMITS,
        authenticatedRequests: 4,
        authenticatedEgressBytes: 600,
        ingressBytes: 100,
      },
      activationControlRequired: true,
      slots: [
        {
          key: "setup.object",
          operationKey: "setup",
          role: "SOURCE_OBJECT",
          id: randomUUID(),
          attachmentId,
        },
      ],
      requests: {
        candidates: [
          {
            key: "read",
            method: "HEAD",
            path: "/api/v1/attachments/" + attachmentId + "/content",
            authClass: "AUTH",
            ingressBytes: 0,
            egressBytes: 200,
          },
          {
            key: "setup",
            method: "PUT",
            path: "/api/v1/attachments/" + attachmentId + "/content",
            authClass: "AUTH",
            ingressBytes: 100,
            egressBytes: 0,
          },
        ],
        attempts: [0, 1, 2]
          .map((i) => ({ key: "coarse-" + i, candidateKey: "read" }))
          .concat([{ key: "setup-request", candidateKey: "setup" }]),
      },
      bindings: {
        operations: [
          {
            key: "setup",
            attachmentId,
            ingressBytes: 100,
            egressBytes: 0,
            processingAttempts: 0,
            slotKeys: ["setup.object"],
          },
          {
            key: "read.a",
            attachmentId,
            ingressBytes: 0,
            egressBytes: 100,
            processingAttempts: 0,
            slotKeys: [],
            policyKey: "read.policy",
            policyAttemptKey: "declared-a",
          },
          {
            key: "read.b",
            attachmentId,
            ingressBytes: 0,
            egressBytes: 100,
            processingAttempts: 0,
            slotKeys: [],
            policyKey: "read.policy",
            policyAttemptKey: "declared-b",
          },
          {
            key: "foreign",
            attachmentId,
            ingressBytes: 0,
            egressBytes: 100,
            processingAttempts: 0,
            slotKeys: [],
            policyKey: "foreign.policy",
            policyAttemptKey: "declared-foreign",
          },
        ],
        edges: [
          { attemptKey: "setup-request", operationKey: "setup" },
          ...[0, 1, 2].flatMap((i) =>
            ["read.a", "read.b", "foreign"].map((operationKey) => ({
              attemptKey: "coarse-" + i,
              operationKey,
            })),
          ),
        ],
      },
    };
  }
  async function ready(
    options: {
      owner?: RunLedger;
      omitFirstEdge?: boolean;
      expiresInMs?: number;
    } = {},
  ) {
    const owner = options.owner ?? ledger,
      p = await plan(options.expiresInMs);
    if (options.omitFirstEdge)
      p.bindings!.edges = p.bindings!.edges.filter(
        (e) => e.attemptKey !== "coarse-0" || e.operationKey !== "read.b",
      );
    await owner.prepare(p);
    const t: ControlTuple = {
      runId: p.runId,
      activationId: p.activationId,
      sourceSha: p.sourceSha,
      manifestSha256: p.manifestSha256,
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      deploymentId: "dep-synthetic-matched-proof",
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
    return { p, t, owner, active: await owner.activateControlled(t) };
  }
  const matched = {
    policyKey: "read.policy",
    instanceKeys: ["read.b", "read.a"],
  };
  async function counters(runId: string) {
    return (
      await db.pool.query(
        "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
        [runId],
      )
    ).rows[0].counters;
  }
  it("atomically assigns distinct available instances and keeps the third exhausted request charged", async () => {
    const f = await ready(),
      requests = await Promise.all([
        ledger.reserveRequest(f.active, "read"),
        ledger.reserveRequest(f.active, "read"),
      ]);
    const handles = await Promise.all(
      requests.map((r) => ledger.bindMatchedPolicy(r, matched)),
    );
    expect(handles.map((h) => h.operationKey).sort()).toEqual([
      "read.a",
      "read.b",
    ]);
    expect(handles.map((h) => h.policyAttemptKey).sort()).toEqual([
      "declared-a",
      "declared-b",
    ]);
    for (const h of handles) {
      expect(ledger.requireMatchedBoundOperation(h)).toBe(h);
      expect(h).toMatchObject({
        policyKey: "read.policy",
        candidateKey: "read",
        candidate: {
          key: "read",
          method: "HEAD",
          authClass: "AUTH",
          ingressBytes: 0,
          egressBytes: 200,
        },
      });
      expect([h, h.candidate, h.slots].every(Object.isFrozen)).toBe(true);
    }
    const third = await ledger.reserveRequest(f.active, "read");
    await expect(ledger.bindMatchedPolicy(third, matched)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(await counters(f.p.runId)).toMatchObject({
      authenticatedRequests: 3,
      authenticatedEgressBytes: 600,
      processingAttempts: 0,
    });
    expect(
      (
        await db.pool.query(
          "SELECT state FROM " + table("slots") + " WHERE run_id=$1",
          [f.p.runId],
        )
      ).rows,
    ).toEqual([{ state: "AVAILABLE" }]);
  });
  it("does not preassign coarse arrival order to original policy identity", async () => {
    const f = await ready();
    const first = await ledger.reserveRequest(f.active, "read");
    expect(
      (
        await ledger.bindMatchedPolicy(first, {
          policyKey: "foreign.policy",
          instanceKeys: ["foreign"],
        })
      ).operationKey,
    ).toBe("foreign");
    const second = await ledger.reserveRequest(f.active, "read");
    expect((await ledger.bindMatchedPolicy(second, matched)).operationKey).toBe(
      "read.a",
    );
    expect(await counters(f.p.runId)).toMatchObject({
      authenticatedRequests: 2,
      authenticatedEgressBytes: 400,
    });
  });
  it("rejects a bad member or missing original edge without falling through to a valid subset", async () => {
    const f = await ready();
    const r = await ledger.reserveRequest(f.active, "read");
    await expect(
      ledger.bindMatchedPolicy(r, {
        policyKey: "read.policy",
        instanceKeys: ["read.a", "foreign"],
      }),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
    await expect(ledger.bindMatchedPolicy(r, matched)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(await counters(f.p.runId)).toMatchObject({
      authenticatedRequests: 1,
      authenticatedEgressBytes: 200,
    });
    const missing = await ready({ omitFirstEdge: true });
    const r2 = await ledger.reserveRequest(missing.active, "read");
    await expect(ledger.bindMatchedPolicy(r2, matched)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(
      (
        await db.pool.query(
          "SELECT DISTINCT state FROM " +
            table("bound_operations") +
            " WHERE run_id=$1",
          [missing.p.runId],
        )
      ).rows,
    ).toEqual([{ state: "AVAILABLE" }]);
  });
  it("keeps policy provenance immutable and refuses generic/copied/restarted handles", async () => {
    const f = await ready(),
      r = await ledger.reserveRequest(f.active, "read"),
      h = await ledger.bindMatchedPolicy(r, matched);
    expect(() => ledger.requireMatchedBoundOperation({ ...h })).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(() =>
      new RunLedger(scoped()).requireMatchedBoundOperation(h),
    ).toThrow("TEST_ADMISSION_LEDGER");
    await expect(
      db.pool.query(
        "UPDATE " +
          table("bound_operations") +
          " SET policy_key='other' WHERE run_id=$1 AND operation_key='read.a'",
        [f.p.runId],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "UPDATE " +
          table("bound_operations") +
          " SET policy_attempt_key='other' WHERE run_id=$1 AND operation_key='read.a'",
        [f.p.runId],
      ),
    ).rejects.toThrow();
    const r2 = await ledger.reserveRequest(f.active, "read"),
      generic = await ledger.bindOperation(r2, "read.b");
    expect(() => ledger.requireMatchedBoundOperation(generic)).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
  });
  it("rejects duplicate original policy-attempt identity at SQL even when preparation input is corrupted below validation", async () => {
    let duplicateCode: string | undefined;
    const corrupt = scoped(async (c, sql, values) => {
      let sent = values;
      if (
        sql.startsWith("INSERT INTO " + db.schema + ".bound_operations") &&
        values?.[1] === "read.b"
      ) {
        const columns = sql
          .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
          .split(",")
          .map((s) => s.trim());
        const index = columns.indexOf("policy_attempt_key");
        if (index < 0) throw Error("proof policy column absent");
        sent = [...values];
        sent[index] = "declared-a";
      }
      try {
        return await c.query(sql, sent);
      } catch (error) {
        if (sent !== values) duplicateCode = (error as { code?: string }).code;
        throw error;
      }
    });
    const p = await plan();
    await expect(new RunLedger(corrupt).prepare(p)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(duplicateCode).toBe("23505");
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM " + table("runs") + " WHERE run_id=$1",
          [p.runId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("retains a committed binding without issuing authority after lost commit acknowledgement", async () => {
    let uncertain = false;
    const owner = new RunLedger(
      scoped(async (c, sql, values) => {
        const result = await c.query(sql, values);
        if (sql === "COMMIT" && uncertain)
          throw Error("synthetic private commit acknowledgement loss");
        return result;
      }),
    );
    const f = await ready({ owner });
    const r = await owner.reserveRequest(f.active, "read");
    uncertain = true;
    await expect(owner.bindMatchedPolicy(r, matched)).rejects.toThrow(
      /^TEST_ADMISSION_LEDGER$/,
    );
    await expect(owner.bindMatchedPolicy(r, matched)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(
      (
        await db.pool.query(
          "SELECT state,policy_key,policy_attempt_key FROM " +
            table("bound_operations") +
            " WHERE run_id=$1 AND operation_key='read.a'",
          [f.p.runId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "BOUND",
      policy_key: "read.policy",
      policy_attempt_key: "declared-a",
    });
    expect(await counters(f.p.runId)).toMatchObject({
      authenticatedRequests: 1,
      authenticatedEgressBytes: 200,
    });
  });
  it("rejects new binding after natural DB expiry while retaining original request charges", async () => {
    const f = await ready({ expiresInMs: 10000 }),
      r = await ledger.reserveRequest(f.active, "read");
    await db.pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)",
      [f.p.expiresAt],
    );
    await expect(ledger.bindMatchedPolicy(r, matched)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(await counters(f.p.runId)).toMatchObject({
      authenticatedRequests: 1,
      authenticatedEgressBytes: 200,
    });
  }, 30000);
});
