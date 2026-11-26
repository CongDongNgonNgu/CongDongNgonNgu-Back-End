import { RunLedger, type RequestReservation } from "./run-ledger";
import type { Pool } from "pg";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
function fixture() {
  const candidate = {
    candidate_key: "candidate",
    method: "HEAD",
    path: "/api/v1/attachments/" + id(4) + "/content",
    auth_class: "AUTH",
    ingress_bytes: "0",
    egress_bytes: "200",
  };
  const query = jest.fn(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes("request_candidates")
      ? [candidate]
      : sql.includes("SELECT attempt_key")
        ? [{ attempt_key: "attempt", candidate_key: "candidate" }]
        : [{ run_id: id(1) }],
  }));
  const connect = jest.fn(async () => ({ query, release: jest.fn() }));
  const ledger = new RunLedger({ connect } as unknown as Pool);
  return { candidate, query, connect, ledger };
}
async function ready() {
  const f = fixture(),
    active = await f.ledger.activate(id(1), id(2), id(3));
  return { ...f, active };
}
describe("committed local request candidate facts only", () => {
  it("returns frozen SQL candidate facts only after the reservation commit without changing handle shape", async () => {
    const f = await ready(),
      h = await f.ledger.reserveRequest(f.active, "candidate"),
      facts = f.ledger.requireRequestCandidate(h);
    expect(Object.keys(h).sort()).toEqual([
      "attemptKey",
      "candidateKey",
      "runId",
    ]);
    expect(facts).toEqual({
      key: "candidate",
      method: "HEAD",
      path: f.candidate.path,
      authClass: "AUTH",
      ingressBytes: 0,
      egressBytes: 200,
    });
    expect(Object.isFrozen(facts)).toBe(true);
    f.candidate.egress_bytes = "999";
    expect(facts.egressBytes).toBe(200);
    expect(f.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });
  it("rejects copied, foreign ledger and unknown request handles", async () => {
    const f = await ready(),
      h = await f.ledger.reserveRequest(f.active, "candidate");
    for (const test of [
      () => f.ledger.requireRequestCandidate({ ...h }),
      () => new RunLedger({} as Pool).requireRequestCandidate(h),
      () => f.ledger.requireRequestCandidate({} as RequestReservation),
    ])
      expect(test).toThrow(/^TEST_ADMISSION_LEDGER$/);
  });
  it("invalidates candidate access synchronously when either binding API consumes the handle even if binding fails", async () => {
    for (const matched of [false, true]) {
      const f = await ready(),
        h = await f.ledger.reserveRequest(f.active, "candidate");
      const pending = matched
        ? f.ledger.bindMatchedPolicy(h, { policyKey: "p", instanceKeys: ["i"] })
        : f.ledger.bindOperation(h, "missing");
      expect(() => f.ledger.requireRequestCandidate(h)).toThrow(
        "TEST_ADMISSION_LEDGER",
      );
      await expect(pending).rejects.toThrow();
    }
  });
  it("rejects missing, malformed, foreign or excessive SQL candidate metadata without issuing authority", async () => {
    for (const patch of [
      { candidate_key: "foreign" },
      { method: "OPTIONS" },
      { path: "/other" },
      { auth_class: "OTHER" },
      { ingress_bytes: "33554433" },
      { egress_bytes: "67108865" },
      { egress_bytes: "1.5" },
      { auth_class: "ANON", ingress_bytes: "1" },
    ]) {
      const f = await ready();
      Object.assign(f.candidate, patch);
      await expect(
        f.ledger.reserveRequest(f.active, "candidate"),
      ).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
    }
    const f = await ready(),
      real = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql: string) =>
      sql.includes("request_candidates")
        ? { rowCount: 0, rows: [] }
        : real(sql),
    );
    await expect(
      f.ledger.reserveRequest(f.active, "candidate"),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
  });
  it("does not expose candidate facts before commit or after an uncertain commit", async () => {
    const f = await ready(),
      real = f.query.getMockImplementation()!;
    let staged: RequestReservation | undefined;
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") {
        staged = {
          runId: id(1),
          candidateKey: "candidate",
          attemptKey: "attempt",
        };
        expect(() => f.ledger.requireRequestCandidate(staged!)).toThrow();
        throw Error("private");
      }
      return real(sql);
    });
    await expect(
      f.ledger.reserveRequest(f.active, "candidate"),
    ).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
    expect(() => f.ledger.requireRequestCandidate(staged!)).toThrow();
  });
});
