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

import { createPutSupervisionAuthority } from "../storage/put-supervision-proof";
import type { AttachmentPutClaim } from "../attachment-object-ledger";
function custodyFixture() {
  const f = fixture();
  let state = "UPLOADING",
    objectVersion = 8;
  const attachmentPatch: Record<string, unknown> = {},
    sourcePatch: Record<string, unknown> = {};
  let afterCommit: (() => void) | undefined;
  const receipt = {
    locator: {
      attachmentId: id(5),
      objectId: id(11),
      attemptId: id(12),
      kind: "source" as const,
    },
    sizeBytes: 100,
    sha256: "b".repeat(64),
    version: '"etag"',
  };
  const a = createPutSupervisionAuthority(
    receipt.locator,
    () => {},
    require("../storage/put-supervision-proof").createPlannedPutSupervisionIdentity(
      id(14),
    ),
  );
  const claim: AttachmentPutClaim = {
    attachmentId: id(5),
    objectId: id(11),
    claimId: id(13),
    leaseOwner: id(10),
    attachmentVersion: 3,
    objectVersion: 7,
    supervisionId: id(14),
    manifest: {
      locator: receipt.locator,
      sizeBytes: 100,
      sha256: receipt.sha256,
    },
  };
  const old = f.query.getMockImplementation()!;
  let lose = 0;
  f.query.mockImplementation(async (sql: string) => {
    if (sql === "COMMIT" && lose > 0) {
      lose--;
      throw Error("lost ack");
    }
    if (sql === "COMMIT") afterCommit?.();
    if (sql.includes("FROM attachment_bindings"))
      return { rowCount: 0, rows: [] };
    if (
      sql.includes("SELECT * FROM attachments") ||
      sql.includes("SELECT *,expires_at")
    )
      return {
        rowCount: 1,
        rows: [
          {
            id: id(5),
            uploader_id: id(6),
            scope: "COMMUNITY",
            scope_id: id(21),
            state,
            init_fingerprint: "a".repeat(64),
            source_object_id: id(11),
            pending_slot_held: state === "PENDING",
            upload_slot_held: state === "UPLOADING",
            lease_owner: state === "UPLOADING" ? id(10) : null,
            ...attachmentPatch,
          },
        ] as any,
      };
    if (sql.includes("SELECT * FROM attachment_objects"))
      return {
        rowCount: 1,
        rows: [
          {
            id: id(11),
            attachment_id: id(5),
            attempt_id: id(12),
            variant: "source",
            put_claim: id(13),
            put_supervision_id: id(14),
            sha256: receipt.sha256,
            byte_count: "100",
            etag: receipt.version,
            object_version: String(objectVersion),
            status: "WRITTEN",
            put_settled_at: new Date(),
            put_uncertain: false,
            put_abandoned_at: null,
            ...sourcePatch,
          },
        ] as any,
      };
    return old(sql);
  });
  return {
    ...f,
    a,
    claim,
    receipt,
    attachmentPatch,
    sourcePatch,
    onCommit: (fn: () => void) => {
      afterCommit = fn;
    },
    setState: (v: string) => {
      state = v;
    },
    setVersion: (v: number) => {
      objectVersion = v;
    },
    loseAck: () => {
      lose++;
    },
    async run(
      work: (
        a: import("./controlled-source-upload").SourceUploadAccess,
      ) => Promise<void>,
    ) {
      return f.manager.run(
        f.manager.issue(f.handle, f.facts, new AbortController().signal),
        {
          actorId: id(6),
          attachmentId: id(5),
          contentType: "image/jpeg",
          contentLength: 100,
        },
        work,
      );
    },
  };
}
it("keeps original pending custody after lost publication acknowledgement and only adopts after inspection acknowledgement", async () => {
  const f = custodyFixture();
  let saved!: import("./controlled-source-upload").SourceUploadAccess;
  await expect(
    f.run(async (a) => {
      saved = a;
      a.registerClaim(f.claim, f.a.handle);
      f.a.start();
      f.a.recordReceipt(f.receipt);
      f.a.settle();
      await a.recordSourceReceipt(async () => {});
      await a.captureQuiescence(async () => {});
      await a.publishPending(async () => {
        f.setState("PENDING");
        f.loseAck();
      });
    }),
  ).rejects.toThrow("Attachments unavailable");
  f.loseAck();
  await expect(saved.reconcilePending()).rejects.toThrow(
    "Attachments unavailable",
  );
  await expect(saved.reconcilePending()).resolves.toBe(true);
  f.a.handle.release();
  await expect(saved.reconcilePending()).resolves.toBe(true);
  expect(() => saved.assertForward()).toThrow();
});
it("validates same-client pending state instead of trusting callback return", async () => {
  const f = custodyFixture();
  await f.run(async (a) => {
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    await a.recordSourceReceipt(async () => {});
    await a.captureQuiescence(async () => {});
    await expect(
      a.publishPending(async () => ({ state: "PENDING" })),
    ).rejects.toThrow();
    await expect(a.reconcilePending()).resolves.toBe(false);
  });
});
it("does not adopt changed settled version or READY and serializes original reconciliation", async () => {
  const f = custodyFixture();
  let saved!: import("./controlled-source-upload").SourceUploadAccess;
  await f.run(async (a) => {
    saved = a;
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    await a.recordSourceReceipt(async () => {});
    await a.captureQuiescence(async () => {});
  });
  f.setState("PENDING");
  f.setVersion(9);
  await expect(saved.reconcilePending()).rejects.toThrow();
  f.setVersion(8);
  f.setState("READY");
  await expect(saved.reconcilePending()).rejects.toThrow();
  f.setState("PENDING");
  const first = saved.reconcilePending();
  await expect(saved.reconcilePending()).rejects.toThrow();
  await expect(first).resolves.toBe(true);
});

