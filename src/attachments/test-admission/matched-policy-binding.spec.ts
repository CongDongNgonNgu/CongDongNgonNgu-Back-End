import {
  RunLedger,
  type MatchedBoundOperation,
  type BoundOperation,
} from "./run-ledger";
import type { Pool } from "pg";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const tuple = () => ({
  runId: id(1),
  activationId: id(2),
  sourceSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  service: "srv-dahnerh594qs73fp3420",
  branch: "dev",
  deploymentId: "dep-proof",
  bootId: id(3),
  notBefore: "2026-11-26T00:00:00.000Z",
  expiresAt: "2026-11-26T00:10:00.000Z",
});
function db() {
  let attempt = 0;
  const available = new Set(["instance-a", "instance-b"]);
  const rows = () =>
    [...["instance-a", "instance-b"]].map((key, i) => ({
      operation_key: key,
      policy_key: "read-policy",
      policy_attempt_key: "policy-attempt-" + i,
      attachment_id: id(5),
      slot_count: 0,
      state: available.has(key) ? "AVAILABLE" : "BOUND",
    }));
  const query = jest.fn(async (sql: string, v?: unknown[]) => {
    if (sql.includes("AS observed_at"))
      return {
        rowCount: 1,
        rows: [{ expires_at: new Date(2000), observed_at: new Date(1000) }],
      };
    if (sql.includes("SELECT o.operation_key"))
      return { rowCount: 2, rows: rows() };
    if (sql.includes("FROM phase30_test_execution.request_candidates"))
      return {
        rowCount: 1,
        rows: [
          {
            candidate_key: "coarse",
            method: "HEAD",
            path: "/api/v1/attachments/" + id(5) + "/content",
            auth_class: "AUTH",
            ingress_bytes: "0",
            egress_bytes: "4194304",
          },
        ],
      };
    if (sql.includes("SELECT attempt_key,candidate_key"))
      return {
        rowCount: 1,
        rows: [
          { attempt_key: "request-" + attempt++, candidate_key: "coarse" },
        ],
      };
    if (sql.includes("SELECT attempt_key"))
      return {
        rowCount: 1,
        rows: [{ attempt_key: String(v?.[1]), candidate_key: "coarse" }],
      };
    if (sql.includes("SELECT s.slot_key")) return { rowCount: 0, rows: [] };
    if (sql.includes("UPDATE phase30_test_execution.bound_operations"))
      available.delete(String(v?.[1]));
    return { rowCount: 1, rows: [{ run_id: id(1) }] };
  });
  const connect = jest.fn(async () => ({ query, release: jest.fn() }));
  return {
    query,
    connect,
    available,
    ledger: new RunLedger({ connect } as unknown as Pool),
  };
}
async function reserved(controlled = true) {
  const p = db(),
    active = controlled
      ? await p.ledger.activateControlled(tuple())
      : await p.ledger.activate(id(1), id(2), id(3)),
    request = await p.ledger.reserveRequest(active, "coarse");
  p.query.mockClear();
  p.connect.mockClear();
  return { ...p, active, request };
}
const matched = () => ({
  policyKey: "read-policy",
  instanceKeys: ["instance-b", "instance-a"],
});
describe("controlled matched policy instance ledger binding", () => {
  it("prepares paired original policy provenance and rejects partial, duplicate or contradictory declarations before SQL", async () => {
    const make = () => ({
      runId: id(1),
      activationId: id(2),
      manifestSha256: "b".repeat(64),
      sourceSha: "a".repeat(40),
      notBefore: tuple().notBefore,
      expiresAt: tuple().expiresAt,
      limits: {
        authenticatedRequests: 120,
        anonymousRequests: 20,
        ingressBytes: 33554432,
        authenticatedEgressBytes: 67108864,
        anonymousEgressBytes: 16777216,
        processingAttempts: 4,
      },
      slots: [
        {
          key: "object",
          operationKey: "instance-a",
          role: "SOURCE_OBJECT" as const,
          id: id(6),
          attachmentId: id(5),
        },
      ],
      requests: {
        candidates: [
          {
            key: "coarse",
            method: "HEAD" as const,
            path: "/api/v1/attachments/" + id(5) + "/content",
            authClass: "AUTH" as const,
            ingressBytes: 0,
            egressBytes: 4194304,
          },
        ],
        attempts: [{ key: "request-a", candidateKey: "coarse" }],
      },
      bindings: {
        operations: [
          {
            key: "instance-a",
            attachmentId: id(5),
            ingressBytes: 0,
            egressBytes: 4194304,
            processingAttempts: 0,
            slotKeys: ["object"],
            policyKey: "read-policy",
            policyAttemptKey: "policy-a",
          },
        ],
        edges: [{ attemptKey: "request-a", operationKey: "instance-a" }],
      },
    });
    const p = db();
    await p.ledger.prepare(make());
    const insert = p.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO phase30_test_execution.bound_operations"),
    )!;
    expect(insert[1]).toContain("read-policy");
    expect(insert[1]).toContain("policy-a");
    for (const mode of ["partial", "duplicate", "contradictory"]) {
      const q = db(),
        v = make();
      if (mode === "partial")
        delete (v.bindings.operations[0] as { policyAttemptKey?: string })
          .policyAttemptKey;
      else {
        v.bindings.operations.push({
          ...v.bindings.operations[0],
          key: "instance-b",
          slotKeys: [],
          attachmentId: mode === "contradictory" ? id(9) : id(5),
          policyAttemptKey: mode === "contradictory" ? "policy-b" : "policy-a",
        });
        v.bindings.edges.push({
          attemptKey: "request-a",
          operationKey: "instance-b",
        });
      }
      await expect(q.ledger.prepare(v)).rejects.toThrow(
        "TEST_ADMISSION_LEDGER",
      );
      expect(q.connect).not.toHaveBeenCalled();
    }
  });
  it("never treats the legacy bindOperation result as a matched-policy receipt", async () => {
    const p = await reserved();
    const old = await p.ledger.bindOperation(p.request, "instance-a");
    expect(() => p.ledger.takeMatchedAttachment(old)).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(() => p.ledger.requireMatchedBoundOperation(old)).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
  });
  it("snapshots the matched policy and all instance keys before the first await", async () => {
    const p = await reserved(),
      input = matched(),
      pending = p.ledger.bindMatchedPolicy(p.request, input);
    input.policyKey = "changed";
    input.instanceKeys[0] = "changed";
    const h = await pending;
    expect(h.policyKey).toBe("read-policy");
    const selected = p.query.mock.calls.find((c) =>
      c[0].includes("ANY($3::text[])"),
    )!;
    expect(selected[1]?.[2]).toEqual(["instance-a", "instance-b"]);
  });

  it("chooses first available instance and returns committed frozen candidate/policy provenance", async () => {
    const p = await reserved(),
      h = await p.ledger.bindMatchedPolicy(p.request, matched());
    expect(h).toMatchObject({
      operationKey: "instance-a",
      policyKey: "read-policy",
      policyAttemptKey: "policy-attempt-0",
      candidateKey: "coarse",
      candidate: {
        key: "coarse",
        method: "HEAD",
        authClass: "AUTH",
        ingressBytes: 0,
        egressBytes: 4194304,
      },
      slots: [],
    });
    expect(p.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(p.ledger.requireMatchedBoundOperation(h)).toBe(h);
    for (const x of [h, h.candidate, h.slots])
      expect(Object.isFrozen(x)).toBe(true);
    expect(
      p.query.mock.calls.some((c) => c[0].includes("SET state='RESERVED'")),
    ).toBe(false);
  });
  it("claims the original request synchronously and never reconstructs local authority", async () => {
    const p = await reserved(),
      results = await Promise.allSettled([
        p.ledger.bindMatchedPolicy(p.request, matched()),
        p.ledger.bindMatchedPolicy(p.request, matched()),
      ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const h = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<MatchedBoundOperation>
    ).value;
    expect(() => p.ledger.requireMatchedBoundOperation({ ...h })).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(() =>
      new RunLedger({} as Pool).requireMatchedBoundOperation(h),
    ).toThrow("TEST_ADMISSION_LEDGER");
    expect(() =>
      p.ledger.requireMatchedBoundOperation({
        runId: id(1),
        attemptKey: "x",
        operationKey: "x",
        attachmentId: id(5),
        slots: [],
      }),
    ).toThrow("TEST_ADMISSION_LEDGER");
  });
  it("selects another remaining instance for a subsequent original request", async () => {
    const p = await reserved();
    await p.ledger.bindMatchedPolicy(p.request, matched());
    const second = await p.ledger.reserveRequest(p.active, "coarse"),
      h = await p.ledger.bindMatchedPolicy(second, matched());
    expect(h.operationKey).toBe("instance-b");
  });
  it("rejects legacy active handles before any binding SQL and consumes their local request", async () => {
    const p = await reserved(false);
    await expect(
      p.ledger.bindMatchedPolicy(p.request, matched()),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
    expect(p.connect).not.toHaveBeenCalled();
    await expect(
      p.ledger.bindOperation(p.request, "instance-a"),
    ).rejects.toThrow();
  });
  it("requires every supplied instance to belong to the policy and compatible coarse edge", async () => {
    for (const mode of ["foreign", "missing", "legacy"]) {
      const p = await reserved(),
        real = p.query.getMockImplementation()!;
      p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
        const result = await real(sql, v);
        if (sql.includes("SELECT o.operation_key")) {
          if (mode === "missing") result.rows = result.rows.slice(0, 1);
          else
            result.rows[1] = {
              ...result.rows[1],
              policy_key: mode === "foreign" ? "other" : null,
              state: "BOUND",
            } as never;
        }
        return result;
      });
      await expect(
        p.ledger.bindMatchedPolicy(p.request, matched()),
      ).rejects.toThrow("TEST_ADMISSION_LEDGER");
      expect(
        p.query.mock.calls.some((c) => c[0].includes("SET state='BOUND'")),
      ).toBe(false);
    }
  });
  it("rejects duplicate/empty/accessor keys before SQL without preserving a retriable handle", async () => {
    for (const value of [
      { policyKey: "read-policy", instanceKeys: [] },
      { policyKey: "read-policy", instanceKeys: ["instance-a", "instance-a"] },
      Object.defineProperty(matched(), "policyKey", {
        get() {
          throw Error("private");
        },
      }),
    ]) {
      const p = await reserved();
      await expect(
        p.ledger.bindMatchedPolicy(p.request, value),
      ).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
      expect(p.connect).not.toHaveBeenCalled();
      await expect(
        p.ledger.bindMatchedPolicy(p.request, matched()),
      ).rejects.toThrow();
    }
  });
  it("does not issue handles or retry after uncertain commit", async () => {
    const p = await reserved(),
      real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
      if (sql === "COMMIT") throw Error("private");
      return real(sql, v);
    });
    await expect(
      p.ledger.bindMatchedPolicy(p.request, matched()),
    ).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
    expect(p.connect).toHaveBeenCalledTimes(1);
    p.connect.mockClear();
    await expect(
      p.ledger.bindMatchedPolicy(p.request, matched()),
    ).rejects.toThrow();
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("does not bind expired runs or exhausted sets", async () => {
    for (const mode of ["expiry", "exhausted"]) {
      const p = await reserved(),
        real = p.query.getMockImplementation()!;
      if (mode === "exhausted") p.available.clear();
      p.query.mockImplementation(async (sql: string, v?: unknown[]) =>
        mode === "expiry" && sql.includes("state='ACTIVE'")
          ? { rowCount: 0, rows: [] }
          : real(sql, v),
      );
      await expect(
        p.ledger.bindMatchedPolicy(p.request, matched()),
      ).rejects.toThrow("TEST_ADMISSION_LEDGER");
      expect(
        p.query.mock.calls.some((c) => c[0].includes("SET state='BOUND'")),
      ).toBe(false);
    }
  });
});

