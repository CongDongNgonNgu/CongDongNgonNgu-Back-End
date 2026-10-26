import type { Pool } from "pg";
import type { Readable } from "node:stream";
import { SessionFailure } from "../../auth/session/session.service";
import { transaction } from "../../study-groups/study-group.store";
import { AttachmentQuotaLedger } from "../attachment-quota-ledger";
import {
  admitAttachmentRead,
  selectAttachmentMetadata,
} from "../access/attachment-access";
import {
  patchDraftMetadata,
  type AttachmentDraftStatus,
} from "../initiation/attachment-draft-repository";
import { AttachmentInitiationRepository } from "../initiation/attachment-initiation-repository";
import { AttachmentLifecycleLedger } from "../lifecycle/attachment-lifecycle-ledger";
import { opaqueAttachmentAuthorizationError } from "../authorization/attachment-authorization";
import {
  attachmentDownloadHeaders,
  attachmentRange,
} from "../transport/attachment-range";
import {
  AttachmentStorageError,
  type AttachmentStorage,
  type AttachmentStoredObject,
} from "../storage/attachment-storage.port";
/** Internal existing-session refresh. Supplied invalid credentials MUST reject;
 * null means genuinely anonymous. No fallback/catch converts failure to null. */
export type RefreshAttachmentIdentity = () => Promise<string | null>;
interface ReadOptions {
  variant?: "normalized" | "thumbnail";
  range?: string;
  trustedIpHash?: string;
  signal?: AbortSignal;
}
export interface AttachmentReadResponse {
  status: 200 | 206;
  headers: Record<string, string>;
  body?: Readable;
}
/** Shared internal service, no routes/config activation. Domain admission commits
 * before storage I/O. Revocation denies subsequent admissions, while an already
 * admitted bounded transfer cannot be recalled. Provider metadata never leaves
 * this service; no URLs or source-byte fallback are returned. */
export class AttachmentReadService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: AttachmentStorage,
    private readonly quotas = new AttachmentQuotaLedger(),
    private readonly lifecycle = new AttachmentLifecycleLedger(),
  ) {}
  private async actor(
    refresh: RefreshAttachmentIdentity,
    required = false,
  ): Promise<string | null> {
    const actor = await refresh();
    if (actor === null) {
      if (required) throw new SessionFailure("AUTH_UNAUTHORIZED");
      return null;
    }
    if (
      typeof actor !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        actor,
      )
    )
      throw new SessionFailure("AUTH_UNAUTHORIZED");
    return actor;
  }
  private async readRate(
    actor: string | null,
    trustedIpHash?: string,
  ): Promise<void> {
    if (actor === null && !/^[a-f0-9]{64}$/.test(trustedIpHash ?? ""))
      throw new SessionFailure("AUTH_UNAUTHORIZED");
    // This transaction touches rate rows only and releases them before domain locks.
    await transaction(this.pool, (c) =>
      this.quotas.consumeRead(c, actor, trustedIpHash),
    );
  }
  async metadata(
    refresh: RefreshAttachmentIdentity,
    id: string,
    trustedIpHash?: string,
  ): Promise<AttachmentDraftStatus> {
    const actor = await this.actor(refresh);
    await this.readRate(actor, trustedIpHash);
    return transaction(this.pool, (c) =>
      selectAttachmentMetadata(c, actor, id),
    );
  }
  async patchMetadata(
    refresh: RefreshAttachmentIdentity,
    id: string,
    input: unknown,
  ): Promise<AttachmentDraftStatus> {
    const actor = (await this.actor(refresh, true))!;
    return transaction(this.pool, (c) =>
      patchDraftMetadata(c, actor, id, input),
    );
  }
  async delete(
    refresh: RefreshAttachmentIdentity,
    id: string,
  ): Promise<{ state: "DELETED" }> {
    const actor = (await this.actor(refresh, true))!;
    return transaction(this.pool, (c) =>
      this.lifecycle.deleteOwned(c, actor, id),
    );
  }
  async initiate(
    refresh: RefreshAttachmentIdentity,
    repository: AttachmentInitiationRepository,
    input: unknown,
  ): Promise<AttachmentDraftStatus> {
    const actor = (await this.actor(refresh, true))!,
      created = await repository.initiate(actor, input);
    // Every replay, including bound history, receives fresh exact-parent metadata
    // authorization. An internal replay reference never becomes an API projection.
    return this.metadata(
      async () => {
        const current = await this.actor(refresh, true);
        if (current !== actor) throw new SessionFailure("AUTH_UNAUTHORIZED");
        return current;
      },
      "requiresBoundProjection" in created ? created.attachmentId : created.id,
    );
  }
  private matches(
    expected: AttachmentStoredObject,
    actual: AttachmentStoredObject | null,
  ): void {
    if (!actual) throw opaqueAttachmentAuthorizationError();
    if (
      actual.sha256 !== expected.sha256 ||
      actual.sizeBytes !== expected.sizeBytes ||
      actual.version !== expected.version ||
      Object.entries(expected.locator).some(
        ([k, v]) => actual.locator[k as keyof typeof expected.locator] !== v,
      )
    )
      throw new AttachmentStorageError("INTEGRITY");
  }
  async read(
    refresh: RefreshAttachmentIdentity,
    id: string,
    method: "GET" | "HEAD",
    options: ReadOptions = {},
  ): Promise<AttachmentReadResponse> {
    const actor = await this.actor(refresh);
    await this.readRate(actor, options.trustedIpHash);
    if (method !== "GET" && method !== "HEAD")
      throw opaqueAttachmentAuthorizationError();
    const variant = options.variant ?? "normalized";
    const admitted = await transaction(this.pool, (c) =>
      admitAttachmentRead(c, actor, id, variant),
    );
    const range = attachmentRange(options.range, admitted.object.sizeBytes),
      responseBytes = range
        ? range.end - range.start + 1
        : admitted.object.sizeBytes;
    const headers = {
      ...attachmentDownloadHeaders(admitted.format, variant, ""),
      "Content-Length": String(responseBytes),
      ...(range
        ? {
            "Content-Range": `bytes ${range.start}-${range.end}/${admitted.object.sizeBytes}`,
          }
        : {}),
    };
    if (options.signal?.aborted)
      throw new AttachmentStorageError("UNAVAILABLE");
    if (method === "HEAD") {
      this.matches(
        admitted.object,
        await this.storage.head(admitted.object.locator),
      );
      return { status: range ? 206 : 200, headers };
    }
    const opened = await this.storage.openRead(
      admitted.object,
      range,
      options.signal,
    );
    try {
      this.matches(admitted.object, opened);
      if (opened.responseBytes !== responseBytes)
        throw new AttachmentStorageError("INTEGRITY");
      return { status: range ? 206 : 200, headers, body: opened.body };
    } catch (error) {
      opened.body.destroy();
      throw error;
    }
  }
}