it("keeps no source-quiescence authority when receipt snapshot commit is uncertain", async () => {
  const f = custodyFixture();
  await f.run(async (a) => {
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    f.loseAck();
    await expect(a.recordSourceReceipt(async () => {})).rejects.toThrow(
      "Attachments unavailable",
    );
    await expect(a.captureQuiescence(async () => {})).rejects.toThrow();
    await expect(
      a.publishPending(async () => {
        f.setState("PENDING");
      }),
    ).rejects.toThrow();
    await expect(a.reconcilePending()).resolves.toBe(false);
  });
});
it("serializes capture until actual local closure and rejects repeat or failed capture", async () => {
  const f = custodyFixture();
  await f.run(async (a) => {
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    await a.recordSourceReceipt(async () => {});
    await expect(
      a.captureQuiescence(async () => {
        throw Error("still open");
      }),
    ).rejects.toThrow("still open");
    let close!: () => void;
    const first = a.captureQuiescence(
      () =>
        new Promise<void>((r) => {
          close = r;
        }),
    );
    await expect(a.captureQuiescence(async () => {})).rejects.toThrow();
    await expect(a.publishPending(async () => {})).rejects.toThrow();
    close();
    await first;
    await expect(a.captureQuiescence(async () => {})).rejects.toThrow();
  });
});
it.each([
  "init_fingerprint",
  "source_object_id",
  "pending_slot_held",
  "upload_slot_held",
  "lease_owner",
])("refuses pending custody with mismatching attachment %s", async (field) => {
  const f = custodyFixture();
  let saved!: import("./controlled-source-upload").SourceUploadAccess;
  await f.run(async (a) => {
    saved = a;
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    await a.recordSourceReceipt(async () => {});
    await a.captureQuiescence(async () => {});
  });
  f.setState("PENDING");
  f.attachmentPatch[field] =
    field === "pending_slot_held"
      ? false
      : field === "upload_slot_held"
        ? true
        : "foreign";
  await expect(saved.reconcilePending()).rejects.toThrow();
  delete f.attachmentPatch[field];
  await expect(saved.reconcilePending()).resolves.toBe(true);
});
it.each([
  "etag",
  "sha256",
  "byte_count",
  "put_claim",
  "put_supervision_id",
  "status",
  "put_uncertain",
  "put_settled_at",
])("retains original observer on mismatching source %s", async (field) => {
  const f = custodyFixture();
  let saved!: import("./controlled-source-upload").SourceUploadAccess;
  await f.run(async (a) => {
    saved = a;
    a.registerClaim(f.claim, f.a.handle);
    f.a.start();
    f.a.recordReceipt(f.receipt);
    f.a.settle();
    await a.recordSourceReceipt(async () => {});
    await a.captureQuiescence(async () => {});
  });
  f.setState("PENDING");
  f.sourcePatch[field] =
    field === "put_uncertain"
      ? true
      : field === "put_settled_at"
        ? null
        : "foreign";
  await expect(saved.reconcilePending()).rejects.toThrow();
  delete f.sourcePatch[field];
  await expect(saved.reconcilePending()).resolves.toBe(true);
});
it("records acknowledged pending custody before post-COMMIT cancellation; grants no forward use", async () => {
  const f = custodyFixture(),
    abort = new AbortController();
  let saved!: import("./controlled-source-upload").SourceUploadAccess;
  await expect(
    f.manager.run(
      f.manager.issue(f.handle, f.facts, abort.signal),
      {
        actorId: id(6),
        attachmentId: id(5),
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async (a) => {
        saved = a;
        a.registerClaim(f.claim, f.a.handle);
        f.a.start();
        f.a.recordReceipt(f.receipt);
        f.a.settle();
        await a.recordSourceReceipt(async () => {});
        await a.captureQuiescence(async () => {});
        f.onCommit(() => abort.abort());
        return a.publishPending(async () => {
          f.setState("PENDING");
        });
      },
    ),
  ).rejects.toThrow();
  const connects = f.pool.connect.mock.calls.length;
  await expect(saved.reconcilePending()).resolves.toBe(true);
  expect(f.pool.connect).toHaveBeenCalledTimes(connects);
  expect(() => saved.assertForward()).toThrow();
});

it("retains at most four original source custodies per active run while all four uncertain publications reconcile", async () => {
  let current: ReturnType<typeof custodyFixture>;
  let rewrite: <T>(v: T) => T;
  const active = {
      runId: id(1),
      activationId: id(2),
      bootId: id(3),
    } as ControlledActiveRun,
    known = new Set<MatchedBoundOperation>();
  const pool = {
    connect: async () => ({
      query: async (sql: string) => rewrite(await current.query(sql)),
      release: () => {},
    }),
  };
  const manager = new ControlledSourceUploads(pool as unknown as Pool, (h) => {
    if (!known.has(h as MatchedBoundOperation)) throw Error("foreign");
    return { handle: h as MatchedBoundOperation, active };
  });
  for (let index = 0; index < 5; index++) {
    current = custodyFixture();
    const f = current,
      substitutions = new Map<string, string>([
        [id(5), id(100 + index)],
        ...Array.from(
          { length: 5 },
          (_, n) => [id(10 + n), id(200 + index * 5 + n)] as [string, string],
        ),
        ["upload", "upload-" + index],
        ["request", "request-" + index],
      ]);
    rewrite = <T>(value: T): T => {
      const visit = (v: any): any => {
        if (typeof v === "string") {
          for (const [a, b] of substitutions) v = v.replaceAll(a, b);
          return v;
        }
        if (v instanceof Date) return new Date(v);
        if (Array.isArray(v)) return v.map(visit);
        if (v && typeof v === "object")
          return Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, visit(x)]),
          );
        return v;
      };
      return visit(value);
    };
    const h = rewrite(f.handle);
    known.add(h);
    const claim = rewrite(f.claim),
      receipt = rewrite(f.receipt);
    // Original factories are separate while the sealed run's custody registry is shared.
    const authority = createPutSupervisionAuthority(
      receipt.locator,
      () => {},
      require("../storage/put-supervision-proof").createPlannedPutSupervisionIdentity(
        claim.supervisionId,
      ),
    );
    let saved!: import("./controlled-source-upload").SourceUploadAccess;
    const operation = manager.run(
      manager.issue(h, f.facts, new AbortController().signal),
      {
        actorId: id(6),
        attachmentId: h.attachmentId,
        contentType: "image/jpeg",
        contentLength: 100,
      },
      async (a) => {
        saved = a;
        a.registerClaim(claim, authority.handle);
        authority.start();
        authority.recordReceipt(receipt);
        authority.settle();
        await a.recordSourceReceipt(async () => {});
        await a.captureQuiescence(async () => {});
        return a.publishPending(async () => {
          f.setState("PENDING");
          f.loseAck();
        });
      },
    );
    await expect(operation).rejects.toThrow("Attachments unavailable");
    if (index < 4) {
      f.loseAck();
      await expect(saved.reconcilePending()).rejects.toThrow(
        "Attachments unavailable",
      );
      await expect(saved.reconcilePending()).resolves.toBe(true);
      authority.handle.release();
      await expect(saved.reconcilePending()).resolves.toBe(true);
    } else {
      await expect(saved.publishPending(async () => {})).rejects.toThrow();
      expect(() => saved.assertForward()).toThrow();
    }
  }
});
