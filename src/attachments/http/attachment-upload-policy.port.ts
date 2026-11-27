import type { Response } from "express";
import type { AuthenticatedRequest } from "../../auth/guards/access-token.guard";
import type { ControlledSourceUploadContext } from "../test-admission/controlled-source-upload";
export const ATTACHMENT_UPLOAD_POLICY = "ATTACHMENT_UPLOAD_POLICY";
export interface AttachmentUploadPolicy {
  bind(
    request: AuthenticatedRequest,
    attachmentId: string,
    response: Response,
  ): Promise<ControlledSourceUploadContext>;
}
