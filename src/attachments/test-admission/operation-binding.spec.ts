import { RunLedger, RUN_LIMITS, type PreparedRun } from "./run-ledger";
import type { Pool } from "pg";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const plan = () => ({
  runId: id(1),
  activationId: id(2),
  manifestSha256: "a".repeat(64),
  sourceSha: "b".repeat(40),
  notBefore: "2026-11-11T00:00:00.000Z",
  expiresAt: "2026-11-11T00:10:00.000Z",
  limits: { ...RUN_LIMITS } as Record<keyof typeof RUN_LIMITS, number>,
  slots: [
    {
      key: "object",
      operationKey: "upload-op",
      role: "SOURCE_OBJECT",
      id: id(4),
      attachmentId: id(5),
    },
  ],
  requests: {
    candidates: [
      {
        key: "candidate",
        method: "PUT",
        path: "/api/v1/attachments/" + id(5) + "/content",
        authClass: "AUTH",
        ingressBytes: 200,
        egressBytes: 0,
      },
    ],
    attempts: [{ key: "attempt", candidateKey: "candidate" }],
  },
  bindings: {
    operations: [
      {
        key: "upload-op",
        attachmentId: id(5),
        ingressBytes: 100,
        egressBytes: 0,
        processingAttempts: 0,
        slotKeys: ["object"],
      },
    ],
    edges: [{ attemptKey: "attempt", operationKey: "upload-op" }],
  },
});
function db() {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => ({
    rowCount: 1,
    rows: sql.includes("FROM phase30_test_execution.request_candidates")
      ? [
          {
            candidate_key: "candidate",
            method: "PUT",
            path: "/api/v1/attachments/" + id(5) + "/content",
            auth_class: "AUTH",
            ingress_bytes: "200",
            egress_bytes: "0",
          },
        ]
      : sql.includes("SELECT run_id FROM") || sql.includes("SET state='ACTIVE'")
        ? [{ run_id: id(1) }]
        : sql.includes("SELECT attempt_key")
          ? [{ attempt_key: "attempt", candidate_key: "candidate" }]
          : sql.includes("SELECT o.operation_key")
            ? [
                {
                  operation_key: "upload-op",
                  attachment_id: id(5),
                  slot_count: 1,
                },
              ]
            : sql.includes("SELECT s.slot_key")
              ? [
                  {
                    slot_key: "object",
                    operation_key: "upload-op",
                    role: "SOURCE_OBJECT",
                    id: id(4),
                    attachment_id: id(5),
                  },
                ]
              : [],
  }));
  return {
    query,
    connect: jest.fn(async () => ({ query, release: jest.fn() })),
  };
}
async function reserved() {
  const p = db(),
    ledger = new RunLedger(p as unknown as Pool),
    active = await ledger.activate(id(1), id(2), id(3)),
    request = await ledger.reserveRequest(active, "candidate");
  p.query.mockClear();
  p.connect.mockClear();
  return { p, ledger, request };
}
describe("inert operation binding only", () => {
  it("prepares exact immutable operation edges/slot mappings before sealing", async () => {
    const p = db();
    await new RunLedger(p as unknown as Pool).prepare(plan() as PreparedRun);
    const sql = p.query.mock.calls.map((c) => c[0]).join("\n");
    expect(sql).toContain("bound_operations");
    expect(sql).toContain("operation_edges");
    expect(sql).toContain("operation_slots");
    expect(p.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });
  it("binds a private reservation once with no second request charge and frozen postcommit slots", async () => {
    const { p, ledger, request } = await reserved();
    const bound = await ledger.bindOperation(request, "upload-op");
    expect(bound).toMatchObject({
      runId: id(1),
      attemptKey: "attempt",
      operationKey: "upload-op",
      attachmentId: id(5),
    });
    expect(bound.slots[0]).toMatchObject({ key: "object", id: id(4) });
    expect(Object.isFrozen(bound.slots[0])).toBe(true);
    expect(p.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(
      p.query.mock.calls.filter(([sql]) =>
        sql.includes("SET state='RESERVED'"),
      ),
    ).toHaveLength(0);
    await expect(ledger.bindOperation(request, "upload-op")).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
  });
  it("consumes the local handle before failure and issues no retriable authority on uncertain commit", async () => {
    const { p, ledger, request } = await reserved();
    const real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
      if (sql === "COMMIT") throw Error("private uncertain");
      return real(sql, v);
    });
    await expect(ledger.bindOperation(request, "upload-op")).rejects.toThrow(
      /^TEST_ADMISSION_LEDGER$/,
    );
    p.connect.mockClear();
    await expect(ledger.bindOperation(request, "upload-op")).rejects.toThrow();
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("rejects reconstructed handles and missing edge before any slot burn", async () => {
    const { p, ledger, request } = await reserved();
    await expect(
      ledger.bindOperation({ ...request }, "upload-op"),
    ).rejects.toThrow();
    expect(p.connect).not.toHaveBeenCalled();
    const real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) =>
      sql.includes("SELECT o.operation_key")
        ? { rowCount: 0, rows: [] }
        : real(sql, v),
    );
    await expect(
      ledger.bindOperation(request, "not-permitted"),
    ).rejects.toThrow();
    expect(
      p.query.mock.calls.some(([sql]) => sql.includes("SET state='BURNED'")),
    ).toBe(false);
  });
  it("rejects unsealed coverage, ceiling excess, duplicate edges and conservative processing overcommit before SQL", async () => {
    for (const which of ["slot", "ceiling", "duplicate", "processing"]) {
      const p = db(),
        v = plan();
      if (which === "slot") v.bindings.operations[0].slotKeys = [];
      if (which === "ceiling") v.bindings.operations[0].ingressBytes = 201;
      if (which === "duplicate")
        v.bindings.edges.push({ ...v.bindings.edges[0] });
      if (which === "processing") {
        v.limits.processingAttempts = 1;
        v.bindings.operations[0].processingAttempts = 1;
        v.requests.attempts.push({ key: "second", candidateKey: "candidate" });
        v.bindings.edges.push({
          attemptKey: "second",
          operationKey: "upload-op",
        });
      }
      await expect(
        new RunLedger(p as unknown as Pool).prepare(v as PreparedRun),
      ).rejects.toThrow("TEST_ADMISSION_LEDGER");
      expect(p.connect).not.toHaveBeenCalled();
    }
  });
  it("claims a request handle synchronously so concurrent bind calls have at most one winner", async () => {
    const { ledger, request } = await reserved();
    const results = await Promise.allSettled([
      ledger.bindOperation(request, "upload-op"),
      ledger.bindOperation(request, "upload-op"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects incomplete or oversized stored slot inventories before binding", async () => {
    for (const slots of [
      [],
      [
        {
          slot_key: "object",
          operation_key: "upload-op",
          role: "SOURCE_OBJECT",
          id: id(4),
          attachment_id: id(5),
        },
        {
          slot_key: "extra",
          operation_key: "upload-op",
          role: "SOURCE_OBJECT",
          id: id(6),
          attachment_id: id(5),
        },
      ],
    ]) {
      const { p, ledger, request } = await reserved();
      const real = p.query.getMockImplementation()!;
      p.query.mockImplementation(async (sql: string, v?: unknown[]) =>
        sql.includes("SELECT s.slot_key")
          ? { rowCount: slots.length, rows: slots }
          : real(sql, v),
      );
      await expect(ledger.bindOperation(request, "upload-op")).rejects.toThrow(
        "TEST_ADMISSION_LEDGER",
      );
      expect(
        p.query.mock.calls.some(([sql]) => sql.includes("SET state='BOUND'")),
      ).toBe(false);
    }
  });
  it("rejects expired run authority and foreign ledger handles without reissuing authority", async () => {
    const { p, ledger, request } = await reserved();
    await expect(
      new RunLedger(p as unknown as Pool).bindOperation(request, "upload-op"),
    ).rejects.toThrow();
    expect(p.connect).not.toHaveBeenCalled();
    const real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) =>
      sql.includes("SELECT run_id FROM")
        ? { rowCount: 0, rows: [] }
        : real(sql, v),
    );
    await expect(ledger.bindOperation(request, "upload-op")).rejects.toThrow();
    expect(
      p.query.mock.calls.some(([sql]) => sql.includes("SET state='BOUND'")),
    ).toBe(false);
  });
});
