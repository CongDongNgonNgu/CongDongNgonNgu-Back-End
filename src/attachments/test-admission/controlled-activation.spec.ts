import { RunLedger, type ActiveRun } from "./run-ledger";
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
  deploymentId: "dep-owned",
  bootId: id(3),
  notBefore: "2026-11-25T00:00:00.000Z",
  expiresAt: "2026-11-25T00:10:00.000Z",
});
function db() {
  const query = jest.fn(async (_sql: string, _v?: unknown[]) => ({
      rowCount: 1,
      rows: [{ run_id: id(1) }],
    })),
    release = jest.fn(),
    connect = jest.fn(async () => ({ query, release }));
  return {
    query,
    release,
    connect,
    ledger: new RunLedger({ connect } as unknown as Pool),
  };
}
describe("atomic controlled ledger activation only", () => {
  it("consumes receipt and activates within one confirmed transaction before returning a frozen local handle", async () => {
    const p = db(),
      t = tuple(),
      handle = await p.ledger.activateControlled(t);
    expect(handle).toMatchObject({ ...t, mode: "CONTROLLED" });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(p.ledger.requireControlled(handle)).toBe(handle);
    const sql = p.query.mock.calls.map((c) => c[0]);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(
      sql.findIndex((s) => s.includes("SET state='CONSUMED'")),
    ).toBeLessThan(sql.findIndex((s) => s.includes("SET state='ACTIVE'")));
    expect(p.connect).toHaveBeenCalledTimes(1);
  });
  it("rejects legacy, reconstructed and foreign-ledger handles before I/O", async () => {
    const p = db(),
      t = tuple(),
      legacy = await p.ledger.activate(t.runId, t.activationId, t.bootId);
    expect(() => p.ledger.requireControlled(legacy)).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    const handle = await p.ledger.activateControlled(t);
    p.connect.mockClear();
    expect(() => p.ledger.requireControlled({ ...handle })).toThrow();
    expect(() => db().ledger.requireControlled(handle)).toThrow();
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("snapshots closed tuple facts before awaiting and never grants independent process identity", async () => {
    const p = db(),
      t = tuple(),
      pending = p.ledger.activateControlled(t);
    t.deploymentId = "dep-changed";
    t.bootId = id(99);
    const result = await pending;
    expect(result).toMatchObject({ deploymentId: "dep-owned", bootId: id(3) });
    expect(JSON.stringify(p.query.mock.calls)).not.toContain("dep-changed");
  });
  it("rejects invalid/accessor tuples without connecting", async () => {
    for (const value of [
      { ...tuple(), extra: true },
      { ...tuple(), branch: "main" },
      { ...tuple(), bootId: "invalid" },
      Object.defineProperty(tuple(), "runId", {
        get() {
          throw Error("private");
        },
        enumerable: true,
      }),
    ]) {
      const p = db();
      await expect(p.ledger.activateControlled(value)).rejects.toThrow(
        /^TEST_ADMISSION_LEDGER$/,
      );
      expect(p.connect).not.toHaveBeenCalled();
    }
  });
  it("issues no handle and never retries uncertain commits", async () => {
    const p = db(),
      real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
      if (sql === "COMMIT") throw Error("private commit");
      return real(sql, v);
    });
    await expect(p.ledger.activateControlled(tuple())).rejects.toThrow(
      /^TEST_ADMISSION_LEDGER$/,
    );
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.query.mock.calls.filter((c) => c[0] === "COMMIT")).toHaveLength(1);
    expect(p.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(() => p.ledger.requireControlled(tuple() as ActiveRun)).toThrow();
  });
  it("rolls back both transitions when either locked row or durable update is missing", async () => {
    for (const stage of ["run", "control", "consume", "activate"]) {
      const p = db(),
        real = p.query.getMockImplementation()!;
      p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
        if (
          (stage === "run" &&
            sql.includes("SELECT") &&
            sql.includes("FROM phase30_test_execution.runs")) ||
          (stage === "control" &&
            sql.includes("SELECT") &&
            sql.includes("FROM phase30_test_execution.activation_controls")) ||
          (stage === "consume" && sql.includes("SET state='CONSUMED'")) ||
          (stage === "activate" && sql.includes("SET state='ACTIVE'"))
        )
          return { rowCount: 0, rows: [] };
        return real(sql, v);
      });
      await expect(p.ledger.activateControlled(tuple())).rejects.toThrow(
        "TEST_ADMISSION_LEDGER",
      );
      expect(p.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    }
  });
});
