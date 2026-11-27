import type {
  ControlledInitiationContext,
  ControlledInitiationProjection,
  ControlledInitiationPort,
  ControlledInitiationAccess,
  InitiationMode,
} from "./controlled-initiation.port";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../../study-groups/study-group.store";
import {
  AttachmentQuotaLedger,
  AttachmentQuotaError,
} from "../attachment-quota-ledger";
import {
  ATTACHMENT_LIMITS as L,
  type parseAttachmentCapabilities,
} from "../attachment-policy";
import {
  AttachmentAuthorizationError,
  authorizeDraftScope,
  opaqueAttachmentAuthorizationError,
} from "../authorization/attachment-authorization";
import {
  AttachmentDraftConflict,
  projectDraft,
  type DraftRow,
  type AttachmentDraftStatus,
} from "./attachment-draft-repository";
import {
  parseInitiation,
  initiationUuid,
  type ParsedInitiation,
} from "./initiation-input";
interface Admission {
  fingerprint: string;
  source_bytes: string;
  format: string;
  status: "ADMITTED" | "REJECTED" | "CREATED";
  attachment_id: string | null;
  expires_at: Date;
  expired: boolean;
}
/** Internal reference only: the caller must authorize the current exact bound
 * parent before projecting any fields. This reference is never an HTTP DTO. */
