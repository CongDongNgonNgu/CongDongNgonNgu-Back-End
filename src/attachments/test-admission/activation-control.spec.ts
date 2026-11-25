import type { Pool } from "pg";
import { ActivationControlRepository } from "./activation-control";
jest.mock("pg", () => {
  throw Error("no runtime database import");
});
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
  notBefore: "2026-11-25T00:00:00.000Z",
  expiresAt: "2026-11-25T00:10:00.000Z",
});
const receipt = () => ({
  service: "srv-dahnerh594qs73fp3420",
  branch: "dev",
  sha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  deploymentId: "dep-proof",
  bootId: id(3),
  observedAt: "2026-11-25T00:01:00.000Z",
  liveObserved: true as const,
  originalDisabledCommandObserved: true as const,
  allFourFlagsFalseObserved: true as const,
});
function db() {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => ({
    rowCount: 1,
    rows: sql.includes("SELECT")
      ? [
          {
            run_id: id(1),
            run_state: "PREPARED",
            state: "ARMED",
            armed_at: new Date("2026-11-25T00:00:00.000Z"),
            receipt: null,
            receipt_stored_at: null,
          },
        ]
      : [],
  }));
  const release = jest.fn(),
    connect = jest.fn(async () => ({ query, release }));
  return {
    query,
    release,
    connect,
    repo: new ActivationControlRepository({ connect } as unknown as Pool),
  };
}
describe("inert activation control storage only", () => {
  it("sanitizes release failures without retrying committed writes", async () => {
    const p = db();
    p.release.mockImplementation(() => {
      throw Error("private release");
    });
    await expect(p.repo.arm(tuple())).rejects.toThrow(
      /^TEST_ACTIVATION_CONTROL$/,
    );
    expect(p.connect).toHaveBeenCalledTimes(1);
  });

  it("does not connect during construction and has no activation API", () => {
    const p = db();
    expect(p.connect).not.toHaveBeenCalled();
    expect(p.repo).not.toHaveProperty("activate");
    expect(p.repo).not.toHaveProperty("consume");
  });
  it("arms using run-first transaction locks and confirms commit without a handle", async () => {
    const p = db();
    await expect(p.repo.arm(tuple())).resolves.toBeUndefined();
    const sql = p.query.mock.calls.map((c) => c[0]);
    expect(sql[0]).toBe("BEGIN");
    expect(
      sql.findIndex((s) => s.includes("FROM phase30_test_execution.runs")),
    ).toBeLessThan(
      sql.findIndex((s) =>
        s.includes("INSERT INTO phase30_test_execution.activation_controls"),
      ),
    );
    expect(sql.at(-1)).toBe("COMMIT");
    expect(p.release).toHaveBeenCalledTimes(1);
  });
  it("stores exactly one detached receipt after run/control locks", async () => {
    const p = db();
    await expect(
      p.repo.storeReceipt(tuple(), receipt()),
    ).resolves.toBeUndefined();
    const sql = p.query.mock.calls.map((c) => c[0]);
    expect(
      sql.findIndex((s) => s.includes("FROM phase30_test_execution.runs")),
    ).toBeLessThan(
      sql.findIndex((s) =>
        s.includes("FROM phase30_test_execution.activation_controls"),
      ),
    );
    expect(sql.at(-1)).toBe("COMMIT");
  });
  it("rejects closed-record/accessor/identity/date/observation failures before connecting", async () => {
    for (const value of [
      { ...tuple(), extra: true },
      { ...tuple(), bootId: id(99), branch: "main" },
      { ...tuple(), notBefore: "2026-11-25T00:00:00Z" },
      Object.defineProperty(tuple(), "runId", {
        get() {
          throw Error("private");
        },
      }),
    ]) {
      const p = db();
      await expect(p.repo.arm(value as never)).rejects.toThrow(
        /^TEST_ACTIVATION_CONTROL$/,
      );
      expect(p.connect).not.toHaveBeenCalled();
    }
    for (const patch of [
      { liveObserved: false },
      { sha: "c".repeat(40) },
      { bootId: id(99) },
      { observedAt: "2026-02-30T00:00:00.000Z" },
      { extra: true },
    ]) {
      const p = db();
      await expect(
        p.repo.storeReceipt(tuple(), { ...receipt(), ...patch } as never),
      ).rejects.toThrow(/^TEST_ACTIVATION_CONTROL$/);
      expect(p.connect).not.toHaveBeenCalled();
    }
  });
  it("snapshots all input facts before the first await", async () => {
    const p = db(),
      t = tuple(),
      r = receipt(),
      pending = p.repo.storeReceipt(t, r);
    t.deploymentId = "dep-mutated";
    r.observedAt = "2026-11-25T00:09:00.000Z";
    await pending;
    const params = p.query.mock.calls.flatMap((c) => c[1] ?? []);
    expect(JSON.stringify(params)).not.toContain("dep-mutated");
    expect(JSON.stringify(params)).not.toContain("00:09:00");
  });
  it("never retries uncertain commits and sanitizes database errors", async () => {
    const p = db(),
      real = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql: string, v?: unknown[]) => {
      if (sql === "COMMIT") throw Error("private database");
      return real(sql, v);
    });
    await expect(p.repo.arm(tuple())).rejects.toThrow(
      /^TEST_ACTIVATION_CONTROL$/,
    );
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.query.mock.calls.filter((c) => c[0] === "COMMIT")).toHaveLength(1);
    expect(p.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(p.release).toHaveBeenCalledTimes(1);
  });
  it("returns frozen canonical inspection facts without requiring current lifetime", async () => {
    const p = db(),
      out = (await p.repo.inspectExact(tuple())) as {
        tuple: unknown;
        runState: string;
        state: string;
        armedAt: string;
        receipt: null;
      };
    expect(out).toMatchObject({
      tuple: tuple(),
      runState: "PREPARED",
      state: "ARMED",
      armedAt: "2026-11-25T00:00:00.000Z",
      receipt: null,
    });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.tuple)).toBe(true);
    expect(
      p.query.mock.calls.some((c) => c[0].includes("clock_timestamp")),
    ).toBe(false);
  });
  it("returns null for a well-formed unmatched exact tuple", async () => {
    const p = db();
    p.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(p.repo.inspectExact(tuple())).resolves.toBeNull();
  });
});
