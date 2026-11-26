import { createHash } from "node:crypto";
import {
  validatePinnedDeclarations,
  type PinnedDeclarations,
} from "../../src/attachments/test-admission/pinned-declarations";
import type { ActivationInputs } from "../../src/attachments/test-admission/guard";
const id = (n: number) =>
  n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const SHA = "a".repeat(40),
  DEP = "dep-synthetic-declarations";
const charges = () => ({
  authenticatedRequests: 1,
  anonymousRequests: 0,
  ingressBytes: 0,
  authenticatedEgressBytes: 0,
  anonymousEgressBytes: 0,
  processingAttempts: 0,
});
export function createPinnedPlanRoot() {
  const envelope = {
    schema: 1,
    runId: id(1),
    activationId: id(2),
    notBefore: "2026-11-25T00:00:00.000Z",
    expiresAt: "2026-11-25T00:10:00.000Z",
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
  const initiation = {
    clientUploadId: id(5),
    scope: {
      kind: "COMMUNITY",
      postType: "DISCUSSION",
      languageId: id(6),
      visibility: "PUBLIC",
    },
    filename: "a.jpg",
    mime: "image/jpeg",
    bytes: 100,
  };
  const inventory = {
    actors: [{ id: id(3), sessionIds: [id(4)] }],
    attachments: [
      {
        id: id(7),
        ownerId: id(3),
        generation: null,
        parent: { kind: "COMMUNITY", postId: id(8) },
        initiation,
        sourceSha256: "b".repeat(64),
      },
    ],
  };
  const principal = { kind: "ACTOR", actorId: id(3), sessionId: id(4) };
  const operation = (kind: string, key: string): Record<string, unknown> => ({
    kind,
    key,
    attachmentId: id(7),
    principal: { ...principal },
    assertion: "NORMAL_AUTHORIZATION",
    attemptKeys: [key + "-attempt"],
    charges: charges(),
    slotKeys: [] as string[],
  });
  const operations = [
    { ...operation("INITIATE", "init"), body: initiation },
    {
      ...operation("UPLOAD", "upload"),
      contentType: "image/jpeg",
      contentLength: 100,
      inputSha256: "b".repeat(64),
      transmittedBytes: 100,
      case: "COMPLETE",
      charges: { ...charges(), ingressBytes: 100 },
    },
    {
      ...operation("FINALIZE", "finalize"),
      charges: { ...charges(), processingAttempts: 1 },
    },
  ] as Record<string, unknown>[];
  const allocationSlots: {
      key: string;
      operationKey: string;
      role: string;
      id: string;
      attachmentId: string;
    }[] = [],
    objectIdentities: {
      attachmentId: string;
      variant: string;
      objectId: string;
      attemptId: string;
      putClaimId: string;
      supervisionId: string;
      operationKey: string;
    }[] = [];
  let next = 100;
  const add = (role: string, operationKey: string, fixed?: string) => {
    const identity = fixed ?? id(next++),
      key = "slot-" + identity.slice(0, 8);
    allocationSlots.push({
      key,
      operationKey,
      role,
      id: identity,
      attachmentId: id(7),
    });
    (operations.find((o) => o.key === operationKey)!.slotKeys as string[]).push(
      key,
    );
    return identity;
  };
  add("ATTACHMENT", "init", id(7));
  const sourceAttempt = add("SOURCE_ATTEMPT", "upload"),
    derivativeAttempt = add("DERIVATIVE_ATTEMPT", "finalize");
  for (const variant of ["source", "normalized", "thumbnail"]) {
    const key = variant === "source" ? "upload" : "finalize";
    objectIdentities.push({
      attachmentId: id(7),
      variant,
      operationKey: key,
      attemptId: variant === "source" ? sourceAttempt : derivativeAttempt,
      objectId: add(
        variant === "source"
          ? "SOURCE_OBJECT"
          : variant === "normalized"
            ? "NORMALIZED_OBJECT"
            : "THUMBNAIL_OBJECT",
        key,
      ),
      putClaimId: add("PUT_CLAIM", key),
      supervisionId: add("PUT_SUPERVISION", key),
    });
  }
  return {
    schema: 1,
    envelope,
    inventory,
    operations,
    allocationSlots,
    objectIdentities,
  };
}
export function createPinnedPlanOptions(
  value: unknown = createPinnedPlanRoot(),
) {
  const manifest = Buffer.from(JSON.stringify(value));
  return {
    activation: {
      expectedSourceSha: SHA,
      expectedManifestSha256: createHash("sha256")
        .update(manifest)
        .digest("hex"),
      expectedDeploymentId: DEP,
    },
    env: {
      NODE_ENV: "test",
      RENDER_GIT_BRANCH: "dev",
      RENDER_GIT_COMMIT: SHA,
      RENDER_SERVICE_ID: "srv-dahnerh594qs73fp3420",
      ATTACHMENTS_ENABLED: "false",
      ATTACHMENTS_IMAGE_ENABLED: "false",
      ATTACHMENTS_VIDEO_ENABLED: "false",
      ATTACHMENTS_TEXT_ENABLED: "false",
    },
    config: {
      environment: "test",
      attachments: { enabled: false, image: false, video: false, text: false },
    },
    platform: "linux",
    arch: "x64",
    execArgv: [] as string[],
    manifest,
    receipt: {
      service: "srv-dahnerh594qs73fp3420",
      branch: "dev",
      sha: SHA,
      deploymentId: DEP,
      observedAt: "2026-11-25T00:01:00.000Z",
    },
    nowMs: Date.parse("2026-11-25T00:02:00.000Z"),
  };
}

export function createPinnedPlanFixture(
  nowMs: number,
  readAttempts = 2,
): {
  declarations: PinnedDeclarations;
  options: ActivationInputs;
  readPolicyKey: string;
} {
  const value = createPinnedPlanRoot();
  value.envelope.notBefore = new Date(nowMs - 60000).toISOString();
  value.envelope.expiresAt = new Date(nowMs + 540000).toISOString();
  if (readAttempts > 0)
    value.operations.push({
      kind: "READ",
      key: "read",
      attachmentId: id(7),
      principal: { kind: "ACTOR", actorId: id(3), sessionId: id(4) },
      assertion: "NORMAL_AUTHORIZATION",
      attemptKeys: Array.from(
        { length: readAttempts },
        (_, i) => "read-attempt-" + i,
      ),
      charges: { ...charges(), authenticatedEgressBytes: 4194304 },
      slotKeys: [],
      method: "GET",
      variant: "normalized",
      range: null,
    });
  const options = createPinnedPlanOptions(value);
  options.nowMs = nowMs;
  options.receipt.observedAt = new Date(nowMs - 30000).toISOString();
  const declarations = validatePinnedDeclarations(options);
  if (!declarations) throw Error("PINNED_PLAN_FIXTURE");
  return { declarations, options, readPolicyKey: "read" };
}
