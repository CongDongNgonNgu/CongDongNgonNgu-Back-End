import type { PoolClient } from "pg";
import { ATTACHMENT_LIMITS } from "./attachment-policy";
import type {
  AttachmentObjectLocator,
  AttachmentStoredObject,
} from "./storage/attachment-storage.port";
export class AttachmentCleanupError extends Error {
  constructor(readonly code: "CLAIM_CONFLICT" | "INTEGRITY") {
    super("ATTACHMENT_CLEANUP_" + code);
    this.name = "AttachmentCleanupError";
  }
}
export interface AttachmentCleanupIdentity {
  attachmentId: string;
  objectId: string;
  jobId: string;
}
export interface AttachmentCleanupClaim extends AttachmentCleanupIdentity {
  leaseOwner: string;
  objectVersion: number;
  claimedAt: Date;
  manifest: {
    locator: AttachmentObjectLocator;
    sizeBytes: number;
    sha256: string;
  };
  expected: AttachmentStoredObject | null;
}
export interface AttachmentCleanupAbsence {
  confirmedLocator: AttachmentObjectLocator;
  headMissing: boolean;
  ownedListingResidual: number;
  observedAt: Date;
}
export type AttachmentCleanupFailure =
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_INTEGRITY"
  | "STORAGE_OWNERSHIP"
  | "RESIDUAL_FOUND"
  | "CLEANUP_CANCELLED";
interface ObjectRow {
  id: string;
  attachment_id: string;
  attempt_id: string;
  variant: AttachmentObjectLocator["kind"];
  byte_count: string;
  sha256: string;
  etag: string | null;
  object_version: string;
  put_claim: string | null;
  put_settled_at: Date | null;
  put_abandoned_at: Date | null;
  put_uncertain: boolean;
  status: string;
}
interface JobRow {
  id: string;
  attempts: number;
  lease_owner: string | null;
  completed_at: Date | null;
  due: boolean;
  lease_valid: boolean;
  now: Date;
}
const reject = (code: "CLAIM_CONFLICT" | "INTEGRITY"): never => {
  throw new AttachmentCleanupError(code);
};
const uuid = (v: string) => {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      v,
    )
  )
    reject("CLAIM_CONFLICT");
};
function snapshot(o: ObjectRow) {
  return {
    locator: {
      attachmentId: o.attachment_id,
      attemptId: o.attempt_id,
      objectId: o.id,
      kind: o.variant,
    },
    sizeBytes: Number(o.byte_count),
    sha256: o.sha256,
  };
}
/** Internal transactions only; caller holds domain/account locks, then we lock attachment -> object -> job.
 * Commit before provider I/O. Never settle uncertain writes from absence; never release quotas here.
 */
