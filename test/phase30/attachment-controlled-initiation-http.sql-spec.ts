import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import type { Response, RequestHandler } from "express";
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
import { InitiationPolicyBinding } from "../../src/attachments/test-admission/initiation-policy-binding";
import {
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "./pinned-plan-fixture";
import {
  AttachmentController,
  ATTACHMENT_HTTP_APPLICATION,
} from "../../src/attachments/http/attachment.controller";
import { ATTACHMENT_INITIATION_POLICY } from "../../src/attachments/http/attachment-initiation-policy.port";
import { AttachmentInitiationRepository } from "../../src/attachments/initiation/attachment-initiation-repository";
import { AttachmentReadService } from "../../src/attachments/service/attachment-read-service";
import { AttachmentRuntime } from "../../src/attachments/attachment-runtime";
import type { AttachmentStorage } from "../../src/attachments/storage/attachment-storage.port";
import type { ControlledInitiationContext } from "../../src/attachments/initiation/controlled-initiation.port";
import { SessionService } from "../../src/auth/session/session.service";
import { AccessTokenService } from "../../src/auth/crypto/access-token";
import { OptionalAccessTokenGuard } from "../../src/community/optional-access-token.guard";
import { IDENTITY_REPOSITORY } from "../../src/identity/identity.module";
import { InMemoryIdentityRepository } from "../../src/identity/identity.repository";
import { configureApp } from "../../src/app.setup";
/** Explicit native HTTP + owned SQL proof adapter only. Synthetic control receipts
 * are not deployment observations. The actual runtime stays four-false; no provider,
 * recovery worker or bootstrap activation is performed. */
describe("native guarded controlled INITIATE into exact planned SQL identity", () => {
  const db = new SqlHarness(),
    base = "/api/v1/attachments";
  let language: string;
  const table = (name: string) => '"' + db.schema + '".' + name;
  const scoped = (
    send?: (
      client: PoolClient,
      sql: string,
      values?: unknown[],
    ) => Promise<any>,
  ) =>
    ({
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            send
              ? send(
                  client,
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                )
              : client.query(
                  sql.replace(/phase30_test_execution/g, db.schema),
                  values,
                ),
          release: () => client.release(),
        };
      },
    }) as unknown as Pool;
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
  async function fixture(ordinary = false, retry = false, expireAfter?: 2 | 3) {
    let armed = false,
      commits = 0,
      expiry = "";
    const identity = new InMemoryIdentityRepository(),
      pool = scoped(async (c, sql, values) => {
        const result = await c.query(sql, values);
        if (
          armed &&
          sql === "COMMIT" &&
          ++commits === (expireAfter === undefined ? -1 : expireAfter + 2)
        ) {
          const remaining = Number(
            (
              await c.query(
                "SELECT EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())*1000 remaining",
                [expiry],
              )
            ).rows[0].remaining,
          );
          await new Promise((r) => setTimeout(r, Math.max(0, remaining) + 25));
        }
        return result;
      }),
      ledger = new RunLedger(pool),
      controls = new ActivationControlRepository(pool);
    const config = new ConfigService({
      app: { environment: "test", corsOrigins: ["http://localhost:5173"] },
      auth: {
        accessSecret: "synthetic-control-http-access-secret-32bytes",
        refreshSecret: "synthetic-control-http-refresh-secret-32bytes",
        accessTtlSeconds: 600,
        refreshTtlSeconds: 3600,
        refreshCookieName: "cdn_refresh",
        csrfCookieName: "cdn_csrf",
      },
      attachments: { enabled: false, image: false, video: false, text: false },
      swagger: { enabled: false },
    });
    const actualRuntime = new AttachmentRuntime(config);
    const storage = {
      head: () => {
        throw Error("provider forbidden");
      },
      get: () => {
        throw Error("provider forbidden");
      },
      put: () => {
        throw Error("provider forbidden");
      },
    } as unknown as AttachmentStorage;
    const service = new AttachmentReadService(pool, storage),
      repo = new AttachmentInitiationRepository(
        pool,
        { enabled: true, image: true, video: false, text: false },
        undefined,
        ledger,
      );
    let accounting: RequestAccounting | undefined,
      binder: InitiationPolicyBinding | undefined;
    const adapter = {
      initiate: (
        refresh: () => Promise<string | null>,
        input: unknown,
        context: ControlledInitiationContext,
      ) =>
        ordinary
          ? actualRuntime.initiate(refresh, input, context)
          : service.initiate(refresh, repo, input, context),
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
          provide: ATTACHMENT_INITIATION_POLICY,
          useValue: {
            bind: (
              req: Parameters<InitiationPolicyBinding["bind"]>[0],
              input: unknown,
              res: Response,
            ) => {
              if (!binder) throw Error("proof not ready");
              return binder.bind(req, input, res);
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
    const parser = createDiagnosticBodyParser({
      peekCandidate: (req) => accounting!.peekCandidate(req),
      peekBodyRemaining: (req) => accounting!.peekBodyRemaining(req),
    });
    configureApp(app, {
      attachmentRequestAccounting: middleware,
      attachmentBodyParser: parser,
    });
    await app.init();
    try {
      const user = await identity.createUser({
        email: randomUUID() + "@phase30.invalid",
        displayName: "Synthetic native controlled INITIATE",
        passwordHash: null,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      });
      await db.pool.query(
        "INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic native controlled INITIATE','ACTIVE',clock_timestamp())",
        [user.id, user.email],
      );
      const sessions = app.get(SessionService),
        credentials = await sessions.issue(user, {
          append: () => {},
        } as unknown as Response);
      const remap = new Map<string, string>();
      const raw = JSON.stringify(createPinnedPlanRoot()).replace(
        /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/g,
        (id) => {
          if (!remap.has(id)) remap.set(id, randomUUID());
          return remap.get(id)!;
        },
      );
      const root = JSON.parse(raw) as ReturnType<typeof createPinnedPlanRoot>,
        body = root.inventory.attachments[0].initiation;
      if (retry) {
        const init = root.operations.find((o) => o.kind === "INITIATE")!;
        init.attemptKeys = ["zzz-create", "aaa-replay"];
        init.creatorAttemptKey = "zzz-create";
      }
      body.scope.languageId = language;
      root.inventory.actors[0] = {
        id: user.id,
        sessionIds: [credentials.sessionId],
      };
      root.inventory.attachments[0].ownerId = user.id;
      for (const operation of root.operations) {
        operation.principal = {
          kind: "ACTOR",
          actorId: user.id,
          sessionId: credentials.sessionId,
        };
        if (operation.kind === "INITIATE") operation.body = body;
      }
      const now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime();
      root.envelope.notBefore = new Date(now - 1000).toISOString();
      root.envelope.expiresAt = new Date(
        now + (expireAfter ? 12000 : 60000),
      ).toISOString();
      const options = createPinnedPlanOptions(root);
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
      binder = new InitiationPolicyBinding(
        declarations,
        lowered,
        accounting,
        ledger,
      );
      const issue = jest.spyOn(ledger, "issueMatchedInitiationContext"),
        authenticate = jest.spyOn(sessions, "authenticate");
      const state = async () => ({
        run: (
          await db.pool.query(
            "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
            [p.runId],
          )
        ).rows[0].counters,
        operations: (
          await db.pool.query(
            "SELECT state FROM " +
              table("bound_operations") +
              " WHERE run_id=$1 AND policy_key=$2",
            [p.runId, "init"],
          )
        ).rows,
        attachments: (
          await db.pool.query(
            "SELECT id FROM attachments WHERE uploader_id=$1",
            [user.id],
          )
        ).rows,
      });
      // HTTP commits: reserve1, matched binding2, INITRATE3, DOMAIN4, readRATE5, projection6.
      expiry = p.expiresAt;
      armed = true;
      return {
        committedStages: () => commits,
        app,
        runId: p.runId,
        user,
        identity,
        sessions,
        credentials,
        body,
        plannedId: root.inventory.attachments[0].id,
        issue,
        authenticate,
        state,
      };
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  it("runs native guard and body policy through fresh SQL ACL to the exact planned INSERT", async () => {
    const f = await fixture();
    try {
      const result = await request(f.app.getHttpServer())
        .post(base)
        .set("Authorization", "Bearer " + f.credentials.accessToken)
        .send(f.body)
        .expect(201);
      expect(result.body.success).toBe(true);
      expect(result.body.data.id).toBe(f.plannedId);
      expect(f.issue).toHaveBeenCalledTimes(1);
      expect(f.authenticate.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(
        f.authenticate.mock.calls.every(
          ([token]) => token === f.credentials.accessToken,
        ),
      ).toBe(true);
      const state = await f.state();
      expect(state.attachments).toEqual([{ id: f.plannedId }]);
      expect(state.operations).toEqual([{ state: "BOUND" }]);
      expect(state.run).toMatchObject({
        authenticatedRequests: 1,
        ingressBytes: 102400,
      });
    } finally {
      await f.app.close();
    }
  }, 30000);
  it.each(["unauthorized", "malformed", "query", "csrf"])(
    "charges but issues no context on %s denial",
    async (mode) => {
      const f = await fixture();
      try {
        let call = request(f.app.getHttpServer()).post(
          base + (mode === "query" ? "?unexpected=1" : ""),
        );
        if (mode !== "unauthorized")
          call = call.set(
            "Authorization",
            "Bearer " + f.credentials.accessToken,
          );
        if (mode === "csrf")
          call = call.set("Cookie", "cdn_refresh=synthetic-present-cookie");
        call = call
          .set("Content-Type", "application/json")
          .send(mode === "malformed" ? "{" : JSON.stringify(f.body));
        await call.expect(
          mode === "unauthorized" ? 401 : mode === "csrf" ? 403 : 400,
        );
        expect(f.issue).not.toHaveBeenCalled();
        const state = await f.state();
        expect(state.attachments).toEqual([]);
        expect(state.operations).toEqual([{ state: "AVAILABLE" }]);
        expect(state.run).toMatchObject({
          authenticatedRequests: 1,
          ingressBytes: 102400,
        });
      } finally {
        await f.app.close();
      }
    },
    30000,
  );
  it.each(["actor", "session", "fingerprint"])(
    "retains the charge without binding changed %s",
    async (mode) => {
      const f = await fixture();
      try {
        let token = f.credentials.accessToken,
          body = f.body;
        if (mode === "session")
          token = (
            await f.sessions.issue(f.user, {
              append: () => {},
            } as unknown as Response)
          ).accessToken;
        if (mode === "actor") {
          const other = await f.identity.createUser({
            email: randomUUID() + "@phase30.invalid",
            displayName: "Different native actor",
            passwordHash: null,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
          });
          token = (
            await f.sessions.issue(other, {
              append: () => {},
            } as unknown as Response)
          ).accessToken;
        }
        if (mode === "fingerprint") body = { ...body, filename: "changed.jpg" };
        await request(f.app.getHttpServer())
          .post(base)
          .set("Authorization", "Bearer " + token)
          .send(body)
          .expect(503);
        expect(f.issue).not.toHaveBeenCalled();
        const state = await f.state();
        expect(state.attachments).toEqual([]);
        expect(state.operations).toEqual([{ state: "AVAILABLE" }]);
        expect(state.run).toMatchObject({
          authenticatedRequests: 1,
          ingressBytes: 102400,
        });
      } finally {
        await f.app.close();
      }
    },
    30000,
  );
  it("fails closed when a controlled context reaches the ordinary disabled runtime", async () => {
    const f = await fixture(true);
    try {
      await request(f.app.getHttpServer())
        .post(base)
        .set("Authorization", "Bearer " + f.credentials.accessToken)
        .send(f.body)
        .expect(503);
      expect(f.issue).toHaveBeenCalledTimes(1);
      const state = await f.state();
      expect(state.operations).toEqual([{ state: "BOUND" }]);
      expect(state.attachments).toEqual([]);
    } finally {
      await f.app.close();
    }
  }, 30000);
  it("replays a completed same-run native INITIATE with the same ID and no second product reservation", async () => {
    const f = await fixture(false, true);
    const productCounters = async () =>
      (
        await db.pool.query(
          "SELECT kind,action,used FROM attachment_quota_counters WHERE (kind='ACTOR' AND subject=$1 AND action IN ('bytes','initiate')) OR (kind='DEPLOYMENT' AND subject='congdongngonngu-test' AND action IN ('bytes','metadata')) ORDER BY kind,action,window_start",
          [f.user.id],
        )
      ).rows;
    const readCalls = async () =>
      Number(
        (
          await db.pool.query(
            "SELECT COALESCE(sum(used),0)::text n FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='read'",
            [f.user.id],
          )
        ).rows[0].n,
      );
    try {
      const initial = await productCounters();
      const send = () =>
        request(f.app.getHttpServer())
          .post(base)
          .set("Authorization", "Bearer " + f.credentials.accessToken)
          .send(f.body);
      const first = await send().expect(201);
      expect(first.body.data.id).toBe(f.plannedId);
      const before = await productCounters(),
        readsBefore = await readCalls();
      const second = await send().expect(201);
      expect(second.body.data.id).toBe(f.plannedId);
      expect(await productCounters()).toEqual(before);
      expect(before.filter((r) => r.action === "initiate")).toEqual([
        { kind: "ACTOR", action: "initiate", used: "1" },
      ]);
      expect(
        Number(
          before.find((r) => r.kind === "DEPLOYMENT" && r.action === "metadata")
            ?.used ?? 0,
        ) -
          Number(
            initial.find(
              (r) => r.kind === "DEPLOYMENT" && r.action === "metadata",
            )?.used ?? 0,
          ),
      ).toBe(1);
      expect(await readCalls()).toBe(readsBefore + 1);
      const state = await f.state();
      expect(state.attachments).toEqual([{ id: f.plannedId }]);
      expect(state.operations).toEqual([
        { state: "BOUND" },
        { state: "BOUND" },
      ]);
      expect(state.run).toMatchObject({
        authenticatedRequests: 2,
        ingressBytes: 204800,
      });
      const slots = (
        await db.pool.query(
          "SELECT id,state FROM " +
            table("slots") +
            " WHERE run_id=$1 AND role='ATTACHMENT'",
          [f.runId],
        )
      ).rows;
      expect(slots).toEqual([{ id: f.plannedId, state: "BURNED" }]);
      expect(f.issue).toHaveBeenCalledTimes(2);
      expect(f.authenticate.mock.calls.length).toBeGreaterThanOrEqual(6);
    } finally {
      await f.app.close();
    }
  }, 30000);
  it.each([2, 3] as const)(
    "denies native success after original expiry following controlled COMMIT%s",
    async (stage) => {
      const f = await fixture(false, false, stage);
      try {
        await request(f.app.getHttpServer())
          .post(base)
          .set("Authorization", "Bearer " + f.credentials.accessToken)
          .send(f.body)
          .expect(503);
        expect(f.committedStages()).toBe(stage + 2);
        const state = await f.state();
        expect(state.attachments).toEqual([{ id: f.plannedId }]);
        expect(state.operations).toEqual([{ state: "BOUND" }]);
        const reads = (
          await db.pool.query(
            "SELECT used FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1 AND action='read'",
            [f.user.id],
          )
        ).rows;
        expect(reads).toEqual(stage === 2 ? [] : [{ used: "1" }]);
      } finally {
        await f.app.close();
      }
    },
    30000,
  );
});
