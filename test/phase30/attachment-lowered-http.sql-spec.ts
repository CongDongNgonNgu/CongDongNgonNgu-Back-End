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
import {
  createPinnedPlanRoot,
  createPinnedPlanOptions,
} from "./pinned-plan-fixture";
import { validatePinnedDeclarations } from "../../src/attachments/test-admission/pinned-declarations";
import { lowerPinnedRequestPlan } from "../../src/attachments/test-admission/request-plan-lowering";
import { ReadPolicyBinding } from "../../src/attachments/test-admission/read-policy-binding";
import {
  ATTACHMENT_REQUEST_POLICY,
  type AttachmentRequestPolicy,
} from "../../src/attachments/http/attachment-request-policy.port";
import type { RequestHandler } from "express";

/** Actual HTTP/parser/native-session + durable SQL accounting proof only.
 * Control receipt/identity rows here are synthetic fixtures, never deployment evidence.
 * Actual AttachmentRuntime remains four-false, no provider/processor/domain execution. */
describe("pinned lowering to native-guard matched binding in owned SQL schema", () => {
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
  it("uses the pinned lowered graph after native auth and exhausts distinct READ instances without granting product execution", async () => {
    let accounting: RequestAccounting | undefined,
      binder: ReadPolicyBinding | undefined;
    const identity = new InMemoryIdentityRepository();
    const config = new ConfigService({
      app: { environment: "test", corsOrigins: ["http://localhost:5173"] },
      auth: {
        accessSecret: "synthetic-lowered-http-access-secret-32bytes",
        refreshSecret: "synthetic-lowered-http-refresh-secret-32bytes",
        accessTtlSeconds: 600,
        refreshTtlSeconds: 3600,
        refreshCookieName: "cdn_refresh",
        csrfCookieName: "cdn_csrf",
      },
      attachments: { enabled: false, image: false, video: false, text: false },
      swagger: { enabled: false },
    });
    const runtime = new AttachmentRuntime(config);
    const gate: AttachmentRequestPolicy = {
      bind: (req, action) => {
        if (!binder) throw Error("proof not ready");
        return binder.bind(req, action);
      },
    };
    const module = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: IDENTITY_REPOSITORY, useValue: identity },
        SessionService,
        AccessTokenService,
        OptionalAccessTokenGuard,
        { provide: ATTACHMENT_HTTP_APPLICATION, useValue: runtime },
        { provide: ATTACHMENT_REQUEST_POLICY, useValue: gate },
      ],
    }).compile();
    const app = module.createNestApplication();
    const middleware: RequestHandler = (req, res, next) => {
      if (!accounting) throw Error("proof not ready");
      return accounting.middleware(req, res, next);
    };
    configureApp(app, { attachmentRequestAccounting: middleware });
    await app.init();
    try {
      const user = await identity.createUser({
        email: randomUUID() + "@phase30.invalid",
        displayName: "Synthetic pinned native matcher",
        passwordHash: null,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      });
      const credentials = await app
        .get(SessionService)
        .issue(user, { append: () => {} } as unknown as Response);
      const now = (
        (await db.pool.query("SELECT clock_timestamp() t")).rows[0].t as Date
      ).getTime();
      const root = createPinnedPlanRoot();
      root.envelope.runId = randomUUID();
      root.envelope.activationId = randomUUID();
      root.envelope.notBefore = new Date(now - 1000).toISOString();
      root.envelope.expiresAt = new Date(now + 60000).toISOString();
      root.inventory.actors[0] = {
        id: user.id,
        sessionIds: [credentials.sessionId],
      };
      root.inventory.attachments[0].ownerId = user.id;
      for (const op of root.operations)
        op.principal = {
          kind: "ACTOR",
          actorId: user.id,
          sessionId: credentials.sessionId,
        };
      const charges = {
        authenticatedRequests: 1,
        anonymousRequests: 0,
        ingressBytes: 0,
        authenticatedEgressBytes: 4194304,
        anonymousEgressBytes: 0,
        processingAttempts: 0,
      };
      root.operations.push({
        key: "read",
        kind: "READ",
        attachmentId: root.inventory.attachments[0].id,
        principal: {
          kind: "ACTOR",
          actorId: user.id,
          sessionId: credentials.sessionId,
        },
        assertion: "NORMAL_AUTHORIZATION",
        attemptKeys: ["declared-read-a", "declared-read-b"],
        charges,
        slotKeys: [],
        method: "GET",
        variant: "normalized",
        range: null,
      } as never);
      const options = createPinnedPlanOptions(root);
      options.nowMs = now;
      options.receipt.observedAt = new Date(now).toISOString();
      const declarations = validatePinnedDeclarations(options)!;
      const lowered = lowerPinnedRequestPlan(declarations);
      await ledger.prepare(lowered.prepared);
      const p = lowered.prepared;
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
      const active = await ledger.activateControlled(tuple);
      accounting = new RequestAccounting(ledger, active, lowered.coarse);
      binder = new ReadPolicyBinding(declarations, lowered, accounting, ledger);
      const path =
        "/api/v1/attachments/" + root.inventory.attachments[0].id + "/content";
      await request(app.getHttpServer())
        .get(path)
        .set("Authorization", "Bearer " + credentials.accessToken)
        .expect(503);
      const rows = async () =>
        (
          await db.pool.query(
            "SELECT policy_attempt_key,state FROM " +
              table("bound_operations") +
              " WHERE run_id=$1 AND policy_key='read' ORDER BY policy_attempt_key",
            [p.runId],
          )
        ).rows;
      expect(await rows()).toEqual([
        { policy_attempt_key: "declared-read-a", state: "BOUND" },
        { policy_attempt_key: "declared-read-b", state: "AVAILABLE" },
      ]);
      await request(app.getHttpServer())
        .get(path)
        .set("Authorization", "Bearer " + credentials.accessToken)
        .expect(503);
      expect((await rows()).every((r) => r.state === "BOUND")).toBe(true);
      await request(app.getHttpServer())
        .get(path)
        .set("Authorization", "Bearer " + credentials.accessToken)
        .expect(503);
      const counters = (
        await db.pool.query(
          "SELECT counters FROM " + table("runs") + " WHERE run_id=$1",
          [p.runId],
        )
      ).rows[0].counters;
      expect(counters).toMatchObject({
        authenticatedRequests: 2,
        authenticatedEgressBytes: 8388608,
        processingAttempts: 0,
      });
      expect(
        (
          await db.pool.query(
            "SELECT DISTINCT state FROM " + table("slots") + " WHERE run_id=$1",
            [p.runId],
          )
        ).rows,
      ).toEqual([{ state: "AVAILABLE" }]);
    } finally {
      await app.close();
    }
  }, 30000);
});
