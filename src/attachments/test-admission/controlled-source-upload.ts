import { AttachmentInitiationUnavailable } from "../initiation/attachment-initiation-repository";
import {
  AttachmentObjectLedger,
  type ControlledCleanupJob,
} from "../attachment-object-ledger";
import { AttachmentLifecycleLedger } from "../lifecycle/attachment-lifecycle-ledger";
import type { Pool, PoolClient } from "pg";
import type {
  BoundOperation,
  MatchedBoundOperation,
  ControlledActiveRun,
} from "./run-ledger";
import type { AttachmentPutClaim } from "../attachment-object-ledger";
import type {
  AttachmentPutSupervision,
  AttachmentStoredObject,
} from "../storage/attachment-storage.port";
import {
  createPlannedPutSupervisionIdentity,
  supervisionIdentity,
  createPutLocalClosure,
  captureSourcePutQuiescence,
  verifySourcePutQuiescence,
  type SourcePutQuiescence,
  verifyPutLocalClosure,
  verifyUnsentProof,
  originalPutSettlement,
  originalPutReceipt,
  type PlannedPutSupervisionIdentity,
} from "../storage/put-supervision-proof";
declare const contextBrand: unique symbol;
export interface ControlledSourceUploadContext {
  readonly [contextBrand]: true;
}
export interface SourceUploadAccess {
  readonly ids: Readonly<{
    uploadOwner: string;
    objectId: string;
    attemptId: string;
    claimId: string;
    supervisionId: string;
  }>;
  readonly supervisionIdentity: PlannedPutSupervisionIdentity;
  readonly signal: AbortSignal;
  readonly sha256: string;
  readonly initiationFingerprint: string;
  assertForward(): void;
  /** Trusted existing receipt SQL; retains its exact settled version only after acknowledged COMMIT. */
  recordSourceReceipt<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Called only after the real bounded upload/spool callback has completely closed. */
  captureQuiescence(closed: () => Promise<void>): Promise<void>;
  publishPending<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Cleanup-only historical adoption; never renews forward authority or returns a DTO. */
  reconcilePending(): Promise<boolean>;
  terminalize(
    closed: () => Promise<void>,
    settleWithoutObject: boolean,
  ): Promise<void>;
  stage<T>(
    work: (client: PoolClient, fresh: () => Promise<void>) => Promise<T>,
    beforeCommit?: () => void,
  ): Promise<T>;
  registerClaim(
    claim: AttachmentPutClaim,
    handle: AttachmentPutSupervision,
  ): void;
  retire(
    claim: AttachmentPutClaim,
    handle: AttachmentPutSupervision,
    closed: () => Promise<void>,
    observed?: AttachmentStoredObject,
  ): Promise<void>;
}

