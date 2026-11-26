import type { Pool, PoolClient } from "pg";
import { AttachmentInitiationRepository } from "./attachment-initiation-repository";
import type {
  ControlledInitiationContext,
  ControlledInitiationPort,
} from "./controlled-initiation.port";
import {
  AttachmentQuotaLedger,
  AttachmentQuotaError,
} from "../attachment-quota-ledger";
import { createPinnedPlanRoot } from "../../../test/phase30/pinned-plan-fixture";
const actor = "00000003-1111-4111-8111-111111111111",
  caps = { enabled: true, image: true, video: false, text: false },
  input = () => createPinnedPlanRoot().operations[0].body;
function fixture(port?: ControlledInitiationPort) {
  const connect = jest.fn(async () => {
      throw Error("must not connect ordinary pool");
    }),
    pool = { connect } as unknown as Pool;
  return {
    connect,
    repo: new AttachmentInitiationRepository(pool, caps, undefined, port),
  };
}
it("ordinary repository rejects any explicitly supplied controlled signature before I/O, including undefined", async () => {
  const f = fixture();
  for (const c of [undefined, {} as ControlledInitiationContext])
    await expect(f.repo.initiate(actor, input(), c)).rejects.toMatchObject({
      code: "ATTACHMENTS_UNAVAILABLE",
    });
  expect(f.connect).not.toHaveBeenCalled();
});
it("controlled repository requires a private context and delegates both trusted callbacks without ordinary fallback", async () => {
  const continuation = jest.fn(async () => ({ id: "planned" })),
    port = {
      continueInitiation: continuation,
    } as unknown as ControlledInitiationPort,
    f = fixture(port);
  await expect(f.repo.initiate(actor, input())).rejects.toMatchObject({
    code: "ATTACHMENTS_UNAVAILABLE",
  });
  const context = {} as ControlledInitiationContext;
  await expect(f.repo.initiate(actor, input(), context)).resolves.toEqual({
    id: "planned",
  });
  expect(continuation).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      actorId: actor,
      fingerprint: expect.any(String),
    }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(f.connect).not.toHaveBeenCalled();
});
it("preserves only known normal callback failures across ledger rollback, never arbitrary SQL messages", async () => {
  const normal = new AttachmentQuotaError("ATTACHMENT_RATE_LIMITED"),
    query = jest.fn(async (sql: string) =>
      sql.includes("SELECT *,expires_at")
        ? {
            rowCount: 1,
            rows: [
              {
                fingerprint: "",
                source_bytes: "100",
                format: "IMAGE",
                status: "ADMITTED",
                expired: false,
              },
            ],
          }
        : { rowCount: 1, rows: [] },
    );
  const quotas = {
    consumeInitiation: jest.fn(async () => {
      throw normal;
    }),
  } as unknown as AttachmentQuotaLedger;
  const port = {
    continueInitiation: async (
      _ctx: ControlledInitiationContext,
      facts: { actorId: string; fingerprint: string },
      rate: (c: PoolClient) => Promise<void>,
    ) => {
      query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT *,expires_at")
          ? {
              rowCount: 1,
              rows: [
                {
                  fingerprint: facts.fingerprint,
                  source_bytes: "100",
                  format: "IMAGE",
                  status: "ADMITTED",
                  expired: false,
                },
              ],
            }
          : { rowCount: 1, rows: [] },
      );
      try {
        await rate({ query } as unknown as PoolClient);
      } catch {
        throw Error("TEST_ADMISSION_LEDGER");
      }
      throw Error("unreachable");
    },
  } as ControlledInitiationPort;
  const f = fixture();
  const repo = new AttachmentInitiationRepository(
    { connect: f.connect } as unknown as Pool,
    caps,
    quotas,
    port,
  );
  await expect(
    repo.initiate(actor, input(), {} as ControlledInitiationContext),
  ).rejects.toBe(normal);
});
