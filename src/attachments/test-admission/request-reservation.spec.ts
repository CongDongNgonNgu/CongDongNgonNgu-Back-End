import { RunLedger, RUN_LIMITS, type PreparedRun } from "./run-ledger";
import type { Pool } from "pg";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const requestPlan = () => ({
  candidates: [
    {
      key: "read",
      method: "HEAD",
      path: "/api/v1/attachments/" + id(4) + "/content",
      authClass: "AUTH",
      ingressBytes: 0,
      egressBytes: 200,
    },
  ],
  attempts: [
    { key: "attempt-a", candidateKey: "read" },
    { key: "attempt-b", candidateKey: "read" },
  ],
});
const plan = () => ({
  runId: id(1),
  activationId: id(2),
  manifestSha256: "a".repeat(64),
  sourceSha: "b".repeat(40),
  notBefore: "2026-11-11T00:00:00.000Z",
  expiresAt: "2026-11-11T00:10:00.000Z",
  limits: { ...RUN_LIMITS } as Record<keyof typeof RUN_LIMITS, number>,
  slots: [
    { key: "object", operationKey: "upload", role: "SOURCE_OBJECT", id: id(4) },
  ],
  requests: requestPlan(),
});
function db() {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => ({
    rowCount: 1,
    rows: sql.includes("UPDATE phase30_test_execution.runs SET state=")
      ? [{ run_id: id(1) }]
      : sql.includes("SELECT run_id FROM")
        ? [{ run_id: id(1) }]
        : sql.includes("SELECT attempt_key")
          ? [{ attempt_key: "attempt-a", candidate_key: "read" }]
          : [],
  }));
  return {
    query,
    release: jest.fn(),
    connect: jest.fn(async () => ({ query, release: jest.fn() })),
  };
}
describe("durable coarse request reservation only", () => {
  it("prepares immutable candidates and attempts atomically before sealing", async () => {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool);
    await ledger.prepare(plan() as PreparedRun);
    const sql = p.query.mock.calls.map((c) => c[0]).join("\n");
    expect(sql).toContain("request_candidates");
    expect(sql).toContain("request_attempts");
    expect(sql).toContain("SET preparation_sealed=true");
    expect(p.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });
  it("rejects sum of group ceiling times attempt count above lower limits before connection", async () => {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool),
      v = plan();
    v.limits.authenticatedEgressBytes = 399;
    await expect(ledger.prepare(v as PreparedRun)).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("rejects unbounded duplicate unknown or hostile request plan records without SQL", async () => {
    for (const mutation of [
      "duplicate",
      "missing",
      "extra",
      "getter",
      "too-many",
    ]) {
      const p = db(),
        v = plan();
      if (mutation === "duplicate")
        v.requests.attempts.push({ ...v.requests.attempts[0] });
      if (mutation === "missing")
        v.requests.attempts[0].candidateKey = "unknown";
      if (mutation === "extra")
        Object.assign(v.requests.candidates[0], { secret: "private" });
      if (mutation === "getter")
        Object.defineProperty(v.requests.candidates[0], "path", {
          get() {
            throw Error("private");
          },
          enumerable: true,
        });
      if (mutation === "too-many")
        v.requests.attempts = Array(141).fill(v.requests.attempts[0]);
      await expect(
        new RunLedger(p as unknown as Pool).prepare(v as PreparedRun),
      ).rejects.toThrow("TEST_ADMISSION_LEDGER");
      expect(p.connect).not.toHaveBeenCalled();
    }
  });
  it("reserves exactly one prelisted attempt, no role burn, and returns only after commit", async () => {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool);
    const active = await ledger.activate(id(1), id(2), id(3));
    p.query.mockClear();
    const handle = await ledger.reserveRequest(active, "read");
    expect(handle).toMatchObject({
      runId: id(1),
      candidateKey: "read",
      attemptKey: "attempt-a",
    });
    expect(Object.isFrozen(handle)).toBe(true);
    const sql = p.query.mock.calls.map((c) => c[0]).join("\n");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("request_attempts");
    expect(sql).not.toContain("SET state='BURNED'");
    expect(p.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });
  it("rejects reconstructed/restarted active handles without SQL", async () => {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool),
      active = await ledger.activate(id(1), id(2), id(3));
    p.connect.mockClear();
    await expect(
      new RunLedger(p as unknown as Pool).reserveRequest(active, "read"),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
    await expect(ledger.reserveRequest({ ...active }, "read")).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("does not issue a handle or retry after uncertain commit", async () => {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool),
      active = await ledger.activate(id(1), id(2), id(3));
    p.query.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw Error("private commit uncertain");
      return {
        rowCount: 1,
        rows: sql.includes("SELECT run_id FROM")
          ? [{ run_id: id(1) }]
          : sql.includes("SELECT attempt_key")
            ? [{ attempt_key: "attempt-a", candidate_key: "read" }]
            : [],
      };
    });
    p.connect.mockClear();
    await expect(ledger.reserveRequest(active, "read")).rejects.toThrow(
      /^TEST_ADMISSION_LEDGER$/,
    );
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
});

it("uses the same snapshotted request inventory after yielding and rejects an accessor plan field", async () => {
  const p = db(),
    v = plan();
  p.connect.mockImplementationOnce(async () => {
    v.requests.candidates[0].egressBytes = 999;
    v.requests.attempts[0].key = "changed";
    return { query: p.query, release: p.release };
  });
  await new RunLedger(p as unknown as Pool).prepare(v as PreparedRun);
  const candidate = p.query.mock.calls.find(([sql]) =>
    sql.includes("INSERT INTO phase30_test_execution.request_candidates"),
  )!;
  expect(candidate[1]![6]).toBe(200);
  const other = db(),
    bad = plan();
  Object.defineProperty(bad, "requests", {
    get() {
      throw Error("private");
    },
    enumerable: true,
  });
  await expect(
    new RunLedger(other as unknown as Pool).prepare(bad as PreparedRun),
  ).rejects.toThrow("TEST_ADMISSION_LEDGER");
  expect(other.connect).not.toHaveBeenCalled();
});
it("fails closed if expired run or exhausted catalogue yields no database row", async () => {
  for (const stage of ["run", "attempt"]) {
    const p = db(),
      ledger = new RunLedger(p as unknown as Pool),
      active = await ledger.activate(id(1), id(2), id(3));
    p.query.mockImplementation(async (sql: string) => ({
      rowCount: 1,
      rows:
        stage === "attempt" && sql.includes("SELECT run_id FROM")
          ? [{ run_id: id(1) }]
          : [],
    }));
    await expect(ledger.reserveRequest(active, "read")).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(p.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  }
});

it("rejects invalid anonymous ceilings, duplicate observable candidates and mutable candidate facts before SQL", async () => {
  for (const patch of [
    { authClass: "ANON", ingressBytes: 1 },
    { authClass: "ANON", method: "POST" },
    { method: "OTHER" },
    { path: "/api/v1/attachments?token=private" },
    { egressBytes: -1 },
    { ingressBytes: 0.5 },
  ]) {
    const p = db(),
      v = plan();
    Object.assign(v.requests.candidates[0], patch);
    await expect(
      new RunLedger(p as unknown as Pool).prepare(v as PreparedRun),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
    expect(p.connect).not.toHaveBeenCalled();
  }
  const p = db(),
    v = plan();
  v.requests.candidates.push({
    ...v.requests.candidates[0],
    key: "same-observable",
  });
  v.requests.attempts.push({ key: "other", candidateKey: "same-observable" });
  await expect(
    new RunLedger(p as unknown as Pool).prepare(v as PreparedRun),
  ).rejects.toThrow("TEST_ADMISSION_LEDGER");
  expect(p.connect).not.toHaveBeenCalled();
});