export class AttachmentCleanupLedger {
  private async locked(client: PoolClient, id: AttachmentCleanupIdentity) {
    [id.attachmentId, id.objectId, id.jobId].forEach(uuid);
    const a = (
      await client.query<{state:string;format:string;source_object_id:string|null;normalized_object_id:string|null;thumbnail_object_id:string|null;lease_owner:string|null}>(
        "SELECT state,format,source_object_id,normalized_object_id,thumbnail_object_id,lease_owner FROM attachments WHERE id=$1 FOR UPDATE",
        [id.attachmentId],
      )
    ).rows[0];
    const o = (
      await client.query<ObjectRow>(
        "SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 FOR UPDATE",
        [id.attachmentId, id.objectId],
      )
    ).rows[0];
    const j = (
      await client.query<JobRow>(
        `SELECT *,next_attempt_at<=clock_timestamp() AS due,lease_expires_at>clock_timestamp() AS lease_valid,clock_timestamp() AS now FROM attachment_cleanup_jobs WHERE attachment_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE`,
        [id.attachmentId, id.objectId, id.jobId],
      )
    ).rows[0];
    if (
      !a ||
      !o ||
      !j ||
      o.put_uncertain ||
      (o.put_claim !== null && o.put_settled_at === null && !o.put_abandoned_at)
    )
      return reject("CLAIM_CONFLICT");
    if(!["DELETED","REJECTED"].includes(a.state)) {
      // A live READY entity may discard only its quarantined selected original,
      // after every exact selected safe derivative is durably settled. The
      // binding/read artifact itself can never enter this exception.
      if(a.state!=="READY"||a.lease_owner||o.variant!=="source"||a.source_object_id!==o.id||!a.normalized_object_id)return reject("CLAIM_CONFLICT");
      const derivatives=(await client.query<{id:string;variant:string;content_type:string;byte_count:string}>("SELECT id,variant,content_type,byte_count FROM attachment_objects WHERE attachment_id=$1 AND id=ANY($2::uuid[]) AND status='WRITTEN' AND NOT put_uncertain AND put_settled_at IS NOT NULL AND etag IS NOT NULL FOR SHARE",[id.attachmentId,[a.normalized_object_id,...(a.thumbnail_object_id?[a.thumbnail_object_id]:[])]] )).rows;
      const normalized=derivatives.find(x=>x.id===a.normalized_object_id&&x.variant==='normalized'), thumbnail=derivatives.find(x=>x.id===a.thumbnail_object_id&&x.variant==='thumbnail');
      const expected=a.format==='IMAGE'?'image/webp':a.format==='VIDEO'?'video/mp4':a.format==='TEXT'?'application/octet-stream':null;
      const limit=a.format==='IMAGE'?ATTACHMENT_LIMITS.imageBytes:a.format==='VIDEO'?ATTACHMENT_LIMITS.videoBytes:ATTACHMENT_LIMITS.textBytes;
      if(!expected||!normalized||normalized.content_type!==expected||Number(normalized.byte_count)>limit||(a.format==='TEXT'?a.thumbnail_object_id!==null:!thumbnail||thumbnail.content_type!==(a.format==='IMAGE'?'image/webp':'image/jpeg')||Number(thumbnail.byte_count)>ATTACHMENT_LIMITS.thumbnailBytes))return reject("CLAIM_CONFLICT");
      if((await client.query('SELECT 1 FROM attachment_processing_lease WHERE attachment_id=$1 AND owner IS NOT NULL',[id.attachmentId])).rowCount)return reject("CLAIM_CONFLICT");
    }
    return { o, j };
  }
  async claim(
    client: PoolClient,
    id: AttachmentCleanupIdentity,
    leaseOwner: string,
  ): Promise<AttachmentCleanupClaim> {
    uuid(leaseOwner);
    const { o, j } = await this.locked(client, id);
    if (
      j.completed_at ||
      !j.due ||
      j.lease_valid ||
      j.attempts >= ATTACHMENT_LIMITS.cleanupAttempts ||
      o.status === "DELETED"
    )
      return reject("CLAIM_CONFLICT");
    if (o.put_claim !== null && o.etag === null && !o.put_abandoned_at) return reject("INTEGRITY");
    const row = (
      await client.query<ObjectRow>(
        `UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1 RETURNING *`,
        [o.id],
      )
    ).rows[0];
    const job = (
      await client.query<{ claimed_at: Date }>(
        `UPDATE attachment_cleanup_jobs SET lease_owner=$2,lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond'),attempts=attempts+1 WHERE id=$1 RETURNING lease_expires_at-($3::bigint*interval '1 millisecond') AS claimed_at`,
        [j.id, leaseOwner, ATTACHMENT_LIMITS.processingLeaseMs],
      )
    ).rows[0];
    const manifest = snapshot(row);
    return {
      ...id,
      leaseOwner,
      objectVersion: Number(row.object_version),
      claimedAt: job.claimed_at,
      manifest,
      expected: row.etag === null ? null : { ...manifest, version: row.etag },
    };
  }
  private matches(c: AttachmentCleanupClaim, o: ObjectRow): boolean {
    const a = snapshot(o);
    return (
      Number.isSafeInteger(c.objectVersion) &&
      Object.entries(a.locator).every(
        ([k, v]) =>
          c.manifest?.locator?.[k as keyof AttachmentObjectLocator] === v,
      ) &&
      a.sha256 === c.manifest.sha256 &&
      a.sizeBytes === c.manifest.sizeBytes &&
      (c.expected === null
        ? o.etag === null
        : c.expected.version === o.etag &&
          c.expected.sha256 === a.sha256 &&
          c.expected.sizeBytes === a.sizeBytes &&
          Object.entries(a.locator).every(
            ([k, v]) =>
              c.expected?.locator?.[k as keyof AttachmentObjectLocator] === v,
          ))
    );
  }
  private live(c: AttachmentCleanupClaim, o: ObjectRow, j: JobRow): void {
    if (
      !this.matches(c, o) ||
      Number(o.object_version) !== c.objectVersion ||
      o.status !== "DELETE_PENDING" ||
      j.completed_at ||
      j.lease_owner !== c.leaseOwner ||
      !j.lease_valid
    )
      return reject("CLAIM_CONFLICT");
  }
  async finish(
    client: PoolClient,
    c: AttachmentCleanupClaim,
    absence: AttachmentCleanupAbsence,
  ): Promise<void> {
    const { o, j } = await this.locked(client, c);
    if (
      Object.entries(c.manifest.locator).some(
        ([key, value]) =>
          absence.confirmedLocator?.[key as keyof AttachmentObjectLocator] !==
          value,
      ) ||
      absence.headMissing !== true ||
      absence.ownedListingResidual !== 0 ||
      !(absence.observedAt instanceof Date) ||
      !Number.isFinite(absence.observedAt.getTime()) ||
      !(c.claimedAt instanceof Date) ||
      !Number.isFinite(c.claimedAt.getTime()) ||
      absence.observedAt < c.claimedAt ||
      absence.observedAt.getTime() > j.now.getTime() + 1000
    )
      return reject("INTEGRITY");
    if (
      j.completed_at &&
      o.status === "DELETED" &&
      Number(o.object_version) === c.objectVersion + 1 &&
      this.matches(c, o) &&
      j.completed_at >= c.claimedAt
    )
      return;
    this.live(c, o, j);
    await client.query(
      "UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1",
      [o.id],
    );
    await client.query(
      "UPDATE attachment_cleanup_jobs SET completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1",
      [j.id],
    );
  }
  async fail(
    client: PoolClient,
    c: AttachmentCleanupClaim,
    code: AttachmentCleanupFailure,
  ): Promise<void> {
    if (
      ![
        "STORAGE_UNAVAILABLE",
        "STORAGE_INTEGRITY",
        "STORAGE_OWNERSHIP",
        "RESIDUAL_FOUND",
        "CLEANUP_CANCELLED",
      ].includes(code)
    )
      return reject("INTEGRITY");
    const { o, j } = await this.locked(client, c);
    this.live(c, o, j);
    const delay = Math.min(
      60000 * 2 ** (j.attempts - 1),
      ATTACHMENT_LIMITS.cleanupMaxBackoffMs,
    );
    await client.query(
      `UPDATE attachment_cleanup_jobs SET lease_owner=NULL,lease_expires_at=NULL,last_error_code=$2,next_attempt_at=clock_timestamp()+($3::bigint*interval '1 millisecond') WHERE id=$1`,
      [j.id, code, delay],
    );
  }
}
