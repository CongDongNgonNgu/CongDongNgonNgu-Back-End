import type { PoolClient } from "pg";
import { ATTACHMENT_LIMITS as L } from "../attachment-policy";
export interface AttachmentRetentionResult {
  admissionsPurged: number;
  rateCountersPurged: number;
  used: number;
  remaining: number;
}
export class AttachmentRetentionError extends Error {
  constructor() {
    super("ATTACHMENT_RETENTION_INVALID");
    this.name = "AttachmentRetentionError";
  }
}
const invalid = (): never => {
  throw new AttachmentRetentionError();
};
/** Internal retention only. Caller owns a dedicated READ COMMITTED transaction
 * and must roll it back on failure. Do not call while holding domain/attachment
 * or unrelated quota locks, and never acquire such locks afterwards. Admissions
 * precede counter locks, matching initiation's admission -> sorted quota order.
 * SKIP LOCKED preserves in-flight admissions/charges instead of waiting on them.
 * No capacity debt, CREATED replay facts or attachment/object ownership is purged.
 */
export class AttachmentRetentionLedger {
  async purge(
    client: PoolClient,
    limit: number = L.cleanupBatch,
  ): Promise<AttachmentRetentionResult> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > L.cleanupBatch)
      return invalid();
    if (limit === 0)
      return {
        admissionsPurged: 0,
        rateCountersPurged: 0,
        used: 0,
        remaining: 0,
      };
    const admissions = await client.query(
      `WITH candidates AS (
   SELECT uploader_id,client_upload_id FROM attachment_initiation_admissions
   WHERE attachment_id IS NULL AND status IN ('ADMITTED','REJECTED')
    AND created_at<=clock_timestamp()-interval '24 hours' AND expires_at<=clock_timestamp()
   ORDER BY uploader_id,client_upload_id LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM attachment_initiation_admissions a USING candidates c
   WHERE a.uploader_id=c.uploader_id AND a.client_upload_id=c.client_upload_id
    AND a.attachment_id IS NULL AND a.status IN ('ADMITTED','REJECTED')
    AND a.created_at<=clock_timestamp()-interval '24 hours' AND a.expires_at<=clock_timestamp()`,
      [limit],
    );
    const admissionsPurged = admissions.rowCount;
    if (
      admissionsPurged === null ||
      !Number.isSafeInteger(admissionsPurged) ||
      admissionsPurged < 0 ||
      admissionsPurged > limit
    )
      return invalid();
    const available = limit - admissionsPurged;
    let rateCountersPurged = 0;
    if (available) {
      const counters = await client.query(
        `WITH candidates AS (
    SELECT kind,subject,action,window_start FROM attachment_quota_counters
    WHERE action IN ('initiate','source','read','upload_attempt','ingress')
     AND window_start<clock_timestamp()-interval '48 hours' AND updated_at<clock_timestamp()-interval '48 hours'
    ORDER BY CASE kind WHEN 'ACTOR' THEN 0 WHEN 'IP' THEN 1 WHEN 'DEPLOYMENT' THEN 2 ELSE 3 END,
     subject COLLATE "C",action COLLATE "C",window_start LIMIT $1 FOR UPDATE SKIP LOCKED
   ) DELETE FROM attachment_quota_counters q USING candidates c
    WHERE q.kind=c.kind AND q.subject=c.subject AND q.action=c.action AND q.window_start=c.window_start
     AND q.action IN ('initiate','source','read','upload_attempt','ingress')
     AND q.window_start<clock_timestamp()-interval '48 hours' AND q.updated_at<clock_timestamp()-interval '48 hours'`,
        [available],
      );
      const count = counters.rowCount;
      if (
        count === null ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > available
      )
        return invalid();
      rateCountersPurged = count;
    }
    const used = admissionsPurged + rateCountersPurged;
    return {
      admissionsPurged,
      rateCountersPurged,
      used,
      remaining: limit - used,
    };
  }
}