const fail = (): never => {
  throw new AttachmentInitiationUnavailable();
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
function data(v: unknown, names: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
    Reflect.ownKeys(v).length !== names.length ||
    Reflect.ownKeys(v).some((k) => typeof k !== "string" || !names.includes(k))
  )
    return fail();
  const out: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(v, name);
    if (!d || !d.enumerable || !("value" in d)) return fail();
    out[name] = d.value;
  }
  return out;
}
interface Facts {
  handle: MatchedBoundOperation;
  active: ControlledActiveRun;
  actorId: string;
  sessionId: string;
  contentType: string;
  contentLength: number;
  inputSha256: string;
  initiationFingerprint: string;
  signal: AbortSignal;
  ids: SourceUploadAccess["ids"];
}
interface SourceCustody {
  state:
    | "UPLOAD_ACTIVE"
    | "QUIESCED_UNPUBLISHED"
    | "PENDING_MAYBE"
    | "PENDING_CUSTODY";
  busy: boolean;
  fact?: SourcePutQuiescence;
  settled?: { version: number; receipt: AttachmentStoredObject };
}
export class ControlledSourceUploads {
  private readonly pendingSources = new WeakMap<
    ControlledActiveRun,
    Map<string, SourceCustody>
  >();
  private readonly issued = new WeakSet<MatchedBoundOperation>();
  private readonly contexts = new WeakMap<
    ControlledSourceUploadContext,
    Facts
  >();
  constructor(
    private readonly pool: Pool,
    private readonly original: (handle: BoundOperation) => {
      handle: MatchedBoundOperation;
      active: ControlledActiveRun;
    },
  ) {}
  issue(
    input: BoundOperation,
    value: {
      actorId: string;
      sessionId: string;
      contentType: string;
      contentLength: number;
      inputSha256: string;
      initiationFingerprint: string;
    },
    signal: AbortSignal,
  ): ControlledSourceUploadContext {
    const { handle: h, active } = this.original(input);
    if (this.issued.has(h)) return fail();
    this.issued.add(h);
    const f = data(value, [
        "actorId",
        "sessionId",
        "contentType",
        "contentLength",
        "inputSha256",
        "initiationFingerprint",
      ]),
      roles = [
        "UPLOAD_OWNER",
        "SOURCE_OBJECT",
        "SOURCE_ATTEMPT",
        "PUT_CLAIM",
        "PUT_SUPERVISION",
      ];
    if (
      !(signal instanceof AbortSignal) ||
      signal.aborted ||
      !uuid(f.actorId) ||
      !uuid(f.sessionId) ||
      typeof f.contentType !== "string" ||
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "video/mp4",
        "text/plain",
      ].includes(f.contentType) ||
      !Number.isSafeInteger(f.contentLength) ||
      Number(f.contentLength) < 1 ||
      Number(f.contentLength) > 4194304 ||
      typeof f.initiationFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.initiationFingerprint) ||
      typeof f.inputSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.inputSha256) ||
      h.candidate.method !== "PUT" ||
      h.candidate.path !==
        "/api/v1/attachments/" + h.attachmentId + "/content" ||
      h.candidate.authClass !== "AUTH" ||
      h.candidate.ingressBytes < Number(f.contentLength) ||
      h.candidate.egressBytes !== 0 ||
      h.slots.length !== 5 ||
      roles.some((r) => h.slots.filter((s) => s.role === r).length !== 1) ||
      h.slots.some(
        (s) =>
          s.operationKey !== h.operationKey ||
          s.attachmentId !== h.attachmentId ||
          !uuid(s.id),
      )
    )
      return fail();
    const id = (role: string) => h.slots.find((s) => s.role === role)!.id,
      ids = Object.freeze({
        uploadOwner: id("UPLOAD_OWNER"),
        objectId: id("SOURCE_OBJECT"),
        attemptId: id("SOURCE_ATTEMPT"),
        claimId: id("PUT_CLAIM"),
        supervisionId: id("PUT_SUPERVISION"),
      });
    const ctx = Object.freeze({}) as ControlledSourceUploadContext;
    this.contexts.set(ctx, {
      handle: h,
      active,
      actorId: f.actorId,
      sessionId: f.sessionId,
      contentType: f.contentType,
      contentLength: Number(f.contentLength),
      inputSha256: f.inputSha256,
      initiationFingerprint: f.initiationFingerprint,
      signal,
      ids,
    });
    return ctx;
  }
  async run<T>(
    context: ControlledSourceUploadContext,
    value: {
      actorId: string;
      attachmentId: string;
      contentType: string;
      contentLength: number;
    },
    work: (access: SourceUploadAccess) => Promise<T>,
  ): Promise<T> {
    const f = this.contexts.get(context);
    this.contexts.delete(context);
    if (!f || f.signal.aborted) return fail();
    const expected = data(value, [
      "actorId",
      "attachmentId",
      "contentType",
      "contentLength",
    ]);
    if (
      expected.actorId !== f.actorId ||
      expected.attachmentId !== f.handle.attachmentId ||
      expected.contentType !== f.contentType ||
      expected.contentLength !== f.contentLength ||
      typeof work !== "function"
    )
      return fail();
    const custody: SourceCustody = { state: "UPLOAD_ACTIVE", busy: false };
    let open = true,
      entry: Record<string, any> | undefined,
      deadline = performance.now() + 30000;
    const abort = new AbortController(),
      signal = AbortSignal.any([f.signal, abort.signal]);
    let timer = setTimeout(() => abort.abort(), 30000);
    let registered:
      | {
          claim: AttachmentPutClaim;
          handle: AttachmentPutSupervision;
          proof?: {
            kind: "UNSENT" | "SETTLED";
            local: Awaited<ReturnType<typeof createPutLocalClosure>>;
            certificate?: ReturnType<AttachmentPutSupervision["retireUnsent"]>;
          };
        }
      | undefined;
    const checkOpen = () => {
      if (!open || signal.aborted || performance.now() >= deadline)
        return fail();
    };
    const stage = async <R>(
      callback: (c: PoolClient, fresh: () => Promise<void>) => Promise<R>,
      beforeCommit?: () => void,
      afterCommit?: () => void,
      opaqueCommit = false,
    ): Promise<R> => {
      checkOpen();
      const c = await this.pool.connect();
      let live = true;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL statement_timeout='3000ms'");
        await c.query("SET LOCAL lock_timeout='2000ms'");
        const h = f.handle;
        if (
          !(
            await c.query(
              "SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3 AND state='ACTIVE' AND activation_control_required AND preparation_sealed FOR UPDATE",
              [h.runId, f.active.activationId, f.active.bootId],
            )
          ).rows[0]
        )
          return fail();
        if (
          !(
            await c.query(
              "SELECT attempt_key FROM phase30_test_execution.request_attempts WHERE run_id=$1 AND attempt_key=$2 AND bound_operation_key=$3 AND boot_id=$4 AND state='BOUND' FOR UPDATE",
              [h.runId, h.attemptKey, h.operationKey, f.active.bootId],
            )
          ).rows[0]
        )
          return fail();
        if (
          !(
            await c.query(
              "SELECT operation_key FROM phase30_test_execution.bound_operations WHERE run_id=$1 AND operation_key=$2 AND bound_attempt_key=$3 AND policy_key=$4 AND policy_attempt_key=$5 AND state='BOUND' FOR UPDATE",
              [
                h.runId,
                h.operationKey,
                h.attemptKey,
                h.policyKey,
                h.policyAttemptKey,
              ],
            )
          ).rows[0]
        )
          return fail();
        const fresh = async () => {
          checkOpen();
          if (!live) return fail();
          const started = performance.now(),
            row = (
              await c.query(
                "SELECT not_before,expires_at,clock_timestamp() AS observed_at FROM phase30_test_execution.runs WHERE run_id=$1 AND state='ACTIVE'",
                [h.runId],
              )
            ).rows[0];
          if (
            !row ||
            ![row.not_before, row.expires_at, row.observed_at].every(
              (d) => d instanceof Date && Number.isFinite(d.getTime()),
            ) ||
            row.observed_at < row.not_before ||
            row.observed_at >= row.expires_at
          )
            return fail();
          deadline = Math.min(
            deadline,
            started + row.expires_at.getTime() - row.observed_at.getTime() - 1,
          );
          clearTimeout(timer);
          timer = setTimeout(
            () => abort.abort(),
            Math.max(0, deadline - performance.now()),
          );
          checkOpen();
        };
        await fresh();
        const raw = (
          await c.query(
            "SELECT i.*,s.id AS job_id FROM phase30_test_execution.internal_cleanup_entries i JOIN phase30_test_execution.slots s ON s.run_id=i.run_id AND s.slot_key=i.job_slot_key WHERE i.run_id=$1 AND i.source_operation_key=$2",
            [h.runId, h.operationKey],
          )
        ).rows[0];
        if (
          !raw ||
          raw.attachment_id !== h.attachmentId ||
          raw.object_id !== f.ids.objectId ||
          raw.attempt_id !== f.ids.attemptId ||
          raw.claim_id !== f.ids.claimId ||
          raw.supervision_id !== f.ids.supervisionId ||
          raw.sha256 !== f.inputSha256 ||
          Number(raw.byte_count) !== f.contentLength ||
          !uuid(raw.job_id)
        )
          return fail();
        entry = { ...raw };
        const result = await callback(c, fresh);
        await fresh();
        live = false;
        if (beforeCommit) beforeCommit();
        try {
          await c.query("COMMIT");
        } catch (error) {
          if (opaqueCommit) return fail();
          throw error;
        }
        afterCommit?.();
        checkOpen();
        return result;
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        live = false;
        c.release();
      }
    };
    const sourceSnapshot = async (c: PoolClient) => {
      if (!registered) return fail();
      const o = (
        await c.query(
          "SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 FOR UPDATE",
          [f.handle.attachmentId, f.ids.objectId],
        )
      ).rows[0];
      const receipt = originalPutReceipt(registered.handle);
      if (
        !o ||
        !receipt ||
        o.id !== f.ids.objectId ||
        o.attachment_id !== f.handle.attachmentId ||
        o.attempt_id !== f.ids.attemptId ||
        o.variant !== "source" ||
        o.put_claim !== f.ids.claimId ||
        o.put_supervision_id !== f.ids.supervisionId ||
        o.sha256 !== f.inputSha256 ||
        Number(o.byte_count) !== f.contentLength ||
        o.etag !== receipt.version ||
        o.status !== "WRITTEN" ||
        !o.put_settled_at ||
        o.put_uncertain !== false ||
        o.put_abandoned_at !== null ||
        !Number.isSafeInteger(Number(o.object_version)) ||
        Number(o.object_version) <= registered.claim.objectVersion
      )
        return fail();
      const captured = structuredClone(receipt);
      Object.freeze(captured.locator);
      Object.freeze(captured);
      return Object.freeze({
        version: Number(o.object_version),
        receipt: captured,
      });
    };
    const pendingPredicate = async (c: PoolClient) => {
      if (
        !registered ||
        !custody.fact ||
        !custody.settled ||
        !verifySourcePutQuiescence(
          custody.fact,
          registered.claim,
          custody.settled.receipt,
        )
      )
        return fail();
      const a = (
        await c.query("SELECT * FROM attachments WHERE id=$1 FOR UPDATE", [
          f.handle.attachmentId,
        ])
      ).rows[0];
      if (
        !a ||
        a.id !== f.handle.attachmentId ||
        a.init_fingerprint !== f.initiationFingerprint ||
        a.state !== "PENDING" ||
        a.source_object_id !== f.ids.objectId ||
        a.pending_slot_held !== true ||
        a.upload_slot_held !== false ||
        a.lease_owner !== null
      )
        return fail();
      const o = (
          await c.query(
            "SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 FOR UPDATE",
            [f.handle.attachmentId, f.ids.objectId],
          )
        ).rows[0],
        settled = custody.settled;
      if (
        !o ||
        o.id !== f.ids.objectId ||
        o.attachment_id !== f.handle.attachmentId ||
        o.attempt_id !== f.ids.attemptId ||
        o.variant !== "source" ||
        o.put_claim !== f.ids.claimId ||
        o.put_supervision_id !== f.ids.supervisionId ||
        o.sha256 !== f.inputSha256 ||
        Number(o.byte_count) !== f.contentLength ||
        o.etag !== settled.receipt.version ||
        Number(o.object_version) !== settled.version ||
        o.status !== "WRITTEN" ||
        !o.put_settled_at ||
        o.put_uncertain !== false ||
        o.put_abandoned_at !== null
      )
        return fail();
    };
    const retainCustody = () => {
      let sources = this.pendingSources.get(f.active);
      if (!sources) {
        sources = new Map();
        this.pendingSources.set(f.active, sources);
      }
      const previous = sources.get(f.ids.objectId);
      if (
        (previous && previous !== custody) ||
        (!previous && sources.size >= 4)
      )
        return fail();
      sources.set(f.ids.objectId, custody);
    };
    const reconcilePending = async (): Promise<boolean> => {
      if (custody.busy) return fail();
      if (custody.state === "PENDING_CUSTODY") return true;
      if (!custody.fact) return false;
      custody.busy = true;
      let c: PoolClient | undefined;
      try {
        c = await this.pool.connect();
        await c.query("BEGIN");
        await c.query("SET LOCAL statement_timeout='3000ms'");
        await c.query("SET LOCAL lock_timeout='2000ms'");
        const h = f.handle;
        if (
          !(
            await c.query(
              "SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3 AND activation_control_required AND preparation_sealed AND state IN ('ACTIVE','CLOSED','EXPIRED') FOR UPDATE",
              [h.runId, f.active.activationId, f.active.bootId],
            )
          ).rows[0]
        )
          return fail();
        if (
          !(
            await c.query(
              "SELECT attempt_key FROM phase30_test_execution.request_attempts WHERE run_id=$1 AND attempt_key=$2 AND bound_operation_key=$3 AND boot_id=$4 AND state='BOUND' FOR UPDATE",
              [h.runId, h.attemptKey, h.operationKey, f.active.bootId],
            )
          ).rows[0]
        )
          return fail();
        if (
          !(
            await c.query(
              "SELECT operation_key FROM phase30_test_execution.bound_operations WHERE run_id=$1 AND operation_key=$2 AND bound_attempt_key=$3 AND policy_key=$4 AND policy_attempt_key=$5 AND state='BOUND' FOR UPDATE",
              [
                h.runId,
                h.operationKey,
                h.attemptKey,
                h.policyKey,
                h.policyAttemptKey,
              ],
            )
          ).rows[0]
        )
          return fail();
        await new AttachmentLifecycleLedger().lockForTerminalRetention(
          c,
          h.attachmentId,
        );
        const a = (
          await c.query("SELECT * FROM attachments WHERE id=$1 FOR UPDATE", [
            h.attachmentId,
          ])
        ).rows[0];
        if (a?.state === "PENDING") {
          await pendingPredicate(c);
          await c.query("COMMIT");
          custody.state = "PENDING_CUSTODY";
          return true;
        }
        if (
          !a ||
          a.init_fingerprint !== f.initiationFingerprint ||
          !(
            (a.state === "UPLOADING" && a.lease_owner === f.ids.uploadOwner) ||
            ["DELETED", "REJECTED"].includes(a.state)
          )
        )
          return fail();
        await c.query("COMMIT");
        return false;
      } catch (error) {
        if (c) await c.query("ROLLBACK").catch(() => undefined);
        return fail();
      } finally {
        c?.release();
        custody.busy = false;
      }
    };
    const access: SourceUploadAccess = Object.freeze({
      ids: f.ids,
      supervisionIdentity: createPlannedPutSupervisionIdentity(
        f.ids.supervisionId,
      ),
      signal,
      sha256: f.inputSha256,
      initiationFingerprint: f.initiationFingerprint,
      stage,
      recordSourceReceipt: async <R>(work: (c: PoolClient) => Promise<R>) => {
        if (!registered || custody.settled || custody.busy) return fail();
        custody.busy = true;
        let snapshot: SourceCustody["settled"];
        try {
          return await stage(
            async (c) => {
              const result = await work(c);
              snapshot = await sourceSnapshot(c);
              return result;
            },
            undefined,
            () => {
              custody.settled = snapshot;
            },
            true,
          );
        } finally {
          custody.busy = false;
        }
      },
      captureQuiescence: async (closed: () => Promise<void>) => {
        checkOpen();
        if (
          !registered ||
          !custody.settled ||
          custody.state !== "UPLOAD_ACTIVE" ||
          custody.busy
        )
          return fail();
        custody.busy = true;
        try {
          const local = await createPutLocalClosure(
            registered.claim,
            registered.handle,
            closed,
          );
          checkOpen();
          custody.fact = captureSourcePutQuiescence(
            registered.claim,
            registered.handle,
            local,
          );
          retainCustody();
          custody.state = "QUIESCED_UNPUBLISHED";
        } finally {
          custody.busy = false;
        }
      },
      publishPending: async <R>(work: (c: PoolClient) => Promise<R>) => {
        if (
          custody.busy ||
          custody.state !== "QUIESCED_UNPUBLISHED" ||
          !custody.fact
        )
          return fail();
        custody.busy = true;
        try {
          return await stage(
            async (c) => {
              const result = await work(c);
              await pendingPredicate(c);
              return result;
            },
            () => {
              custody.state = "PENDING_MAYBE";
            },
            () => {
              custody.state = "PENDING_CUSTODY";
            },
            true,
          );
        } finally {
          custody.busy = false;
        }
      },
      reconcilePending,
      assertForward: checkOpen,
      terminalize: async (
        closed: () => Promise<void>,
        settleWithoutObject: boolean,
      ) => {
        await closed();
        const c = await this.pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL statement_timeout='3000ms'");
          await c.query("SET LOCAL lock_timeout='2000ms'");
          if (
            !(
              await c.query(
                "SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3 AND activation_control_required AND preparation_sealed AND state IN ('ACTIVE','CLOSED','EXPIRED') FOR UPDATE",
                [f.handle.runId, f.active.activationId, f.active.bootId],
              )
            ).rows[0]
          )
            return fail();
          if (
            !(
              await c.query(
                "SELECT operation_key FROM phase30_test_execution.bound_operations WHERE run_id=$1 AND operation_key=$2 AND bound_attempt_key=$3 AND state='BOUND' FOR UPDATE",
                [f.handle.runId, f.handle.operationKey, f.handle.attemptKey],
              )
            ).rows[0]
          )
            return fail();
          const row = (
            await c.query(
              "SELECT state,lease_owner FROM attachments WHERE id=$1",
              [f.handle.attachmentId],
            )
          ).rows[0];
          if (row?.state === "TEMPORARY" && row.lease_owner === null) {
            await c.query("COMMIT");
            return;
          }
          if (
            row?.state === "UPLOADING" &&
            row.lease_owner === f.ids.uploadOwner
          )
            await new AttachmentLifecycleLedger().interruptUpload(
              c,
              f.handle.attachmentId,
              f.ids.uploadOwner,
              f.ids.objectId,
            );
          else if (row && !["DELETED", "REJECTED"].includes(row.state))
            return fail();
          if (settleWithoutObject && row)
            await new AttachmentLifecycleLedger().settleUpload(c, {
              attachmentId: f.handle.attachmentId,
              leaseOwner: f.ids.uploadOwner,
              producerQuiesced: true,
            });
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          c.release();
        }
      },
      registerClaim: (
        claim: AttachmentPutClaim,
        handle: AttachmentPutSupervision,
      ) => {
        checkOpen();
        if (
          registered ||
          supervisionIdentity(handle, claim.manifest.locator) !==
            f.ids.supervisionId ||
          claim.attachmentId !== f.handle.attachmentId ||
          claim.objectId !== f.ids.objectId ||
          claim.claimId !== f.ids.claimId ||
          claim.leaseOwner !== f.ids.uploadOwner ||
          claim.manifest.locator.attemptId !== f.ids.attemptId ||
          claim.manifest.sha256 !== f.inputSha256 ||
          claim.manifest.sizeBytes !== f.contentLength
        )
          return fail();
        registered = { claim: structuredClone(claim), handle };
      },
      retire: async (
        claim: AttachmentPutClaim,
        handle: AttachmentPutSupervision,
        closed: () => Promise<void>,
        observed?: AttachmentStoredObject,
      ) => {
        if (
          !registered ||
          registered.handle !== handle ||
          JSON.stringify(registered.claim) !== JSON.stringify(claim) ||
          typeof closed !== "function" ||
          !entry
        )
          return fail();
        if (!registered.proof) {
          const local = await createPutLocalClosure(claim, handle, closed);
          let kind: "UNSENT" | "SETTLED",
            certificate:
              ReturnType<AttachmentPutSupervision["retireUnsent"]> | undefined;
          try {
            certificate = handle.retireUnsent();
            if (
              !verifyUnsentProof(
                claim,
                claim.supervisionId!,
                certificate,
                local,
              )
            )
              return fail();
            kind = "UNSENT";
          } catch {
            await originalPutSettlement(handle, claim.manifest.locator).actual;
            if (!verifyPutLocalClosure(claim, handle, local)) return fail();
            kind = "SETTLED";
          }
          registered.proof = { kind, local, certificate };
        }
        const { kind, local, certificate } = registered.proof;
        if (
          kind === "UNSENT" &&
          !verifyUnsentProof(claim, claim.supervisionId!, certificate!, local)
        )
          return fail();
        if (kind === "SETTLED") {
          if (!verifyPutLocalClosure(claim, handle, local)) return fail();
          observed ??= originalPutReceipt(handle);
        }
        const c = await this.pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL statement_timeout='3000ms'");
          await c.query("SET LOCAL lock_timeout='2000ms'");
          const h = f.handle;
          if (
            !(
              await c.query(
                "SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3 AND preparation_sealed AND activation_control_required AND state IN ('ACTIVE','CLOSED','EXPIRED') FOR UPDATE",
                [h.runId, f.active.activationId, f.active.bootId],
              )
            ).rows[0]
          )
            return fail();
          if (
            !(
              await c.query(
                "SELECT operation_key FROM phase30_test_execution.bound_operations WHERE run_id=$1 AND operation_key=$2 AND bound_attempt_key=$3 AND state='BOUND' FOR UPDATE",
                [h.runId, h.operationKey, h.attemptKey],
              )
            ).rows[0]
          )
            return fail();
          const retained = (
            await c.query(
              "SELECT i.*,s.id AS job_id,s.state AS slot_state FROM phase30_test_execution.internal_cleanup_entries i JOIN phase30_test_execution.slots s ON s.run_id=i.run_id AND s.slot_key=i.job_slot_key WHERE i.run_id=$1 AND i.entry_key=$2 FOR UPDATE OF i,s",
              [h.runId, entry.entry_key],
            )
          ).rows[0];
          if (
            !retained ||
            retained.object_id !== f.ids.objectId ||
            retained.supervision_id !== f.ids.supervisionId
          )
            return fail();
          await new AttachmentLifecycleLedger().lockForTerminalRetention(
            c,
            h.attachmentId,
          );
          const a = (
              await c.query(
                "SELECT state,version,lease_owner,upload_slot_held FROM attachments WHERE id=$1 FOR UPDATE",
                [h.attachmentId],
              )
            ).rows[0],
            o = (
              await c.query(
                "SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 FOR UPDATE",
                [h.attachmentId, f.ids.objectId],
              )
            ).rows[0];
          if (!o) {
            if (kind !== "UNSENT") return fail();
            await new AttachmentLifecycleLedger().settleUpload(c, {
              attachmentId: h.attachmentId,
              leaseOwner: f.ids.uploadOwner,
              producerQuiesced: true,
            });
            await c.query("COMMIT");
            return;
          }
          if (
            !a ||
            !["DELETED", "REJECTED"].includes(a.state) ||
            o.attempt_id !== f.ids.attemptId ||
            o.put_claim !== f.ids.claimId ||
            o.put_supervision_id !== f.ids.supervisionId ||
            o.sha256 !== f.inputSha256 ||
            Number(o.byte_count) !== f.contentLength ||
            (a.lease_owner !== f.ids.uploadOwner &&
              !(
                retained.state === "BOUND" &&
                a.lease_owner === null &&
                !a.upload_slot_held
              ))
          )
            return fail();
          const ensure: ControlledCleanupJob = {
            ensure: async (client, attachmentId, objectId, reason) => {
              if (
                client !== c ||
                attachmentId !== h.attachmentId ||
                objectId !== f.ids.objectId
              )
                return fail();
              const jobs = (
                await c.query(
                  "SELECT id,completed_at FROM attachment_cleanup_jobs WHERE object_id=$1 ORDER BY created_at FOR UPDATE",
                  [objectId],
                )
              ).rows;
              if (jobs.length) {
                if (
                  jobs.length !== 1 ||
                  jobs[0].id !== retained.job_id ||
                  jobs[0].completed_at ||
                  retained.state !== "BOUND" ||
                  retained.slot_state !== "BURNED"
                )
                  return fail();
                return;
              }
              if (
                retained.state !== "AVAILABLE" ||
                retained.slot_state !== "AVAILABLE"
              )
                return fail();
              const current = (
                await c.query(
                  "SELECT object_version FROM attachment_objects WHERE id=$1 FOR UPDATE",
                  [objectId],
                )
              ).rows[0];
              if (
                (
                  await c.query(
                    "UPDATE phase30_test_execution.internal_cleanup_entries SET state='BOUND',proof_kind=$3,lease_owner=$4,attachment_version=$5,object_version=$6 WHERE run_id=$1 AND entry_key=$2 AND state='AVAILABLE'",
                    [
                      h.runId,
                      retained.entry_key,
                      kind,
                      f.ids.uploadOwner,
                      Number(a.version),
                      Number(current.object_version),
                    ],
                  )
                ).rowCount !== 1
              )
                return fail();
              if (
                (
                  await c.query(
                    "UPDATE phase30_test_execution.slots SET state='BURNED' WHERE run_id=$1 AND slot_key=$2 AND state='AVAILABLE'",
                    [h.runId, retained.job_slot_key],
                  )
                ).rowCount !== 1
              )
                return fail();
              await c.query(
                "INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,$4)",
                [retained.job_id, attachmentId, objectId, reason],
              );
              retained.state = "BOUND";
              retained.slot_state = "BURNED";
            },
          };
          const objects = new AttachmentObjectLedger();
          if (kind === "UNSENT")
            await objects.abandonUnsent(c, claim, certificate!, local, ensure);
          else if (observed)
            await objects.recordPutResult(c, claim, observed, ensure);
          else
            await ensure.ensure(c, h.attachmentId, f.ids.objectId, "REJECTED");
          await ensure.ensure(
            c,
            h.attachmentId,
            f.ids.objectId,
            observed ? "LATE_WRITE" : "REJECTED",
          );
          await new AttachmentLifecycleLedger().settleUpload(c, {
            attachmentId: h.attachmentId,
            leaseOwner: f.ids.uploadOwner,
            producerQuiesced: true,
          });
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          c.release();
        }
      },
    });
    try {
      const result = await work(access);
      checkOpen();
      return result;
    } finally {
      open = false;
      clearTimeout(timer);
    }
  }
}
