import type { Pool, PoolClient } from "pg";
import { RunLedger } from "./run-ledger";
import type { ControlledInitiationAccess } from "../initiation/controlled-initiation.port";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const facts = { actorId: id(8), sessionId: id(9), fingerprint: "f".repeat(64) };
const continuationFacts = {
  actorId: facts.actorId,
  fingerprint: facts.fingerprint,
};
async function fixture(replay = false) {
  const sql: string[] = [];
  const query = jest.fn(async (q: string) => {
    sql.push(q);
    if (q.includes("AS observed_at"))
      return {
        rowCount: 1,
        rows: [
          {
            not_before: new Date(0),
            expires_at: new Date(600000),
            observed_at: new Date(1000),
          },
        ],
      };
    if (q.includes("SELECT c.candidate_key"))
      return {
        rowCount: 1,
        rows: [
          {
            candidate_key: "coarse",
            method: "POST",
            path: "/api/v1/attachments",
            auth_class: "AUTH",
            ingress_bytes: "102400",
            egress_bytes: "0",
          },
        ],
      };
    if (q.includes("SELECT attempt_key,candidate_key"))
      return {
        rowCount: 1,
        rows: [{ attempt_key: "attempt", candidate_key: "coarse" }],
      };
    if (q.includes("SELECT o.operation_key"))
      return {
        rowCount: 1,
        rows: [
          {
            operation_key: "instance",
            policy_key: "init",
            policy_attempt_key: "init-attempt",
            attachment_id: id(5),
            slot_count: replay ? 0 : 1,
            state: "AVAILABLE",
          },
        ],
      };
    if (q.includes("SELECT s.slot_key") && replay)
      return { rowCount: 0, rows: [] };
    if (q.includes("SELECT s.slot_key"))
      return {
        rowCount: 1,
        rows: [
          {
            slot_key: "attachment",
            operation_key: "instance",
            role: "ATTACHMENT",
            id: id(5),
            attachment_id: id(5),
          },
        ],
      };
    return {
      rowCount: 1,
      rows: [
        { run_id: id(1), attempt_key: "attempt", operation_key: "instance" },
      ],
    };
  });
  const client = { query, release: jest.fn() },
    pool = { connect: jest.fn(async () => client) },
    ledger = new RunLedger(pool as unknown as Pool);
  const active = await ledger.activateControlled({
    runId: id(1),
    activationId: id(2),
    bootId: id(3),
    sourceSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    service: "srv-dahnerh594qs73fp3420",
    branch: "dev",
    deploymentId: "dep-proof",
    notBefore: new Date(0).toISOString(),
    expiresAt: new Date(600000).toISOString(),
  });
  const request = await ledger.reserveRequest(active, "coarse"),
    handle = await ledger.bindMatchedPolicy(request, {
      policyKey: "init",
      instanceKeys: ["instance"],
    });
  sql.length = 0;
  query.mockClear();
  pool.connect.mockClear();
  return { ledger, handle, sql, query, pool, client };
}
describe("private controlled INITIATE continuation", () => {
  it("issues once without taking ID, consumes before rate await, owns rate then locked domain TX and closes helpers", async () => {
    const f = await fixture(),
      context = f.ledger.issueMatchedInitiationContext(
        f.handle,
        facts,
        new AbortController().signal,
      );
    expect(Object.keys(context)).toEqual([]);
    expect(() =>
      f.ledger.issueMatchedInitiationContext(
        f.handle,
        facts,
        new AbortController().signal,
      ),
    ).toThrow();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let access: ControlledInitiationAccess | undefined;
    const rate = jest.fn(async (c: PoolClient) => {
        expect(c).toBe(f.client);
        await gate;
      }),
      domain = jest.fn(async (c: PoolClient, a: ControlledInitiationAccess) => {
        access = a;
        expect(c).toBe(f.client);
        await a.fresh();
        return a.takeAttachment();
      });
    const result = f.ledger.continueInitiation(
      context,
      continuationFacts,
      rate,
      domain,
    );
    await expect(
      f.ledger.continueInitiation(context, continuationFacts, rate, domain),
    ).rejects.toThrow("TEST_ADMISSION_LEDGER");
    release();
    await expect(result).resolves.toBe(id(5));
    expect(rate).toHaveBeenCalledTimes(1);
    expect(domain).toHaveBeenCalledTimes(1);
    expect(f.sql.filter((s) => s === "COMMIT")).toHaveLength(2);
    const firstCommit = f.sql.indexOf("COMMIT");
    expect(f.sql.findIndex((s) => s.includes("FOR UPDATE"))).toBeLessThan(
      firstCommit,
    );
    expect(
      f.sql.slice(firstCommit + 1).some((s) => s.includes("FOR UPDATE")),
    ).toBe(true);
    expect(() => access!.takeAttachment()).toThrow();
    await expect(access!.fresh()).rejects.toThrow();
  });
  it("rejects copied/foreign contexts and correlation mismatch before I/O", async () => {
    for (const mode of ["copy", "foreign", "actor", "fingerprint"]) {
      const f = await fixture(),
        context = f.ledger.issueMatchedInitiationContext(
          f.handle,
          facts,
          new AbortController().signal,
        ),
        other = new RunLedger(f.pool as unknown as Pool);
      const value = mode === "copy" ? { ...context } : context,
        ledger = mode === "foreign" ? other : f.ledger;
      await expect(
        ledger.continueInitiation(
          value,
          {
            ...continuationFacts,
            ...(mode === "actor"
              ? { actorId: id(99) }
              : mode === "fingerprint"
                ? { fingerprint: "e".repeat(64) }
                : {}),
          },
          async () => {},
          async () => 1,
        ),
      ).rejects.toThrow();
      expect(f.pool.connect).not.toHaveBeenCalled();
    }
  });
  it("never publishes success or retries after uncertain domain COMMIT", async () => {
    const f = await fixture(),
      ctx = f.ledger.issueMatchedInitiationContext(
        f.handle,
        facts,
        new AbortController().signal,
      ),
      real = f.query.getMockImplementation()!;
    let commits = 0;
    f.query.mockImplementation(async (q) => {
      if (q === "COMMIT" && ++commits === 2) throw Error("PRIVATE_SQL");
      return real(q);
    });
    await expect(
      f.ledger.continueInitiation(
        ctx,
        continuationFacts,
        async () => {},
        async () => 1,
      ),
    ).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
    f.pool.connect.mockClear();
    await expect(
      f.ledger.continueInitiation(
        ctx,
        continuationFacts,
        async () => {},
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
});

it("consumes cancelled context before any rate I/O and retains one-use after cancellation", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    ctx = f.ledger.issueMatchedInitiationContext(f.handle, facts, abort.signal);
  abort.abort();
  await expect(
    f.ledger.continueInitiation(
      ctx,
      continuationFacts,
      async () => {},
      async () => 1,
    ),
  ).rejects.toThrow("TEST_ADMISSION_LEDGER");
  expect(f.pool.connect).not.toHaveBeenCalled();
});

it("rolls back rate work when cancellation occurs before its COMMIT", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    ctx = f.ledger.issueMatchedInitiationContext(f.handle, facts, abort.signal),
    domain = jest.fn(async () => 1);
  await expect(
    f.ledger.continueInitiation(
      ctx,
      continuationFacts,
      async () => {
        abort.abort();
      },
      domain,
    ),
  ).rejects.toThrow();
  expect(domain).not.toHaveBeenCalled();
  expect(f.sql.filter((q) => q === "COMMIT")).toHaveLength(0);
});
it("checks expiry after the domain callback and invalidates helpers even when final check rolls back", async () => {
  const f = await fixture(),
    ctx = f.ledger.issueMatchedInitiationContext(
      f.handle,
      facts,
      new AbortController().signal,
    ),
    real = f.query.getMockImplementation()!;
  let expired = false,
    access: ControlledInitiationAccess | undefined;
  f.query.mockImplementation(async (q) =>
    q.includes("AS observed_at") && expired
      ? {
          rowCount: 1,
          rows: [
            {
              not_before: new Date(0),
              expires_at: new Date(600000),
              observed_at: new Date(600000),
            },
          ],
        }
      : real(q),
  );
  await expect(
    f.ledger.continueInitiation(
      ctx,
      continuationFacts,
      async () => {},
      async (_c, a) => {
        access = a;
        expired = true;
        return 1;
      },
    ),
  ).rejects.toThrow();
  expect(f.sql.filter((q) => q === "COMMIT")).toHaveLength(1);
  expect(() => access!.takeAttachment()).toThrow();
  await expect(access!.fresh()).rejects.toThrow();
});

describe("rate writes require original controlled lifetime", () => {
  it.each(["expired", "stopped"])(
    "rejects %s context before calling rate or domain callbacks",
    async (mode) => {
      const f = await fixture(),
        ctx = f.ledger.issueMatchedInitiationContext(
          f.handle,
          facts,
          new AbortController().signal,
        ),
        real = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (q) =>
        mode === "expired" && q.includes("AS observed_at")
          ? {
              rowCount: 1,
              rows: [
                {
                  not_before: new Date(0),
                  expires_at: new Date(600000),
                  observed_at: new Date(600000),
                },
              ],
            }
          : mode === "stopped" && q.includes("SELECT run_id FROM")
            ? { rowCount: 0, rows: [] }
            : real(q),
      );
      const rate = jest.fn(async () => {}),
        domain = jest.fn(async () => 1);
      await expect(
        f.ledger.continueInitiation(ctx, continuationFacts, rate, domain),
      ).rejects.toThrow();
      expect(rate).not.toHaveBeenCalled();
      expect(domain).not.toHaveBeenCalled();
      expect(f.sql.filter((q) => q === "COMMIT")).toHaveLength(0);
    },
  );
  it("rolls rate transaction back if callback outlives original expiry", async () => {
    const f = await fixture(),
      ctx = f.ledger.issueMatchedInitiationContext(
        f.handle,
        facts,
        new AbortController().signal,
      ),
      real = f.query.getMockImplementation()!;
    let expired = false;
    f.query.mockImplementation(async (q) =>
      expired && q.includes("AS observed_at")
        ? {
            rowCount: 1,
            rows: [
              {
                not_before: new Date(0),
                expires_at: new Date(600000),
                observed_at: new Date(600000),
              },
            ],
          }
        : real(q),
    );
    const domain = jest.fn(async () => 1);
    await expect(
      f.ledger.continueInitiation(
        ctx,
        continuationFacts,
        async () => {
          expired = true;
        },
        domain,
      ),
    ).rejects.toThrow();
    expect(domain).not.toHaveBeenCalled();
    expect(f.sql.filter((q) => q === "COMMIT")).toHaveLength(0);
  });
});

it("accepts slot-free replay only with exact trusted policy/attempt/creator plan, and exposes immutable private mode", async () => {
  const f = await fixture(true),
    ctx = f.ledger.issueMatchedInitiationContext(
      f.handle,
      facts,
      new AbortController().signal,
      {
        policyKey: "init",
        policyAttemptKey: "init-attempt",
        creatorAttemptKey: "creator",
        mode: "REPLAY_ONLY",
      },
    ),
    rate = jest.fn(async () => {});
  await expect(
    f.ledger.continueInitiation(ctx, continuationFacts, rate, async (_c, a) => {
      expect(a.mode).toBe("REPLAY_ONLY");
      expect(() => a.takeAttachment()).toThrow("TEST_ADMISSION_LEDGER");
      return a.attachmentId;
    }),
  ).resolves.toBe(id(5));
  expect(rate).toHaveBeenCalledWith(f.client, "REPLAY_ONLY");
});
it("rejects zero-slot inference, contradictory creator mode and foreign policy plan", async () => {
  for (const mode of ["missing", "creator", "foreign"]) {
    const f = await fixture(true);
    expect(() =>
      f.ledger.issueMatchedInitiationContext(
        f.handle,
        facts,
        new AbortController().signal,
        mode === "missing"
          ? undefined
          : {
              policyKey: mode === "foreign" ? "other" : "init",
              policyAttemptKey: "init-attempt",
              creatorAttemptKey:
                mode === "creator" ? "init-attempt" : "creator",
              mode: "REPLAY_ONLY",
            },
      ),
    ).toThrow("TEST_ADMISSION_LEDGER");
    expect(f.pool.connect).not.toHaveBeenCalled();
  }
});