async function attachmentBound(
  slots = [
    {
      slot_key: "attachment",
      operation_key: "instance-a",
      role: "ATTACHMENT",
      id: id(5),
      attachment_id: id(5),
    },
  ],
) {
  const p = await reserved(),
    real = p.query.getMockImplementation()!;
  p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
    if (sql.includes("SELECT s.slot_key"))
      return { rowCount: slots.length, rows: slots } as unknown as Awaited<
        ReturnType<typeof real>
      >;
    const result = await real(sql, v);
    if (sql.includes("SELECT o.operation_key"))
      result.rows = result.rows.map((row) => ({
        ...row,
        slot_count: slots.length,
      })) as typeof result.rows;
    return result;
  });
  const handle = await p.ledger.bindMatchedPolicy(p.request, matched());
  return { ...p, handle };
}
describe("local original matched ATTACHMENT identity, never fresh producer authority", () => {
  it("takes the exact durably burned attachment once without SQL or public handle mutation", async () => {
    const f = await attachmentBound(),
      before = JSON.stringify(f.handle);
    f.query.mockClear();
    f.connect.mockClear();
    expect(f.ledger.takeMatchedAttachment(f.handle)).toBe(id(5));
    expect(JSON.stringify(f.handle)).toBe(before);
    expect(() => f.ledger.takeMatchedAttachment(f.handle)).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.ledger.requireMatchedBoundOperation(f.handle)).toBe(f.handle);
  });
  it("rejects copies, foreign/restarted ledgers and legacy objects without consuming original authority", async () => {
    const f = await attachmentBound();
    for (const h of [
      { ...f.handle },
      {
        runId: id(1),
        attemptKey: "a",
        operationKey: "o",
        attachmentId: id(5),
        slots: f.handle.slots,
      },
    ])
      expect(() => f.ledger.takeMatchedAttachment(h)).toThrow(
        "TEST_ADMISSION_LEDGER",
      );
    expect(() =>
      new RunLedger({} as Pool).takeMatchedAttachment(f.handle),
    ).toThrow("TEST_ADMISSION_LEDGER");
    expect(f.ledger.takeMatchedAttachment(f.handle)).toBe(id(5));
  });
  it("rejects missing, extra, wrong-role and wrong-identity mapped slots", async () => {
    const slot = {
      slot_key: "attachment",
      operation_key: "instance-a",
      role: "ATTACHMENT",
      id: id(5),
      attachment_id: id(5),
    };
    for (const slots of [
      [],
      [{ ...slot, role: "SOURCE_OBJECT" }],
      [{ ...slot, id: id(6) }],
      [slot, { ...slot, slot_key: "owner", role: "UPLOAD_OWNER", id: id(6) }],
    ]) {
      const f = await attachmentBound(slots);
      f.query.mockClear();
      expect(() => f.ledger.takeMatchedAttachment(f.handle)).toThrow(
        "TEST_ADMISSION_LEDGER",
      );
      expect(f.query).not.toHaveBeenCalled();
    }
  });
});
