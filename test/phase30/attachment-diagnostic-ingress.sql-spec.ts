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
import { Controller, Post, Body } from "@nestjs/common";
import { request as nativeRequest } from "node:http";
import { createDiagnosticBodyParser } from "../../src/attachments/test-admission/diagnostic-body-parser";
import { DIAGNOSTIC_JSON_INGRESS_CAP as CAP } from "../../src/attachments/test-admission/diagnostic-ingress-policy";
@Controller("proof-json")
class OutsideProofController {
  @Post() echo(@Body() value: unknown) {
    return value ?? { notParsed: true };
  }
}

/** Actual HTTP/parser/native-session + durable SQL accounting proof only.
 * Control receipt/identity rows here are synthetic fixtures, never deployment evidence.
 * Actual AttachmentRuntime remains four-false, no provider/processor/domain execution. */
describe("bounded diagnostic parser with committed SQL reservations", () => {
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
      ingressBytes: method === "POST" ? CAP : 0,
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
        {
          method: "PUT",
          path: base + "/" + attachmentId + "/content",
          authClass: "AUTH",
          ingressBytes: 1024,
          egressBytes: 0,
          attemptCount: 2,
          policies: [
            { operationKey: "raw-put", attemptKeys: ["raw-a", "raw-b"] },
          ],
        },
        group("HEAD", base + "/" + attachmentId + "/content", "AUTH", 2),
        group("HEAD", base + "/" + attachmentId + "/content", "ANON", 2),
      ],
      totals: {
        authenticatedRequests: 8,
        anonymousRequests: 2,
        ingressBytes: 4 * CAP + 2048,
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
      controllers: [AttachmentController, OutsideProofController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: IDENTITY_REPOSITORY, useValue: identity },
        SessionService,
        AccessTokenService,
        OptionalAccessTokenGuard,
        { provide: ATTACHMENT_HTTP_APPLICATION, useValue: runtime },
      ],
    }).compile();
    const app = module.createNestApplication({ bodyParser: false });
    const observed: Array<{ body: unknown; ended: boolean }> = [];
    const parser = accounting
      ? createDiagnosticBodyParser(accounting)
      : undefined;
    configureApp(app, {
      attachmentRequestAccounting: accounting?.middleware,
      attachmentBodyParser: parser
        ? (req, res, next) =>
            parser(req, res, (error) => {
              if (req.method === "PUT")
                observed.push({ body: req.body, ended: req.readableEnded });
              next(error);
            })
        : undefined,
    });
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
    return { app, token, observed };
  }
  async function counters(runId: string) {
    return (
      await db.pool.query(
        "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
        [runId],
      )
    ).rows[0].counters;
  }

  const payload = (bytes: number) => '{"x":"' + "a".repeat(bytes - 8) + '"}';
  async function raw(
    app: INestApplication,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ) {
    if (!app.getHttpServer().listening) await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    return new Promise<{ status: number; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const call = nativeRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            method,
            path,
            headers,
            agent: false,
          },
          (res) => {
            res.resume();
            res.once("end", () =>
              resolve({ status: res.statusCode!, headers: res.headers }),
            );
            res.once("error", reject);
          },
        );
        call.setTimeout(10000, () => call.destroy(Error("proof HTTP timeout")));
        call.once("error", reject);
        call.end(body);
      },
    );
  }
  it("charges before below/at/above JSON cap and malformed parser outcomes", async () => {
    const f = await accounting(),
      { app } = await application(f.accounting);
    try {
      for (const bytes of [CAP - 1, CAP])
        await request(app.getHttpServer())
          .post(base)
          .set("Content-Type", "application/json")
          .send(payload(bytes))
          .expect(401);
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "application/json")
        .send(payload(CAP + 1))
        .expect(413)
        .expect("Connection", "close");
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "application/json")
        .send("{")
        .expect(400);
      expect(await counters(f.runId)).toMatchObject({
        authenticatedRequests: 4,
        ingressBytes: 4 * CAP,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  it("rejects diagnostic chunked/compressed/wrong-type JSON only after reservation", async () => {
    const f = await accounting(),
      { app } = await application(f.accounting);
    try {
      expect(
        (
          await raw(
            app,
            "POST",
            base,
            {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
            "{}",
          )
        ).status,
      ).toBe(400);
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "gzip")
        .send("{}")
        .expect(415)
        .expect("Connection", "close");
      await request(app.getHttpServer())
        .post(base)
        .set("Content-Type", "text/plain")
        .send("{}")
        .expect(415);
      expect(await counters(f.runId)).toMatchObject({
        authenticatedRequests: 3,
        ingressBytes: 3 * CAP,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  it("rejects framed zero-ingress HEAD bodies but preserves ordinary empty HEAD", async () => {
    const f = await accounting(),
      { app } = await application(f.accounting),
      path = base + "/" + attachmentId + "/content";
    try {
      const response = await raw(
        app,
        "HEAD",
        path,
        { "Content-Type": "application/json", "Content-Length": "1" },
        "x",
      );
      expect(response.status).toBe(400);
      expect(response.headers.connection).toBe("close");
      await request(app.getHttpServer()).head(path).expect(503);
      expect(await counters(f.runId)).toMatchObject({
        anonymousRequests: 2,
        anonymousEgressBytes: 8192,
        ingressBytes: 0,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  it("adds no raw PUT parser before native auth and preserves unrelated JSON parsing", async () => {
    const f = await accounting(),
      { app, observed } = await application(f.accounting);
    try {
      await request(app.getHttpServer())
        .put(base + "/" + attachmentId + "/content")
        .set("Content-Type", "application/json")
        .send("{")
        .expect(401);
      expect(observed).toEqual([{ body: undefined, ended: false }]);
      await request(app.getHttpServer())
        .post("/api/v1/proof-json")
        .send({ outside: 1 })
        .expect(201)
        .expect({ outside: 1 });
      expect(await counters(f.runId)).toMatchObject({
        authenticatedRequests: 1,
        ingressBytes: 1024,
      });
    } finally {
      await app.close();
    }
  }, 30000);
});
