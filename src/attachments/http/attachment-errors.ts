import { HttpException } from "@nestjs/common";
import { SessionFailure } from "../../auth/session/session.service";
import { AttachmentAuthorizationError } from "../authorization/attachment-authorization";
import { AttachmentValidationError } from "../validation/validation-error";
import { AttachmentPolicyError } from "../attachment-policy";
import { AttachmentQuotaError } from "../attachment-quota-ledger";
import { AttachmentStorageError } from "../storage/attachment-storage.port";
import { AttachmentLedgerError } from "../attachment-object-ledger";
import { AttachmentCleanupError } from "../attachment-cleanup-ledger";
import { AttachmentBindingError } from "../binding/attachment-binding";
import { AttachmentDraftConflict } from "../initiation/attachment-draft-repository";
import { AttachmentInitiationInputError } from "../initiation/initiation-input";
import { AttachmentInitiationUnavailable } from "../initiation/attachment-initiation-repository";
import { AttachmentUploadError } from "../transport/attachment-upload";
import { AttachmentRangeError } from "../transport/attachment-range";
import { AttachmentUploadStateError } from "../upload/attachment-upload-ledger";
import { AttachmentFinalizationError } from "../finalization/attachment-finalization-ledger";
import { AttachmentLifecycleError } from "../lifecycle/attachment-lifecycle-ledger";
import { ImageProcessingError } from "../processing/image-processor";
import { VideoProcessingError } from "../video-processing/video-processor";
const failure = (
  status: number,
  code: string,
  message: string,
): HttpException => new HttpException({ code, message }, status);
const invalid = (code: string) =>
  failure(400, code, "Attachment request is invalid");
const conflict = (code: string) =>
  failure(409, code, "Attachment request conflicts with current state");
const unavailable = () =>
  failure(
    503,
    "ATTACHMENTS_UNAVAILABLE",
    "Attachments are temporarily unavailable",
  );
const missing = () =>
  failure(404, "ATTACHMENT_UNAVAILABLE", "Attachment is not available");
const unsupported = (code: string) =>
  failure(415, code, "Attachment content is not supported");
/** Catch-boundary adapter, not authentication or authorization. Guards must run
 * before lookup; a supplied invalid identity must never become anonymous. Only
 * explicit error classes and constant allowlisted codes are public. Never return
 * provider/processor messages, filenames, URLs, paths, tokens or arbitrary status.
 * Caller uses `throw attachmentHttpError(error)`. Unknown errors rethrow into the
 * existing generic500 filter. Unknown HttpException is deliberately stripped of
 * its payload because that filter would otherwise expose its arbitrary response.
 */
