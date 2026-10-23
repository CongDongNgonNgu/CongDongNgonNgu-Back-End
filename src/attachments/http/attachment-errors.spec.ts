import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { attachmentHttpError } from "./attachment-errors";
import { ApiExceptionFilter } from "../../common/http/api-exception.filter";
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
const privateDetail =
  "private-photo.jpg https://private.invalid/?signed=SECRET";
describe("HTTP attachment failures use explicit classes and constant safe responses", () => {
  const cases: Array<[Error, number, string]> = [
    [new AttachmentAuthorizationError(), 404, "ATTACHMENT_UNAVAILABLE"],
    [
      new AttachmentInitiationInputError(),
      400,
      "ATTACHMENT_INVALID_INITIATION",
    ],
    [new AttachmentPolicyError(), 400, "ATTACHMENT_INVALID_REQUEST"],
    [
      new AttachmentValidationError("ATTACHMENT_INVALID_METADATA"),
      400,
      "ATTACHMENT_INVALID_METADATA",
    ],
    [
      new AttachmentValidationError("ATTACHMENT_LIMIT_EXCEEDED"),
      413,
      "ATTACHMENT_LIMIT_EXCEEDED",
    ],
    [
      new AttachmentValidationError("ATTACHMENT_TYPE_MISMATCH"),
      415,
      "ATTACHMENT_TYPE_MISMATCH",
    ],
    [
      new AttachmentValidationError("ATTACHMENT_INVALID_CONTENT"),
      415,
      "ATTACHMENT_INVALID_CONTENT",
    ],
    [new AttachmentDraftConflict(), 409, "ATTACHMENT_METADATA_CONFLICT"],
    [
      new AttachmentDraftConflict("ATTACHMENT_INITIATION_CONFLICT"),
      409,
      "ATTACHMENT_INITIATION_CONFLICT",
    ],
    [new AttachmentBindingError(), 409, "ATTACHMENT_BINDING_CONFLICT"],
    [
      new AttachmentFinalizationError(),
      409,
      "ATTACHMENT_FINALIZATION_CONFLICT",
    ],
    [new AttachmentLifecycleError(), 409, "ATTACHMENT_LIFECYCLE_CONFLICT"],
    [new AttachmentRangeError(), 416, "ATTACHMENT_RANGE_INVALID"],
    [
      new AttachmentQuotaError("ATTACHMENT_RATE_LIMITED"),
      429,
      "ATTACHMENT_RATE_LIMITED",
    ],
    [
      new AttachmentQuotaError("ATTACHMENT_QUOTA_EXCEEDED"),
      429,
      "ATTACHMENT_QUOTA_EXCEEDED",
    ],
    [
      new AttachmentQuotaError("ATTACHMENT_BUSY"),
      503,
      "ATTACHMENTS_UNAVAILABLE",
    ],
    [new AttachmentInitiationUnavailable(), 503, "ATTACHMENTS_UNAVAILABLE"],
    [new AttachmentStorageError("NOT_FOUND"), 404, "ATTACHMENT_UNAVAILABLE"],
    [new AttachmentStorageError("OWNERSHIP"), 404, "ATTACHMENT_UNAVAILABLE"],
    [
      new AttachmentStorageError("CONFLICT"),
      409,
      "ATTACHMENT_STORAGE_CONFLICT",
    ],
    [
      new AttachmentUploadStateError("CONFLICT"),
      409,
      "ATTACHMENT_UPLOAD_CONFLICT",
    ],
    [
      new AttachmentUploadStateError("INTEGRITY"),
      400,
      "ATTACHMENT_UPLOAD_INVALID",
    ],
    [new AttachmentUploadError("INTEGRITY"), 400, "ATTACHMENT_UPLOAD_INVALID"],
    [
      new AttachmentUploadError("CANCELLED"),
      400,
      "ATTACHMENT_UPLOAD_CANCELLED",
    ],
    [
      new AttachmentLedgerError("CLAIM_CONFLICT"),
      409,
      "ATTACHMENT_OBJECT_CONFLICT",
    ],
    [
      new AttachmentCleanupError("CLAIM_CONFLICT"),
      409,
      "ATTACHMENT_CLEANUP_CONFLICT",
    ],
  ];
  for (const code of [
    "INVALID_CONFIGURATION",
    "INVALID_INPUT",
    "INTEGRITY",
    "UNAVAILABLE",
  ] as const)
    cases.push([
      new AttachmentStorageError(code),
      503,
      "ATTACHMENTS_UNAVAILABLE",
    ]);
  for (const code of ["TIMEOUT", "UNAVAILABLE"] as const)
    cases.push([
      new AttachmentUploadError(code),
      503,
      "ATTACHMENTS_UNAVAILABLE",
    ]);
  for (const Processor of [ImageProcessingError, VideoProcessingError]) {
    cases.push([
      new Processor("PROCESSING_INVALID"),
      415,
      "ATTACHMENT_INVALID_CONTENT",
    ]);
    for (const code of [
      "PROCESSING_TIMEOUT",
      "PROCESSING_MEMORY_LIMIT",
      "PROCESSING_CANCELLED",
      "PROCESSING_UNAVAILABLE",
    ] as const)
      cases.push([new Processor(code), 503, "ATTACHMENTS_UNAVAILABLE"]);
  }
  it.each(cases)("maps %s to safe HTTP %i/%s", (error, status, code) => {
    error.message = privateDetail;
    const mapped = attachmentHttpError(error);
    expect(mapped).toBeInstanceOf(HttpException);
    expect(mapped.getStatus()).toBe(status);
    expect(mapped.getResponse()).toMatchObject({
      code,
      message: expect.any(String),
    });
    expect(JSON.stringify(mapped.getResponse())).not.toContain(privateDetail);
  });
  it.each([
    "AUTH_UNAUTHORIZED",
    "AUTH_SESSION_EXPIRED",
    "AUTH_REFRESH_REUSE_DETECTED",
    "AUTH_ACCOUNT_DISABLED",
  ])(
    "never downgrades supplied invalid authentication %s to anonymous404",
    (code) => {
      const mapped = attachmentHttpError(
        new SessionFailure(code, 200, privateDetail),
      );
      expect(mapped.getStatus()).toBe(401);
      expect(mapped.getResponse()).toEqual({
        code,
        message: "Authentication required",
      });
    },
  );
  it.each(["AUTH_CSRF_INVALID", "AUTH_FORBIDDEN"])(
    "preserves existing explicit403 %s without trusting its constructor status/message",
    (code) => {
      const mapped = attachmentHttpError(
        new SessionFailure(code, 200, privateDetail),
      );
      expect(mapped.getStatus()).toBe(403);
      expect(mapped.getResponse()).toEqual({
        code,
        message: "Request is not permitted",
      });
    },
  );
  it("uses opaque401 for an unknown SessionFailure code and never serializes it", () => {
    const mapped = attachmentHttpError(
      new SessionFailure(privateDetail, 404, privateDetail),
    );
    expect(mapped.getStatus()).toBe(401);
    expect(mapped.getResponse()).toEqual({
      code: "AUTH_UNAUTHORIZED",
      message: "Authentication required",
    });
  });
  it.each([
    new Error(privateDetail),
    { code: "ATTACHMENT_UNAVAILABLE", status: 404, message: privateDetail },
    Object.assign(new Error(privateDetail), {
      name: "AttachmentAuthorizationError",
      code: "ATTACHMENT_UNAVAILABLE",
      status: 404,
    }),
    new AttachmentQuotaError("ATTACHMENT_QUOTA_INTEGRITY"),
    new AttachmentQuotaError("ATTACHMENT_QUOTA_LOCK_ORDER"),
  ])(
    "rethrows unrecognized errors without trusting structural code/status",
    (error) => {
      try {
        attachmentHttpError(error);
        throw Error("expected rejection");
      } catch (observed) {
        expect(observed).toBe(error);
      }
    },
  );
  it("scrubs unrecognized HttpException so the existing filter cannot expose arbitrary HTTP details", () => {
    let mapped: unknown;
    try {
      attachmentHttpError(
        new HttpException(
          { code: "PRIVATE_SIGNED_URL", message: privateDetail },
          418,
        ),
      );
    } catch (error) {
      mapped = error;
    }
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(HttpException);
    let status: number | undefined, body: unknown;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    new ApiExceptionFilter().catch(mapped, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost);
    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      },
    });
  });
});