export interface BoundInitiationReplay {
  attachmentId: string;
  requiresBoundProjection: true;
}
export class AttachmentInitiationUnavailable extends Error {
  readonly code = "ATTACHMENTS_UNAVAILABLE";
  readonly status = 503;
  constructor() {
    super("Attachments unavailable");
  }
}
export class AttachmentInitiationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly capabilities: ReturnType<
      typeof parseAttachmentCapabilities
    >,
    private readonly quotas = new AttachmentQuotaLedger(),
    private readonly controlled?: ControlledInitiationPort,
  ) {}
  private async admission(
    client: PoolClient,
    actor: string,
    input: ParsedInitiation,
  ): Promise<Admission> {
    const row = (
      await client.query<Admission>(
        "SELECT *,expires_at<=clock_timestamp() AS expired FROM attachment_initiation_admissions WHERE uploader_id=$1 AND client_upload_id=$2 FOR UPDATE",
        [actor, input.clientUploadId],
      )
    ).rows[0];
    if (
      !row ||
      row.fingerprint !== input.fingerprint ||
      row.source_bytes !== String(input.bytes) ||
      row.format !== input.format ||
      row.expired ||
      row.status === "REJECTED"
    )
      throw new AttachmentDraftConflict("ATTACHMENT_INITIATION_CONFLICT");
    return row;
  }
  async initiateProjected<R>(
    actor: string,
    input: unknown,
    context: ControlledInitiationContext,
    projection: ControlledInitiationProjection<R>,
  ): Promise<R> {
    if (!this.controlled || !context || !projection)
      throw new AttachmentInitiationUnavailable();
    let snapshot: ControlledInitiationProjection<R>;
    try {
      if (
        typeof projection !== "object" ||
        Array.isArray(projection) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(projection))
      )
        throw new AttachmentInitiationUnavailable();
      const names = ["refresh", "rate", "select"],
        keys = Reflect.ownKeys(projection);
      if (
        keys.length !== 3 ||
        keys.some((k) => typeof k !== "string" || !names.includes(k))
      )
        throw new AttachmentInitiationUnavailable();
      const descriptors = names.map((name) =>
        Object.getOwnPropertyDescriptor(projection, name),
      );
      if (
        descriptors.some(
          (d) =>
            !d ||
            !d.enumerable ||
            !("value" in d) ||
            typeof d.value !== "function",
        )
      )
        throw new AttachmentInitiationUnavailable();
      snapshot = Object.freeze({
        refresh: descriptors[0]!.value,
        rate: descriptors[1]!.value,
        select: descriptors[2]!.value,
      }) as ControlledInitiationProjection<R>;
    } catch {
      throw new AttachmentInitiationUnavailable();
    }
    return this.execute(actor, input, context, snapshot);
  }
  async initiate(
    actorValue: string,
    inputValue: unknown,
    context?: ControlledInitiationContext,
  ): Promise<AttachmentDraftStatus | BoundInitiationReplay> {
    if (this.controlled ? !context : arguments.length >= 3)
      throw new AttachmentInitiationUnavailable();
    return this.execute(actorValue, inputValue, context);
  }
  private execute<R>(
    actorValue: string,
    inputValue: unknown,
    context: ControlledInitiationContext,
    projection: ControlledInitiationProjection<R>,
  ): Promise<R>;
  private execute(
    actorValue: string,
    inputValue: unknown,
    context?: ControlledInitiationContext,
  ): Promise<AttachmentDraftStatus | BoundInitiationReplay>;
  private async execute<R>(
    actorValue: string,
    inputValue: unknown,
    context?: ControlledInitiationContext,
    projection?: ControlledInitiationProjection<R>,
  ): Promise<AttachmentDraftStatus | BoundInitiationReplay | R> {
    const projectionRefresh = projection?.refresh,
      projectionRate = projection?.rate,
      projectionSelect = projection?.select;
    const actor = initiationUuid(actorValue),
      input = parseInitiation(inputValue);
    if (
      !this.capabilities.enabled ||
      !this.capabilities[
        input.format === "IMAGE"
          ? "image"
          : input.format === "VIDEO"
            ? "video"
            : "text"
      ]
    )
      throw new AttachmentInitiationUnavailable();
    // Rate-only transaction: controlled ledger locks (when injected), then
    // admission -> sorted counters and a separate commit. It must
    // never acquire account, scope or attachment locks. Failed NEW domain work
    // remains durably charged; immutable retries share the same admission.
    const rate = async (
      client: PoolClient,
      mode: InitiationMode = "CREATE_ALLOWED",
    ) => {
      if (mode === "REPLAY_ONLY") {
        const existing = await this.admission(client, actor, input);
        if (existing.status !== "CREATED")
          throw new AttachmentDraftConflict("ATTACHMENT_INITIATION_CONFLICT");
        return;
      }
      const added = await client.query(
        `INSERT INTO attachment_initiation_admissions(uploader_id,client_upload_id,fingerprint,source_bytes,format,created_at,expires_at) SELECT $1,$2,$3,$4,$5,t,t+interval '24 hours' FROM (SELECT clock_timestamp() t) stamp ON CONFLICT DO NOTHING RETURNING uploader_id`,
        [
          actor,
          input.clientUploadId,
          input.fingerprint,
          input.bytes,
          input.format,
        ],
      );
      await this.admission(client, actor, input);
      if (added.rowCount === 1)
        await this.quotas.consumeInitiation(client, actor, input.bytes);
    };
    const domain = async (
      client: PoolClient,
      access?: ControlledInitiationAccess,
    ) => {
      if (this.controlled && !access)
        throw new AttachmentInitiationUnavailable();
      // Unlocked candidate is not an authorization result; immutable request and
      // current scope/generation are checked before admission/attachment locks.
      const candidate = (
        await client.query<DraftRow>(
          "SELECT * FROM attachments WHERE uploader_id=$1 AND client_upload_id=$2",
          [actor, input.clientUploadId],
        )
      ).rows[0];
      let authorized: Awaited<ReturnType<typeof authorizeDraftScope>> | null =
        null;
      if (candidate?.first_bound_at) {
        const active = await client.query(
          "SELECT id FROM users WHERE id=$1 AND status='ACTIVE' AND email_verified_at IS NOT NULL FOR UPDATE",
          [actor],
        );
        if (active.rowCount !== 1) throw opaqueAttachmentAuthorizationError();
      } else
        authorized = await authorizeDraftScope(
          client,
          actor,
          input.intent,
          candidate?.scope_generation,
        );
      const admission = await this.admission(client, actor, input);
      if (admission.status === "CREATED") {
        if (access) await access.fresh();
        const row = (
          await client.query<DraftRow & { declared_mime: string }>(
            "SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2 FOR UPDATE",
            [admission.attachment_id, actor],
          )
        ).rows[0];
        if (
          !row ||
          row.init_fingerprint !== input.fingerprint ||
          row.state === "DELETED" ||
          (access &&
            (row.id !== access.attachmentId ||
              row.client_upload_id !== input.clientUploadId ||
              row.declared_mime !== input.mime ||
              String(row.expected_bytes) !== String(input.bytes) ||
              row.format !== input.format))
        )
          throw opaqueAttachmentAuthorizationError();
        if (row.first_bound_at) {
          if (access) await access.fresh();
          return {
            attachmentId: row.id,
            requiresBoundProjection: true,
          } as BoundInitiationReplay;
        }
        if (!authorized || row.scope_generation !== authorized.generation)
          throw opaqueAttachmentAuthorizationError();
        if (
          (
            await client.query(
              "SELECT 1 FROM attachments WHERE id=$1 AND expires_at>clock_timestamp()",
              [row.id],
            )
          ).rowCount !== 1
        )
          throw opaqueAttachmentAuthorizationError();
        if (access) await access.fresh();
        return projectDraft(row);
      }
      if (access?.mode === "REPLAY_ONLY")
        throw new AttachmentDraftConflict("ATTACHMENT_INITIATION_CONFLICT");
      // Current actor account lock serializes any same-actor reservation writer.
      // ADMITTED has no draft yet; capture current membership/connection generation.
      if (!authorized) throw opaqueAttachmentAuthorizationError();
      const scope = input.intent,
        id = access ? access.takeAttachment() : randomUUID();
      const scopeId =
        scope.kind === "COMMUNITY"
          ? scope.languageId
          : scope.kind === "STUDY_GROUP"
            ? scope.groupId
            : scope.conversationId;
      if (access) await access.fresh();
      const row = (
        await client.query<DraftRow>(
          `INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,group_id,conversation_id,scope_generation,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,caption,alt,reserved_bytes,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,t,t+($20::bigint*interval '1 millisecond') FROM (SELECT clock_timestamp() t) stamp RETURNING *`,
          [
            id,
            actor,
            scope.kind,
            scopeId,
            scope.kind === "COMMUNITY" ? scopeId : null,
            scope.kind === "STUDY_GROUP" ? scopeId : null,
            scope.kind === "DIRECT_MESSAGE" ? scopeId : null,
            authorized.generation,
            scope.kind === "COMMUNITY" ? scope.postType : null,
            scope.kind === "COMMUNITY" ? scope.visibility : null,
            input.clientUploadId,
            input.fingerprint,
            input.format,
            input.mime,
            input.bytes,
            input.filename,
            input.caption,
            input.alt,
            input.reservedBytes,
            L.draftTtlMs,
          ],
        )
      ).rows[0];
      if (access) await access.fresh();
      await this.quotas.changeCapacity(client, actor, {
        bytesDelta: input.reservedBytes,
        metadataDelta: 1,
      });
      await client.query(
        "UPDATE attachment_initiation_admissions SET status='CREATED',attachment_id=$3 WHERE uploader_id=$1 AND client_upload_id=$2",
        [actor, input.clientUploadId, id],
      );
      if (access) await access.fresh();
      return projectDraft(row);
    };
    if (!this.controlled) {
      await transaction(this.pool, rate);
      return transaction(this.pool, (client) => domain(client));
    }
    let normalError: unknown;
    const protect = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (
          error instanceof AttachmentAuthorizationError ||
          error instanceof AttachmentQuotaError ||
          error instanceof AttachmentDraftConflict
        )
          normalError = error;
        throw error;
      }
    };
    try {
      if (projection) {
        const recipe: ControlledInitiationProjection<R> = {
          refresh: () => projectionRefresh!(),
          rate: (client, id) => protect(() => projectionRate!(client, id)),
          select: (client, id) => protect(() => projectionSelect!(client, id)),
        };
        return await this.controlled.continueInitiation(
          context!,
          { actorId: actor, fingerprint: input.fingerprint },
          (client, mode) => protect(() => rate(client, mode)),
          (client, access) => protect(() => domain(client, access)),
          recipe,
        );
      }
      return await this.controlled.continueInitiation(
        context!,
        { actorId: actor, fingerprint: input.fingerprint },
        (client, mode) => protect(() => rate(client, mode)),
        (client, access) => protect(() => domain(client, access)),
      );
    } catch {
      if (normalError) throw normalError;
      throw new AttachmentInitiationUnavailable();
    }
  }
}