export function attachmentHttpError(error: unknown): HttpException {
  if (error instanceof SessionFailure) {
    const code = error.code;
    switch (code) {
      case "AUTH_CSRF_INVALID":
        return failure(403, "AUTH_CSRF_INVALID", "Request is not permitted");
      case "AUTH_FORBIDDEN":
        return failure(403, "AUTH_FORBIDDEN", "Request is not permitted");
      case "AUTH_SESSION_EXPIRED":
        return failure(401, "AUTH_SESSION_EXPIRED", "Authentication required");
      case "AUTH_REFRESH_REUSE_DETECTED":
        return failure(
          401,
          "AUTH_REFRESH_REUSE_DETECTED",
          "Authentication required",
        );
      case "AUTH_ACCOUNT_DISABLED":
        return failure(401, "AUTH_ACCOUNT_DISABLED", "Authentication required");
      default:
        return failure(401, "AUTH_UNAUTHORIZED", "Authentication required");
    }
  }
  if (error instanceof AttachmentAuthorizationError) return missing();
  if (error instanceof AttachmentInitiationInputError)
    return invalid("ATTACHMENT_INVALID_INITIATION");
  if (error instanceof AttachmentPolicyError)
    return invalid("ATTACHMENT_INVALID_REQUEST");
  if (error instanceof AttachmentValidationError) {
    switch (error.code) {
      case "ATTACHMENT_INVALID_METADATA":
        return invalid("ATTACHMENT_INVALID_METADATA");
      case "ATTACHMENT_LIMIT_EXCEEDED":
        return failure(
          413,
          "ATTACHMENT_LIMIT_EXCEEDED",
          "Attachment limit exceeded",
        );
      case "ATTACHMENT_TYPE_MISMATCH":
        return unsupported("ATTACHMENT_TYPE_MISMATCH");
      case "ATTACHMENT_INVALID_CONTENT":
        return unsupported("ATTACHMENT_INVALID_CONTENT");
    }
  }
  if (error instanceof AttachmentDraftConflict) {
    switch (error.code) {
      case "ATTACHMENT_METADATA_CONFLICT":
        return conflict("ATTACHMENT_METADATA_CONFLICT");
      case "ATTACHMENT_INITIATION_CONFLICT":
        return conflict("ATTACHMENT_INITIATION_CONFLICT");
    }
  }
  if (error instanceof AttachmentBindingError)
    return conflict("ATTACHMENT_BINDING_CONFLICT");
  if (error instanceof AttachmentFinalizationError)
    return conflict("ATTACHMENT_FINALIZATION_CONFLICT");
  if (error instanceof AttachmentLifecycleError)
    return conflict("ATTACHMENT_LIFECYCLE_CONFLICT");
  if (error instanceof AttachmentRangeError)
    return failure(
      416,
      "ATTACHMENT_RANGE_INVALID",
      "Attachment range is invalid",
    );
  if (error instanceof AttachmentInitiationUnavailable) return unavailable();
  if (error instanceof AttachmentQuotaError) {
    switch (error.code) {
      case "ATTACHMENT_RATE_LIMITED":
        return failure(
          429,
          "ATTACHMENT_RATE_LIMITED",
          "Attachment request limit exceeded",
        );
      case "ATTACHMENT_QUOTA_EXCEEDED":
        return failure(
          429,
          "ATTACHMENT_QUOTA_EXCEEDED",
          "Attachment request limit exceeded",
        );
      case "ATTACHMENT_BUSY":
        return unavailable();
      // Counter corruption or lock-order misuse is an internal500, not a user quota.
    }
  }
  if (error instanceof AttachmentStorageError) {
    switch (error.code) {
      case "NOT_FOUND":
      case "OWNERSHIP":
        return missing();
      case "CONFLICT":
        return conflict("ATTACHMENT_STORAGE_CONFLICT");
      case "INVALID_CONFIGURATION":
      case "INVALID_INPUT":
      case "INTEGRITY":
      case "UNAVAILABLE":
        return unavailable();
    }
  }
  if (error instanceof AttachmentUploadStateError) {
    switch (error.code) {
      case "CONFLICT":
        return conflict("ATTACHMENT_UPLOAD_CONFLICT");
      case "INTEGRITY":
        return invalid("ATTACHMENT_UPLOAD_INVALID");
    }
  }
  if (error instanceof AttachmentUploadError) {
    switch (error.code) {
      case "INTEGRITY":
        return invalid("ATTACHMENT_UPLOAD_INVALID");
      case "CANCELLED":
        return invalid("ATTACHMENT_UPLOAD_CANCELLED");
      case "TIMEOUT":
      case "UNAVAILABLE":
        return unavailable();
    }
  }
  if (error instanceof AttachmentLedgerError) {
    switch (error.code) {
      case "CLAIM_CONFLICT":
        return conflict("ATTACHMENT_OBJECT_CONFLICT");
      case "INTEGRITY":
        return unavailable();
    }
  }
  if (error instanceof AttachmentCleanupError) {
    switch (error.code) {
      case "CLAIM_CONFLICT":
        return conflict("ATTACHMENT_CLEANUP_CONFLICT");
      case "INTEGRITY":
        return unavailable();
    }
  }
  if (
    error instanceof ImageProcessingError ||
    error instanceof VideoProcessingError
  ) {
    switch (error.code) {
      case "PROCESSING_INVALID":
        return unsupported("ATTACHMENT_INVALID_CONTENT");
      case "PROCESSING_TIMEOUT":
      case "PROCESSING_MEMORY_LIMIT":
      case "PROCESSING_CANCELLED":
      case "PROCESSING_UNAVAILABLE":
        return unavailable();
    }
  }
  if (error instanceof HttpException) throw new Error("Internal server error");
  throw error;
}
