import {
  RunLedger,
  type MatchedBoundOperation,
  type ControlledActiveRun,
} from "./run-ledger";
import { ControlledSourceUploads } from "./controlled-source-upload";
import type { Pool } from "pg";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const roles = [
  "UPLOAD_OWNER",
  "SOURCE_OBJECT",
  "SOURCE_ATTEMPT",
  "PUT_CLAIM",
  "PUT_SUPERVISION",
] as const;
function fixture() {
  const handle = Object.freeze({
    runId: id(1),
    attemptKey: "request",
    operationKey: "upload",
    attachmentId: id(5),
    policyKey: "upload-policy",
    policyAttemptKey: "one",
    candidateKey: "coarse",
    candidate: Object.freeze({
      key: "coarse",
      method: "PUT",
      path: "/api/v1/attachments/" + id(5) + "/content",
      authClass: "AUTH",
      ingressBytes: 100,
      egressBytes: 0,
    }),
    slots: Object.freeze(
      roles.map((role, i) =>
        Object.freeze({
          key: "s" + i,
          operationKey: "upload",
          attachmentId: id(5),
          role,
          id: id(10 + i),
        }),
      ),
    ),
  }) as MatchedBoundOperation;
  const query = jest.fn(async (sql: string) => ({
      rowCount: 1,
      rows: sql.includes("clock_timestamp")
        ? [
            {
              not_before: new Date(0),
              expires_at: new Date(Date.now() + 600000),
              observed_at: new Date(),
            },
          ]
        : [
            {
              run_id: id(1),
              entry_key: "cleanup",
              source_operation_key: "upload",
              attachment_id: id(5),
              object_id: id(11),
              attempt_id: id(12),
              claim_id: id(13),
              supervision_id: id(14),
              sha256: "b".repeat(64),
              byte_count: "100",
              job_slot_key: "cleanup-job",
              job_id: id(20),
            },
          ],
    })),
    pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) },
    original = jest.fn((h: unknown) => {
      if (h !== handle) throw Error("not original");
      return {
        handle,
        active: {
          runId: id(1),
          activationId: id(2),
          bootId: id(3),
        } as ControlledActiveRun,
      };
    }),
    manager = new ControlledSourceUploads(pool as unknown as Pool, original),
    facts = {
      actorId: id(6),
      sessionId: id(7),
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "b".repeat(64),
      initiationFingerprint: "a".repeat(64),
    };
  return { handle, query, pool, original, manager, facts };
}
it("consumes original source context once and provides actual prelisted five roles with fresh gated transaction before callback", async () => {
  const f = fixture(),
    ctx = f.manager.issue(f.handle, f.facts, new AbortController().signal);
  await expect(
    f.manager.run(
      ctx,
      {
        actorId: f.facts.actorId,
        attachmentId: id(5),
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async (a) => {
        expect(a.ids).toEqual({
          uploadOwner: id(10),
          objectId: id(11),
          attemptId: id(12),
          claimId: id(13),
          supervisionId: id(14),
        });
        expect(a.sha256).toBe("b".repeat(64));
        return a.stage(async (_c, fresh) => {
          await fresh();
          return "owned";
        });
      },
    ),
  ).resolves.toBe("owned");
  expect(f.query.mock.calls.some(([sql]) => sql.includes("FOR UPDATE"))).toBe(
    true,
  );
  await expect(
    f.manager.run(
      ctx,
      {
        actorId: f.facts.actorId,
        attachmentId: id(5),
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async () => 1,
    ),
  ).rejects.toThrow();
});

it("never returns a successful controlled result when cancellation occurs before callback completion", async () => {
  const f = fixture(),
    abort = new AbortController(),
    ctx = f.manager.issue(f.handle, f.facts, abort.signal);
  await expect(
    f.manager.run(
      ctx,
      {
        actorId: f.facts.actorId,
        attachmentId: id(5),
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async () => {
        abort.abort();
        return "late";
      },
    ),
  ).rejects.toThrow();
});
it("rejects copied context and duplicate issuance without SQL and closes forward helpers after return", async () => {
  const f = fixture(),
    ctx = f.manager.issue(f.handle, f.facts, new AbortController().signal);
  expect(() =>
    f.manager.issue(f.handle, f.facts, new AbortController().signal),
  ).toThrow();
  await expect(
    f.manager.run(
      { ...ctx },
      {
        actorId: f.facts.actorId,
        attachmentId: id(5),
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async () => 1,
    ),
  ).rejects.toThrow();
  expect(f.pool.connect).not.toHaveBeenCalled();
  let saved:
    import("./controlled-source-upload").SourceUploadAccess | undefined;
  await f.manager.run(
    ctx,
    {
      actorId: f.facts.actorId,
      attachmentId: id(5),
      contentType: "image/jpeg",
      contentLength: 100,
    },
    async (access) => {
      saved = access;
      return 1;
    },
  );
  await expect(saved!.stage(async () => 1)).rejects.toThrow();
  expect(() => saved!.assertForward()).toThrow();
});
