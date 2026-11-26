import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import type { INestApplication } from "@nestjs/common";
import type { Response } from "express";
import request from "supertest";
import { SqlHarness } from "../phase22/sql-harness";
import {
  RunLedger,
  RUN_LIMITS,
  type PreparedRun,
} from "../../src/attachments/test-admission/run-ledger";
import { RUN_LEDGER_DDL } from "../../src/attachments/test-admission/run-ledger-schema";
import { ACTIVATION_CONTROL_DDL } from "../../src/attachments/test-admission/activation-control-schema";
import {
  ActivationControlRepository,
  type ControlTuple,
} from "../../src/attachments/test-admission/activation-control";
import { compileCoarseRequestPlan } from "../../src/attachments/test-admission/coarse-request-plan";
import { RequestAccounting } from "../../src/attachments/test-admission/request-accounting";
import type { RequestCatalogue } from "../../src/attachments/test-admission/request-catalogue";
import type { ActivationEnvelope } from "../../src/attachments/test-admission/guard";
import {
  AttachmentController,
  ATTACHMENT_HTTP_APPLICATION,
} from "../../src/attachments/http/attachment.controller";
import { AttachmentRuntime } from "../../src/attachments/attachment-runtime";
import { SessionService } from "../../src/auth/session/session.service";
import { AccessTokenService } from "../../src/auth/crypto/access-token";
import { OptionalAccessTokenGuard } from "../../src/community/optional-access-token.guard";
import { IDENTITY_REPOSITORY } from "../../src/identity/identity.module";
import { InMemoryIdentityRepository } from "../../src/identity/identity.repository";
import { configureApp } from "../../src/app.setup";

/** Actual HTTP/parser/native-session + durable SQL accounting proof only.
 * Control receipt/identity rows here are synthetic fixtures, never deployment evidence.
 * Actual AttachmentRuntime remains four-false, no provider/processor/domain execution. */
