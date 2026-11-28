import { randomUUID, createHash } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import type { Response, RequestHandler } from "express";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { SqlHarness } from "../phase22/sql-harness";
import { RunLedger } from "../../src/attachments/test-admission/run-ledger";
import { RUN_LEDGER_DDL } from "../../src/attachments/test-admission/run-ledger-schema";
import { ACTIVATION_CONTROL_DDL } from "../../src/attachments/test-admission/activation-control-schema";
import {
  ActivationControlRepository,
  type ControlTuple,
} from "../../src/attachments/test-admission/activation-control";
import { RequestAccounting } from "../../src/attachments/test-admission/request-accounting";
import { createDiagnosticBodyParser } from "../../src/attachments/test-admission/diagnostic-body-parser";
import { validatePinnedDeclarations } from "../../src/attachments/test-admission/pinned-declarations";
import { lowerPinnedRequestPlan } from "../../src/attachments/test-admission/request-plan-lowering";
import { SourceUploadPolicyBinding } from "../../src/attachments/test-admission/source-upload-policy-binding";
import {
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "./pinned-plan-fixture";
import {
  AttachmentController,
  ATTACHMENT_HTTP_APPLICATION,
} from "../../src/attachments/http/attachment.controller";
import { ATTACHMENT_UPLOAD_POLICY } from "../../src/attachments/http/attachment-upload-policy.port";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { AttachmentUploadService } from "../../src/attachments/service/attachment-upload-service";
import { AttachmentRuntime } from "../../src/attachments/attachment-runtime";
import {
  createPutSupervisionAuthority,
  supervisionIdentity,
  type PlannedPutSupervisionIdentity,
} from "../../src/attachments/storage/put-supervision-proof";
import type {
  AttachmentStorage,
  AttachmentObjectLocator,
  AttachmentPutSupervision,
} from "../../src/attachments/storage/attachment-storage.port";
import type { ControlledSourceUploadContext } from "../../src/attachments/test-admission/controlled-source-upload";
import { SessionService } from "../../src/auth/session/session.service";
import { AccessTokenService } from "../../src/auth/crypto/access-token";
import { OptionalAccessTokenGuard } from "../../src/community/optional-access-token.guard";
import { IDENTITY_REPOSITORY } from "../../src/identity/identity.module";
import { InMemoryIdentityRepository } from "../../src/identity/identity.repository";
import { configureApp } from "../../src/app.setup";

/** Real native HTTP/auth/parser and owned PostgreSQL, with a supervised fake
 * transport only. TEXT is explicitly enabled in this proof service; the actual
 * ordinary runtime/config stay four-false. Synthetic control is not boot or
 * deployment evidence, and no provider, worker or fixed schema is activated. */
describe("native controlled source upload with exact planned ownership", () => {
  const db = new SqlHarness();
  const capabilities = {
    enabled: true,
    text: true,
    image: false,
    video: false,
  };
  const table = (name: string) => '"' + db.schema + '".' + name;
  let language: string;
  beforeAll(async () => {
    await db.open();
    if (!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))
      throw Error("unsafe proof schema");
    await db.migration("0027_phase22_study_groups.down.sql");
    const files = (
      await readdir(path.resolve(__dirname, "../../database/migrations"))
    )
      .filter(
        (f) =>
          f.endsWith(".sql") &&
          !f.endsWith(".down.sql") &&
          Number(f.slice(0, 4)) >= 2 &&
          Number(f.slice(0, 4)) <= 39,
      )
      .sort();
    for (const file of files) await db.migration(file);
    await db.pool.query(
      RUN_LEDGER_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    await db.pool.query(
      ACTIVATION_CONTROL_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    language = (
      await db.pool.query(
        "INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id",
      )
    ).rows[0].id;
  }, 180000);
  afterAll(async () => db.close());
  type Send = (
    client: PoolClient,
    sql: string,
    values?: unknown[],
  ) => Promise<any>;
  async function fixture(
    ordinary = false,
    proofOptions: { send?: Send; expiresInMs?: number } = {},
  ) {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "phase30-source-http-"),
    );
    const identity = new InMemoryIdentityRepository();
    const pool = {
      connect: async () => {
        const c = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            proofOptions.send
              ? proofOptions.send(
                  c,
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                )
              : c.query(
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                ),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const ledger = new RunLedger(pool),
      controls = new ActivationControlRepository(pool),
      executor = ledger.controlledSourceUploads();
    const config = new ConfigService({
      app: { environment: "test", corsOrigins: ["http://localhost:5173"] },
      auth: {
        accessSecret: "synthetic-source-http-access-secret-32bytes",
        refreshSecret: "synthetic-source-http-refresh-secret-32bytes",
        accessTtlSeconds: 600,
        refreshTtlSeconds: 3600,
        refreshCookieName: "cdn_refresh",
        csrfCookieName: "cdn_csrf",
      },
      attachments: { enabled: false, image: false, video: false, text: false },
      swagger: { enabled: false },
    });
    const ordinaryRuntime = new AttachmentRuntime(config);
    const authorities = new Map<
      AttachmentPutSupervision,
      ReturnType<typeof createPutSupervisionAuthority>
    >();
    const transport = {
      putTemporary: jest.fn(async () => {
        throw Error("unsupervised provider forbidden");
      }),
      supervisePut: jest.fn(
        (
          locator: AttachmentObjectLocator,
          planned?: PlannedPutSupervisionIdentity,
        ) => {
          const authority = createPutSupervisionAuthority(
            locator,
            () => {},
            planned,
          );
          authorities.set(authority.handle, authority);
          return authority.handle;
        },
      ),
      putSupervised: jest.fn(
        async (
          handle: AttachmentPutSupervision,
          input: Parameters<AttachmentStorage["putTemporary"]>[0],
        ) => {
          const authority = authorities.get(handle);
          if (
            !authority ||
            supervisionIdentity(handle, input.locator) !== handle.id
          )
            throw Error("original supervision required");
          authority.start();
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of input.body)
              chunks.push(Buffer.from(chunk));
            expect(Buffer.concat(chunks)).toEqual(Buffer.from("abc"));
            const observed = {
              locator: { ...input.locator },
              sha256: input.sha256,
              sizeBytes: input.sizeBytes,
              version: '"synthetic-source-http"',
            };
            authority.recordReceipt(observed);
            return observed;
          } finally {
            authority.settle();
          }
        },
      ),
    };
    const service = new AttachmentUploadService(
      pool,
      transport as unknown as AttachmentStorage,
      capabilities,
      { temporaryRoot, controlled: executor },
    );
    let accounting: RequestAccounting | undefined,
      binder: SourceUploadPolicyBinding | undefined;
    const adapter = {
      upload: (
        input: Parameters<AttachmentUploadService["upload"]>[0],
        context: ControlledSourceUploadContext,
      ) =>
        ordinary
          ? ordinaryRuntime.upload(input, context)
          : service.upload(input, context),
    };
    const module = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: IDENTITY_REPOSITORY, useValue: identity },
        SessionService,
        AccessTokenService,
        OptionalAccessTokenGuard,
        { provide: ATTACHMENT_HTTP_APPLICATION, useValue: adapter },
        {
          provide: ATTACHMENT_UPLOAD_POLICY,
          useValue: {
            bind: (
              req: Parameters<SourceUploadPolicyBinding["bind"]>[0],
              id: string,
              res: Response,
            ) => {
              if (!binder) throw Error("proof not ready");
              return binder.bind(req, id, res);
            },
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication({ bodyParser: false });
    const middleware: RequestHandler = (req, res, next) => {
      if (!accounting) throw Error("proof not ready");
      return accounting.middleware(req, res, next);
    };
    configureApp(app, {
      attachmentRequestAccounting: middleware,
      attachmentBodyParser: createDiagnosticBodyParser({
        peekCandidate: (req) => accounting!.peekCandidate(req),
        peekBodyRemaining: (req) => accounting!.peekBodyRemaining(req),
      }),
    });
    await app.init();
    const close = async () => {
      try {
        await app.close();
      } finally {
        if (
          !temporaryRoot.startsWith(path.join(tmpdir(), "phase30-source-http-"))
        )
          throw Error("unsafe owned temp");
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    };
    try {
      const user = await identity.createUser({
        email: randomUUID() + "@phase30.invalid",
        displayName: "Synthetic native source",
        passwordHash: null,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      });
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic native source','ACTIVE',clock_timestamp())",
        [user.id, user.email],
      );
      const sessions = app.get(SessionService),
        credentials = await sessions.issue(user, {
          append: () => {},
        } as unknown as Response);
      const remap = new Map<string, string>();
      let raw = JSON.stringify(createPinnedPlanRoot()).replace(
        /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/g,
        (id) => {
          if (!remap.has(id)) remap.set(id, randomUUID());
          return remap.get(id)!;
        },
      );
      let root = JSON.parse(raw) as ReturnType<typeof createPinnedPlanRoot>;
      const body = {
        clientUploadId: randomUUID(),
        scope: {
          kind: "COMMUNITY",
          postType: "DISCUSSION",
          languageId: language,
          visibility: "PUBLIC",
        },
        filename: "source.txt",
        mime: "text/plain",
        bytes: 3,
      };
      const draft = await new AttachmentInitiationRepository(
        pool,
        capabilities,
      ).initiate(user.id, body);
      if (!("id" in draft)) throw Error("unexpected bound fixture");
      raw = raw.split(root.inventory.attachments[0].id).join(draft.id);
      root = JSON.parse(raw) as typeof root;
      const sha256 = createHash("sha256").update("abc").digest("hex");
      Object.assign(root.inventory.attachments[0].initiation, body);
      root.inventory.attachments[0].ownerId = user.id;
      root.inventory.attachments[0].sourceSha256 = sha256;
      root.inventory.actors[0] = {
        id: user.id,
        sessionIds: [credentials.sessionId],
      };
      const thumbnail = root.objectIdentities.find(
        (o) => o.variant === "thumbnail",
      )!;
      const removed = new Set([
        thumbnail.objectId,
        thumbnail.putClaimId,
        thumbnail.supervisionId,
      ]);
      root.objectIdentities = root.objectIdentities.filter(
        (o) => o.variant !== "thumbnail",
      );
      root.allocationSlots = root.allocationSlots.filter(
        (s) => !removed.has(s.id),
      );
      for (const operation of root.operations) {
        operation.principal = {
          kind: "ACTOR",
          actorId: user.id,
          sessionId: credentials.sessionId,
        };
        operation.slotKeys = (operation.slotKeys as string[]).filter((k) =>
          root.allocationSlots.some((s) => s.key === k),
        );
        if (operation.kind === "INITIATE")
          operation.body = root.inventory.attachments[0].initiation;
        if (operation.kind === "UPLOAD")
          Object.assign(operation, {
            contentType: "text/plain",
            contentLength: 3,
            inputSha256: sha256,
            transmittedBytes: 3,
            charges: { ...(operation.charges as object), ingressBytes: 3 },
          });
      }
      const source = root.objectIdentities.find((o) => o.variant === "source")!,
        owner = randomUUID(),
        job = randomUUID();
      root.allocationSlots.push(
        {
          key: "upload-owner",
          operationKey: "upload",
          role: "UPLOAD_OWNER",
          id: owner,
          attachmentId: draft.id,
        },
        {
          key: "source-cleanup-job",
          operationKey: "source-cleanup",
          role: "CLEANUP_JOB",
          id: job,
          attachmentId: draft.id,
        },
      );
      (
        root.operations.find((o) => o.kind === "UPLOAD")!.slotKeys as string[]
      ).push("upload-owner");
      const now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime();
      root.envelope.notBefore = new Date(now - 1000).toISOString();
      root.envelope.expiresAt = new Date(
        now + (proofOptions.expiresInMs ?? 60000),
      ).toISOString();
      const literal = {
          ...root,
          internalCleanup: [
            {
              key: "source-cleanup",
              sourceOperationKey: "upload",
              attachmentId: draft.id,
              objectId: source.objectId,
              jobSlotKey: "source-cleanup-job",
            },
          ],
        },
        options = createPinnedPlanOptions(literal);
      options.nowMs = now;
      options.receipt.observedAt = new Date(now).toISOString();
      const declarations = validatePinnedDeclarations(options)!,
        lowered = lowerPinnedRequestPlan(declarations),
        p = lowered.prepared;
      await ledger.prepare(p);
      const tuple: ControlTuple = {
        runId: p.runId,
        activationId: p.activationId,
        sourceSha: p.sourceSha,
        manifestSha256: p.manifestSha256,
        service: "srv-dahnerh594qs73fp3420",
        branch: "dev",
        deploymentId: declarations.deploymentId,
        bootId: randomUUID(),
        notBefore: p.notBefore,
        expiresAt: p.expiresAt,
      };
      await controls.arm(tuple);
      await controls.storeReceipt(tuple, {
        service: tuple.service,
        branch: tuple.branch,
        sha: tuple.sourceSha,
        manifestSha256: tuple.manifestSha256,
        deploymentId: tuple.deploymentId,
        bootId: tuple.bootId,
        observedAt: (
          (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
        ).toISOString(),
        liveObserved: true,
        originalDisabledCommandObserved: true,
        allFourFlagsFalseObserved: true,
      });
      accounting = new RequestAccounting(
        ledger,
        await ledger.activateControlled(tuple),
        lowered.coarse,
      );
      binder = new SourceUploadPolicyBinding(
        declarations,
        lowered,
        accounting,
        ledger,
        executor,
      );
      const issue = jest.spyOn(executor, "issue"),
        authenticate = jest.spyOn(sessions, "authenticate");
      const state = async () => ({
        counters: (
          await db.pool.query(
            "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
            [p.runId],
          )
        ).rows[0].counters,
        operation: (
          await db.pool.query(
            "SELECT state FROM " +
              table("bound_operations") +
              " WHERE run_id=$1 AND policy_key=$2",
            [p.runId, "upload"],
          )
        ).rows,
        slots: (
          await db.pool.query(
            "SELECT role,id,state FROM " +
              table("slots") +
              " WHERE run_id=$1 AND operation_key=$2 ORDER BY role",
            [
              p.runId,
              lowered.policies.find((p) => p.policyKey === "upload")!
                .instances[0].instanceKey,
            ],
          )
        ).rows,
        jobs: (
          await db.pool.query(
            "SELECT id FROM attachment_cleanup_jobs WHERE attachment_id=$1",
            [draft.id],
          )
        ).rows,
      });
      return {
        app,
        close,
        expiresAt: p.expiresAt,
        retry: () => service.retryControlledRetirements(),
        originalReleased: () =>
          [...authorities.values()].every((a) => a.released),
        credentials,
        issue,
        authenticate,
        transport,
        source,
        owner,
        job,
        runId: p.runId,
        attachmentId: draft.id,
        url: "/api/v1/attachments/" + draft.id + "/content",
        state,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  it("uploads exact three-byte TEXT through native guards and one original planned supervised PUT", async () => {
    const f = await fixture();
    try {
      await request(f.app.getHttpServer())
        .put(f.url)
        .set("Authorization", "Bearer " + f.credentials.accessToken)
        .set("Content-Type", "text/plain")
        .send("abc")
        .expect(200)
        .expect(({ body }) => expect(body.data).toEqual({ state: "PENDING" }));
      expect(f.transport.putTemporary).not.toHaveBeenCalled();
      expect(f.transport.putSupervised).toHaveBeenCalledTimes(1);
      expect(f.issue).toHaveBeenCalledTimes(1);
      expect(f.authenticate.mock.calls.length).toBeGreaterThanOrEqual(3);
      const [handle, input] = f.transport.putSupervised.mock.calls[0];
      expect(handle.id).toBe(f.source.supervisionId);
      expect(input.locator).toEqual({
        attachmentId: f.attachmentId,
        objectId: f.source.objectId,
        attemptId: f.source.attemptId,
        kind: "source",
      });
      const state = await f.state();
      expect(state.counters).toMatchObject({
        authenticatedRequests: 1,
        ingressBytes: 3,
      });
      expect(state.operation).toEqual([{ state: "BOUND" }]);
      expect(state.slots).toHaveLength(5);
      expect(state.slots.every((s) => s.state === "BURNED")).toBe(true);
      expect(state.jobs).toEqual([]);
      const row = (
        await db.pool.query(
          "SELECT a.state,a.source_object_id,o.id,o.attempt_id,o.put_claim,o.put_supervision_id,o.sha256,o.byte_count FROM attachments a JOIN attachment_objects o ON o.id=a.source_object_id WHERE a.id=$1",
          [f.attachmentId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        state: "PENDING",
        source_object_id: f.source.objectId,
        id: f.source.objectId,
        attempt_id: f.source.attemptId,
        put_claim: f.source.putClaimId,
        put_supervision_id: f.source.supervisionId,
        sha256: createHash("sha256").update("abc").digest("hex"),
        byte_count: "3",
      });
      expect(state.slots.find((s) => s.role === "UPLOAD_OWNER")).toMatchObject({
        id: f.owner,
      });
      expect(
        (
          await db.pool.query(
            "SELECT state FROM " +
              table("internal_cleanup_entries") +
              " WHERE run_id=$1",
            [f.runId],
          )
        ).rows,
      ).toEqual([{ state: "AVAILABLE" }]);
    } finally {
      await f.close();
    }
  }, 30000);
  it.each(["token", "query", "csrf", "header"])(
    "charges conservative ingress but starts no producer on %s mismatch",
    async (mode) => {
      const f = await fixture();
      try {
        let call = request(f.app.getHttpServer()).put(
          f.url + (mode === "query" ? "?unexpected=1" : ""),
        );
        call = call
          .set(
            "Authorization",
            mode === "token"
              ? "Bearer invalid"
              : "Bearer " + f.credentials.accessToken,
          )
          .set(
            "Content-Type",
            mode === "header" ? "application/octet-stream" : "text/plain",
          );
        if (mode === "csrf")
          call = call.set("Cookie", "cdn_refresh=synthetic-present-cookie");
        await call
          .send("abc")
          .expect(
            mode === "token"
              ? 401
              : mode === "query"
                ? 400
                : mode === "csrf"
                  ? 403
                  : 503,
          );
        expect(f.issue).not.toHaveBeenCalled();
        expect(f.transport.putSupervised).not.toHaveBeenCalled();
        expect(f.transport.supervisePut).not.toHaveBeenCalled();
        const state = await f.state();
        expect(state.counters).toMatchObject({
          authenticatedRequests: 1,
          ingressBytes: 3,
        });
        expect(state.operation).toEqual([{ state: "AVAILABLE" }]);
        expect(state.slots.every((s) => s.state === "AVAILABLE")).toBe(true);
        expect(state.jobs).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );
  it("rejects the controlled context at the ordinary four-false runtime after binding", async () => {
    const f = await fixture(true);
    try {
      await request(f.app.getHttpServer())
        .put(f.url)
        .set("Authorization", "Bearer " + f.credentials.accessToken)
        .set("Content-Type", "text/plain")
        .send("abc")
        .expect(503);
      expect(f.issue).toHaveBeenCalledTimes(1);
      expect(f.transport.putSupervised).not.toHaveBeenCalled();
      const state = await f.state();
      expect(state.operation).toEqual([{ state: "BOUND" }]);
      expect(state.counters).toMatchObject({
        authenticatedRequests: 1,
        ingressBytes: 3,
      });
      expect(state.slots.every((s) => s.state === "BURNED")).toBe(true);
      expect(state.jobs).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);
  it.each(["lost-ack", "lost-inspection-ack", "natural-expiry"] as const)(
    "preserves committed PENDING custody and no DTO after %s, with original-only manual retry",
    async (mode) => {
      let pendingWrite = false,
        pendingCommitSeen = false,
        inspectionAckLost = false,
        expiry = "";
      const f = await fixture(false, {
        expiresInMs: mode === "natural-expiry" ? 14000 : 60000,
        send: async (c, sql, values) => {
          const result = await c.query(sql, values);
          if (/UPDATE attachments SET state='PENDING'/.test(sql))
            pendingWrite = true;
          if (sql === "COMMIT" && pendingWrite && !pendingCommitSeen) {
            pendingCommitSeen = true;
            if (mode !== "natural-expiry")
              throw Error("synthetic lost PENDING acknowledgement");
            const remaining = Number(
              (
                await c.query(
                  "SELECT EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())*1000 remaining",
                  [expiry],
                )
              ).rows[0].remaining,
            );
            await new Promise((r) =>
              setTimeout(r, Math.max(0, remaining) + 25),
            );
          } else if (
            sql === "COMMIT" &&
            pendingCommitSeen &&
            mode === "lost-inspection-ack" &&
            !inspectionAckLost
          ) {
            inspectionAckLost = true;
            throw Error("synthetic lost custody inspection acknowledgement");
          }
          return result;
        },
      });
      expiry = f.expiresAt;
      try {
        const response = await request(f.app.getHttpServer())
          .put(f.url)
          .set("Authorization", "Bearer " + f.credentials.accessToken)
          .set("Content-Type", "text/plain")
          .send("abc")
          .expect(503);
        expect(response.body.success).toBe(false);
        expect(response.body.data).toBeUndefined();
        expect(pendingCommitSeen).toBe(true);
        expect(
          (
            await db.pool.query(
              "SELECT state,lease_owner,upload_slot_held,pending_slot_held,source_object_id FROM attachments WHERE id=$1",
              [f.attachmentId],
            )
          ).rows[0],
        ).toMatchObject({
          state: "PENDING",
          lease_owner: null,
          upload_slot_held: false,
          pending_slot_held: true,
          source_object_id: f.source.objectId,
        });
        expect((await f.state()).jobs).toEqual([]);
        expect(await f.retry()).toEqual({ remaining: 0 });
        expect(inspectionAckLost).toBe(mode === "lost-inspection-ack");
        expect(f.originalReleased()).toBe(true);
        expect(await f.retry()).toEqual({ remaining: 0 });
        expect(f.transport.putSupervised).toHaveBeenCalledTimes(1);
        const state = await f.state();
        expect(state.jobs).toEqual([]);
        expect(state.counters).toMatchObject({
          authenticatedRequests: 1,
          ingressBytes: 3,
        });
        expect(
          (
            await db.pool.query(
              "SELECT state FROM " +
                table("internal_cleanup_entries") +
                " WHERE run_id=$1",
              [f.runId],
            )
          ).rows,
        ).toEqual([{ state: "AVAILABLE" }]);
      } finally {
        await f.close();
      }
    },
    35000,
  );
});