describe("pre-parser Nest HTTP accounting in exact owned disposable SQL schema", () => {
  const db = new SqlHarness();
  let ledger: RunLedger;
  let controls: ActivationControlRepository;
  const base = "/api/v1/attachments";
  const attachmentId = randomUUID();
  beforeAll(async () => {
    await db.open();
    if (!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))
      throw Error("unsafe proof schema");
    await db.pool.query(
      RUN_LEDGER_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    await db.pool.query(
      ACTIVATION_CONTROL_DDL.replace(/phase30_test_execution/g, db.schema),
    );
    const scoped = {
      connect: async () => {
        const c = await db.pool.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            c.query(sql.replace(/phase30_test_execution/g, db.schema), values),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    ledger = new RunLedger(scoped);
    controls = new ActivationControlRepository(scoped);
  }, 30000);
  afterAll(async () => db.close());
  const table = (name: string) => '"' + db.schema + '".' + name;
  async function accounting(expiresInMs = 60000) {
    const now = (
      (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
    ).getTime();
    const envelope: ActivationEnvelope = {
      schema: 1,
      runId: randomUUID(),
      activationId: randomUUID(),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      budgets: {
        durationMs: 600000,
        attachments: 4,
        videos: 1,
        declaredBytes: 16777216,
        authenticatedRequests: 120,
        anonymousRequests: 20,
        ingressBytes: 33554432,
        authenticatedEgressBytes: 67108864,
        anonymousEgressBytes: 16777216,
        processingAttempts: 4,
        processingConcurrency: 1,
      },
    };
    const group = (
      method: "POST" | "HEAD",
      path: string,
      authClass: "AUTH" | "ANON",
      attemptCount: number,
    ) => ({
      method,
      path,
      authClass,
      ingressBytes: method === "POST" ? 32 : 0,
      egressBytes: method === "HEAD" ? 4096 : 0,
      attemptCount,
      policies: [
        {
          operationKey: authClass.toLowerCase() + "-" + method.toLowerCase(),
          attemptKeys: Array.from(
            { length: attemptCount },
            (_, i) =>
              "policy-" +
              authClass.toLowerCase() +
              "-" +
              method.toLowerCase() +
              "-" +
              i,
          ),
        },
      ],
    });
    const catalogue: RequestCatalogue = {
      groups: [
        group("POST", base, "AUTH", 4),
        group("HEAD", base + "/" + attachmentId + "/content", "AUTH", 2),
        group("HEAD", base + "/" + attachmentId + "/content", "ANON", 2),
      ],
      totals: {
        authenticatedRequests: 6,
        anonymousRequests: 2,
        ingressBytes: 128,
        authenticatedEgressBytes: 8192,
        anonymousEgressBytes: 8192,
      },
    };
    const compiled = compileCoarseRequestPlan(catalogue, envelope);
    const plan: PreparedRun = {
      runId: envelope.runId,
      activationId: envelope.activationId,
      manifestSha256: createHash("sha256")
        .update(JSON.stringify({ envelope, catalogue }))
        .digest("hex"),
      sourceSha: "b".repeat(40),
      notBefore: envelope.notBefore,
      expiresAt: envelope.expiresAt,
      limits: { ...RUN_LIMITS },
      slots: [
        {
          key: "proof.unused-source",
          operationKey: "proof.unused",
          role: "SOURCE_OBJECT",
          id: randomUUID(),
          attachmentId,
        },
      ],
      requests: compiled.requests,
      activationControlRequired: true,
    };
    await ledger.prepare(plan);
    const tuple: ControlTuple = {
      runId: plan.runId,
      activationId: plan.activationId,
      sourceSha: plan.sourceSha,
      manifestSha256: plan.manifestSha256,
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      deploymentId: "dep-synthetic-http-sql-proof",
      bootId: randomUUID(),
      notBefore: plan.notBefore,
      expiresAt: plan.expiresAt,
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
    const active = await ledger.activateControlled(tuple);
    return {
      runId: plan.runId,
      expiresAt: plan.expiresAt,
      accounting: new RequestAccounting(ledger, active, compiled),
    };
  }
  async function application(accounting?: RequestAccounting) {
    const identity = new InMemoryIdentityRepository();
    const config = new ConfigService({
      app: { environment: "test", corsOrigins: ["http://localhost:5173"] },
      auth: {
        accessSecret: "synthetic-http-proof-access-key-32-bytes",
        refreshSecret: "synthetic-http-proof-refresh-key-32-bytes",
        accessTtlSeconds: 600,
        refreshTtlSeconds: 3600,
        refreshCookieName: "cdn_refresh",
        csrfCookieName: "cdn_csrf",
      },
      attachments: { enabled: false, image: false, video: false, text: false },
      swagger: { enabled: false },
    });
    const runtime = new AttachmentRuntime(config);
    const module = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: IDENTITY_REPOSITORY, useValue: identity },
        SessionService,
        AccessTokenService,
        OptionalAccessTokenGuard,
        { provide: ATTACHMENT_HTTP_APPLICATION, useValue: runtime },
      ],
    }).compile();
    const app = module.createNestApplication();
    configureApp(app, { attachmentRequestAccounting: accounting?.middleware });
    await app.init();
    const user = await identity.createUser({
      email: randomUUID() + "@phase30.invalid",
      displayName: "Synthetic accounting proof",
      passwordHash: null,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    const token = (
      await app
        .get(SessionService)
        .issue(user, { append: () => {} } as unknown as Response)
    ).accessToken;
    return { app, token };
  }
  async function counters(runId: string) {
    return (
      await db.pool.query(
        "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
        [runId],
      )
    ).rows[0].counters;
  }
  it("commits coarse charges before malformed JSON and native auth failures and never refunds", async () => {
    const context = await accounting();
    const { app, token } = await application(context.accounting);
    try {
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "application/json")
        .send("{")
        .expect("Cache-Control", "private, no-store")
        .expect("Vary", /Authorization/)
        .expect("X-Content-Type-Options", "nosniff")
        .expect(400);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 1,
        ingressBytes: 32,
      });
      await request(app.getHttpServer()).post(base).send({}).expect(401);
      await request(app.getHttpServer())
        .post(base)
        .set("Authorization", "Bearer invalid")
        .send({})
        .expect(401);
      await request(app.getHttpServer())
        .post(base)
        .set("Authorization", "Bearer " + token)
        .send({})
        .expect(503);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 4,
        ingressBytes: 128,
      });
      await request(app.getHttpServer()).post(base).send({}).expect(503);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 4,
        ingressBytes: 128,
        processingAttempts: 0,
      });
      expect(
        (
          await db.pool.query(
            "SELECT DISTINCT state FROM " + table("slots") + " WHERE run_id=$1",
            [context.runId],
          )
        ).rows,
      ).toEqual([{ state: "AVAILABLE" }]);
    } finally {
      await app.close();
    }
  }, 30000);
  it("charges optional reads by supplied credentials, not outcome/query, and denies aliases/nonfixtures", async () => {
    const context = await accounting();
    const { app, token } = await application(context.accounting);
    const path = base + "/" + attachmentId + "/content";
    try {
      await request(app.getHttpServer()).head(path).expect(503);
      await request(app.getHttpServer())
        .head(path)
        .set("Authorization", "Bearer invalid")
        .expect(401);
      await request(app.getHttpServer())
        .head(path + "?unexpected=1")
        .set("Authorization", "Bearer " + token)
        .expect(400);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 2,
        anonymousRequests: 1,
        authenticatedEgressBytes: 8192,
        anonymousEgressBytes: 4096,
      });
      await request(app.getHttpServer())
        .head(base + "/" + randomUUID() + "/content")
        .expect(503);
      await request(app.getHttpServer())
        .head(base + "/" + attachmentId + "/%63ontent")
        .expect(503);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 2,
        anonymousRequests: 1,
        authenticatedEgressBytes: 8192,
        anonymousEgressBytes: 4096,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  it("serializes simultaneous HTTP reservations without overshooting slots or refunds", async () => {
    const context = await accounting();
    const { app } = await application(context.accounting);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(app.getHttpServer()).post(base).send({}),
        ),
      );
      const authenticated = results.filter((r) => r.status === 401).length;
      expect(results.every((r) => r.status === 401 || r.status === 503)).toBe(true);
      expect(authenticated).toBeGreaterThanOrEqual(1);
      expect(authenticated).toBeLessThanOrEqual(4);
      const durable = await counters(context.runId);
      // Lock timeouts may refuse capacity; uncertain commits may retain charges
      // despite a503. Neither outcome permits overshoot or a refund.
      expect(durable.authenticatedRequests).toBeGreaterThanOrEqual(authenticated);
      expect(durable.authenticatedRequests).toBeLessThanOrEqual(4);
      expect(durable.ingressBytes).toBe(32 * durable.authenticatedRequests);
      expect(durable.processingAttempts).toBe(0);
    } finally {
      await app.close();
    }
  }, 30000);
  it("checks database expiry before parsing new HTTP input without renewing the run", async () => {
    const context = await accounting(10000);
    const { app } = await application(context.accounting);
    try {
      await db.pool.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)",
        [context.expiresAt],
      );
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "application/json")
        .send("{")
        .expect(503);
      expect(await counters(context.runId)).toMatchObject({
        authenticatedRequests: 0,
        ingressBytes: 0,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  it("keeps ordinary four-false startup cold without injected accounting", async () => {
    const before = await db.pool.query(
      "SELECT count(*) n FROM " + table("request_attempts"),
    );
    const { app, token } = await application();
    try {
      await request(app.getHttpServer()).post(base).send({}).expect(401);
      await request(app.getHttpServer())
        .post(base)
        .set("Authorization", "Bearer " + token)
        .send({})
        .expect(503);
      expect(
        (
          await db.pool.query(
            "SELECT count(*) n FROM " + table("request_attempts"),
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await app.close();
    }
  });
});
